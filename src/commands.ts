import * as vscode from "vscode";
import * as api from "./api";
import { deleteCredentials, saveCredentials } from "./auth";
import { Events } from "./events";

/**
 * Configures and responds to the general purpose commands used by the extension.
 */
export class Commands implements vscode.Disposable {
    // #region Private Properties

    /** The context we were initialized with. */
    private context: vscode.ExtensionContext;

    /** The Events object that we use to subscribe to events. */
    private events: Events;

    // #endregion

    // #region Constructors

    /**
     * Creates a new instance of the command handler. Commands are automatically
     * registered with the extension context.
     *
     * @param context The context that identifies our extension instance.
     * @param events The events object that we will use to communicate with the rest of the system.
     */
    public constructor(context: vscode.ExtensionContext, events: Events) {
        this.context = context;
        this.events = events;

        context.subscriptions.push(vscode.commands.registerCommand("magnus.addServer", this.addServer, this));
        context.subscriptions.push(vscode.commands.registerCommand("magnus.refreshFolder", this.refreshFolder, this));
        context.subscriptions.push(vscode.commands.registerCommand("magnus.removeServer", this.removeServer, this));
        context.subscriptions.push(vscode.commands.registerCommand("magnus.buildUrl", this.buildUrl, this));
        context.subscriptions.push(vscode.commands.registerCommand("magnus.newFile", this.newFile, this));
        context.subscriptions.push(vscode.commands.registerCommand("magnus.newFolder", this.newFolder, this));
        context.subscriptions.push(vscode.commands.registerCommand("magnus.uploadUrl", this.uploadUrl, this));
        context.subscriptions.push(vscode.commands.registerCommand("magnus.deleteUrl", this.deleteUrl, this));
        context.subscriptions.push(vscode.commands.registerCommand("magnus.copyId", this.copyId, this));
        context.subscriptions.push(vscode.commands.registerCommand("magnus.copyGuid", this.copyGuid, this));
        context.subscriptions.push(vscode.commands.registerCommand("magnus.copyValue", this.copyValue, this));
        context.subscriptions.push(vscode.commands.registerCommand("magnus.remoteView", this.remoteView, this));
        context.subscriptions.push(vscode.commands.registerCommand("magnus.remoteEdit", this.remoteEdit, this));
    }

    public dispose(): void {
        /* Future use */
    }

    // #endregion

    // #region Command Functions

    /**
     * Called when the person wishes to add a new server to the list of
     * known servers.
     */
    private async addServer(): Promise<void> {
        const serverUrl = await this.getAddServerUrl();

        if (!serverUrl) {
            return;
        }

        const username = await vscode.window.showInputBox({
            title: "Add Server (step 2 of 3)",
            prompt: "Username"
        });

        if (!username) {
            return;
        }

        const password = await vscode.window.showInputBox({
            title: "Add Server (step 3 of 3)",
            prompt: "Password",
            password: true
        });

        if (!password) {
            return;
        }

        const knownServers = this.context.globalState.get<string[]>("KnownServers", []);

        if (knownServers.includes(serverUrl)) {
            await vscode.window.showInformationMessage("Server already exists.");
            return;
        }

        if (!api.login(serverUrl, username, password)) {
            await vscode.window.showErrorMessage("Unable to login. Please check server URL and credentials and try again.");
            return;
        }

        await saveCredentials(serverUrl, username, password);
        knownServers.push(serverUrl);

        this.context.globalState.update("KnownServers", knownServers);
        this.events.emitServerAdded();
    }

    /**
     * Called when the person wants to refresh the children of a folder.
     *
     * @param node The node to be refreshed.
     */
    private refreshFolder(node: ITreeNode): void {
        this.events.emitRefreshFolder(node);
    }

    /**
     * Called when the person wants to build the specified node.
     *
     * @param node The node to be built.
     */
    private buildUrl(node: ITreeNode): void {
        this.events.emitBuildUrl(node);
    }

    /**
     * Called when the person wants to create a new file.
     *
     * @param node The parent node the file will be created under.
     */
    private newFile(node: ITreeNode): void {
        this.events.emitNewFile(node);
    }

    /**
     * Called when the person wants to create a new folder.
     *
     * @param node The parent node the folder will be created under.
     */
    private newFolder(node: ITreeNode): void {
        this.events.emitNewFolder(node);
    }

    /**
     * Called when the person wants to uploaded to the specified node.
     *
     * @param node The node to be built.
     */
    private uploadUrl(node: ITreeNode): void {
        this.events.emitUploadUrl(node);
    }

    /**
     * Called when the person wants to delete the specified node.
     *
     * @param node The node to be deleted.
     */
    private deleteUrl(node: ITreeNode): void {
        this.events.emitDeleteUrl(node);
    }

    /**
     * Called when the person wants to copy the id of a node.
     *
     * @param node The node currently selected.
     */
    private copyId(node: ITreeNode): void {
        this.events.emitCopyId(node);
    }

    /**
     * Called when the person wants to copy the guid of a node.
     *
     * @param node The node currently selected.
     */
    private copyGuid(node: ITreeNode): void {
        this.events.emitCopyGuid(node);
    }

    /**
     * Called when the person wants to copy the value of a node.
     *
     * @param node The node currently selected.
     */
    private copyValue(node: ITreeNode): void {
        this.events.emitCopyValue(node);
    }

    /**
     * Called when the person wants to remotely view a node.
     *
     * @param node The node currently selected.
     */
    private remoteView(node: ITreeNode): void {
        this.events.emitRemoteView(node);
    }

    /**
     * Called when the person wants to remotely edit a node.
     *
     * @param node The node currently selected.
     */
    private remoteEdit(node: ITreeNode): void {
        this.events.emitRemoteEdit(node);
    }

    /**
     * Called when the person wants to remove a server.
     *
     * @param node The server node to be removed.
     */
    private async removeServer(node: ITreeNode): Promise<void> {
        const confirmation = await vscode.window.showWarningMessage(`Are you sure you want to remove the server at ${node.serverUrl}?`, {
            modal: true
        }, { title: "Yes" }, { title: "No", isCloseAffordance: true });

        if (confirmation?.title !== "Yes") {
            return;
        }

        const knownServers = this.context.globalState.get<string[]>("KnownServers", []);
        const serverIndex = knownServers.findIndex(s => s === node.serverUrl);

        if (serverIndex === -1) {
            return;
        }

        knownServers.splice(serverIndex, 1);

        this.context.globalState.update("KnownServers", knownServers);
        this.events.emitServerAdded();

        await deleteCredentials(node.serverUrl);
    }

    // #endregion

    // #region Functions

    /**
     * Get the base URL of a server to connect to.
     *
     * @returns The standardized base server URL or undefined if cancelled.
     */
    private async getAddServerUrl(): Promise<string | undefined> {
        let serverUrl = await vscode.window.showInputBox({
            title: "Add Server (step 1 of 3)",
            prompt: "Server URL",
            placeHolder: "https://rock.rocksolidchurchdemo.com"
        });

        if (!serverUrl) {
            return undefined;
        }

        try {
            const uri = vscode.Uri.parse(serverUrl);

            // A scheme of "file" usually means they typed in the name without
            // any http or https specifier.
            if (uri.scheme === "file") {
                serverUrl = `https://${serverUrl}`;
            }
            else {
                serverUrl = `${uri.scheme}://${uri.authority}`;
            }
        }
        catch {
            await vscode.window.showInformationMessage("Invalid server URL specified.");
            return undefined;
        }

        return serverUrl;
    }

    // #endregion
}
