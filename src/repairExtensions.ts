import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
    INCOMING_SIDECAR_PATH,
    readIncomingSidecar,
    writeIncomingSidecar
} from "./incomingSidecar";
import { Manifest, readManifest, writeManifest } from "./manifest";
import { planRename } from "./repairPlan";

// Re-export for callers that already import from this file.
export { migratedRelPath, planRename } from "./repairPlan";

/**
 * Migration command for workspaces pulled before v1.2.1, when filenames on
 * disk took the server's `displayName` verbatim ("Content", "Metadata",
 * "CSS Styles") with no extension. VS Code couldn't language-detect on
 * those bare names, so Lava files showed as plain text or sniffed as HTML.
 *
 * v1.2.1 fixes pull/fetch to append the extension recovered from the
 * content URI. This command applies the same rule to existing pulled
 * workspaces: walks the manifest, renames each leaf that gained an
 * extension, and updates baselines, incoming bytes, and the sidecar in
 * lockstep so SCM state stays consistent.
 *
 * Idempotent. Re-running on an already-migrated workspace is a no-op.
 */
export function registerRepairExtensionsCommand(): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand("magnusLocal.repairFileExtensions", async () => {
            const folders = vscode.workspace.workspaceFolders ?? [];
            const candidates: { root: string; manifest: Manifest }[] = [];
            for (const folder of folders) {
                const root = folder.uri.fsPath;
                let manifest: Manifest | null;
                try {
                    manifest = await readManifest(root);
                }
                catch {
                    continue;
                }
                if (manifest) {
                    candidates.push({ root, manifest });
                }
            }

            if (candidates.length === 0) {
                void vscode.window.showInformationMessage(
                    "Magnus Local: no pulled workspace found in this window."
                );
                return;
            }

            // Compute previews so the confirm dialog can show a real count
            // before the user commits to renames.
            const previews = candidates.map(c => ({
                ...c,
                plan: planRename(c.manifest)
            }));
            const totalRenames = previews.reduce((sum, p) => sum + p.plan.size, 0);

            if (totalRenames === 0) {
                void vscode.window.showInformationMessage(
                    "Magnus Local: nothing to repair — all tracked files already have the right extensions."
                );
                return;
            }

            const summary = previews
                .filter(p => p.plan.size > 0)
                .map(p => `• ${path.basename(p.root)}: ${p.plan.size} files`)
                .join("\n");

            const choice = await vscode.window.showWarningMessage(
                `Magnus Local will rename ${totalRenames} file${totalRenames === 1 ? "" : "s"} to add extensions parsed from their server URIs:\n${summary}\n\nBaselines and incoming entries are updated in lockstep. Local edits are preserved.`,
                { modal: true },
                "Repair"
            );
            if (choice !== "Repair") {
                return;
            }

            let totalRenamed = 0;
            const errors: string[] = [];
            for (const { root, manifest, plan } of previews) {
                if (plan.size === 0) {
                    continue;
                }
                try {
                    const renamed = await applyRenames(root, manifest, plan);
                    totalRenamed += renamed;
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`${path.basename(root)}: ${msg}`);
                }
            }

            if (errors.length > 0) {
                void vscode.window.showWarningMessage(
                    `Magnus Local repair completed with errors. Renamed ${totalRenamed}, failed:\n${errors.join("\n")}`
                );
            }
            else {
                void vscode.window.showInformationMessage(
                    `Magnus Local: repaired ${totalRenamed} file${totalRenamed === 1 ? "" : "s"}. Reload the window to refresh language detection.`
                );
            }
        })
    ];
}

/**
 * Apply a precomputed rename plan: move files in the working tree, baseline
 * directory, and incoming directory; rewrite the manifest's `items` map and
 * the incoming sidecar; return the count actually renamed.
 */
async function applyRenames(
    root: string,
    manifest: Manifest,
    plan: Map<string, string>
): Promise<number> {
    let renamed = 0;
    const newItems: Manifest["items"] = {};
    for (const [relPath, entry] of Object.entries(manifest.items)) {
        const next = plan.get(relPath);
        if (!next) {
            newItems[relPath] = entry;
            continue;
        }

        await moveIfPresent(path.join(root, relPath), path.join(root, next));
        await moveIfPresent(
            path.join(root, ".magnus", "baseline", relPath),
            path.join(root, ".magnus", "baseline", next)
        );
        await moveIfPresent(
            path.join(root, ".magnus", "incoming", relPath),
            path.join(root, ".magnus", "incoming", next)
        );

        newItems[next] = entry;
        renamed++;
    }
    manifest.items = newItems;
    await writeManifest(root, manifest);

    // Migrate the incoming sidecar's keyed entries too — they reference
    // relPaths that the manifest just renamed underneath them.
    const sidecar = await readIncomingSidecar(root);
    let sidecarMutated = false;
    const newSidecarItems: typeof sidecar.items = {};
    for (const [relPath, entry] of Object.entries(sidecar.items)) {
        const next = plan.get(relPath);
        if (next) {
            newSidecarItems[next] = entry;
            sidecarMutated = true;
        }
        else {
            newSidecarItems[relPath] = entry;
        }
    }
    if (sidecarMutated) {
        sidecar.items = newSidecarItems;
        await writeIncomingSidecar(root, sidecar);
    }

    return renamed;
}

async function moveIfPresent(from: string, to: string): Promise<void> {
    try {
        await fs.access(from);
    }
    catch {
        return;
    }
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
}

// Re-export so other modules don't have to import from `./incomingSidecar`
// just to find the path constant.
export { INCOMING_SIDECAR_PATH };
