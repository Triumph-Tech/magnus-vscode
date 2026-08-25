import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Api, AuthenticationError } from "./api";
import { mapWithConcurrency } from "./asyncUtils";
import { assembleFlatTreePaths } from "./flatTree";
import {
    BASELINE_DIR,
    BaselineContentProvider,
    encodeBaselineUri,
    readBaseline,
    removeBaseline,
    writeBaseline
} from "./baselineContentProvider";
import {
    Manifest, ManifestRoot, rootForPath,
    hashBytes,
    readManifest,
    writeManifest
} from "./manifest";
import { toFullUrl } from "./pullCommand";
import {
    IncomingSidecar,
    readIncomingSidecar,
    writeIncomingSidecar
} from "./incomingSidecar";
import { MagnusJson } from "./magnusJson";
import { friendlyNetworkMessage } from "./networkErrors";
import { Secrets } from "./secrets";
import { resolveServerConnection } from "./serverConnection";
import { classifyWorkspace } from "./workspaceState";
import { enumerateServerTree } from "./serverTree";
import { bytesEqual, classifyDeletionScan, classifyFetchedFile, classifyLocalState, classifyServerDeletion } from "./syncDecisions";
import { RootAccess, classifyRootAccess, extractFilesystemIdentifier } from "./capabilities";
import { MagnusHttpError, describeHttpFailure } from "./httpErrors";
import { planBaselineRepair } from "./repair";
import { canSkipByTimestamp } from "./staleness";
import { IStampObservation, classifyStampChange, foldStampObservations, resolvePollIntervalMs } from "./pollDecisions";
import {
    INCOMING_DIR,
    incomingAbsPath,
    performFilePush,
    performPullFromServer,
    pruneEmptyParents,
    PushFileOutcome,
    removeIncoming,
    renameTracked,
    writeIncoming,
    repairMissingBaselines
} from "./syncOperations";

/** Debounce window for filesystem events triggering a refresh. */
const REFRESH_DEBOUNCE_MS = 300;

/**
 * Concurrency cap for per-file content GETs during fetch. Files can be large
 * and each request does real work on the server, so six is the sweet spot
 * between saturating the pipe and hammering Rock.
 */
const FETCH_CONCURRENCY = 6;

/**
 * Whether the Build action makes sense for a given pulled workspace.
 *
 * The single requirement: the manifest captured a `buildUri` at pull
 * time. Build is conceptually mobile-only today (it triggers the
 * layout/CSS recompile that makes changes visible in the running
 * mobile client), but content types that have no build step don't
 * populate `buildUri` on their root descriptor — AI Skills, for
 * example, leaves it null because there's nothing to compile. Gating
 * on `buildUri` alone is therefore equivalent to the old URI-regex
 * check for current content types and self-extends to future ones.
 *
 * Workspaces pulled before `buildUri` capture landed are also
 * correctly excluded: their manifests omit the field.
 *
 * Used by `MagnusSourceControlManager` to drive the `magnusLocal:canBuild`
 * context key that gates the Build button's visibility in the SCM title
 * bar and command palette.
 */
function canBuildManifest(manifest: Manifest): boolean {
    return manifest.roots.some(r => typeof r.buildUri === "string" && r.buildUri.length > 0);
}

/**
 * Top-level SCM integration for Magnus Local. Watches workspace folders,
 * creates one `MagnusWorkspaceSourceControl` per pulled workspace found, and
 * tears them down when folders are removed.
 */
/**
 * A short human label for whatever a workspace holds.
 *
 * One root reads as itself; several read as a count, because listing four
 * resource names in a status bar is worse than not naming them.
 */
function describeRoots(roots: ManifestRoot[]): string {
    if (roots.length === 1) {
        const only = roots[0];
        return only.platform ? `${only.platform} › ${only.displayName}` : only.displayName;
    }
    return `${roots.length} resources`;
}

/**
 * The Source Control entry for a cloned workspace that has no `.magnus/` yet.
 *
 * A real `SourceControl` with no resource groups, existing purely so the panel
 * says something. The bug this fixes is a silent one: a clone produced no
 * provider at all, so the person who looked in Source Control for their Magnus
 * workspace found an empty panel and no explanation. A provider that shows the
 * server name and a single Restore action costs almost nothing and turns an
 * invisible state into an obvious one.
 *
 * Registered under a distinct provider id so the title menus can tell it apart
 * from a working control in their `when` clauses.
 */
class UnhydratedWorkspaceSourceControl implements vscode.Disposable {
    private sourceControl: vscode.SourceControl;

    public constructor(root: string, magnusJson: MagnusJson, disconnected: boolean) {
        this.sourceControl = vscode.scm.createSourceControl(
            "magnusLocalUnhydrated",
            `Magnus (${magnusJson.server.alias})`,
            vscode.Uri.file(root)
        );

        this.sourceControl.statusBarCommands = [
            disconnected
                ? {
                    command: "magnusLocal.connectWorkspaceServer",
                    title: "$(debug-disconnect) Connect Server",
                    tooltip: `Not connected to ${magnusJson.server.url} on this machine`,
                    arguments: [{ serverUrl: magnusJson.server.url }]
                }
                : {
                    command: "magnusLocal.hydrateWorkspace",
                    title: "$(cloud-download) Restore Sync State",
                    tooltip: "Rebuild this clone's local sync state from the server",
                    arguments: [{ root }]
                }
        ];
    }

    public dispose(): void {
        this.sourceControl.dispose();
    }
}

export class MagnusSourceControlManager implements vscode.Disposable {
    private api: Api;
    private secrets: Secrets;
    private baseline: BaselineContentProvider;
    private controls: Map<string, MagnusWorkspaceSourceControl> = new Map();
    private unhydrated: Map<string, UnhydratedWorkspaceSourceControl> = new Map();
    private disposables: vscode.Disposable[] = [];

    public constructor(api: Api, secrets: Secrets, baseline: BaselineContentProvider) {
        this.api = api;
        this.secrets = secrets;
        this.baseline = baseline;

        this.disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
            vscode.commands.registerCommand("magnusLocal.pushChanges", (arg) => this.onPush(arg)),
            vscode.commands.registerCommand("magnusLocal.discardChange", (arg) => this.onDiscard(arg)),
            vscode.commands.registerCommand("magnusLocal.refreshChanges", (arg) => this.onRefresh(arg)),
            vscode.commands.registerCommand("magnusLocal.fetchFromServer", (arg) => this.onFetch(arg)),
            vscode.commands.registerCommand("magnusLocal.pullFromServer", (arg) => this.onPullFromServer(arg)),
            vscode.commands.registerCommand("magnusLocal.deployApp", (arg) => this.onBuild(arg, "deploy")),
            vscode.commands.registerCommand("magnusLocal.compileTheme", (arg) => this.onBuild(arg, "theme"))
        );

        void this.refresh();
    }

    public dispose(): void {
        for (const c of this.controls.values()) {
            c.dispose();
        }
        this.controls.clear();
        for (const c of this.unhydrated.values()) {
            c.dispose();
        }
        this.unhydrated.clear();
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    /**
     * Rebuild the set of Source Control panels from what is on disk.
     *
     * Public because hydration writes a manifest into a folder that is already
     * open, and nothing else would notice: the only other triggers are the
     * constructor and `onDidChangeWorkspaceFolders`, neither of which fires
     * when a directory appears inside an existing folder.
     */
    public async refresh(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders ?? [];
        console.log(`[Magnus Local SCM] refresh: ${folders.length} workspace folder(s)`);
        const activeRoots = new Set<string>();
        const activeUnhydrated = new Set<string>();
        let anyDisconnected = false;

        for (const folder of folders) {
            const root = folder.uri.fsPath;
            const state = await classifyWorkspace(root);
            console.log(`[Magnus Local SCM] folder=${root} state=${state.kind}`);

            // A refused manifest used to be indistinguishable from no manifest,
            // which is precisely how a version mismatch turned into a Source
            // Control panel that silently never appeared. Say it out loud.
            if (state.kind === "broken") {
                void vscode.window.showErrorMessage(`Magnus Local: ${state.message}`);
                continue;
            }

            if (state.kind === "needs-hydrate") {
                const disconnected = await resolveServerConnection(
                    this.secrets, state.magnusJson.server.url
                ) === "disconnected";
                anyDisconnected ||= disconnected;

                activeUnhydrated.add(root);
                // Recreated rather than mutated, because the single status-bar
                // command differs between the connected and disconnected cases.
                this.unhydrated.get(root)?.dispose();
                this.unhydrated.set(
                    root,
                    new UnhydratedWorkspaceSourceControl(root, state.magnusJson, disconnected)
                );
                continue;
            }

            if (state.kind !== "hydrated") {
                continue;
            }

            if (await resolveServerConnection(this.secrets, state.manifest.server.url) === "disconnected") {
                anyDisconnected = true;
            }

            activeRoots.add(root);
            if (!this.controls.has(root)) {
                console.log(`[Magnus Local SCM] creating SourceControl for ${root}`);
                this.controls.set(
                    root,
                    new MagnusWorkspaceSourceControl(root, state.manifest, this.api, this.baseline)
                );
            }
        }

        for (const [root, control] of this.controls) {
            if (!activeRoots.has(root)) {
                control.dispose();
                this.controls.delete(root);
            }
        }

        for (const [root, control] of this.unhydrated) {
            if (!activeUnhydrated.has(root)) {
                control.dispose();
                this.unhydrated.delete(root);
            }
        }

        await vscode.commands.executeCommand(
            "setContext", "magnusLocal:needsHydrate", this.unhydrated.size > 0
        );
        await vscode.commands.executeCommand(
            "setContext", "magnusLocal:serverDisconnected", anyDisconnected
        );

        // Drive the `magnusLocal:canBuild` context key so the Build button
        // hides itself in non-mobile pulled workspaces (and in cloud-only
        // sessions where there are no controls at all).
        // Gates the Edit Selection command in the palette: it acts on an open
        // pulled workspace, so offering it when there is none is a dead end.
        await vscode.commands.executeCommand(
            "setContext", "magnusLocal:hasWorkspace", this.controls.size > 0
        );

        const anyBuildable = Array.from(this.controls.values()).some(c => c.canBuild());
        await vscode.commands.executeCommand("setContext", "magnusLocal:canBuild", anyBuildable);

        // Deploy and Compile Theme are independent now. A workspace holding a
        // mobile app and a theme shows both buttons, which is the point of the
        // split: one button that meant different things depending on what you
        // happened to have pulled was the thing to get rid of (spec 7.10).
        const anyDeployable = Array.from(this.controls.values()).some(c => c.canDeploy());
        await vscode.commands.executeCommand("setContext", "magnusLocal:canDeploy", anyDeployable);

        const anyCompilable = Array.from(this.controls.values()).some(c => c.canCompileTheme());
        await vscode.commands.executeCommand("setContext", "magnusLocal:canCompileTheme", anyCompilable);

        // Drive `magnusLocal:isThemeWorkspace` so the SCM title button
        // shows "Compile Theme" instead of "Deploy Mobile App" when any
        // open pulled workspace is a theme. This is a coarse single-bit
        // flag (true if any control is a theme); the per-control build()
        // method sets the progress title precisely from its own manifest.
        const anyTheme = Array.from(this.controls.values()).some(c => c.isThemeWorkspace());
        await vscode.commands.executeCommand("setContext", "magnusLocal:isThemeWorkspace", anyTheme);
    }

    private controlFor(arg: unknown): MagnusWorkspaceSourceControl | undefined {
        if (arg && typeof arg === "object" && "rootUri" in arg) {
            const rootUri = (arg as vscode.SourceControl).rootUri;
            if (rootUri) {
                return this.controls.get(rootUri.fsPath);
            }
        }
        if (this.controls.size === 1) {
            return Array.from(this.controls.values())[0];
        }
        return undefined;
    }

    private async onPush(arg: unknown): Promise<void> {
        if (arg instanceof vscode.Uri) {
            const control = this.findControlForUri(arg);
            await control?.pushResource(arg);
            return;
        }
        if (arg && typeof arg === "object" && "resourceUri" in arg) {
            const uri = (arg as vscode.SourceControlResourceState).resourceUri;
            const control = this.findControlForUri(uri);
            await control?.pushResource(uri);
            return;
        }
        const control = this.controlFor(arg);
        await control?.pushAll();
    }

    private async onDiscard(arg: unknown): Promise<void> {
        if (arg instanceof vscode.Uri) {
            const control = this.findControlForUri(arg);
            await control?.discardResource(arg);
            return;
        }
        if (arg && typeof arg === "object" && "resourceUri" in arg) {
            const uri = (arg as vscode.SourceControlResourceState).resourceUri;
            const control = this.findControlForUri(uri);
            await control?.discardResource(uri);
        }
    }

    private async onRefresh(arg: unknown): Promise<void> {
        const control = this.controlFor(arg);
        if (control) {
            await control.refresh();
            return;
        }
        for (const c of this.controls.values()) {
            await c.refresh();
        }
    }

    private async onFetch(arg: unknown): Promise<void> {
        const control = this.controlFor(arg);
        if (control) {
            await control.fetch();
            return;
        }
        for (const c of this.controls.values()) {
            await c.fetch();
        }
    }

    private async onBuild(arg: unknown, kind: "deploy" | "theme"): Promise<void> {
        const control = this.controlFor(arg);
        const run = (c: MagnusWorkspaceSourceControl) =>
            kind === "theme" ? c.compileTheme() : c.deploy();
        if (control) {
            await run(control);
            return;
        }
        for (const c of this.controls.values()) {
            await run(c);
        }
    }

    private async onPullFromServer(arg: unknown): Promise<void> {
        if (arg instanceof vscode.Uri) {
            const control = this.findControlForUri(arg);
            await control?.pullFromServer(arg);
            return;
        }
        if (arg && typeof arg === "object" && "resourceUri" in arg) {
            const uri = (arg as vscode.SourceControlResourceState).resourceUri;
            const control = this.findControlForUri(uri);
            await control?.pullFromServer(uri);
        }
    }

    private findControlForUri(uri: vscode.Uri): MagnusWorkspaceSourceControl | undefined {
        for (const [root, control] of this.controls) {
            if (uri.fsPath.startsWith(root + path.sep)) {
                return control;
            }
        }
        return undefined;
    }
}

/**
 * SCM provider for a single pulled workspace. Exposes a "Changes" group
 * whose resources are files whose on-disk bytes differ from their baseline
 * (the last bytes synced with the server).
 */
class MagnusWorkspaceSourceControl implements vscode.Disposable {
    private root: string;
    private manifest: Manifest;
    private api: Api;
    private baseline: BaselineContentProvider;
    private sourceControl: vscode.SourceControl;
    private changesGroup: vscode.SourceControlResourceGroup;
    private incomingGroup: vscode.SourceControlResourceGroup;
    private fsWatcher: vscode.FileSystemWatcher;
    private refreshTimer: NodeJS.Timeout | undefined;
    private disposables: vscode.Disposable[] = [];
    /**
     * Status bar state. `lastFetchedAt` is in-memory only: in the Git model
     * we reach for, "how long since the last fetch" resets to "never" when
     * you close and re-open the workspace, same as `git status` not
     * remembering your last `git fetch` across shell sessions. The explicit
     * Fetch button is the way to refresh it.
     */
    private statusBarItem: vscode.StatusBarItem;
    private statusBarRefreshTimer: NodeJS.Timeout | undefined;
    private isFetching = false;
    private lastFetchedAt: Date | undefined;
    /**
     * Tracked files surfaced as `unknown` by the last refresh: they exist on
     * disk but have no baseline, so whether they were edited is unknowable.
     * They appear in Changes (spec 8.2) but are held back from Push All, which
     * must not bulk-write content whose state nobody can determine.
     */
    private unverifiedPaths = new Set<string>();
    /**
     * Whether this workspace's resource type is still enabled on the server.
     *
     * Starts as `unknown` and stays that way against any plugin before 2.4.0,
     * because "the server did not tell us" must never present as "the server
     * said no". Refreshed alongside fetch rather than on a timer of its own.
     */
    /**
     * Access verdict per root, keyed by path prefix. Per-root rather than
     * per-workspace because a workspace can hold several resource types and an
     * administrator can disable them independently.
     */
    private rootAccess = new Map<string, RootAccess>();
    private pollTimer: NodeJS.Timeout | undefined;
    /**
     * Last stamp seen for this root, held in memory only.
     *
     * Deliberately not persisted. Reloading the window costs one extra
     * escalation, whereas persisting it would mean a manifest schema change and
     * would let a stale on-disk stamp convince a fresh session that nothing had
     * moved since whenever it was written.
     */
    private lastStamp: IStampObservation | null = null;
    /**
     * Set once the server has said it cannot answer the cheap question for this
     * root, which it signals with a 404. Polling then stops for good rather than
     * degrading into something expensive on a timer.
     */
    private pollUnsupported = false;
    private isPolling = false;

    public constructor(root: string, manifest: Manifest, api: Api, baseline: BaselineContentProvider) {
        this.root = root;
        this.manifest = manifest;
        this.api = api;
        this.baseline = baseline;

        const label = `Magnus Local (${describeRoots(manifest.roots)})`;
        this.sourceControl = vscode.scm.createSourceControl(
            "magnusLocal",
            label,
            vscode.Uri.file(root)
        );
        this.sourceControl.quickDiffProvider = {
            provideOriginalResource: (uri) => this.toBaselineUri(uri)
        };
        this.sourceControl.inputBox.visible = false;

        this.changesGroup = this.sourceControl.createResourceGroup("changes", "Changes");
        this.changesGroup.hideWhenEmpty = true;

        this.incomingGroup = this.sourceControl.createResourceGroup("incoming", "Incoming Changes");
        this.incomingGroup.hideWhenEmpty = true;

        this.fsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(root, "**/*")
        );
        this.disposables.push(
            this.fsWatcher,
            this.sourceControl,
            this.fsWatcher.onDidChange(() => this.scheduleRefresh()),
            this.fsWatcher.onDidCreate(() => this.scheduleRefresh()),
            this.fsWatcher.onDidDelete(() => this.scheduleRefresh())
        );

        // Status bar: one item per workspace source control. For a multi-root
        // workspace with several pulled apps each gets its own indicator, so
        // you can see each one's last-fetch state at a glance. Low priority
        // puts us toward the right edge of the left group (near git status).
        this.statusBarItem = vscode.window.createStatusBarItem(
            `magnusLocal.status.${root}`,
            vscode.StatusBarAlignment.Left,
            -100
        );
        this.statusBarItem.name = `Magnus Local: ${describeRoots(manifest.roots)}`;
        this.statusBarItem.command = {
            command: "magnusLocal.fetchFromServer",
            title: "Fetch from Server",
            // Manager's `controlFor` routes by rootUri, so this shim is all
            // we need to scope the click to this particular workspace.
            arguments: [{ rootUri: vscode.Uri.file(root) }]
        };
        this.disposables.push(this.statusBarItem);
        this.updateStatusBar();
        this.statusBarItem.show();
        // Tick the "N minutes ago" label forward on its own.
        this.statusBarRefreshTimer = setInterval(() => this.updateStatusBar(), 30_000);
        this.startPolling();

        // Pick up an interval change without needing a window reload. Someone
        // turning polling off is usually reacting to it being in their way right
        // now, so making them restart first would miss the point.
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration("magnusLocal.pollIntervalSeconds")) {
                    this.startPolling();
                }
            })
        );

        void this.repairThenRefresh();

        // Deliberately *no* automatic fetch here. Git doesn't `git fetch`
        // when you `cd` into a repo, so neither do we. Staleness is the
        // default state until the user explicitly clicks Fetch; the status
        // bar's "last fetched Xh ago" tells them when they last synced.
    }

    public dispose(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
        if (this.statusBarRefreshTimer) {
            clearInterval(this.statusBarRefreshTimer);
        }
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    private updateStatusBar(): void {
        if (this.isFetching) {
            // Deliberately static text during fetch: any reassignment
            // restarts the $(sync~spin) CSS animation, and updating per
            // folder/file (we tick up to ~12/sec on a fast scan) made the
            // spinner stutter visibly. The toast / SCM spinner already
            // carries the running count; the status bar just signals
            // "something is happening."
            this.statusBarItem.text = "$(sync~spin) Magnus";
            this.statusBarItem.tooltip = `Fetching from ${this.manifest.server.url}…`;
            return;
        }

        this.statusBarItem.text = this.lastFetchedAt
            ? `$(cloud) Magnus: ${formatRelativeTime(this.lastFetchedAt)}`
            : "$(cloud) Magnus";

        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**Magnus Local** — ${describeRoots(this.manifest.roots)}\n\n`);
        tooltip.appendMarkdown(`Server: \`${this.manifest.server.url}\`\n\n`);
        tooltip.appendMarkdown(
            this.lastFetchedAt
                ? `Last fetch: ${this.lastFetchedAt.toLocaleString()}\n\n`
                : "Last fetch: not yet this session\n\n"
        );
        tooltip.appendMarkdown("_Click to fetch now._");
        this.statusBarItem.tooltip = tooltip;
    }

    /**
     * Recovery UX for an unrecoverable auth failure. Offers a single
     * "Re-authenticate…" action that routes to the reauthenticate command
     * for this server.
     */
    private handleAuthenticationFailure(err: AuthenticationError): void {
        console.warn(`[Magnus Local SCM] authentication failed for ${err.serverUrl}: ${err.message}`);

        const reauthLabel = "Re-authenticate…";
        void vscode.window.showErrorMessage(
            `Magnus Local fetch failed: ${err.message}`,
            reauthLabel
        ).then(choice => {
            if (choice === reauthLabel) {
                // Pass a shim that matches the ITreeNode shape the command
                // expects so it can skip the "pick a server" QuickPick.
                void vscode.commands.executeCommand("magnusLocal.reauthenticateServer", {
                    serverUrl: err.serverUrl
                });
            }
        });
    }

    /**
     * Handle a non-auth network failure (DNS, refused, timeout, reset).
     * Surfaces a friendlier message than axios's raw `getaddrinfo ENOTFOUND …`
     * prose and offers a "Retry" action that re-runs the fetch immediately.
     */
    private handleNetworkFailure(err: unknown): void {
        const raw = err instanceof Error ? err.message : String(err);
        console.warn(`[Magnus Local SCM] fetch walk failed:`, err);

        // An HTTP failure that kept its status says something specific; a
        // transport failure does not. Previously both arrived here as the same
        // bare Error, so a revoked permission and a flaky network produced
        // identical advice (defect 8.7).
        const http = err instanceof MagnusHttpError
            ? describeHttpFailure(err.status, this.manifest.server.url)
            : null;

        const friendly = http?.message ?? friendlyNetworkMessage(raw, this.manifest.server.url);
        const retryable = http === null || http.retryable;
        const retryLabel = "Retry";

        // No Retry on a 403 or a 404: the first invites clicking repeatedly at a
        // decision an administrator made, and the second at content that is gone.
        const actions = retryable ? [retryLabel] : [];

        void vscode.window.showErrorMessage(
            `Magnus Local fetch failed: ${friendly}`,
            ...actions
        ).then(choice => {
            if (choice === retryLabel) {
                void this.fetch();
            }
        });
    }

    private scheduleRefresh(): void {
        // Suppress while a fetch is in flight. Fetch's renames trigger file
        // watcher events that would otherwise schedule a debounced refresh
        // which races with fetch's in-memory manifest mutations: refresh
        // re-reads the on-disk manifest (still pre-fetch state), wiping the
        // pre-pass rename migrations. End-of-fetch `await this.refresh()`
        // handles the SCM update once `writeManifest` has persisted.
        if (this.isFetching) {
            return;
        }
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.refresh();
        }, REFRESH_DEBOUNCE_MS);
    }

    public async refresh(): Promise<void> {
        // Defense-in-depth: even if a refresh slips through `scheduleRefresh`
        // during a fetch (e.g. from a different callsite), do not reload the
        // manifest from disk and clobber fetch's in-memory state. Fetch
        // serves its own end-of-run refresh after `writeManifest`.
        if (!this.isFetching) {
            const latest = await safeReadManifest(this.root);
            if (latest) {
                this.manifest = latest;
            }
        }

        const states: vscode.SourceControlResourceState[] = [];
        this.unverifiedPaths.clear();
        for (const relPath in this.manifest.items) {
            const entry = this.manifest.items[relPath];
            if (entry.isFolder) {
                continue;
            }
            const absPath = path.join(this.root, relPath);
            let localBytes: Uint8Array | null = null;
            try {
                localBytes = await fs.readFile(absPath);
            }
            catch {
                localBytes = null;
            }

            if (localBytes === null) {
                states.push(this.buildResourceState(relPath, "deleted"));
                continue;
            }

            let baselineBytes = await readBaseline(this.root, relPath);

            // Workspaces pulled before baselines were introduced have no
            // `.magnus/baseline/` directory. Backfill on the fly.
            if (baselineBytes === null) {
                baselineBytes = await this.backfillBaseline(relPath, entry, localBytes);
            }

            // A failed backfill used to `continue` here, which dropped the file
            // from the panel altogether: a tracked file with content nobody
            // could verify, invisible in the only UI that would have said so
            // (spec 8.2). It is now surfaced as unverified.
            const state = classifyLocalState({ localBytes, baselineBytes });
            if (state === "unknown") {
                this.unverifiedPaths.add(relPath);
            }
            if (state === "modified" || state === "unknown") {
                states.push(this.buildResourceState(relPath, state));
            }
        }

        this.changesGroup.resourceStates = states;

        // Surface incoming entries tracked in the sidecar: conflicts on
        // existing manifest entries, new server-side files, and server-side
        // deletions that still have uncommitted local edits to consider.
        const sidecar = await readIncomingSidecar(this.root);
        const incomingStates: vscode.SourceControlResourceState[] = [];

        // Whether a file also changed locally is derived here rather than stored
        // in the sidecar, so it stays accurate even against a sidecar written by
        // an earlier fetch: the user may have edited the file since.
        const locallyModified = new Set(
            states
                .filter(st => st.decorations?.tooltip === "Modified")
                .map(st => path.relative(this.root, st.resourceUri.fsPath).split(path.sep).join("/"))
        );

        for (const [relPath, entry] of Object.entries(sidecar.items)) {
            incomingStates.push(
                this.buildIncomingResourceState(relPath, entry, locallyModified.has(relPath))
            );
        }
        this.incomingGroup.resourceStates = incomingStates;
        this.sourceControl.count = states.length + incomingStates.length;
    }

    /**
     * Produce a baseline for `relPath` on workspaces that predate baselines.
     * Uses the local file if its hash matches the manifest (= in sync), else
     * fetches the current server bytes as a best-effort reconstruction.
     * Returns null if we can't establish a baseline (e.g. server unreachable).
     */
    private async backfillBaseline(
        relPath: string,
        entry: Manifest["items"][string],
        localBytes: Uint8Array
    ): Promise<Uint8Array | null> {
        const localHash = hashBytes(localBytes);
        if (entry.hash && localHash === entry.hash) {
            await writeBaseline(this.root, relPath, localBytes);
            console.log(`[Magnus Local SCM] backfilled baseline (in-sync) for ${relPath}`);
            return localBytes;
        }

        try {
            const fullUrl = toFullUrl(this.manifest.server.url, entry.uri);
            const serverBytes = await this.api.getFileContent(fullUrl);
            await writeBaseline(this.root, relPath, serverBytes);
            console.log(`[Magnus Local SCM] backfilled baseline (from server) for ${relPath}`);
            return serverBytes;
        }
        catch (err) {
            console.warn(`[Magnus Local SCM] failed to backfill baseline for ${relPath}`, err);
            return null;
        }
    }

    /**
     * Render one incoming entry.
     *
     * Poll broadly, warn narrowly (spec 7.9). Only a genuine two-sided conflict
     * gets prominence: the server moved *and* the local copy moved, which needs
     * judgement and can lose work. A server change over a clean local file is a
     * fast-forward with nothing at risk, so it sits quietly in Incoming waiting
     * to be accepted. Shouting about both would train people to dismiss the
     * shouting.
     */
    private buildIncomingResourceState(
        relPath: string,
        entry: { isNew: boolean; isDeleted?: boolean },
        locallyModified: boolean
    ): vscode.SourceControlResourceState {
        const absUri = vscode.Uri.file(path.join(this.root, relPath));
        const baselineUri = encodeBaselineUri(this.root, relPath);
        const incomingUri = vscode.Uri.file(incomingAbsPath(this.root, relPath));

        if (entry.isDeleted) {
            // Server removed the file while local still has uncommitted edits.
            // Show a diff of what was last synced vs what the user has now so
            // they can decide whether to keep working locally or accept the
            // deletion via Pull Server Version.
            return {
                resourceUri: absUri,
                contextValue: "magnusLocalIncoming",
                decorations: {
                    tooltip: "Deleted on server (local has uncommitted changes)",
                    strikeThrough: true,
                    faded: true
                },
                command: {
                    command: "vscode.diff",
                    arguments: [baselineUri, absUri, `${relPath} (Server Deleted ↔ Local)`],
                    title: "Compare Last-Synced vs Local"
                }
            };
        }

        const isConflict = !entry.isNew && locallyModified;

        const title = entry.isNew
            ? `${relPath} (New on Server)`
            : isConflict
                ? `${relPath} (Yours ↔ Server)`
                : `${relPath} (Baseline ↔ Server)`;

        const tooltip = entry.isNew
            ? "New file on server"
            : isConflict
                ? "Conflict: you and the server both changed this"
                : "Server has a newer version. Accept it with Pull Server Version.";

        return {
            resourceUri: absUri,
            contextValue: "magnusLocalIncoming",
            decorations: {
                tooltip,
                // Faded means "nothing at risk here". A conflict is the one case
                // that is not, so it is the one case that stays at full weight.
                faded: !entry.isNew && !isConflict
            },
            command: {
                command: "vscode.diff",
                // A conflict diffs the user's working file against the server's
                // version, because that is the decision in front of them. A
                // clean incoming change diffs baseline against server, which
                // shows what would arrive.
                arguments: isConflict
                    ? [absUri, incomingUri, title]
                    : [baselineUri, incomingUri, title],
                title: "Compare with Server"
            }
        };
    }

    private buildResourceState(
        relPath: string,
        kind: "modified" | "deleted" | "unknown"
    ): vscode.SourceControlResourceState {
        const absUri = vscode.Uri.file(path.join(this.root, relPath));
        const baselineUri = encodeBaselineUri(this.root, relPath);
        const label = kind === "deleted"
            ? "Deleted"
            : kind === "unknown"
                ? "Unverified — no last-synced copy to compare against"
                : "Modified";

        // No diff for either of the other two kinds: `deleted` has no working
        // file on the right-hand side, and `unknown` is defined by having no
        // baseline on the left. Offering one would open an empty editor.
        const canDiff = kind === "modified";

        return {
            resourceUri: absUri,
            decorations: {
                strikeThrough: kind === "deleted",
                faded: kind === "unknown",
                tooltip: label
            },
            command: canDiff
                ? {
                    command: "vscode.diff",
                    arguments: [baselineUri, absUri, `${relPath} (Magnus Local)`],
                    title: "Open Diff"
                }
                : undefined
        };
    }

    private toBaselineUri(uri: vscode.Uri): vscode.Uri | undefined {
        if (uri.scheme !== "file") {
            return undefined;
        }
        if (!uri.fsPath.startsWith(this.root + path.sep)) {
            return undefined;
        }
        const relPath = path.relative(this.root, uri.fsPath).split(path.sep).join("/");
        const entry = this.manifest.items[relPath];
        if (!entry || entry.isFolder) {
            return undefined;
        }
        return encodeBaselineUri(this.root, relPath);
    }

    public async pushAll(): Promise<void> {

        // Unverified files (spec 8.2) are visible in Changes but excluded here.
        // With no baseline there is no way to tell whether they were edited at
        // all, so each one would raise its own overwrite modal and Push All
        // would degrade into a prompt cascade. Pushing one is still available
        // individually, where a single prompt is the whole interaction.
        const allStates = this.changesGroup.resourceStates;
        let blockedByRoot = 0;
        const states = allStates.filter(st => {
            const rel = path.relative(this.root, st.resourceUri.fsPath).split(path.sep).join("/");
            if (this.unverifiedPaths.has(rel)) {
                return false;
            }
            // A disabled resource type blocks its own root, not the workspace.
            // Refusing everything because one root was turned off would be a
            // bigger refusal than the administrator actually made.
            if (this.pushBlockedReasonForPath(rel) !== null) {
                blockedByRoot++;
                return false;
            }
            return true;
        });
        const heldBack = allStates.length - states.length - blockedByRoot;

        if (states.length === 0) {
            void vscode.window.showInformationMessage(
                heldBack > 0
                    ? `Magnus Local: nothing to push. ${heldBack} file${heldBack === 1 ? " has" : "s have"} no last-synced copy to compare against — push ${heldBack === 1 ? "it" : "them"} individually to review.`
                    : "Magnus Local: nothing to push."
            );
            return;
        }
        const notes: string[] = [];
        if (heldBack > 0) {
            notes.push(`${heldBack} unverified file${heldBack === 1 ? "" : "s"} will be skipped.`);
        }
        if (blockedByRoot > 0) {
            notes.push(
                `${blockedByRoot} file${blockedByRoot === 1 ? "" : "s"} belong to a resource type that is `
                + "disabled on the server and will be skipped."
            );
        }
        const heldBackNote = notes.length > 0 ? `\n\n${notes.join("\n")}` : "";
        const confirm = await vscode.window.showWarningMessage(
            `Push ${states.length} change${states.length === 1 ? "" : "s"} to ${this.manifest.server.url}?${heldBackNote}`,
            { modal: true },
            "Push"
        );
        if (confirm !== "Push") {
            return;
        }

        let pushed = 0;
        for (const state of states) {
            try {
                const outcome = await this.pushResourceInternal(state.resourceUri, { skipConfirm: true });
                if (outcome.kind === "applied") {
                    pushed++;
                }
                // `cancelled` and `viewing-server` are user choices, not failures —
                // skip silently and continue with the next file.
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                void vscode.window.showErrorMessage(`Push failed for ${path.basename(state.resourceUri.fsPath)}: ${message}`);
            }
        }

        if (pushed > 0) {
            void vscode.window.showInformationMessage(`Magnus Local: pushed ${pushed} file${pushed === 1 ? "" : "s"}.`);
        }
        await this.refresh();
    }

    public async pushResource(uri: vscode.Uri): Promise<void> {
        const relForGate = path.relative(this.root, uri.fsPath).split(path.sep).join("/");
        const blocked = this.pushBlockedReasonForPath(relForGate);
        if (blocked) {
            void vscode.window.showWarningMessage(`Magnus Local: ${blocked}`);
            return;
        }

        try {
            await this.pushResourceInternal(uri, { skipConfirm: false });
        }
        catch (err) {
            // Only real failures reach here — user-cancel and view-server return
            // an outcome rather than throwing.
            const message = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`Magnus Local push failed: ${message}`);
        }
        await this.refresh();
    }

    private async pushResourceInternal(uri: vscode.Uri, opts: { skipConfirm: boolean }): Promise<PushFileOutcome> {
        const relPath = path.relative(this.root, uri.fsPath).split(path.sep).join("/");

        const outcome = await performFilePush({
            root: this.root,
            manifest: this.manifest,
            relPath,
            api: this.api,
            onConflictPrompt: async () => {
                const choice = await vscode.window.showWarningMessage(
                    `${relPath} was changed on the server after your last sync. Pushing will replace the server's version with yours, overwriting whoever else's changes were there. This cannot be undone.`,
                    { modal: true },
                    "View Server Version",
                    "Overwrite Server"
                );
                if (choice === "View Server Version") { return "view-server"; }
                if (choice === "Overwrite Server") { return "force-overwrite"; }
                return "cancel";
            },
            onShowServerVersion: async (serverBytes) => {
                const doc = await vscode.workspace.openTextDocument({
                    content: Buffer.from(serverBytes).toString("utf8")
                });
                await vscode.window.showTextDocument(doc, { preview: true });
            }
        });

        if (outcome.kind === "applied") {
            this.baseline.notifyChanged(encodeBaselineUri(this.root, relPath));
            if (!opts.skipConfirm) {
                void vscode.window.showInformationMessage(`Magnus Local: pushed ${relPath}.`);
            }
        }

        return outcome;
    }

    public async discardResource(uri: vscode.Uri): Promise<void> {
        const relPath = path.relative(this.root, uri.fsPath).split(path.sep).join("/");
        const baselineBytes = await readBaseline(this.root, relPath);
        if (baselineBytes === null) {
            void vscode.window.showErrorMessage(`No baseline found for ${relPath}.`);
            return;
        }

        const openDoc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
        if (openDoc?.isDirty) {
            const confirm = await vscode.window.showWarningMessage(
                `${relPath} has unsaved changes. Reverting will replace the file with the last version pulled from the server. Your unsaved edits and any saved local changes will be lost.`,
                { modal: true },
                "Revert and Discard Changes"
            );
            if (confirm !== "Revert and Discard Changes") {
                return;
            }
        }
        else {
            const confirm = await vscode.window.showWarningMessage(
                `Revert ${relPath} to the last version pulled from the server? Your local changes will be lost.`,
                { modal: true },
                "Revert"
            );
            if (confirm !== "Revert") {
                return;
            }
        }

        await fs.writeFile(uri.fsPath, baselineBytes);
        await this.refresh();
    }

    /**
     * Walk the server tree under this workspace's root, compare each file's
     * current server bytes against our baseline, and classify:
     *   - unchanged: server bytes match baseline → nothing to do.
     *   - fast-forward: server bytes differ from baseline, local equals
     *     baseline → overwrite local + baseline silently.
     *   - conflict: server and local both diverged from baseline → stage
     *     server bytes under `.magnus/incoming/<relPath>` and show in the
     *     Incoming Changes group.
     *   - new: server has a file not present in our manifest → same incoming
     *     staging, but flagged with `isNew: true` so `pullFromServer` knows
     *     to materialize it as a new tracked file instead of overwriting.
     */

    /**
     * Trigger a server-side build of the pulled app. Mirrors the
     * cloud-mode `magnus.buildUrl` action (right-click → Build) so users
     * working in a pulled workspace don't have to flip back to the tree
     * just to recompile layouts/CSS after a push.
     *
     * Build URL is captured into the manifest at pull time. Workspaces
     * pulled before that capture landed get a "re-pull to enable"
     * message — backfilling the URL would require an extra round-trip
     * through the parent group's tree listing, which isn't worth the
     * complexity for a one-time migration cost.
     */
    /**
     * Public test for "is the Build button meaningful here?" — used by the
     * manager to drive the `magnusLocal:canBuild` context key. The same
     * test is repeated inside `build()` so a stale context key (e.g. fired
     * before a refetch caught up to a re-pull) can't push a meaningless
     * request through.
     */
    public canBuild(): boolean {
        return canBuildManifest(this.manifest);
    }

    /**
     * Whether this workspace is a pulled theme. Drives content-type-aware
     * progress titles and menu labels (Compile vs. Deploy). The platform
     * string is captured from the parent group's display name at pull
     * time, so this stays accurate across re-pulls and is independent of
     * URI shape.
     */
    public isThemeWorkspace(): boolean {
        return this.manifest.roots.some(r => r.platform === "Themes");
    }

    /**
     * Roots that can run a build of the given kind.
     *
     * Deploy and Compile Theme are separate actions that never merge (spec
     * 7.10). `ThemeFilesystem.RunBuild` and `ServerFilesystem.RunBuild` both
     * exist, so without the split a single "Build" button would mean two quite
     * different things depending on what you happened to have pulled.
     */
    private buildableRoots(kind: "deploy" | "theme"): ManifestRoot[] {
        return this.manifest.roots.filter(r => {
            if (typeof r.buildUri !== "string" || r.buildUri.length === 0) {
                return false;
            }
            return kind === "theme"
                ? r.platform === "Themes"
                : r.platform !== "Themes";
        });
    }

    /**
     * Pick the one root to act on, asking only when the answer is ambiguous.
     *
     * Both actions operate on exactly one target, always (spec 7.10). A
     * workspace can now hold several apps, so "the root" is no longer a
     * question with an automatic answer.
     */
    private async chooseBuildTarget(
        kind: "deploy" | "theme"
    ): Promise<ManifestRoot | null> {
        const candidates = this.buildableRoots(kind);
        const noun = kind === "theme" ? "theme" : "app";

        if (candidates.length === 0) {
            void vscode.window.showErrorMessage(
                `Magnus Local: no ${noun} in this workspace can be `
                + `${kind === "theme" ? "compiled" : "deployed"}. `
                + `If you pulled one before this action existed, pull it again to pick up the build URI.`
            );
            return null;
        }

        if (candidates.length === 1) {
            return candidates[0];
        }

        const picked = await vscode.window.showQuickPick(
            candidates.map(r => ({
                label: r.displayName,
                description: r.platform,
                root: r
            })),
            {
                title: kind === "theme" ? "Compile which theme?" : "Deploy which app?",
                placeHolder: `This workspace has ${candidates.length} ${noun}s. Choose one.`
            }
        );

        return picked ? picked.root : null;
    }

    public canDeploy(): boolean {
        return this.buildableRoots("deploy").length > 0;
    }

    public canCompileTheme(): boolean {
        return this.buildableRoots("theme").length > 0;
    }

    public async deploy(): Promise<void> {
        await this.runBuild("deploy");
    }

    public async compileTheme(): Promise<void> {
        await this.runBuild("theme");
    }

    private async runBuild(kind: "deploy" | "theme"): Promise<void> {
        const target = await this.chooseBuildTarget(kind);
        if (target === null) {
            return;
        }

        const blocked = this.pushBlockedReason(target);
        if (blocked) {
            void vscode.window.showWarningMessage(`Magnus Local: ${blocked}`);
            return;
        }

        const fullUrl = toFullUrl(this.manifest.server.url, target.buildUri!);

        // Themes call this "Compile" rather than "Deploy": the action is a
        // synchronous LESS recompile of the theme's Styles/ folder, not a
        // mobile-app push.
        const isTheme = kind === "theme";
        const progressTitle = isTheme
            ? `Compiling ${target.displayName}…`
            : `Deploying ${target.displayName}…`;
        const failureFallback = isTheme
            ? "Compile reported failure."
            : "Deploy reported failure.";

        await vscode.window.withProgress(
            {
                cancellable: false,
                location: vscode.ProgressLocation.Notification,
                title: progressTitle
            },
            async (progress) => {
                try {
                    const response = await this.api.buildUrl(fullUrl);
                    progress.report({
                        message: response.responseMessage || "Complete"
                    });
                    if (!response.actionSuccessful) {
                        void vscode.window.showErrorMessage(
                            response.responseMessage || failureFallback
                        );
                    }
                    // Brief pause so the "Complete" message stays visible
                    // long enough to read; mirrors the cloud-mode handler.
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
                catch (err) {
                    if (err instanceof AuthenticationError) {
                        this.handleAuthenticationFailure(err);
                        return;
                    }
                    this.handleNetworkFailure(err);
                }
            }
        );
    }

    /**
     * @param allowEmptyScanDeletions Set only by the confirmation path in
     * `fetchInner`, when the user has agreed that an empty scan really means
     * the server side is empty. The scan re-runs first, so honouring it still
     * requires a second independent empty result.
     */
    public async fetch(
        allowEmptyScanDeletions = false,
        opts: { quiet?: boolean } = {}
    ): Promise<void> {
        // Coalesce overlapping fetches. A user mashing the status-bar item
        // would otherwise kick off parallel tree walks — on a big app that's
        // 6-way concurrency × N fetches all hitting the same Rock server and
        // can itself be what trips the timeouts we're trying to report.
        if (this.isFetching) {
            if (!opts.quiet) {
                void vscode.window.showInformationMessage(
                    `Magnus Local: fetch already in progress for ${describeRoots(this.manifest.roots)}.`
                );
            }
            return;
        }
        this.isFetching = true;
        this.updateStatusBar();
        try {
            await this.fetchInner(allowEmptyScanDeletions, opts.quiet === true);
        }
        finally {
            this.isFetching = false;
            this.updateStatusBar();
        }
    }

    /**
     * Starts (or restarts) the tier-1 poll for this workspace.
     *
     * Note the deliberate asymmetry with the constructor's "no automatic fetch"
     * rule just above. Not fetching on open is about not surprising the user with
     * file changes they did not ask for. Polling is the opposite: it only ever
     * *tells* them something moved, and staying silent for hours while a
     * colleague edits the same content is the failure mode it exists to prevent.
     */
    /**
     * One-time bookkeeping repair, then the first refresh (spec 7.7, item 18).
     *
     * Files with neither a baseline nor a recorded hash cannot be compared
     * against anything, so the panel cannot say whether they changed and push
     * cannot say whether the server moved. That is Magnus's problem to fix, not
     * a question to ask, so it is fixed on open.
     *
     * Note this is not the "no automatic fetch on open" rule being broken.
     * Nothing here touches a working file: repair writes only inside `.magnus/`.
     * The user's tree is exactly as they left it; only Magnus's own notes get
     * rebuilt.
     */
    private async repairThenRefresh(): Promise<void> {
        try {
            // Two steps because the plan is pure and the check is not. The
            // planner narrows to entries with no recorded hash, which is cheap
            // and testable; only those few are then touched on disk.
            const withoutHash = planBaselineRepair({
                manifest: this.manifest,
                hasBaseline: () => false
            });

            const candidates: string[] = [];
            for (const relPath of withoutHash) {
                if ((await readBaseline(this.root, relPath)) === null) {
                    candidates.push(relPath);
                }
            }

            if (candidates.length > 0) {
                const result = await repairMissingBaselines(
                    this.root,
                    this.manifest,
                    this.api,
                    candidates
                );

                if (result.repaired > 0) {
                    await writeManifest(this.root, this.manifest);
                    console.log(
                        `[Magnus Local SCM] repaired ${result.repaired} baseline(s) for ${this.root}`
                    );
                }

                // Deliberately quiet. A user opening a workspace did not ask
                // about this and cannot act on it; the failures show up as
                // unverified files in the panel, which is the visible half.
                if (result.failed > 0) {
                    console.warn(
                        `[Magnus Local SCM] ${result.failed} baseline(s) could not be repaired for ${this.root}`
                    );
                }
            }
        }
        catch (err) {
            console.warn(`[Magnus Local SCM] baseline repair failed for ${this.root}`, err);
        }

        await this.refresh();
    }

    private startPolling(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }

        const configured = vscode.workspace
            .getConfiguration("magnusLocal")
            .get<number>("pollIntervalSeconds", 60);

        const intervalMs = resolvePollIntervalMs(configured);

        if (intervalMs === null) {
            console.log(`[Magnus Local SCM] polling disabled for ${this.root}`);
            return;
        }

        this.pollTimer = setInterval(() => void this.pollOnce(), intervalMs);
    }

    /**
     * One tier-1 tick: ask whether anything under this root moved, and escalate
     * only if it did.
     *
     * Never throws and never nags. A tick that fails is silent, because the
     * alternative is an error toast every minute for the duration of an outage.
     */
    /**
     * Ask every root for its stamp and fold the answers into one.
     *
     * Null means no root could answer, which stops polling for the workspace.
     * A root that declines drops out of the fold rather than counting as quiet,
     * so a workspace mixing a pollable app with an unpollable theme still polls
     * on the app.
     */
    private async pollRoots(): Promise<IStampObservation | null> {
        const observations = await Promise.all(
            this.manifest.roots.map(root =>
                this.api.getTreeStamp(this.manifest.server.url, root.uri ?? ""))
        );

        return foldStampObservations(observations);
    }

    private async pollOnce(): Promise<void> {
        if (this.pollUnsupported || this.isPolling || this.isFetching) {
            return;
        }

        this.isPolling = true;
        try {
            // One stamp per root. A workspace holding a mobile app and two
            // themes asks three times, which is still three indexed aggregates
            // and no enumeration.
            const observation = await this.pollRoots();

            if (observation === null) {
                // The handler has no cheap answer. Stop asking rather than
                // falling back to an expensive check on a timer.
                this.pollUnsupported = true;
                if (this.pollTimer) {
                    clearInterval(this.pollTimer);
                    this.pollTimer = undefined;
                }
                console.log(`[Magnus Local SCM] server cannot report changes cheaply for ${this.root}; polling stopped`);
                return;
            }

            const verdict = classifyStampChange(this.lastStamp, observation);
            this.lastStamp = observation;

            if (verdict !== "changed") {
                // `first-observation` is deliberately not an escalation. There is
                // no prior state to compare against on the first tick, and
                // treating that as a change would mean every window reload
                // triggered a full sweep whether or not anything had happened.
                return;
            }

            console.log(`[Magnus Local SCM] server moved under ${this.root}; escalating`);

            // Escalate by running the normal Fetch, quietly. Fetch is already the
            // operation that reconciles: it stages server changes into Incoming
            // rather than applying them, flags the both-sides-moved case, and
            // never writes over a dirty file. Reimplementing any of that here
            // would be a second reconciliation path to keep in step with the
            // first.
            await this.fetch(false, { quiet: true });
        }
        catch (err) {
            // Includes auth expiry and network failures. The user finds out when
            // they next do something deliberate; a poll is not the place to
            // interrupt them.
            console.warn(`[Magnus Local SCM] poll failed for ${this.root}`, err);
        }
        finally {
            this.isPolling = false;
        }
    }

    /**
     * Re-reads what the server says it can do, and records whether this
     * workspace may still push.
     *
     * Never throws and never blocks: capability discovery is an enhancement, so
     * a server that cannot answer leaves the previous verdict in place rather
     * than degrading it. Per 7.11 this only ever withdraws the ability to push.
     * Files are left completely alone: they belong to whoever pulled them,
     * remain fully editable, and keep their permissions.
     */
    private async refreshRootAccess(): Promise<void> {
        const serverInfo = await this.api.getServerInfo(this.manifest.server.url);

        if (serverInfo === null) {
            return;
        }

        const enabled = serverInfo.enabledVirtualFilesystems ?? null;

        // Per root, because a workspace can hold several resource types and an
        // administrator can disable them independently.
        for (const root of this.manifest.roots) {
            const previous = this.rootAccess.get(root.pathPrefix);

            const verdict = classifyRootAccess({
                filesystemIdentifier: extractFilesystemIdentifier(root.uri),
                enabledFilesystems: enabled
            });

            this.rootAccess.set(root.pathPrefix, verdict);

            if (previous !== "push-blocked-disabled" && verdict === "push-blocked-disabled") {
                void vscode.window.showWarningMessage(
                    `Magnus Local: ${root.platform ?? "this resource type"} is no longer enabled on `
                    + `${this.manifest.server.url}, so ${root.displayName} can no longer be pushed. `
                    + "Your local files are untouched and still editable."
                );
            }
        }
    }

    /**
     * Returns a reason to refuse a push for one root, or null to proceed.
     */
    private pushBlockedReason(root: ManifestRoot | null): string | null {
        if (root === null) {
            return null;
        }

        if (this.rootAccess.get(root.pathPrefix) !== "push-blocked-disabled") {
            return null;
        }

        return `${root.platform ?? "This resource type"} is not enabled on `
            + `${this.manifest.server.url}, so Magnus cannot push ${root.displayName}. `
            + "Your local files are unaffected.";
    }

    /** Returns a reason to refuse a push for a workspace-relative path. */
    private pushBlockedReasonForPath(relPath: string): string | null {
        return this.pushBlockedReason(rootForPath(this.manifest, relPath));
    }

    /**
     * Enumerate one root on the server, returning paths relative to that root.
     *
     * Tries the flat tree first: one round trip for the whole subtree. A null
     * result means the handler has not opted in, and the recursive walk covers
     * it transparently.
     */
    private async scanRoot(
        manifestRoot: ManifestRoot,
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        detail: "tree" | "hash"
    ): Promise<{
        files: Array<{ naiveRelPath: string; descriptor: IItemDescriptor }>;
        complete: boolean;
        incompleteReason: string | null;
    }> {
        progress.report({ message: `${manifestRoot.displayName}: fetching file list…` });

        // Which question to ask depends on who is asking.
        //
        // A background poll wants to be cheap, and `detail=tree` costs the
        // server one enumeration with no content reads at all. Its per-item
        // timestamps are enough to decide what to look at.
        //
        // A person clicking Fetch wants certainty, so they get `detail=hash`:
        // the server reads every item's content to hash it, which is expensive
        // but answers "did this really change" without trusting a timestamp
        // anyone could have failed to bump.
        const flatResult = await this.api.getFlatTree(
            this.manifest.server.url,
            manifestRoot.uri ?? "",
            detail
        );

        if (flatResult !== null && flatResult.items.length > 0) {
            return {
                files: this.flatItemsToServerFiles(flatResult.items),
                complete: flatResult.complete,
                incompleteReason: flatResult.incompleteReason ?? null
            };
        }

        // Recursive-walk fallback. Drop folders before feeding the worker pool:
        // the rest of fetchInner only handles leaves, and a folder URI must not
        // mistake itself for a content GET.
        const rootDescriptor: IItemDescriptor = {
            uri: manifestRoot.uri,
            displayName: manifestRoot.displayName,
            isFolder: true
        };

        const allItems = await enumerateServerTree(
            this.api,
            this.manifest.server.url,
            rootDescriptor,
            {
                onFolderWalked: (n) => {
                    progress.report({ message: `${manifestRoot.displayName}: ${n} folders` });
                }
            }
        );

        // The recursive walk is trustworthy for exactly the reason the flat tree
        // needed a flag: it has no per-item error handling anywhere, so any
        // failure propagates as an exception rather than as a shorter list. If it
        // returned, it is complete.
        return {
            files: allItems
                .filter(it => !it.descriptor.isFolder)
                .map(it => ({ naiveRelPath: it.naiveRelPath, descriptor: it.descriptor })),
            complete: true,
            incompleteReason: null
        };
    }

    private async fetchInner(allowEmptyScanDeletions: boolean, quiet: boolean): Promise<void> {
        // Ask before scanning, so a workspace whose type was disabled learns it
        // from a message rather than from a push that fails.
        await this.refreshRootAccess();

        // Always use the Notification progress toast. Fetch is user-initiated
        // now (no silent periodic timer), and the scan can take minutes on
        // a big app — a hidden spinner would be indistinguishable from
        // nothing happening.
        // A poll-driven fetch reports into the status bar instead of throwing a
        // toast up every time a colleague saves a file.
        const progressLocation = quiet
            ? vscode.ProgressLocation.Window
            : vscode.ProgressLocation.Notification;

        // Poll-driven fetches take the cheap path; user-initiated ones do not.
        const scanDetail: "tree" | "hash" = quiet ? "tree" : "hash";

        let scan: {
            files: Array<{ naiveRelPath: string; descriptor: IItemDescriptor }>;
            complete: boolean;
            incompleteReason: string | null;
            /**
             * Path prefixes of the roots whose scan came back complete. Only
             * these may have deletions computed for them: if one root's scan was
             * partial, its missing items are unexplained, but that says nothing
             * about a sibling root that scanned cleanly.
             */
            completePrefixes: Set<string>;
        };
        try {
            scan = await vscode.window.withProgress(
                {
                    location: progressLocation,
                    title: `Scanning ${this.manifest.server.url}…`,
                    cancellable: false
                },
                async (progress) => {
                    const files: Array<{ naiveRelPath: string; descriptor: IItemDescriptor }> = [];
                    const completePrefixes = new Set<string>();
                    let complete = true;
                    let incompleteReason: string | null = null;

                    for (const manifestRoot of this.manifest.roots) {
                        const rootScan = await this.scanRoot(manifestRoot, progress, scanDetail);

                        // Each root's walk yields paths relative to that root, so
                        // re-anchor them onto the root's prefix before they meet
                        // the manifest, which is keyed workspace-relative.
                        for (const file of rootScan.files) {
                            files.push({
                                naiveRelPath: `${manifestRoot.pathPrefix}${file.naiveRelPath}`,
                                descriptor: file.descriptor
                            });
                        }

                        if (rootScan.complete) {
                            completePrefixes.add(manifestRoot.pathPrefix);
                        }
                        else {
                            complete = false;
                            incompleteReason = incompleteReason ?? rootScan.incompleteReason;
                        }
                    }

                    return { files, complete, incompleteReason, completePrefixes };
                }
            );
        }
        catch (err) {
            if (err instanceof AuthenticationError) {
                this.handleAuthenticationFailure(err);
                return;
            }
            this.handleNetworkFailure(err);
            return;
        }


        const serverFiles = scan.files;

        const manifestByUri = new Map<string, string>();
        for (const relPath in this.manifest.items) {
            const entry = this.manifest.items[relPath];
            if (!entry.isFolder && entry.uri) {
                manifestByUri.set(entry.uri, relPath);
            }
        }

        // The floor (spec 8.3.1). The deletion pass below reads absence from
        // the scan as proof of server-side deletion, so an empty scan against
        // a populated manifest would delete every tracked file in one pass.
        //
        // Bail out before anything is written rather than skipping just the
        // deletion pass: continuing would persist an empty incoming sidecar,
        // clearing conflicts staged by an earlier fetch, and would stamp
        // `lastFetchedAt` as though a scan that plainly did not work had
        // succeeded.
        const scanVerdict = classifyDeletionScan({
            scannedFileCount: serverFiles.length,
            trackedFileCount: manifestByUri.size,
            scanComplete: scan.complete,
            userConfirmedEmpty: allowEmptyScanDeletions
        });

        // An incomplete scan is different from an empty one. The items it did
        // return are real, so adds and updates proceed normally; only deletions
        // are withheld, because the server has told us it left things out and
        // absence therefore proves nothing. Unlike the empty case there is
        // nothing to confirm, so this is not overridable.
        const deletionsTrusted = scanVerdict === "trust";
        if (scanVerdict === "distrust-empty-scan") {
            const retryLabel = "Retry";
            const emptyLabel = "Server Really Is Empty";
            void vscode.window.showWarningMessage(
                `Magnus Local: scanning ${this.manifest.server.url} returned no items, `
                + `but ${manifestByUri.size} file${manifestByUri.size === 1 ? " is" : "s are"} tracked here. `
                + "Nothing was changed. If the resource was genuinely emptied on the server, "
                + "confirm below and the scan will run again.",
                retryLabel,
                emptyLabel
            ).then(choice => {
                if (choice === retryLabel) {
                    void this.fetch();
                }
                else if (choice === emptyLabel) {
                    void this.fetch(true);
                }
            });
            return;
        }

        const newSidecar: IncomingSidecar = { version: 1, items: {} };
        const seenIncomingPaths = new Set<string>();
        const seenServerUris = new Set<string>();
        let fastForwarded = 0;
        let skippedByHash = 0;
        let conflicts = 0;
        let newFiles = 0;
        let unchanged = 0;
        let renamed = 0;
        // Track per-file failures by path + error so the summary toast can
        // name the file(s) and reason. A bare "N failed" counter leaves the
        // user with no way to know whether it was a specific broken page or
        // a transient blip.
        const failedItems: Array<{ path: string; error: string }> = [];
        let deletedAuto = 0;
        let deletedConflicts = 0;
        // Once the session is confirmed dead (authenticatedRequest already
        // tried relogin and failed), further content GETs will keep failing
        // the same way. Flip this on first sighting so remaining workers
        // short-circuit instead of throwing N identical errors.
        let authFailure: AuthenticationError | undefined;

        await vscode.window.withProgress(
            {
                location: progressLocation,
                title: `Fetching from ${this.manifest.server.url}…`,
                cancellable: false
            },
            async (progress) => {
                // Collect seenServerUris up front so the server-delete pass
                // below doesn't need to wait for content GETs to finish.
                for (const { descriptor } of serverFiles) {
                    if (descriptor.uri) {
                        seenServerUris.add(descriptor.uri);
                    }
                }

                // Rename detection pre-pass (clean local files only).
                // Two-pass through a temp directory so swap/cascade renames
                // don't collide. If Y wants the bare name X currently holds
                // and X is moving to `(2)`, a single pass would race on the
                // bare path; routing both through `.magnus/.tmp-rename/`
                // first clears every source before any final write.
                //
                // Dirty/conflict renames are handled inside the worker pool's
                // conflict branch below, where rename + sidecar write happen
                // together for the same file.
                type RenamePlan = {
                    uri: string;
                    oldRelPath: string;
                    newRelPath: string;
                    baselineBytes: Uint8Array | null;
                };
                const renamePlans: RenamePlan[] = [];
                for (const { naiveRelPath, descriptor } of serverFiles) {
                    if (!descriptor.uri) { continue; }
                    const fromRelPath = manifestByUri.get(descriptor.uri);
                    if (!fromRelPath || fromRelPath === naiveRelPath) { continue; }

                    let localBytes: Uint8Array | null = null;
                    try {
                        localBytes = await fs.readFile(path.join(this.root, fromRelPath));
                    }
                    catch {
                        localBytes = null;
                    }
                    const baselineBytes = await readBaseline(this.root, fromRelPath);
                    const localClean = localBytes === null
                        || (baselineBytes !== null && bytesEqual(localBytes, baselineBytes));
                    if (!localClean) { continue; }

                    renamePlans.push({
                        uri: descriptor.uri,
                        oldRelPath: fromRelPath,
                        newRelPath: naiveRelPath,
                        baselineBytes
                    });
                }

                // Phase 1: move each source working file to a per-URI temp
                // path under `.magnus/.tmp-rename/`. Failures land in
                // failedItems and the plan drops out of the pipeline.
                const tmpDirAbs = path.join(this.root, ".magnus", ".tmp-rename");
                const baselineRootAbs = path.join(this.root, BASELINE_DIR);
                const stagedPlans: Array<{ plan: RenamePlan; tmpAbsPath: string }> = [];
                if (renamePlans.length > 0) {
                    await fs.mkdir(tmpDirAbs, { recursive: true });
                }
                for (const plan of renamePlans) {
                    const tmpAbsPath = path.join(tmpDirAbs, encodeURIComponent(plan.uri));
                    try {
                        await vscode.workspace.fs.rename(
                            vscode.Uri.file(path.join(this.root, plan.oldRelPath)),
                            vscode.Uri.file(tmpAbsPath),
                            { overwrite: false }
                        );
                        stagedPlans.push({ plan, tmpAbsPath });
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        failedItems.push({
                            path: plan.oldRelPath,
                            error: `rename failed (move to temp): ${msg}`
                        });
                        console.warn(`[Magnus Local fetch] rename pass 1 failed ${plan.oldRelPath}`, err);
                    }
                }

                // Folder case-fix pass: between Phase 1 and Phase 2, rename any
                // parent directories whose names changed only by case. On
                // macOS APFS (case-insensitive), mkdir won't create a new
                // directory that differs from an existing one only in case, so
                // without this the file would land in the old-cased folder.
                // We only rename dirs that Phase 1 left completely empty so we
                // don't disturb siblings that aren't part of this rename batch.
                // Sort deepest-first so nested parent renames don't shift the
                // paths we use for their own ancestors.
                {
                    const seenCaseDirs = new Set<string>();
                    const caseDirWork: Array<{ oldAbsDir: string; newAbsDir: string }> = [];
                    for (const { plan } of stagedPlans) {
                        const oldParent = path.dirname(path.join(this.root, plan.oldRelPath));
                        const newParent = path.dirname(path.join(this.root, plan.newRelPath));
                        if (oldParent === newParent || seenCaseDirs.has(oldParent)) { continue; }
                        seenCaseDirs.add(oldParent);
                        if (oldParent.toLowerCase() === newParent.toLowerCase()) {
                            caseDirWork.push({ oldAbsDir: oldParent, newAbsDir: newParent });
                        }
                    }
                    caseDirWork.sort((a, b) =>
                        b.oldAbsDir.split(path.sep).length - a.oldAbsDir.split(path.sep).length
                    );
                    for (const { oldAbsDir, newAbsDir } of caseDirWork) {
                        try {
                            const entries = await fs.readdir(oldAbsDir);
                            if (entries.length > 0) { continue; }
                            const tmpCaseDir = oldAbsDir + "__tmpcase__";
                            await fs.rename(oldAbsDir, tmpCaseDir);
                            await fs.rename(tmpCaseDir, newAbsDir);
                        }
                        catch (err) {
                            console.warn(`[Magnus Local fetch] dir case-rename skipped: ${oldAbsDir}`, err);
                        }
                    }
                }

                // Phase 2: move each staged temp file to its final
                // destination, write/remove baseline, migrate manifest key,
                // prune empty parents. Any per-file failure attempts to
                // restore from temp back to the original location so we
                // don't strand files in `.magnus/.tmp-rename/`.
                for (const { plan, tmpAbsPath } of stagedPlans) {
                    const finalAbsPath = path.join(this.root, plan.newRelPath);
                    try {
                        await fs.mkdir(path.dirname(finalAbsPath), { recursive: true });
                        await vscode.workspace.fs.rename(
                            vscode.Uri.file(tmpAbsPath),
                            vscode.Uri.file(finalAbsPath),
                            { overwrite: false }
                        );
                        if (plan.baselineBytes !== null) {
                            if (plan.newRelPath.toLowerCase() === plan.oldRelPath.toLowerCase()) {
                                // Case-only rename: old and new baseline paths resolve to the
                                // same inode on a case-insensitive volume. Write to the old
                                // path so the file exists, then case-rename the parent dir.
                                // Calling removeBaseline would delete what we just wrote.
                                await writeBaseline(this.root, plan.oldRelPath, plan.baselineBytes);
                                const baselineOldDir = path.dirname(path.join(baselineRootAbs, plan.oldRelPath));
                                const baselineNewDir = path.dirname(path.join(baselineRootAbs, plan.newRelPath));
                                if (baselineOldDir !== baselineNewDir) {
                                    const tmpCaseDir = baselineOldDir + "__tmpcase__";
                                    try {
                                        await fs.rename(baselineOldDir, tmpCaseDir);
                                        await fs.rename(tmpCaseDir, baselineNewDir);
                                    }
                                    catch (err) {
                                        console.warn(`[Magnus Local fetch] baseline dir case-rename skipped`, err);
                                    }
                                }
                            }
                            else {
                                await writeBaseline(this.root, plan.newRelPath, plan.baselineBytes);
                                await removeBaseline(this.root, plan.oldRelPath);
                            }
                        }
                        const entry = this.manifest.items[plan.oldRelPath];
                        if (entry) {
                            this.manifest.items[plan.newRelPath] = entry;
                            delete this.manifest.items[plan.oldRelPath];
                        }
                        manifestByUri.set(plan.uri, plan.newRelPath);
                        renamed++;
                        console.log(`[Magnus Local fetch] renamed: ${plan.oldRelPath} -> ${plan.newRelPath}`);
                        await pruneEmptyParents(path.dirname(path.join(this.root, plan.oldRelPath)), this.root);
                        await pruneEmptyParents(path.dirname(path.join(baselineRootAbs, plan.oldRelPath)), baselineRootAbs);
                    }
                    catch (err) {
                        try {
                            await fs.mkdir(path.dirname(path.join(this.root, plan.oldRelPath)), { recursive: true });
                            await vscode.workspace.fs.rename(
                                vscode.Uri.file(tmpAbsPath),
                                vscode.Uri.file(path.join(this.root, plan.oldRelPath)),
                                { overwrite: false }
                            );
                        }
                        catch {
                            // Source slot may now be occupied by another
                            // rename's destination; the file stays in
                            // `.magnus/.tmp-rename/` and the tmp dir
                            // cleanup below will skip removal.
                        }
                        const msg = err instanceof Error ? err.message : String(err);
                        failedItems.push({
                            path: plan.oldRelPath,
                            error: `rename failed (move from temp): ${msg}`
                        });
                        console.warn(`[Magnus Local fetch] rename pass 2 failed ${plan.oldRelPath} -> ${plan.newRelPath}`, err);
                    }
                }

                // Best-effort cleanup of the temp directory. Empty when
                // every staged plan landed; lingers if any pass 2 failure
                // also failed to restore. Either way, this runs before
                // writeManifest so a stuck file doesn't trip the SCM
                // refresh.
                if (renamePlans.length > 0) {
                    try { await fs.rmdir(tmpDirAbs); } catch { /* not empty, leave it */ }
                }

                // Seed the message with the total so the user sees the
                // denominator before the first file completes.
                progress.report({ message: `0/${serverFiles.length}` });

                let completed = 0;
                const incrementPer = serverFiles.length > 0 ? (100 / serverFiles.length) : 0;
                await mapWithConcurrency(serverFiles, FETCH_CONCURRENCY, async ({ naiveRelPath, descriptor }) => {
                    if (authFailure || !descriptor.uri) {
                        completed++;
                        return;
                    }

                    // The server told us this item's hash and it matches what we
                    // last synced, so its content cannot have changed and there
                    // is nothing to download. Skipping is safe in a way that
                    // guessing would not be: a null or absent hash falls through
                    // to the download, so an older plugin behaves exactly as
                    // before rather than silently skipping everything.
                    const flatItem = descriptor as IFlatTreeItem;
                    const existing = this.manifest.items[naiveRelPath];

                    // Two ways to know nothing changed, in order of how much we
                    // trust them. A matching hash is proof. A matching timestamp
                    // is the server saying it has not touched this since we last
                    // looked, which is cheaper to produce and good enough to
                    // decide where to look (spec 7.8).
                    const hashSaysUnchanged = !!flatItem.hash
                        && !!existing
                        && !existing.isFolder
                        && existing.hash === flatItem.hash;

                    if (hashSaysUnchanged || canSkipByTimestamp(existing, flatItem.modifiedDateTime)) {
                        skippedByHash++;
                        unchanged++;
                        completed++;
                        progress.report({
                            message: `${completed}/${serverFiles.length}`,
                            increment: incrementPer
                        });
                        return;
                    }

                    let serverBytes: Uint8Array;
                    try {
                        serverBytes = await this.api.getFileContent(toFullUrl(this.manifest.server.url, descriptor.uri));
                    }
                    catch (err) {
                        if (err instanceof AuthenticationError) {
                            authFailure = err;
                            completed++;
                            return;
                        }
                        const msg = err instanceof Error ? err.message : String(err);
                        failedItems.push({
                            path: naiveRelPath,
                            error: friendlyNetworkMessage(msg, this.manifest.server.url)
                        });
                        completed++;
                        progress.report({
                            message: `${completed}/${serverFiles.length}`,
                            increment: incrementPer
                        });
                        console.warn(`[Magnus Local SCM] fetch failed for ${naiveRelPath}`, err);
                        return;
                    }

                    const serverHash = hashBytes(serverBytes);
                    const existingRelPath = manifestByUri.get(descriptor.uri);

                    if (existingRelPath) {
                        const entry = this.manifest.items[existingRelPath];
                        const baselineBytes = await readBaseline(this.root, existingRelPath);
                        let localBytes: Uint8Array | null = null;
                        try {
                            localBytes = await fs.readFile(path.join(this.root, existingRelPath));
                        }
                        catch {
                            localBytes = null;
                        }

                        const decision = classifyFetchedFile({
                            serverBytes,
                            baselineBytes,
                            localBytes,
                            manifestEntry: entry
                        });

                        if (decision === "unchanged") {
                            // Server content matches baseline — no content to
                            // write. But if the server also renamed the file
                            // and the pre-pass skipped it (local was dirty),
                            // we still need to move the working file now.
                            if (existingRelPath !== naiveRelPath) {
                                try {
                                    await renameTracked({
                                        root: this.root,
                                        oldRelPath: existingRelPath,
                                        newRelPath: naiveRelPath,
                                        renameWorkingFile: async (oldAbs, newAbs) => {
                                            const edit = new vscode.WorkspaceEdit();
                                            edit.renameFile(
                                                vscode.Uri.file(oldAbs),
                                                vscode.Uri.file(newAbs),
                                                { overwrite: false }
                                            );
                                            if (!await vscode.workspace.applyEdit(edit)) {
                                                throw new Error("WorkspaceEdit rename returned false");
                                            }
                                        },
                                        baselineBytes
                                    });
                                    this.manifest.items[naiveRelPath] = entry;
                                    delete this.manifest.items[existingRelPath];
                                    manifestByUri.set(descriptor.uri, naiveRelPath);
                                    renamed++;
                                    console.log(`[Magnus Local fetch] renamed: ${existingRelPath} -> ${naiveRelPath}`);
                                }
                                catch (err) {
                                    const msg = err instanceof Error ? err.message : String(err);
                                    failedItems.push({ path: existingRelPath, error: `rename failed: ${msg}` });
                                    console.warn(`[Magnus Local fetch] rename failed (dirty-unchanged): ${existingRelPath} -> ${naiveRelPath}`, err);
                                }
                            }
                            // Keep the recorded timestamp current even when
                            // nothing changed, or an item whose timestamp moved
                            // without its content changing would be re-downloaded
                            // on every scan forever.
                            if (flatItem.modifiedDateTime) {
                                entry.modifiedDateTime = flatItem.modifiedDateTime;
                            }
                            unchanged++;
                        }
                        else if (decision === "fast-forward") {
                            // Staged, not applied (spec 7.9). Nothing is at risk
                            // here, which is exactly why this used to overwrite
                            // the working file outright. The reason not to is
                            // that changing a file underneath a running agent
                            // mid-task produces confusing results and leaves no
                            // audit trail. Every change to the working tree
                            // should be either the user's or one they accepted.
                            await writeIncoming(this.root, existingRelPath, serverBytes);
                            seenIncomingPaths.add(existingRelPath);
                            newSidecar.items[existingRelPath] = {
                                uri: descriptor.uri,
                                buildUri: descriptor.buildUri ?? null,
                                deleteUri: descriptor.deleteUri ?? null,
                                displayName: descriptor.displayName,
                                fetchedAt: new Date().toISOString(),
                                isNew: false
                            };
                            fastForwarded++;
                        }
                        else { // "conflict" — "new" and "skip-empty" are unreachable for tracked entries
                            // Diagnostic: dump the byte-state the classifier
                            // saw. A conflict on a freshly-renamed file with
                            // matching local/baseline/server points at a
                            // stale-baseline-after-rename bug; the sizes
                            // and hashes here say which input was off.
                            console.log(
                                `[Magnus Local fetch] conflict at ${existingRelPath}: `
                                + `local=${localBytes ? localBytes.byteLength : "null"}/${localBytes ? hashBytes(localBytes).slice(0, 12) : "—"} `
                                + `baseline=${baselineBytes ? baselineBytes.byteLength : "null"}/${baselineBytes ? hashBytes(baselineBytes).slice(0, 12) : "—"} `
                                + `server=${serverBytes.byteLength}/${serverHash.slice(0, 12)} `
                                + `manifestHash=${entry.hash ? entry.hash.slice(0, 12) : "—"}`
                            );

                            // Phase 3: server renamed a dirty local file.
                            // The pre-pass skipped it because local was dirty;
                            // rename it here so the working file and the
                            // incoming sidecar entry both land at the new path.
                            let targetRelPath = existingRelPath;
                            if (existingRelPath !== naiveRelPath) {
                                try {
                                    await renameTracked({
                                        root: this.root,
                                        oldRelPath: existingRelPath,
                                        newRelPath: naiveRelPath,
                                        renameWorkingFile: async (oldAbs, newAbs) => {
                                            const edit = new vscode.WorkspaceEdit();
                                            edit.renameFile(
                                                vscode.Uri.file(oldAbs),
                                                vscode.Uri.file(newAbs),
                                                { overwrite: false }
                                            );
                                            if (!await vscode.workspace.applyEdit(edit)) {
                                                throw new Error("WorkspaceEdit rename returned false");
                                            }
                                        },
                                        baselineBytes
                                    });
                                    this.manifest.items[naiveRelPath] = entry;
                                    delete this.manifest.items[existingRelPath];
                                    manifestByUri.set(descriptor.uri, naiveRelPath);
                                    targetRelPath = naiveRelPath;
                                    renamed++;
                                    console.log(`[Magnus Local fetch] renamed: ${existingRelPath} -> ${naiveRelPath}`);
                                }
                                catch (err) {
                                    const msg = err instanceof Error ? err.message : String(err);
                                    failedItems.push({ path: existingRelPath, error: `rename failed: ${msg}` });
                                    console.warn(`[Magnus Local fetch] rename failed (dirty): ${existingRelPath} -> ${naiveRelPath}`, err);
                                    return;
                                }
                            }

                            await writeIncoming(this.root, targetRelPath, serverBytes);
                            seenIncomingPaths.add(targetRelPath);
                            newSidecar.items[targetRelPath] = {
                                uri: descriptor.uri,
                                buildUri: descriptor.buildUri ?? null,
                                deleteUri: descriptor.deleteUri ?? null,
                                displayName: descriptor.displayName,
                                fetchedAt: new Date().toISOString(),
                                isNew: false
                            };
                            conflicts++;
                        }
                    }
                    else {
                        const decision = classifyFetchedFile({
                            serverBytes,
                            baselineBytes: null,
                            localBytes: null,
                            manifestEntry: null
                        });
                        if (decision === "new") {
                            await writeIncoming(this.root, naiveRelPath, serverBytes);
                            seenIncomingPaths.add(naiveRelPath);
                            newSidecar.items[naiveRelPath] = {
                                uri: descriptor.uri,
                                buildUri: descriptor.buildUri ?? null,
                                deleteUri: descriptor.deleteUri ?? null,
                                displayName: descriptor.displayName,
                                fetchedAt: new Date().toISOString(),
                                isNew: true
                            };
                            newFiles++;
                        }
                        // "skip-empty": Rock returns empty bytes for unset block
                        // templates; pull-time skips these and so do we, else
                        // every empty endpoint would re-flag as "new" forever.
                    }

                    completed++;
                    progress.report({
                        message: `${completed}/${serverFiles.length}`,
                        increment: incrementPer
                    });
                });
            }
        );

        if (authFailure) {
            // Content fetches died mid-flight. Do NOT persist partial state:
            // skip the delete-detection pass (otherwise files we never got a
            // chance to check would be misread as "deleted on server"), and
            // drop the half-built incoming sidecar without writing it.
            this.handleAuthenticationFailure(authFailure);
            return;
        }

        // Second pass: detect files tracked in the manifest that the server
        // walk did NOT produce. These are server-side deletions. If the local
        // is clean (matches baseline or never existed), auto-apply. If local
        // has uncommitted edits, surface in Incoming for the user to decide.
        let manifestMutated = fastForwarded > 0 || renamed > 0;
        // Iterate a snapshot of the keys: the body deletes manifest entries as it
        // goes, and an empty list is how a withheld deletion pass is expressed.
        const deletionCandidates = deletionsTrusted ? Object.keys(this.manifest.items) : [];
        for (const relPath of deletionCandidates) {
            const entry = this.manifest.items[relPath];
            if (entry.isFolder) { continue; }
            if (!entry.uri) { continue; }
            if (seenServerUris.has(entry.uri)) { continue; }

            const absPath = path.join(this.root, relPath);
            let localBytes: Uint8Array | null = null;
            try {
                localBytes = await fs.readFile(absPath);
            }
            catch {
                localBytes = null;
            }
            const baselineBytes = await readBaseline(this.root, relPath);
            const decision = classifyServerDeletion({ localBytes, baselineBytes });

            if (decision === "auto-delete") {
                if (localBytes !== null) {
                    try { await fs.unlink(absPath); } catch { /* best-effort */ }
                }
                await removeBaseline(this.root, relPath);
                delete this.manifest.items[relPath];
                manifestMutated = true;
                deletedAuto++;
                // Match rename's cleanup: drop now-empty parent directories
                // (the deleted block's `[Main] X/` folder, etc.) so the
                // explorer reflects what the manifest reflects.
                await pruneEmptyParents(path.dirname(absPath), this.root);
                await pruneEmptyParents(
                    path.dirname(path.join(this.root, BASELINE_DIR, relPath)),
                    path.join(this.root, BASELINE_DIR)
                );
            }
            else {
                newSidecar.items[relPath] = {
                    uri: entry.uri,
                    buildUri: entry.buildUri ?? null,
                    deleteUri: entry.deleteUri ?? null,
                    displayName: entry.displayName ?? path.basename(relPath),
                    fetchedAt: new Date().toISOString(),
                    isNew: false,
                    isDeleted: true
                };
                deletedConflicts++;
            }
        }

        // When deletions were withheld, the sidecar rebuilt above only covers
        // items this scan actually saw. Writing it as-is would silently drop
        // entries the user had already been asked to resolve, for files the
        // scan happened to omit. Carry those forward.
        if (!deletionsTrusted) {
            const priorSidecar = await readIncomingSidecar(this.root);
            for (const [relPath, entry] of Object.entries(priorSidecar.items)) {
                if (newSidecar.items[relPath]) {
                    continue;
                }
                newSidecar.items[relPath] = entry;
                // Keep its staged bytes too, or the stale-incoming sweep below
                // would delete the content this entry refers to.
                seenIncomingPaths.add(relPath);
            }
        }

        if (manifestMutated) {
            await writeManifest(this.root, this.manifest);
        }
        await writeIncomingSidecar(this.root, newSidecar);

        // Remove any previously-staged incoming files that no longer apply
        // (e.g. server file was deleted, or conflict resolved out-of-band).
        for (const stale of await listIncomingPaths(this.root)) {
            if (!seenIncomingPaths.has(stale)) {
                await removeIncoming(this.root, stale);
            }
        }

        await this.refresh();

        // Mark the successful-completion moment for the status bar. Only
        // reached if the walk succeeded, no auth failure interrupted, and the
        // delete-detection pass ran. Error/auth early-returns above skip this.
        this.lastFetchedAt = new Date();

        // Summary toast. Fetch is always user-initiated now, so the user is
        // waiting to hear how it went — we surface every run, including
        // "nothing to do" and "N unchanged". Failures go through a warning
        // with named files and a Retry action.
        const failed = failedItems.length;
        const parts: string[] = [];
        if (renamed > 0) { parts.push(`${renamed} renamed`); }
        if (fastForwarded > 0) { parts.push(`${fastForwarded} incoming`); }
        if (conflicts > 0) { parts.push(`${conflicts} conflicting`); }
        if (newFiles > 0) { parts.push(`${newFiles} new`); }
        if (deletedAuto > 0) { parts.push(`${deletedAuto} removed`); }
        if (deletedConflicts > 0) { parts.push(`${deletedConflicts} deleted on server`); }
        if (unchanged > 0) {
            parts.push(skippedByHash > 0
                ? `${unchanged} unchanged (${skippedByHash} skipped by hash)`
                : `${unchanged} unchanged`);
        }
        if (failed > 0) { parts.push(`${failed} failed`); }

        const baseSummary = parts.length > 0
            ? `Magnus Local fetch: ${parts.join(", ")}.`
            : "Magnus Local fetch: nothing to do.";

        // Say it plainly rather than letting a withheld deletion pass look like
        // a clean run. `no-completeness-signal` means the plugin predates the
        // flag, which is a different conversation from a truncated response.
        const summary = deletionsTrusted
            ? baseSummary
            : `${baseSummary} The server's file list was incomplete`
                + (scan.incompleteReason === "no-completeness-signal"
                    ? " (this plugin version can't report completeness)"
                    : scan.incompleteReason ? ` (${scan.incompleteReason})` : "")
                + ", so server-side deletions were not applied.";

        // A quiet fetch stays quiet unless something actually needs a person.
        // "12 unchanged" every minute would train the user to ignore exactly the
        // notifications that matter.
        const needsAttention = conflicts > 0
            || newFiles > 0
            || deletedConflicts > 0
            || failed > 0
            || !deletionsTrusted;

        if (quiet && !needsAttention) {
            console.log(`[Magnus Local SCM] quiet fetch: ${summary}`);
            return;
        }

        if (failed > 0) {
            // Name up to 3 failing files so the user can see whether it's a
            // specific troublesome page or a scatter of transient blips, and
            // offer a single-click Retry for the common "one flaky file,
            // try again" case.
            const sample = failedItems.slice(0, 3)
                .map(f => `• ${f.path}: ${f.error}`)
                .join("\n");
            const andMore = failed > 3 ? `\n…and ${failed - 3} more` : "";
            const retryLabel = "Retry";
            void vscode.window.showWarningMessage(
                `${summary}\n${sample}${andMore}`,
                retryLabel
            ).then(choice => {
                if (choice === retryLabel) {
                    void this.fetch();
                }
            });
        }
        else {
            void vscode.window.showInformationMessage(summary);
        }
    }

    /**
     * Convert a flat-tree response into the same `{ naiveRelPath, descriptor }`
     * shape the existing reconciliation pipeline consumes from the recursive
     * fallback (`enumerateServerTree`). Only leaves (non-folder items) are
     * emitted; folders are dropped here because the reconciliation logic
     * doesn't track them. Items pruned by the content filter are absent from
     * the assembled path map and skipped.
     */
    private flatItemsToServerFiles(
        items: IFlatTreeItem[]
    ): Array<{ naiveRelPath: string; descriptor: IItemDescriptor }> {
        const pathByUri = assembleFlatTreePaths(items);
        const results: Array<{ naiveRelPath: string; descriptor: IItemDescriptor }> = [];
        for (const item of items) {
            if (!item.uri || item.isFolder) {
                continue;
            }
            const relPath = pathByUri.get(item.uri);
            if (!relPath) {
                continue;
            }
            results.push({ naiveRelPath: relPath, descriptor: item });
        }
        return results;
    }

    /**
     * Apply the server bytes (previously fetched and stored under
     * `.magnus/incoming/`) over the user's local file, updating the baseline
     * so the file leaves the Incoming group.
     *
     * Two branches: for a tracked file this overwrites local + baseline and
     * updates the manifest hash. For a new-on-server file (sidecar marked
     * `isNew`) it materializes the file, adds a manifest entry, and writes
     * a fresh baseline. Either way the sidecar entry is removed on success.
     */
    public async pullFromServer(uri: vscode.Uri): Promise<void> {
        const relPath = path.relative(this.root, uri.fsPath).split(path.sep).join("/");

        const outcome = await performPullFromServer({
            root: this.root,
            manifest: this.manifest,
            relPath,
            confirm: async (kind) => {
                const message = kind === "accept-deletion"
                    ? `${relPath} was deleted on the server. Accepting the deletion will remove your local copy and discard any unsynced changes.`
                    : kind === "overwrite-existing-new"
                        ? `${relPath} already exists locally. Replacing it with the server version will discard your local content.`
                        : `${relPath} has unsynced local changes. Pulling the server version will replace them. This cannot be undone.`;
                const button = kind === "accept-deletion" ? "Delete Local Copy" : "Replace Local";
                const choice = await vscode.window.showWarningMessage(message, { modal: true }, button);
                return choice === button;
            }
        });

        if (outcome === "no-server-bytes") {
            void vscode.window.showErrorMessage(`No fetched server version for ${relPath}. Run Fetch again.`);
            return;
        }

        if (outcome === "new-applied" || outcome === "conflict-applied") {
            // Both branches updated the baseline; let any open diff editors refresh.
            this.baseline.notifyChanged(encodeBaselineUri(this.root, relPath));
        }

        if (outcome !== "deletion-cancelled" && outcome !== "new-cancelled" && outcome !== "conflict-cancelled") {
            await this.refresh();
        }
    }
}

/**
 * Format a past timestamp for the status bar. Precision is coarse on purpose —
 * the label needs to stay short so it doesn't crowd the status bar, and the
 * full timestamp is always available in the tooltip.
 */
function formatRelativeTime(date: Date): string {
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 45) {
        return "just now";
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours}h ago`;
    }
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

async function safeReadManifest(root: string): Promise<Manifest | null> {
    try {
        return await readManifest(root);
    }
    catch {
        return null;
    }
}

async function listIncomingPaths(root: string): Promise<string[]> {
    const baseDir = path.join(root, INCOMING_DIR);
    const results: string[] = [];
    async function walk(dir: string, rel: string): Promise<void> {
        let entries: import("fs").Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            const childRel = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
                await walk(path.join(dir, e.name), childRel);
            }
            else if (e.isFile()) {
                results.push(childRel);
            }
        }
    }
    await walk(baseDir, "");
    return results;
}
