import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Api } from "./api";
import { removeBaseline } from "./baseline";
import {
    MAGNUS_JSON_SCHEMA_VERSION,
    MagnusJson,
    MagnusSelectionEntry,
    ensureMagnusGitignore,
    readMagnusJson,
    writeMagnusJson
} from "./magnusJson";
import { Manifest, ManifestRoot, readManifest, writeManifest } from "./manifest";
import { pullResourceIntoWorkspace } from "./pullCommand";
import { diffSelection } from "./selectionDiff";
import { promptForSelection } from "./selectionDialog";

/**
 * "Edit what this workspace holds": the one place resources are added to and
 * removed from an existing workspace (spec 7.3, 7.4).
 *
 * The whole point of routing both through one dialog is that adding a second
 * theme and removing a stale app are the same gesture, done in the same place,
 * rather than an "add" command and a separate "unlink" command that each know
 * half the state.
 */

/**
 * Remove a root's files, baselines and manifest entries from a workspace.
 *
 * `keepFiles` leaves the working files exactly where they are and only stops
 * tracking them, which is the honest default for someone who unchecked a box
 * without intending to lose work. Baselines and manifest entries go either way:
 * keeping them would leave the workspace claiming to track content it no longer
 * syncs, which is the "manifest present, baseline absent" shape the classifiers
 * handle worst.
 */
async function removeRoot(
    workspaceRoot: string,
    manifest: Manifest,
    entry: MagnusSelectionEntry,
    keepFiles: boolean
): Promise<number> {
    const prefix = entry.pathPrefix;
    const owned = Object.keys(manifest.items).filter(k => k.startsWith(prefix));

    for (const key of owned) {
        if (!manifest.items[key].isFolder) {
            await removeBaseline(workspaceRoot, key);
        }
        delete manifest.items[key];
    }

    manifest.roots = manifest.roots.filter((r: ManifestRoot) => r.pathPrefix !== prefix);

    if (!keepFiles && prefix.length > 0) {
        await fs.rm(path.join(workspaceRoot, ...prefix.split("/").filter(Boolean)), {
            recursive: true,
            force: true
        });
    }

    return owned.length;
}

/**
 * Ask what should happen to a removed resource's files.
 *
 * Deliberately a modal with no default action: unchecking a box is a small
 * gesture and deleting a directory is not, so the two must not be joined by an
 * assumption.
 */
async function confirmRemoval(entry: MagnusSelectionEntry): Promise<"keep" | "delete" | "cancel"> {
    const keep = "Keep Files";
    const remove = "Delete Files";

    const choice = await vscode.window.showWarningMessage(
        `Stop tracking ${entry.displayName}?`,
        {
            modal: true,
            detail:
                `Magnus will no longer sync ${entry.pathPrefix}.\n\n`
                + "Keep Files leaves everything on disk and only stops tracking it. "
                + "Delete Files removes the directory, including anything you have not pushed."
        },
        keep,
        remove
    );

    if (choice === keep) { return "keep"; }
    if (choice === remove) { return "delete"; }
    return "cancel";
}

/**
 * Open the selection dialog for a workspace and apply whatever changes.
 */
export async function editSelection(
    api: Api,
    workspaceRoot: string,
    extensionVersion: string,
    preSeed?: string
): Promise<void> {
    let manifest: Manifest | null;
    try {
        manifest = await readManifest(workspaceRoot);
    }
    catch (err) {
        void vscode.window.showErrorMessage(
            `Magnus Local: ${err instanceof Error ? err.message : String(err)}`
        );
        return;
    }

    if (manifest === null) {
        // A clone has magnus.json and no manifest. That is a restorable
        // workspace, not a non-workspace, and saying "use Pull to Local
        // Workspace" sends the user somewhere that cannot help: Pull refuses a
        // non-empty target and would nest a second workspace inside this one.
        // Point at Restore instead, and let it own hydration so there is only
        // ever one implementation of it.
        const restorable = await readMagnusJson(workspaceRoot).catch(() => null);
        if (restorable) {
            const choice = await vscode.window.showErrorMessage(
                "Magnus Local: this clone has no local sync state yet. Restore it first, then edit the selection.",
                "Restore Local Sync State"
            );
            if (choice === "Restore Local Sync State") {
                await vscode.commands.executeCommand(
                    "magnusLocal.hydrateWorkspace", { root: workspaceRoot }
                );
            }
            return;
        }

        void vscode.window.showErrorMessage(
            "Magnus Local: this folder is not a pulled workspace. Use Pull to Local Workspace to create one."
        );
        return;
    }

    const committed = await readMagnusJson(workspaceRoot);

    // The manifest is the fallback source of truth, not magnus.json. A
    // workspace pulled before magnus.json existed has a manifest and no
    // committed file, so deriving from the manifest when the committed file is
    // missing means the dialog opens showing what is actually on disk.
    const current: MagnusSelectionEntry[] = committed?.selection ?? manifest.roots.map(r => ({
        uri: r.uri,
        displayName: r.displayName,
        platform: r.platform,
        pathPrefix: r.pathPrefix
    }));

    const chosen = await promptForSelection(api, manifest.server.url, current, preSeed);

    if (chosen === null) {
        return;
    }

    const diff = diffSelection(current, chosen);

    if (diff.added.length === 0 && diff.removed.length === 0) {
        void vscode.window.showInformationMessage("Magnus Local: selection unchanged.");
        return;
    }

    // Removals first, and each confirmed on its own. Batching the prompt would
    // make "yes" mean different things for different directories.
    const keptSelection: MagnusSelectionEntry[] = [...diff.unchanged, ...diff.added];
    let removedCount = 0;

    for (const entry of diff.removed) {
        const decision = await confirmRemoval(entry);

        if (decision === "cancel") {
            // Cancelling one removal keeps that resource selected rather than
            // abandoning the whole edit, so the additions the user also asked
            // for still happen.
            keptSelection.push(entry);
            continue;
        }

        await removeRoot(workspaceRoot, manifest, entry, decision === "keep");
        removedCount++;
    }

    const pulledAt = new Date().toISOString();
    const failures: string[] = [];

    for (const entry of diff.added) {
        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Pulling ${entry.displayName}`,
                    cancellable: false
                },
                (progress) => pullResourceIntoWorkspace(
                    api,
                    manifest!.server.url,
                    workspaceRoot,
                    manifest!,
                    {
                        uri: entry.uri,
                        displayName: entry.displayName,
                        isFolder: true
                    },
                    entry.pathPrefix,
                    pulledAt,
                    progress
                )
            );

            manifest.roots = manifest.roots.filter(r => r.pathPrefix !== entry.pathPrefix);
            manifest.roots.push({
                uri: entry.uri,
                displayName: entry.displayName,
                platform: entry.platform,
                pulledAt,
                pathPrefix: entry.pathPrefix,
                buildUri: null
            });
        }
        catch (err) {
            failures.push(`${entry.displayName}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // A resource that failed to pull is not recorded as selected. Writing it
    // anyway would leave magnus.json claiming content the workspace does not
    // have, and the next fetch would read the gap as a server-side deletion.
    const failedNames = new Set(failures.map(f => f.split(":")[0]));
    const finalSelection = keptSelection.filter(e => !failedNames.has(e.displayName));

    await writeManifest(workspaceRoot, manifest);

    const magnusJson: MagnusJson = {
        schemaVersion: MAGNUS_JSON_SCHEMA_VERSION,
        server: manifest.server,
        selection: finalSelection.sort((a, b) => a.pathPrefix.localeCompare(b.pathPrefix)),
        pulledAt,
        versions: {
            extension: extensionVersion,
            plugin: (await api.getServerInfo(manifest.server.url))?.pluginVersion ?? null
        }
    };
    await writeMagnusJson(workspaceRoot, magnusJson);

    // Pull does this after its own write; Edit Selection did not, so a
    // workspace whose resources all arrived through this command never got the
    // ignore block and would commit its baselines and staged incoming files on
    // the first `git add .`. Idempotent, so calling it on every edit is fine.
    await ensureMagnusGitignore(workspaceRoot);

    const parts: string[] = [];
    if (diff.added.length - failures.length > 0) {
        parts.push(`${diff.added.length - failures.length} added`);
    }
    if (removedCount > 0) { parts.push(`${removedCount} removed`); }
    if (failures.length > 0) { parts.push(`${failures.length} failed`); }

    const summary = `Magnus Local: ${parts.length > 0 ? parts.join(", ") : "no changes"}.`;

    if (failures.length > 0) {
        void vscode.window.showWarningMessage(`${summary}\n${failures.join("\n")}`);
    }
    else {
        void vscode.window.showInformationMessage(summary);
    }
}
