import { promises as fs } from "fs";
import * as vscode from "vscode";
import { PullRegistry } from "./pullRegistry";

/**
 * Register commands that operate on app tree nodes whose pulled workspace
 * path is recorded in the registry (open in a new window, reveal in finder,
 * unlink). These are separate from the pull command itself because they act
 * on registry entries, not on server nodes.
 */
export function registerPulledWorkspaceCommands(
    registry: PullRegistry
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand("magnusLocal.openPulledWorkspace", async (node: ITreeNode | undefined) => {
            const localPath = node?.pulledWorkspacePath;
            if (!localPath) {
                return;
            }
            if (!(await pathExists(localPath))) {
                await handleMissingPath(registry, localPath);
                return;
            }
            await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(localPath), true);
        }),

        vscode.commands.registerCommand("magnusLocal.revealPulledWorkspace", async (node: ITreeNode | undefined) => {
            const localPath = node?.pulledWorkspacePath;
            if (!localPath) {
                return;
            }
            if (!(await pathExists(localPath))) {
                await handleMissingPath(registry, localPath);
                return;
            }
            await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(localPath));
        }),

        vscode.commands.registerCommand("magnusLocal.unlinkPulledWorkspace", async (node: ITreeNode | undefined) => {
            const localPath = node?.pulledWorkspacePath;
            if (!localPath) {
                return;
            }

            const entry = registry.findByLocalPath(localPath);
            if (!entry) {
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Remove "${entry.label}" from the pulled workspaces list? Files on disk at ${entry.localPath} will not be deleted.`,
                { modal: true },
                "Unlink"
            );
            if (confirm !== "Unlink") {
                return;
            }

            await registry.remove(localPath);
        })
    ];
}

async function handleMissingPath(registry: PullRegistry, localPath: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
        `The pulled workspace at ${localPath} no longer exists on disk.`,
        { modal: true },
        "Unlink"
    );
    if (choice === "Unlink") {
        await registry.remove(localPath);
    }
}

async function pathExists(p: string): Promise<boolean> {
    try {
        await fs.stat(p);
        return true;
    }
    catch {
        return false;
    }
}
