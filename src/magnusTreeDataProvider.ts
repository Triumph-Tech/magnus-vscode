import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { Api } from "./api";
import { Events } from "./events";
import { IconCache } from "./iconCache";

/** The custom scheme used in building URIs for Visual Studio Code. */
const customUriSchemeInsecure = "ttmagnus";
const customUriSchemeSecure = "ttmagnuss";

export class MagnusTreeDataProvider implements vscode.Disposable, vscode.TreeDataProvider<ITreeNode | undefined>, vscode.FileSystemProvider {
    private context: vscode.ExtensionContext;
    private events?: Events;
    private api: Api;
    private iconCache: IconCache = new IconCache();
    private didChangeTreeData: vscode.EventEmitter<ITreeNode | undefined> = new vscode.EventEmitter<ITreeNode | undefined>();
    private treeNodeTable: Record<string, ITreeNode> = {};
    private parentItemLookup: Record<string, ITreeNode> = {};

    // #region Constructors

    public constructor(context: vscode.ExtensionContext, events: Events, api: Api) {
        this.context = context;
        this.events = events;
        this.api = api;

        context.subscriptions.push(vscode.workspace.registerFileSystemProvider(customUriSchemeInsecure, this));
        context.subscriptions.push(vscode.workspace.registerFileSystemProvider(customUriSchemeSecure, this));
        context.subscriptions.push(vscode.window.registerTreeDataProvider("magnus-servers", this));

        this.events.onServerAdded(this.onKnownServersChanged.bind(this));
        this.events.onServerRemoved(this.onKnownServersChanged.bind(this));
        this.events.onRefreshFolder(this.onRefreshFolder.bind(this));
        this.events.onBuildUrl(this.onBuildUrl.bind(this));
        this.events.onUploadUrl(this.onUploadUrl.bind(this));
        this.events.onUploadFolderUrl(this.onUploadFolderUrl.bind(this));
        this.events.onNewFile(this.onNewFile.bind(this));
        this.events.onNewFolder(this.onNewFolder.bind(this));
        this.events.onDeleteUrl(this.onDeleteUrl.bind(this));
        this.events.onCopyId(this.onCopyId.bind(this));
        this.events.onCopyGuid(this.onCopyGuid.bind(this));
        this.events.onCopyValue(this.onCopyValue.bind(this));
        this.events.onRemoteView(this.onRemoteView.bind(this));
        this.events.onRemoteEdit(this.onRemoteEdit.bind(this));

        this.initNoServersContext();
    }

    /** @inheritdoc */
    public dispose(): void {
        this.events = undefined;
    }

    // #endregion

    // #region TreeDataProvider<ITreeNode>

    /** @inheritdoc */
    public readonly onDidChangeTreeData: vscode.Event<ITreeNode | undefined> = this.didChangeTreeData.event;

    /** @inheritdoc */
    public async getTreeItem(element: ITreeNode): Promise<vscode.TreeItem> {
        const iconPath = await this.getTreeItemIconPair(element.serverUrl, element.itemDescriptor.icon, element.itemDescriptor.iconDark);

        this.treeNodeTable[element.resource.toString()] = element;

        const node: vscode.TreeItem = {
            resourceUri: element.resource,
            collapsibleState: element.itemDescriptor.isFolder ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
            label: element.itemDescriptor.displayName,
            tooltip: element.itemDescriptor.tooltip ?? undefined,
            iconPath,
            command: element.itemDescriptor.isFolder ? void 0 : {
                command: "vscode.open",
                arguments: [element.resource],
                title: "Open File"
            },
            contextValue: this.getContextValue(element)
        };

        const hasOpenCommand = element.itemDescriptor.disableOpenFile !== true
            && !element.itemDescriptor.isFolder
            && (element.itemDescriptor.uri || element.isServer);

        if (hasOpenCommand) {
            node.command = {
                command: "vscode.open",
                arguments: [element.resource],
                title: "Open File"
            };
        }

        return node;
    }

    /** @inheritdoc */
    public async getChildren(element?: ITreeNode | undefined): Promise<ITreeNode[]> {
        if (!element) {
            return await this.getServerNodes();
        }
        else if (!element.itemDescriptor.uri && !element.isServer) {
            return [];
        }
        else {
            const childItemDescriptors = await this.api.getChildItems(element.serverUrl, element.itemDescriptor.uri ?? "");

            const items = childItemDescriptors.map(item => {
                return {
                    serverUrl: element.serverUrl,
                    resource: this.getResourceFromWebUrl(element.serverUrl, item.uri),
                    itemDescriptor: item,
                    isServer: false
                };
            });

            for (const item of items) {
                this.parentItemLookup[item.resource.toString()] = element;
            }

            return items;
        }
    }

    // #endregion

    // #region Private Functions

    /**
     * Initialize the "magnus:noServers" context variable so that the welcome
     * content will only show if no servers have been configured. Otherwise it
     * shows for about 1 second while the extension finishes loading.
     */
    private async initNoServersContext(): Promise<void> {
        const servers = this.context.globalState.get<string[]>("KnownServers", []);

        await vscode.commands.executeCommand("setContext", "magnus:noServers", servers.length === 0);
    }

    /**
     * Gets the nodes to use for the server list.
     *
     * @returns An array of tree node items.
     */
    private async getServerNodes(): Promise<ITreeNode[]> {
        const nodes: ITreeNode[] = [];
        const servers = this.context.globalState.get<string[]>("KnownServers", []);

        for (const server of servers) {
            try {
                const uri = vscode.Uri.parse(server);
                let descriptor: IItemDescriptor | null = null;

                try {
                    descriptor = await this.api.getServerDescriptor(server);
                }
                catch (e) {
                    console.log("Failed to get server descriptor.", e);
                }

                nodes.push({
                    serverUrl: server,
                    isServer: true,
                    resource: vscode.Uri.from({
                        scheme: uri.scheme.toLowerCase() === "https" ? customUriSchemeSecure : customUriSchemeInsecure,
                        authority: uri.authority
                    }),
                    itemDescriptor: {
                        displayName: uri.authority,
                        tooltip: descriptor?.tooltip || uri.authority,
                        isFolder: true,
                        icon: descriptor?.icon || "$(server)",
                        iconDark: descriptor?.iconDark || "$(server)",
                        buildUri: descriptor?.buildUri,
                        uploadFileUri: descriptor?.uploadFileUri,
                        uploadFolderUri: descriptor?.uploadFolderUri,
                        uri: ""
                    }
                });
            }
            catch {
                // Intentionally left blank.
            }
        }

        return nodes;
    }

    /**
     * Get the context value to use for the tree node.
     *
     * @param node The node whose context value should be calculated.
     *
     * @returns A string that should be passed to the contextValue of the tree item.
     */
    private getContextValue(node: ITreeNode): string {
        const type = node.isServer
            ? "server"
            : (node.itemDescriptor.isFolder ? "folder" : "file");

        let context = `${type}_`;

        if (node.itemDescriptor.id !== null && node.itemDescriptor.id !== undefined && node.itemDescriptor.id !== "") {
            context = `${context}canCopyId_`;
        }

        if (node.itemDescriptor.guid !== null && node.itemDescriptor.guid !== undefined && node.itemDescriptor.guid !== "") {
            context = `${context}canCopyGuid_`;
        }

        if (node.itemDescriptor.copyValue) {
            context = `${context}canCopyValue_`;
        }

        if (node.itemDescriptor.remoteViewUri) {
            context = `${context}canView_`;
        }

        if (node.itemDescriptor.remoteEditUri) {
            context = `${context}canEdit_`;
        }

        if (node.itemDescriptor.deleteUri) {
            context = `${context}canDelete_`;
        }

        if (node.itemDescriptor.newFileUri) {
            context = `${context}canNewFile_`;
        }

        if (node.itemDescriptor.newFolderUri) {
            context = `${context}canNewFolder_`;
        }

        if (node.itemDescriptor.uploadFileUri) {
            context = `${context}canUpload_`;
        }

        if (node.itemDescriptor.uploadFolderUri) {
            context = `${context}canUploadFolder_`;
        }

        if (node.itemDescriptor.buildUri) {
            context = `${context}canBuild_`;
        }

        return context;
    }

    /**
     * Gets the icon path element for a tree item.
     *
     * @param serverUrl The URL of the server when the icon path does not contain a scheme and host.
     * @param uri The URI of the icon. This should be changed to the object interface.
     * @param darkUri The URI of the icon. This should be changed to the object interface.
     *
     * @returns The iconPath object that can be used for a TreeItem.
     */
    private async getTreeItemIconPair(serverUrl: string, uri?: string | null, darkUri?: string | null): Promise<string | vscode.Uri | { light: string | vscode.Uri; dark: string | vscode.Uri } | vscode.ThemeIcon | undefined> {
        if (!uri) {
            return undefined;
        }

        // Check if the icon is a standard icon reference.
        const themeIconMatch = uri.match(/^\$\(([^)]+)\)/);
        if (themeIconMatch !== null) {
            return new vscode.ThemeIcon(themeIconMatch[1]);
        }

        // Load the light icon from the remote URI.
        try {
            const light = await this.iconCache.getIcon(this.getFullyQualifiedUrl(serverUrl, uri));
            if (light === null) {
                return undefined;
            }

            // Try to load the dark icon from the remote URI.
            let dark = darkUri ? (await this.iconCache.getIcon(this.getFullyQualifiedUrl(serverUrl, darkUri))) : null;
            if (dark === null) {
                dark = light;
            }

            return {
                light: vscode.Uri.parse(light),
                dark: vscode.Uri.parse(dark)
            };
        }
        catch (e) {
            console.error(e);
            return undefined;
        }
    }

    /**
     * Get a Visual Studio Code resource URI based on the server URL and the
     * absolute path in the provided URL.
     *
     * @param serverUrl The server URL that is handling requests for the url.
     * @param url The url that needs to be translated into a resource.
     *
     * @returns A Uri object that represents the resource.
     */
    private getResourceFromWebUrl(serverUrl: string, url?: string | null): vscode.Uri {
        const serverUri = vscode.Uri.parse(serverUrl);
        const scheme = serverUri.scheme.toLowerCase() === "https"
            ? customUriSchemeSecure
            : customUriSchemeInsecure;

        if (url === undefined || url === null) {
            return vscode.Uri.parse(`${scheme}://${serverUri.authority}/${randomUUID()}`);
        }

        if (url.includes("://")) {
            return vscode.Uri.parse(url);
        }

        if (url.toLowerCase().startsWith("/api/triumphtech/magnus")) {
            return vscode.Uri.parse(`${scheme}://${serverUri.authority}${url.substring(23)}`);
        }
        else {
            return vscode.Uri.parse(`${scheme}://${serverUri.authority}${url}`);
        }
    }

    /**
     * Gets the full HTTP or HTTPS URL for the given Visual Studio Code
     * resource URI.
     *
     * @param uri The URI that needs to be translated.
     *
     * @returns A string that represents the URL on the web.
     */
    private getWebUrlFromResource(uri: vscode.Uri): string {
        if (uri.scheme !== customUriSchemeInsecure && uri.scheme !== customUriSchemeSecure) {
            throw new Error("Unexpected scheme.");
        }

        return vscode.Uri.from({
            scheme: uri.scheme === customUriSchemeSecure ? "https" : "http",
            authority: uri.authority,
            path: `/api/TriumphTech/Magnus${uri.path}`,
            query: uri.query,
            fragment: uri.fragment
        }).toString();
    }

    /**
     * Ensures that the URL is fully qualified with a scheme and host. If not
     * then it will use the scheme and host from the server URL.
     *
     * @param serverUrl The server associated with this URL.
     * @param url The URL that will be checked to see if it is fully qualified.
     *
     * @returns A new string that is fully qualified if the original was not.
     */
    private getFullyQualifiedUrl(serverUrl: string, url: string): string {
        if (url.includes("://")) {
            return url;
        }

        if (!url.startsWith("/")) {
            return `${serverUrl}/${url.substring}`;
        }
        else {
            return `${serverUrl}${url}`;
        }
    }

    // #endregion

    // #region Event Handlers

    /**
     * Called when the list of known servers has changed.
     */
    private onKnownServersChanged(): void {
        this.didChangeTreeData.fire(undefined);
    }

    /**
     * Called when a folder should be refreshed.
     *
     * @param item The folder item that should be refreshed.
     */
    private onRefreshFolder(item: ITreeNode): void {
        this.didChangeTreeData.fire(item);
    }

    /**
     * Called when a node should be built by the server. Perform a POST
     * operation to the specified callback URL.
     *
     * @param item The node item that should be built.
     */
    private onBuildUrl(item: ITreeNode): void {
        if (!item.itemDescriptor.buildUri) {
            return;
        }

        const buildUrl = this.getFullyQualifiedUrl(item.serverUrl, item.itemDescriptor.buildUri);

        const options: vscode.ProgressOptions = {
            cancellable: false,
            location: vscode.ProgressLocation.Notification,
            title: `Building ${item.itemDescriptor.displayName}`
        };

        vscode.window.withProgress(options, async progress => {
            try {
                const response = await this.api.buildUrl(buildUrl);

                if (response.actionSuccessful) {
                    progress.report({
                        message: response.responseMessage || "Complete"
                    });
                }
                else {
                    progress.report({
                        message: "Complete"
                    });

                    vscode.window.showErrorMessage(response.responseMessage || "Build failed.");
                }

                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            catch (error) {
                if (error instanceof Error) {
                    vscode.window.showErrorMessage(error.message);
                }
            }
        });
    }

    /**
     * Called when a node should be built by the server. Perform a POST
     * operation to the specified callback URL.
     *
     * @param item The node item that should be built.
     */
    private async onNewFile(item: ITreeNode): Promise<void> {
        if (!item.itemDescriptor.newFileUri) {
            return;
        }

        const url = this.getFullyQualifiedUrl(item.serverUrl, item.itemDescriptor.newFileUri);

        const name = await vscode.window.showInputBox({
            title: "Please enter the name of the file to create."
        });

        if (!name) {
            return;
        }

        const options: vscode.ProgressOptions = {
            cancellable: false,
            location: vscode.ProgressLocation.Notification,
            title: `Creating ${name}`
        };

        vscode.window.withProgress(options, async progress => {
            try {
                const response = await this.api.createNewFile(url, name);

                if (response.actionSuccessful) {
                    progress.report({
                        message: response.responseMessage || "Complete"
                    });
                }
                else {
                    progress.report({
                        message: "Complete"
                    });

                    vscode.window.showErrorMessage(response.responseMessage || "Failed to create new file.");
                }

                const parentItem = this.parentItemLookup[item.resource.toString()];

                if (parentItem) {
                    this.didChangeTreeData.fire(parentItem);
                }

                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            catch (error) {
                if (error instanceof Error) {
                    vscode.window.showErrorMessage(error.message);
                }
            }
        });
    }

    /**
     * Called when a node should be built by the server. Perform a POST
     * operation to the specified callback URL.
     *
     * @param item The node item that should be built.
     */
     private async onNewFolder(item: ITreeNode): Promise<void> {
        if (!item.itemDescriptor.newFolderUri) {
            return;
        }

        const url = this.getFullyQualifiedUrl(item.serverUrl, item.itemDescriptor.newFolderUri);

        const name = await vscode.window.showInputBox({
            title: "Please enter the name of the folder to create."
        });

        if (!name) {
            return;
        }

        const options: vscode.ProgressOptions = {
            cancellable: false,
            location: vscode.ProgressLocation.Notification,
            title: `Creating ${name}`
        };

        vscode.window.withProgress(options, async progress => {
            try {
                const response = await this.api.createNewFolder(url, name);

                if (response.actionSuccessful) {
                    progress.report({
                        message: response.responseMessage || "Complete"
                    });
                }
                else {
                    progress.report({
                        message: "Complete"
                    });

                    vscode.window.showErrorMessage(response.responseMessage || "Failed to create new folder.");
                }

                const parentItem = this.parentItemLookup[item.resource.toString()];

                if (parentItem) {
                    this.didChangeTreeData.fire(parentItem);
                }

                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            catch (error) {
                if (error instanceof Error) {
                    vscode.window.showErrorMessage(error.message);
                }
            }
        });
    }

    /**
     * Called when a node should have new files uploaded to it. Perform a POST
     * operation to the specified callback URL.
     *
     * @param item The node item that should be built.
     */
    private async onUploadUrl(item: ITreeNode): Promise<void> {
        if (!item.itemDescriptor.uploadFileUri) {
            return;
        }

        const uploadUrl = this.getFullyQualifiedUrl(item.serverUrl, item.itemDescriptor.uploadFileUri);

        const fileUris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true
        });

        if (!fileUris || fileUris.length === 0) {
            return;
        }

        const options: vscode.ProgressOptions = {
            cancellable: false,
            location: vscode.ProgressLocation.Notification,
            title: `Uploading to ${item.itemDescriptor.displayName}`
        };

        vscode.window.withProgress(options, async progress => {
            try {
                const response = await this.api.uploadUrl(uploadUrl, fileUris);

                if (response.actionSuccessful) {
                    progress.report({
                        message: response.responseMessage || "Complete"
                    });
                }
                else {
                    progress.report({
                        message: "Complete"
                    });

                    vscode.window.showErrorMessage(response.responseMessage || "Upload failed.");
                }

                const parentItem = this.parentItemLookup[item.resource.toString()];

                if (parentItem) {
                    this.didChangeTreeData.fire(parentItem);
                }

                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            catch (error) {
                if (error instanceof Error) {
                    vscode.window.showErrorMessage(error.message);
                }
            }
        });
    }

    /**
     * Called when a node should have a folder uploaded to it. Perform a POST
     * operation to the specified callback URL.
     *
     * @param item The node item that should be built.
     */
     private async onUploadFolderUrl(item: ITreeNode): Promise<void> {
        if (!item.itemDescriptor.uploadFolderUri) {
            return;
        }

        const uploadUrl = this.getFullyQualifiedUrl(item.serverUrl, item.itemDescriptor.uploadFolderUri);

        const fileUris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false
        });

        if (!fileUris || fileUris.length !== 1) {
            return;
        }

        const options: vscode.ProgressOptions = {
            cancellable: false,
            location: vscode.ProgressLocation.Notification,
            title: `Uploading to ${item.itemDescriptor.displayName}`
        };

        vscode.window.withProgress(options, async progress => {
            try {
                const response = await this.api.uploadFolderUrl(uploadUrl, fileUris[0]);

                if (response.actionSuccessful) {
                    progress.report({
                        message: response.responseMessage || "Complete"
                    });
                }
                else {
                    progress.report({
                        message: "Complete"
                    });

                    vscode.window.showErrorMessage(response.responseMessage || "Upload failed.");
                }

                const parentItem = this.parentItemLookup[item.resource.toString()];

                if (parentItem) {
                    this.didChangeTreeData.fire(parentItem);
                }

                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            catch (error) {
                if (error instanceof Error) {
                    vscode.window.showErrorMessage(error.message);
                }
            }
        });
    }

    /**
     * Called when a node should be deleted by the server. Perform a DELETE
     * operation to the specified callback URL.
     *
     * @param item The node item that should be built.
     */
    private async onDeleteUrl(item: ITreeNode): Promise<void> {
        if (!item.itemDescriptor.deleteUri) {
            return;
        }

        const deleteUrl = this.getFullyQualifiedUrl(item.serverUrl, item.itemDescriptor.deleteUri);
        console.log("deleteUrl", deleteUrl);

        const verificationResult = await vscode.window.showInformationMessage(`Do you really want to delete '${item.itemDescriptor.displayName}'?`, {
            modal: true
        }, "Delete");

        if (verificationResult !== "Delete") {
            return;
        }

        const options: vscode.ProgressOptions = {
            cancellable: false,
            location: vscode.ProgressLocation.Notification,
            title: `Deleting ${item.itemDescriptor.displayName}`
        };

        vscode.window.withProgress(options, async progress => {
            try {
                const response = await this.api.deleteUrl(deleteUrl);

                if (response.actionSuccessful) {
                    progress.report({
                        message: response.responseMessage || "Complete"
                    });
                }
                else {
                    progress.report({
                        message: "Complete"
                    });

                    vscode.window.showErrorMessage(response.responseMessage || "Delete failed.");
                }

                const parentItem = this.parentItemLookup[item.resource.toString()];

                if (parentItem) {
                    this.didChangeTreeData.fire(parentItem);
                }

                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            catch (error) {
                if (error instanceof Error) {
                    vscode.window.showErrorMessage(error.message);
                }
            }
        });
    }

    /**
     * Called when an identifier should be copied to the clipboard.
     *
     * @param item The item whose value should be copied.
     */
    private onCopyId(item: ITreeNode): void {
        if (item.itemDescriptor.id !== null && item.itemDescriptor.id !== undefined) {
            vscode.env.clipboard.writeText(item.itemDescriptor.id);
        }
    }

    /**
     * Called when an unique identifier should be copied to the clipboard.
     *
     * @param item The item whose value should be copied.
     */
    private onCopyGuid(item: ITreeNode): void {
        if (item.itemDescriptor.guid !== null && item.itemDescriptor.guid !== undefined) {
            vscode.env.clipboard.writeText(item.itemDescriptor.guid);
        }
    }

    /**
     * Called when a value should be copied to the clipboard.
     *
     * @param item The item whose value should be copied.
     */
    private onCopyValue(item: ITreeNode): void {
        if (item.itemDescriptor.copyValue) {
            vscode.env.clipboard.writeText(item.itemDescriptor.copyValue);
        }
    }

    /**
     * Called when an item should be opened on the web for viewing.
     *
     * @param item The item whose value should be copied.
     */
    private onRemoteView(item: ITreeNode): void {
        if (!item.itemDescriptor.remoteViewUri) {
            return;
        }

        const url = this.getFullyQualifiedUrl(item.serverUrl, item.itemDescriptor.remoteViewUri);

        vscode.env.openExternal(vscode.Uri.parse(url));
    }

    /**
     * Called when an item should be opened on the web for editing.
     *
     * @param item The item whose value should be copied.
     */
    private onRemoteEdit(item: ITreeNode): void {
        if (!item.itemDescriptor.remoteEditUri) {
            return;
        }

        const url = this.getFullyQualifiedUrl(item.serverUrl, item.itemDescriptor.remoteEditUri);

        vscode.env.openExternal(vscode.Uri.parse(url));
    }

    // #endregion

    // #region FileSystemProvider

    /** The event emitter for the onDidChangeFile event. */
    private didChangeFile: vscode.EventEmitter<vscode.FileChangeEvent[]> = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

    /** @inheritdoc */
    public onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this.didChangeFile.event;

    /** @inheritdoc */
    public watch(_uri: vscode.Uri, _options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): vscode.Disposable {
        return {
            dispose: () => {
                // Intentionally ignored.
            }
        };
    }

    /** @inheritdoc */
    public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const url = this.getWebUrlFromResource(uri);

        return await this.api.getFileStat(url);
    }

    /** @inheritdoc */
    public readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
        throw new Error("Method not implemented.");
    }

    /** @inheritdoc */
    public createDirectory(_uri: vscode.Uri): void | Thenable<void> {
        throw new Error("Method not implemented.");
    }

    /** @inheritdoc */
    public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const url = this.getWebUrlFromResource(uri);

        return await this.api.getFileContent(url);
    }

    /** @inheritdoc */
    public async writeFile(uri: vscode.Uri, content: Uint8Array, _options: { readonly create: boolean; readonly overwrite: boolean; }): Promise<void> {
        const url = this.getWebUrlFromResource(uri);

        await this.api.updateFileContent(url, content);
    }

    /** @inheritdoc */
    public delete(_uri: vscode.Uri, _options: { readonly recursive: boolean; }): void | Thenable<void> {
        throw new Error("Method not implemented.");
    }

    /** @inheritdoc */
    public rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { readonly overwrite: boolean; }): void | Thenable<void> {
        throw new Error("Method not implemented.");
    }

    // #endregion
}
