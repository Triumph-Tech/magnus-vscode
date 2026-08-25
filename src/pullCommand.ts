import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { Api } from "./api";
import { mapWithConcurrency } from "./asyncUtils";
import { assembleFlatTreePaths } from "./flatTree";
import { MaterializeMode, materializeFile } from "./materializeFile";
import {
    Manifest,
    ManifestRoot,
    MANIFEST_VERSION,
    hashBytes,
    normalizePathPrefix,
    readManifest,
    writeManifest
} from "./manifest";
import {
    MAGNUS_JSON_SCHEMA_VERSION,
    ensureMagnusGitignore,
    writeMagnusJson
} from "./magnusJson";
import { PullRegistry } from "./pullRegistry";
import { editSelection } from "./editSelectionCommand";
import { enumerateServerTree } from "./serverTree";
import {
    aliasFromUrl,
    disambiguateName,
    extensionFromUri,
    isAISkillsCollectionNodeUri,
    isEmptyContent,
    isLocalModePullableUri,
    isMobileAppNodeUri,
    isPersistedDatasetsCollectionNodeUri,
    isThemeNodeUri,
    nameForDescriptor,
    sanitizeForFs,
    toFullUrl
} from "./pullHelpers";

// Re-export pure helpers so downstream modules keep their existing import paths.
export { MaterializeMode };
export {
    aliasFromUrl,
    disambiguateName,
    extensionFromUri,
    isAISkillsCollectionNodeUri,
    isEmptyContent,
    isLocalModePullableUri,
    isMobileAppNodeUri,
    isPersistedDatasetsCollectionNodeUri,
    isThemeNodeUri,
    nameForDescriptor,
    sanitizeForFs,
    toFullUrl
};

/** Safety threshold — ask the user to confirm before pulling more than this many files. */
const LARGE_PULL_THRESHOLD = 1000;

/**
 * Concurrency cap for per-file content GETs during pull. Matches the value
 * used by Fetch — six is the sweet spot between saturating the pipe and
 * hammering Rock. Both pull paths (flat-tree fast and recursive-walk fallback)
 * funnel through `materializePullItems` and use this cap.
 */
const PULL_FETCH_CONCURRENCY = 6;

/**
 * Pull one resource into an existing workspace, materialising its files and
 * recording its items in `manifest`.
 *
 * Extracted so the selection dialog and the tree's right-click land on the same
 * code. Two ways to start a pull that then diverge is how the two paths end up
 * disagreeing about where files go.
 *
 * Does not write the manifest: the caller owns that, because adding several
 * resources in one edit should produce one write, not one per resource.
 */
export async function pullResourceIntoWorkspace(
    api: Api,
    serverUrl: string,
    workspaceRoot: string,
    manifest: Manifest,
    rootDescriptor: IItemDescriptor,
    pathPrefix: string,
    pulledAt: string,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    mode: MaterializeMode = "pull"
): Promise<MaterializeResult> {
    const node = { serverUrl, itemDescriptor: rootDescriptor };
    const absPath = path.join(workspaceRoot, ...pathPrefix.split("/").filter(Boolean));
    await fs.mkdir(absPath, { recursive: true });

    // Try the flat-tree fast path first. One round trip returns the
    // entire subtree; null/non-array means the server hasn't
    // implemented the endpoint for this VFS, in which case we fall
    // back to a recursive walk (which still works against older
    // servers).
    progress.report({ message: "Fetching file list…" });
    const flatResult = await api.getFlatTree(
        node.serverUrl,
        node.itemDescriptor.uri ?? ""
    );

    let folders: PullDescriptor[];
    let files: PullDescriptor[];
    if (flatResult !== null && flatResult.items.length > 0) {
        ({ folders, files } = splitFlatTreeItems(flatResult.items));

        // Pull has no deletions to get wrong, so an incomplete list
        // is not dangerous here, just short: the workspace comes
        // down missing files. Say so, because the alternative is the
        // user discovering it later and blaming the tool. A later
        // Fetch will bring the rest in as new files.
        if (!flatResult.complete) {
            void vscode.window.showWarningMessage(
                "Magnus Local: the server's file list was incomplete"
                + (flatResult.incompleteReason === "no-completeness-signal"
                    ? " (this plugin version can't report completeness)"
                    : flatResult.incompleteReason ? ` (${flatResult.incompleteReason})` : "")
                + ", so this workspace may be missing files. Run Fetch to pick up the rest."
            );
        }
    }
    else {
        progress.report({ message: "Scanning server…" });
        const allItems = await enumerateServerTree(
            api,
            node.serverUrl,
            node.itemDescriptor,
            {
                onFolderWalked: (n) =>
                    progress.report({ message: `Scanning server… ${n} folders` })
            }
        );
        ({ folders, files } = splitServerTreeItems(allItems));
    }

    // Re-anchor onto the workspace root before materialising, so
    // item keys and `.magnus/baseline/` paths are workspace-relative
    // while the files themselves land exactly where they always did.
    const anchor = (d: PullDescriptor): PullDescriptor => ({
        descriptor: d.descriptor,
        relPath: `${pathPrefix}${d.relPath}`
    });

    return materializePullItems(
        api,
        node.serverUrl,
        folders.map(anchor),
        files.map(anchor),
        workspaceRoot,
        manifest,
        pulledAt,
        progress,
        mode
    );
}

/**
 * Register the `magnus.pullToWorkspace` command and related handlers.
 *
 * @param api The Magnus API client.
 * @param registry The pulled-workspace registry.
 */
export function extensionVersion(): string {
    return vscode.extensions.getExtension("TriumphTech.magnus")?.packageJSON?.version ?? "unknown";
}

export function registerPullCommand(
    api: Api,
    registry: PullRegistry
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand("magnusLocal.pullToWorkspace", (node: ITreeNode) =>
            pullToWorkspace(api, registry, node)
        ),
        vscode.commands.registerCommand("magnusLocal.editSelection", async () => {
            // Operates on the open folder, because that is what "this
            // workspace" means to the person looking at it.
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) {
                void vscode.window.showErrorMessage(
                    "Magnus Local: open a pulled workspace folder first."
                );
                return;
            }
            await editSelection(api, folder.uri.fsPath, extensionVersion());
        })
    ];
}

/**
 * Entry point for the pull flow. See v1-plan §3.2 and §7.1 for the contract.
 */
async function pullToWorkspace(
    api: Api,
    registry: PullRegistry,
    node: ITreeNode | undefined
): Promise<void> {
    if (!node || !node.itemDescriptor.isFolder) {
        return;
    }

    // Belt-and-suspenders: the right-click menu is already gated on the
    // viewItem's `canPullLocal_` marker (only injected for supported
    // node types), but the command can also be invoked programmatically
    // — e.g. from another extension via executeCommand, or via the
    // command palette if anyone ever exposes it there. Refuse pulls of
    // unsupported node types explicitly so the failure mode is a clear
    // message rather than a half-materialized workspace whose SCM panel
    // won't behave. See `isLocalModePullableUri` for the supported
    // content types (currently mobile apps and AI Skills).
    if (!isLocalModePullableUri(node.itemDescriptor.uri)) {
        await vscode.window.showErrorMessage(
            "Magnus Local: Pull to Local Workspace is not supported for this node type."
        );
        return;
    }

    const serverAlias = aliasFromUrl(node.serverUrl);
    const folderName = sanitizeForFs(node.itemDescriptor.displayName) || "pulled";
    const groupFolder = node.parentGroupName
        ? (sanitizeForFs(node.parentGroupName) || "")
        : "";

    // Optional starting directory for the picker. We do NOT auto-create
    // anything; if the configured pullRoot doesn't exist, we just don't
    // pass a defaultUri and let VS Code's picker default to its last-used
    // directory. The user owns where pulls go.
    const pullRootSetting = getPullRootSetting().trim();
    let defaultUri: vscode.Uri | undefined;
    if (pullRootSetting !== "") {
        const expanded = expandTilde(pullRootSetting);
        if (await exists(expanded)) {
            defaultUri = vscode.Uri.file(expanded);
        }
    }

    // User picks the parent folder; we create
    // `<server-alias>/<group>/<app>/` inside it. Different apps can be
    // pulled to different parents — the picker is per-pull, not a
    // one-time global decision.
    const picked = await vscode.window.showOpenDialog({
        title: `Pull "${node.itemDescriptor.displayName}" — choose a parent folder`,
        defaultUri,
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Pull Here"
    });
    if (!picked || picked.length === 0) {
        return;
    }
    const chosenParent = picked[0].fsPath;

    // The workspace is the server, not the resource (spec 7.3). Bookkeeping
    // lives once at the server level and each pulled resource occupies its own
    // prefix beneath it, so a second pull from the same server joins the
    // existing workspace instead of starting a rival one.
    //
    // File locations are unchanged from previous versions: what moved is where
    // `.magnus/` sits, not where content lands.
    const workspaceRoot = path.join(chosenParent, serverAlias);
    const pathPrefix = normalizePathPrefix(
        groupFolder ? `${groupFolder}/${folderName}` : folderName
    );
    const absPath = path.join(workspaceRoot, ...pathPrefix.split("/").filter(Boolean));

    if (await exists(absPath) && !(await isEmpty(absPath))) {
        const relForMsg = path.relative(chosenParent, absPath) || absPath;
        await vscode.window.showErrorMessage(
            `${relForMsg} already exists and isn't empty. Unlink the existing pull first, or pick a different parent.`
        );
        return;
    }

    // An existing workspace for this server is joined, not replaced. Reading it
    // first also means a manifest written by an older Magnus surfaces its
    // "pull again" error here, before anything is written.
    let existing: Manifest | null = null;
    try {
        existing = await readManifest(workspaceRoot);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await vscode.window.showErrorMessage(`Magnus Local: ${message}`);
        return;
    }

    if (existing && existing.server.url !== node.serverUrl) {
        await vscode.window.showErrorMessage(
            `${workspaceRoot} is already a Magnus workspace for ${existing.server.url}. `
            + "Pick a different parent folder for a second server."
        );
        return;
    }

    await fs.mkdir(absPath, { recursive: true });

    const pulledAt = new Date().toISOString();
    // Mobile-app pulls put the app *under* a parent group ("Mobile Apps"),
    // so `parentGroupName` carries the platform. Collection-level pulls
    // (AI Skills today, future content types tomorrow) target the group
    // node itself, so its displayName *is* the platform — fall back to
    // displayName when parentGroupName is absent. The `platform` field
    // drives downstream UI choices (e.g. tree decorations).
    const platform = node.parentGroupName ?? node.itemDescriptor.displayName;
    const newRoot: ManifestRoot = {
        uri: node.itemDescriptor.uri ?? "",
        displayName: node.itemDescriptor.displayName,
        pulledAt,
        platform,
        buildUri: node.itemDescriptor.buildUri ?? null,
        pathPrefix
    };

    const manifest: Manifest = existing ?? {
        version: MANIFEST_VERSION,
        server: { url: node.serverUrl, alias: serverAlias },
        roots: [],
        items: {}
    };

    // Re-pulling the same resource replaces its root entry rather than adding a
    // duplicate, so the prefix stays a unique key.
    manifest.roots = manifest.roots.filter(r => r.pathPrefix !== pathPrefix);
    manifest.roots.push(newRoot);

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Pulling ${node.itemDescriptor.displayName}`,
                cancellable: false
            },
            (progress) => pullResourceIntoWorkspace(
                api,
                node.serverUrl,
                workspaceRoot,
                manifest,
                node.itemDescriptor,
                pathPrefix,
                pulledAt,
                progress
            )
        );
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await vscode.window.showErrorMessage(`Pull failed: ${message}`);
        return;
    }

    await writeManifest(workspaceRoot, manifest);

    await ensureMagnusGitignore(workspaceRoot);

    // The committed half (spec 7.4). Written from the manifest's roots rather
    // than from this one pull, so a workspace that already held resources keeps
    // describing all of them.
    await writeMagnusJson(workspaceRoot, {
        schemaVersion: MAGNUS_JSON_SCHEMA_VERSION,
        server: manifest.server,
        selection: manifest.roots
            .map(r => ({
                uri: r.uri,
                displayName: r.displayName,
                platform: r.platform,
                pathPrefix: r.pathPrefix
            }))
            .sort((a, b) => a.pathPrefix.localeCompare(b.pathPrefix)),
        pulledAt,
        versions: {
            extension: extensionVersion(),
            plugin: (await api.getServerInfo(node.serverUrl))?.pluginVersion ?? null
        }
    });

    await registry.add({
        serverUrl: node.serverUrl,
        localPath: workspaceRoot,
        label: `${serverAlias} / ${node.itemDescriptor.displayName}`,
        rootUri: node.itemDescriptor.uri ?? "",
        pulledAt
    });

    const allowMultiApp = vscode.workspace.getConfiguration("magnusLocal").get<boolean>("allowMultiAppWorkspace", false);
    const fileTotal = countFiles(manifest);
    const choices: string[] = ["Open in New Window"];
    if (allowMultiApp && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        choices.push("Add to Current Workspace");
    }
    choices.push("Done");

    const openChoice = await vscode.window.showInformationMessage(
        `Pulled ${fileTotal} file${fileTotal === 1 ? "" : "s"} to ${absPath}`,
        ...choices
    );

    if (openChoice === "Open in New Window") {
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspaceRoot), true);
    }
    else if (openChoice === "Add to Current Workspace") {
        vscode.workspace.updateWorkspaceFolders(
            vscode.workspace.workspaceFolders?.length ?? 0,
            0,
            { uri: vscode.Uri.file(workspaceRoot) }
        );
    }
}

/**
 * Normalized shape that both the flat-tree fast path and the recursive walk
 * fallback produce, fed into `materializePullItems` for the actual disk +
 * manifest writes. `descriptor` is the server-side descriptor; `relPath` is
 * the on-disk path relative to the workspace root.
 */
type PullDescriptor = { descriptor: IItemDescriptor; relPath: string };

/**
 * Split a flat-tree response into folder and file PullDescriptors using
 * `assembleFlatTreePaths` for the URI → relPath mapping. Items pruned by the
 * content filter are absent from the path map and skipped here.
 */
function splitFlatTreeItems(
    items: IFlatTreeItem[]
): { folders: PullDescriptor[]; files: PullDescriptor[] } {
    const pathByUri = assembleFlatTreePaths(items);
    const folders: PullDescriptor[] = [];
    const files: PullDescriptor[] = [];
    for (const item of items) {
        if (!item.uri) {
            continue;
        }
        const relPath = pathByUri.get(item.uri);
        if (!relPath) {
            continue;
        }
        if (item.isFolder) {
            folders.push({ descriptor: item, relPath });
        }
        else {
            files.push({ descriptor: item, relPath });
        }
    }
    return { folders, files };
}

/**
 * Split a recursive-walk enumeration into folder and file PullDescriptors.
 * The walk already applied the content filter, so every item here is kept.
 */
function splitServerTreeItems(
    items: Array<{ naiveRelPath: string; descriptor: IItemDescriptor }>
): { folders: PullDescriptor[]; files: PullDescriptor[] } {
    const folders: PullDescriptor[] = [];
    const files: PullDescriptor[] = [];
    for (const it of items) {
        if (it.descriptor.isFolder) {
            folders.push({ descriptor: it.descriptor, relPath: it.naiveRelPath });
        }
        else {
            files.push({ descriptor: it.descriptor, relPath: it.naiveRelPath });
        }
    }
    return { folders, files };
}

export type MaterializeResult = {
    /** Files that were absent locally and came down from the server. */
    written: number;
    /** Files already present and already identical to the server (`hydrate` only). */
    unchanged: number;
    /** Files present, different, and replaced by the server's version (`hydrate` only). */
    replaced: number;
};

/**
 * Shared two-phase materialization step used by both pull paths once items
 * are split into folders and files. Performs the large-pull confirmation,
 * pre-creates folders + records them in the manifest, then fetches file
 * content concurrently and writes each file + its baseline + manifest entry.
 */
async function materializePullItems(
    api: Api,
    serverUrl: string,
    folders: PullDescriptor[],
    files: PullDescriptor[],
    absRoot: string,
    manifest: Manifest,
    pulledAt: string,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    mode: MaterializeMode = "pull"
): Promise<MaterializeResult> {
    const fileTotal = files.length;

    if (fileTotal > LARGE_PULL_THRESHOLD) {
        const confirm = await vscode.window.showWarningMessage(
            `This pull contains ${fileTotal} files. Continue?`,
            { modal: true },
            "Continue",
            "Cancel"
        );
        if (confirm !== "Continue") {
            throw new Error("Pull cancelled.");
        }
    }

    // Pre-create folders and record them in the manifest. mkdir recursive:true
    // is idempotent and creates missing parents, so we don't need to sort by
    // depth — the server may return items in any per-parent order.
    for (const { descriptor, relPath } of folders) {
        await fs.mkdir(path.join(absRoot, relPath), { recursive: true });
        manifest.items[`${relPath}/`] = {
            uri: descriptor.uri ?? "",
            isFolder: true,
            displayName: descriptor.displayName
        };
    }

    let filesPulled = 0;
    const result: MaterializeResult = { written: 0, unchanged: 0, replaced: 0 };
    const incrementPer = fileTotal > 0 ? (100 / fileTotal) : 0;

    await mapWithConcurrency(files, PULL_FETCH_CONCURRENCY, async ({ descriptor, relPath }) => {
        if (!descriptor.uri) {
            return;
        }
        const fullUrl = toFullUrl(serverUrl, descriptor.uri);
        const bytes = await api.getFileContent(fullUrl);
        if (isEmptyContent(bytes)) {
            return;
        }
        // Kept in its own module so the write rule can be tested against a real
        // filesystem rather than only through this concurrent loop.
        const outcome = await materializeFile(absRoot, relPath, bytes, mode);
        if (outcome === "replaced") {
            result.replaced++;
        }
        else if (outcome === "unchanged") {
            result.unchanged++;
        }
        else {
            result.written++;
        }

        manifest.items[relPath] = {
            uri: descriptor.uri,
            buildUri: descriptor.buildUri ?? null,
            deleteUri: descriptor.deleteUri ?? null,
            isFolder: false,
            hash: hashBytes(bytes),
            lastSyncedAt: pulledAt,
            // Recorded so a later scan can tell "unchanged" from "changed"
            // without either side reading content (spec 7.8 tier 2). Absent when
            // the handler does not report one, which reads as "check properly".
            modifiedDateTime: (descriptor as IFlatTreeItem).modifiedDateTime ?? undefined
        };

        filesPulled++;
        progress.report({
            message: `${filesPulled}/${fileTotal} · ${relPath}`,
            increment: incrementPer
        });
    });

    return result;
}

/** Read the configured pull root; falls back to ~/RockMagnus. */
function getPullRootSetting(): string {
    const raw = vscode.workspace.getConfiguration("magnusLocal").get<string>("pullRoot", "~/RockMagnus");
    return raw || "~/RockMagnus";
}

function expandTilde(p: string): string {
    if (p.startsWith("~")) {
        return path.join(os.homedir(), p.slice(1));
    }
    return p;
}

async function exists(p: string): Promise<boolean> {
    try {
        await fs.stat(p);
        return true;
    }
    catch {
        return false;
    }
}

async function isEmpty(p: string): Promise<boolean> {
    try {
        const entries = await fs.readdir(p);
        return entries.length === 0;
    }
    catch {
        return true;
    }
}

function countFiles(manifest: Manifest): number {
    let n = 0;
    for (const key in manifest.items) {
        if (!manifest.items[key].isFolder) {
            n++;
        }
    }
    return n;
}
