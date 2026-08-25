import * as vscode from "vscode";
import { Api } from "./api";
import {
    HydrateSummary,
    changedCount,
    describeSummary,
    emptySummary,
    planHydrateScope,
    rootForEntry
} from "./hydratePlan";
import { MagnusJson, ensureMagnusGitignore, readMagnusJson } from "./magnusJson";
import { apiFetchChildren, resolveRootDescriptors } from "./resolveDescriptor";
import { MANIFEST_VERSION, Manifest, writeManifest } from "./manifest";
import { pullResourceIntoWorkspace } from "./pullCommand";
import { promptAndLogin } from "./reauthenticateCommand";
import { Secrets } from "./secrets";
import { resolveServerConnection } from "./serverConnection";
import { classifyWorkspace } from "./workspaceState";

/**
 * Hydration: give a cloned repository its local sync state.
 *
 * `magnus.json` is committed and `.magnus/` is not, so `git clone` produces a
 * workspace with content and intent but no baselines, no manifest, and
 * therefore no Source Control panel. Until now there was no command that closed
 * that gap: Pull refuses a non-empty target and creates a nested
 * `<serverAlias>/` folder anyway, and Edit Selection returns early when the
 * manifest is missing. See `hydratePlan.ts` for the safety rule this enforces.
 */

/**
 * Rebuild `.magnus/` for a workspace from its committed selection.
 *
 * Deliberately does not write `magnus.json`. Pull rewrites it because pull
 * changes the selection; hydrate only reads it. Rewriting it here would churn
 * `pulledAt` and hand every teammate a dirty working tree the first time they
 * hydrate their own clone.
 */
export async function hydrateWorkspace(
    api: Api,
    root: string,
    magnusJson: MagnusJson,
    progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<HydrateSummary> {
    const { accepted, rejected } = planHydrateScope(magnusJson.selection);

    if (rejected.length > 0) {
        void vscode.window.showWarningMessage(
            `Magnus Local: skipped ${rejected.length} entr${rejected.length === 1 ? "y" : "ies"} in `
            + `magnus.json (${rejected.map(r => `${r.entry.displayName}: ${r.reason}`).join("; ")}).`
        );
    }

    if (accepted.length === 0) {
        throw new Error("magnus.json has no usable entries to restore.");
    }

    const hydratedAt = new Date().toISOString();
    const manifest: Manifest = {
        version: MANIFEST_VERSION,
        server: magnusJson.server,
        roots: [],
        items: {}
    };

    const summary = emptySummary();

    // Recover each resource's real descriptor before materializing anything.
    // Two things depend on it, and neither can be reconstructed from
    // `magnus.json`: `buildUri`, which decides whether Deploy appears, and the
    // descriptor handed to the recursive-walk fallback, which is the path older
    // plugins without GetFlatTree actually take.
    progress.report({ message: "Locating resources on the server…" });
    const descriptors = await resolveRootDescriptors(
        apiFetchChildren(api, magnusJson.server.url),
        accepted.map(e => e.uri)
    );

    for (const entry of accepted) {
        progress.report({ message: `${entry.displayName}: fetching file list…` });

        const descriptor = descriptors.get(entry.uri);
        if (!descriptor) {
            // The selection names something this account cannot see, or that no
            // longer exists. Skipping beats failing the whole restore: the other
            // resources are still worth having.
            summary.unresolved.push(entry.displayName);
            continue;
        }

        const result = await pullResourceIntoWorkspace(
            api,
            magnusJson.server.url,
            root,
            manifest,
            descriptor,
            entry.pathPrefix,
            hydratedAt,
            progress,
            "hydrate"
        );

        manifest.roots.push(rootForEntry(entry, hydratedAt, descriptor.buildUri ?? null));

        summary.unchanged += result.unchanged;
        summary.replaced += result.replaced;
        summary.materialized += result.written;
        if (!descriptor.buildUri) {
            summary.rootsMissingBuildUri.push(entry.displayName);
        }
    }

    if (manifest.roots.length === 0) {
        throw new Error(
            "None of the resources in magnus.json could be found on "
            + `${magnusJson.server.url}. Check that you have access to them.`
        );
    }

    await writeManifest(root, manifest);
    await ensureMagnusGitignore(root);

    return summary;
}

/**
 * Ensure this machine can reach the workspace's server, offering to connect.
 *
 * Returns whether hydration should proceed. Asking here rather than letting the
 * first request fail is the whole point of the disconnected state: "you have
 * not connected to this server" is actionable, and a 401 buried in a fetch is
 * not.
 */
async function ensureConnected(
    context: vscode.ExtensionContext,
    api: Api,
    secrets: Secrets,
    serverUrl: string
): Promise<boolean> {
    if (await resolveServerConnection(secrets, serverUrl) === "connected") {
        return true;
    }

    const choice = await vscode.window.showWarningMessage(
        `This workspace syncs with ${serverUrl}, which you have not connected to on this machine.`,
        { modal: true },
        "Connect…"
    );
    if (choice !== "Connect…") {
        return false;
    }

    return promptAndLogin(context, api, secrets, serverUrl, `Connect to ${serverUrl}`);
}

/**
 * Pick the folder to act on.
 *
 * Prefers an explicit argument (the SCM title button passes its root), then the
 * only candidate, then asks. Silently guessing among several clones would be
 * the kind of thing you notice only after it has written to the wrong one.
 */
async function resolveTargetRoot(explicit?: string): Promise<string | undefined> {
    if (explicit) {
        return explicit;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    const candidates: string[] = [];
    for (const folder of folders) {
        const root = folder.uri.fsPath;
        const state = await classifyWorkspace(root);

        // Anything with a committed selection is a candidate, restored or not:
        // re-restoring is how you take the server's state wholesale.
        if (state.kind === "needs-hydrate") {
            candidates.push(root);
        }
        else if (state.kind === "hydrated" && await readMagnusJson(root).catch(() => null)) {
            candidates.push(root);
        }
    }

    if (candidates.length === 0) {
        await vscode.window.showInformationMessage(
            "Magnus Local: no folder here has a magnus.json to restore from."
        );
        return undefined;
    }

    if (candidates.length === 1) {
        return candidates[0];
    }

    return vscode.window.showQuickPick(candidates, {
        title: "Restore Local Sync State",
        placeHolder: "Choose which workspace folder to restore"
    });
}

export function registerHydrateCommand(
    context: vscode.ExtensionContext,
    api: Api,
    secrets: Secrets,
    onHydrated: () => void | Promise<void>
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand(
            "magnusLocal.hydrateWorkspace",
            async (arg?: { rootUri?: vscode.Uri; root?: string }) => {
                const explicit = arg?.root
                    ?? (arg?.rootUri instanceof vscode.Uri ? arg.rootUri.fsPath : undefined);

                const root = await resolveTargetRoot(explicit);
                if (!root) {
                    return;
                }

                const state = await classifyWorkspace(root);

                if (state.kind === "broken") {
                    await vscode.window.showErrorMessage(`Magnus Local: ${state.message}`);
                    return;
                }
                if (state.kind === "none") {
                    await vscode.window.showErrorMessage(
                        "Magnus Local: no magnus.json in this folder, so there is no selection to restore."
                    );
                    return;
                }

                let selection: MagnusJson;
                if (state.kind === "hydrated") {
                    // An already-restored workspace can be restored again. Under
                    // "the server is the authority" that is a meaningful
                    // operation and not a mistake: it is how you discard local
                    // drift wholesale and take the server's state, without
                    // hand-deleting `.magnus/`. Fetch stays the per-file way.
                    const existing = await readMagnusJson(root).catch(() => null);
                    if (!existing) {
                        await vscode.window.showInformationMessage(
                            "Magnus Local: this workspace already has its sync state. "
                            + "Use Fetch from Server to pick up server changes."
                        );
                        return;
                    }

                    const again = await vscode.window.showInformationMessage(
                        "Magnus Local: this workspace is already restored. Restore it again from the server?",
                        {
                            modal: true,
                            detail: "Everything is re-downloaded and local files are replaced "
                                + "with the server's version."
                        },
                        "Restore Again"
                    );
                    if (again !== "Restore Again") {
                        return;
                    }
                    selection = existing;
                }
                else {
                    selection = state.magnusJson;
                }

                const serverUrl = selection.server.url;
                if (!await ensureConnected(context, api, secrets, serverUrl)) {
                    return;
                }

                // The server is the authority, so this overwrites. Committed
                // content is recoverable through git, but work that was never
                // committed is not recoverable at all, and Restore cannot tell
                // the two apart. One prompt, before anything is written.
                const proceed = await vscode.window.showWarningMessage(
                    `Restore replaces local files with the server's version from ${serverUrl}.`,
                    {
                        modal: true,
                        detail: "Anything here that has not been committed will be lost. "
                            + "Commit or stash first if you want to keep it.\n\n"
                            + "Afterwards, review what changed with git diff and commit it."
                    },
                    "Restore from Server"
                );
                if (proceed !== "Restore from Server") {
                    return;
                }

                let summary: HydrateSummary;
                try {
                    summary = await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: `Restoring from ${selection.server.alias}`,
                            cancellable: false
                        },
                        (progress) => hydrateWorkspace(api, root, selection, progress)
                    );
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    await vscode.window.showErrorMessage(`Restore failed: ${message}`);
                    return;
                }

                await onHydrated();

                if (summary.unresolved.length > 0) {
                    void vscode.window.showWarningMessage(
                        `Magnus Local: could not find ${summary.unresolved.join(", ")} on `
                        + `${selection.server.url}. This usually means the plugin there does `
                        + "not serve that content type, or your account cannot see it. "
                        + "The rest of the workspace was restored."
                    );
                }

                if (summary.rootsMissingBuildUri.length > 0) {
                    void vscode.window.showWarningMessage(
                        "Magnus Local: the server did not report a deploy endpoint for "
                        + `${summary.rootsMissingBuildUri.join(", ")}, so Deploy stays hidden for those.`
                    );
                }

                const changed = changedCount(summary);
                await vscode.window.showInformationMessage(
                    `Magnus Local: restored from the server, ${describeSummary(summary)}.`
                    + (changed > 0
                        ? ` Source Control is clean because this workspace now matches the server; `
                          + `review the ${changed} changed file${changed === 1 ? "" : "s"} with `
                          + "git diff and commit them to bring the repository up to date."
                        : " Source Control is clean and the repository is already current.")
                );
            }
        ),

        vscode.commands.registerCommand(
            "magnusLocal.connectWorkspaceServer",
            async (arg?: { serverUrl?: string }) => {
                let serverUrl = arg?.serverUrl;

                if (!serverUrl) {
                    const folders = vscode.workspace.workspaceFolders ?? [];
                    for (const folder of folders) {
                        const state = await classifyWorkspace(folder.uri.fsPath);
                        if (state.kind === "needs-hydrate") {
                            serverUrl = state.magnusJson.server.url;
                            break;
                        }
                        if (state.kind === "hydrated") {
                            serverUrl = state.manifest.server.url;
                            break;
                        }
                    }
                }

                if (!serverUrl) {
                    await vscode.window.showInformationMessage(
                        "Magnus Local: no workspace server to connect to."
                    );
                    return;
                }

                if (await promptAndLogin(context, api, secrets, serverUrl, `Connect to ${serverUrl}`)) {
                    await vscode.window.showInformationMessage(`Connected to ${serverUrl}.`);
                    await onHydrated();
                }
            }
        )
    ];
}
