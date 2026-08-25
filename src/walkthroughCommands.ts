import * as vscode from "vscode";

/**
 * Commands that back the Getting Started walkthrough surface.
 */
export function registerWalkthroughCommands(): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand("magnus.openWalkthrough", async () => {
            await vscode.commands.executeCommand(
                "workbench.action.openWalkthrough",
                "TriumphTech.magnus#magnus.gettingStarted",
                false
            );
        })
    ];
}
