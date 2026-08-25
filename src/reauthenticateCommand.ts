import * as vscode from "vscode";
import { Api } from "./api";
import { Secrets } from "./secrets";
import { addKnownServer } from "./serverConnection";

/**
 * Prompt for credentials, verify them against the server, and save them.
 *
 * Shared by re-authentication and by connecting a cloned workspace's server,
 * because the two differ only in wording and in whether the server is already
 * in the list. Returns whether credentials were saved; callers use that to
 * decide whether to continue with whatever needed the connection.
 *
 * Registers the server in `KnownServers` on success. That matters: this used to
 * write SecretStorage only, so connecting to a server that was not already in
 * the list left working credentials attached to a server the tree refused to
 * display. Idempotent for servers already listed.
 */
export async function promptAndLogin(
    context: vscode.ExtensionContext,
    api: Api,
    secrets: Secrets,
    serverUrl: string,
    title: string
): Promise<boolean> {
    const existing = await secrets.getCredentials(serverUrl);

    const username = await vscode.window.showInputBox({
        title: `${title} (1 of 2)`,
        prompt: "Username",
        value: existing?.username ?? ""
    });
    if (!username) {
        return false;
    }

    const password = await vscode.window.showInputBox({
        title: `${title} (2 of 2)`,
        prompt: "Password",
        password: true
    });
    if (!password) {
        return false;
    }

    const ok = await api.login(serverUrl, username, password);
    if (!ok) {
        await vscode.window.showErrorMessage(
            `Could not sign in to ${serverUrl}. Double-check the credentials and try again.`
        );
        return false;
    }

    await secrets.saveCredentials(serverUrl, username, password);
    await addKnownServer(context.globalState, serverUrl);
    return true;
}

/**
 * Register the `magnusLocal.reauthenticateServer` command.
 *
 * Used by local-mode error handlers (the SCM provider's auth-failure toast
 * and the tree's right-click menu on a server node) to re-prompt for
 * credentials when a server's stored login has gone stale. Doesn't replace
 * the upstream `magnus.removeServer` flow — that still works for actual
 * server removal. This is the lighter "session expired" recovery path.
 *
 * Accepts an optional `ITreeNode` (when invoked from the tree) or
 * `{ serverUrl: string }` shim (when invoked programmatically by the SCM
 * provider's auth-failure handler). Falls back to a quick-pick over known
 * servers when invoked from the command palette with no arguments.
 */
export function registerReauthenticateCommand(
    context: vscode.ExtensionContext,
    api: Api,
    secrets: Secrets
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand(
            "magnusLocal.reauthenticateServer",
            async (arg?: { serverUrl?: string }) => {
                let serverUrl = arg?.serverUrl;

                if (!serverUrl) {
                    const knownServers = context.globalState.get<string[]>("KnownServers", []);
                    if (knownServers.length === 0) {
                        await vscode.window.showInformationMessage(
                            "No servers configured to re-authenticate."
                        );
                        return;
                    }
                    if (knownServers.length === 1) {
                        serverUrl = knownServers[0];
                    }
                    else {
                        const pick = await vscode.window.showQuickPick(knownServers, {
                            title: "Re-authenticate Server",
                            placeHolder: "Choose which server's credentials to update"
                        });
                        if (!pick) {
                            return;
                        }
                        serverUrl = pick;
                    }
                }

                const ok = await promptAndLogin(
                    context,
                    api,
                    secrets,
                    serverUrl,
                    `Re-authenticate ${serverUrl}`
                );
                if (ok) {
                    await vscode.window.showInformationMessage(`Re-authenticated ${serverUrl}.`);
                }
            }
        )
    ];
}
