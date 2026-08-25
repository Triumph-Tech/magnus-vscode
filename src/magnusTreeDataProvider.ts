import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { Api } from "./api";
import { Events } from "./events";
import { IconCache } from "./iconCache";
import { isAISkillsCollectionNodeUri, isLocalModePullableUri, isMobileAppNodeUri, isThemeNodeUri } from "./pullHelpers";
import { PullRegistry } from "./pullRegistry";
import { SqlObjectExplorer } from "./sql/sqlObjectExplorer";

/** The custom scheme used in building URIs for Visual Studio Code. */
const customUriSchemeInsecure = "ttmagnus";
const customUriSchemeSecure = "ttmagnuss";

export class MagnusTreeDataProvider implements vscode.Disposable, vscode.TreeDataProvider<ITreeNode | undefined>, vscode.FileSystemProvider {
    private context: vscode.ExtensionContext;
    private events?: Events;
    private api: Api;
    private pullRegistry: PullRegistry;
    private pullRegistryListener: vscode.Disposable;
    private iconCache: IconCache = new IconCache();
    private didChangeTreeData: vscode.EventEmitter<ITreeNode | undefined> = new vscode.EventEmitter<ITreeNode | undefined>();
    private treeNodeTable: Record<string, ITreeNode> = {};
    private parentItemLookup: Record<string, ITreeNode> = {};
    private sqlObjectExplorer: SqlObjectExplorer;

    // #region Constructors

    public constructor(context: vscode.ExtensionContext, events: Events, api: Api, pullRegistry: PullRegistry, sqlObjectExplorer: SqlObjectExplorer) {
        this.context = context;
        this.events = events;
        this.api = api;
        this.pullRegistry = pullRegistry;
        this.sqlObjectExplorer = sqlObjectExplorer;

        context.subscriptions.push(vscode.workspace.registerFileSystemProvider(customUriSchemeInsecure, this));
        context.subscriptions.push(vscode.workspace.registerFileSystemProvider(customUriSchemeSecure, this));

        const treeView = vscode.window.createTreeView<ITreeNode | undefined>("magnus-servers", { treeDataProvider: this });
        context.subscriptions.push(treeView);
        this.sqlObjectExplorer.attachTreeView(treeView);
        this.sqlObjectExplorer.onDidChangeNode(node => this.didChangeTreeData.fire(node));

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

        // Pulled-state changes (a new pull, an unlink) repaint the tree so
        // the "Pull to Local…" / "Open Local Workspace" right-click items
        // and the "↓ pulled" description toggle in real time.
        this.pullRegistryListener = pullRegistry.onDidChange(() => {
            this.didChangeTreeData.fire(undefined);
        });

        this.initNoServersContext();
    }

    /** @inheritdoc */
    public dispose(): void {
        this.events = undefined;
        this.pullRegistryListener.dispose();
    }

    // #endregion

    // #region TreeDataProvider<ITreeNode>

    /** @inheritdoc */
    public readonly onDidChangeTreeData: vscode.Event<ITreeNode | undefined> = this.didChangeTreeData.event;

    /** @inheritdoc */
    public async getTreeItem(element: ITreeNode): Promise<vscode.TreeItem> {
        this.treeNodeTable[element.resource.toString()] = element;

        const pulled = this.findPulledWorkspace(element);
        // Mutate the node so other surfaces (right-click handlers, the
        // Pulled Workspaces commands) can read pulledWorkspacePath without
        // re-querying the registry.
        element.pulledWorkspacePath = pulled?.localPath;

        // Pulled nodes for certain VFS types show a distinct icon instead of
        // the "↓ pulled" text label. The server sends a full URL like:
        //   …/Assets/Icons/themes-theme.svg
        // For each supported type we swap the filename to its local variant
        // when the node is pulled into a local workspace.
        const isPulledTheme = !!pulled && isThemeNodeUri(element.itemDescriptor.uri);
        const isPulledAISkills = !!pulled && isAISkillsCollectionNodeUri(element.itemDescriptor.uri);
        const isPulledMobileApp = !!pulled && isMobileAppNodeUri(element.itemDescriptor.uri);
        const isPulledLocalIcon = isPulledTheme || isPulledAISkills || isPulledMobileApp;

        let effectiveIcon = element.itemDescriptor.icon;
        if (isPulledTheme) {
            effectiveIcon = (effectiveIcon ?? "").replace(/themes-theme\.svg(\b|$)/, "themes-theme-local.svg");
        }
        else if (isPulledAISkills) {
            effectiveIcon = (effectiveIcon ?? "").replace(/aiskills\.svg(\b|$)/, "aiskills-local.svg");
        }
        else if (isPulledMobileApp) {
            effectiveIcon = (effectiveIcon ?? "").replace(/mobileapps-app\.svg(\b|$)/, "mobileapps-app-local.svg");
        }

        const iconPath = await this.getTreeItemIconPair(element.serverUrl, effectiveIcon, element.itemDescriptor.iconDark);

        const node: vscode.TreeItem = {
            resourceUri: element.resource,
            collapsibleState: element.itemDescriptor.isFolder ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
            label: element.itemDescriptor.displayName,
            // Pulled-state hint shown after the label in dimmed text for
            // nodes that do not have a dedicated local icon. Nodes with a
            // local icon variant use that instead of the text badge.
            description: (pulled && !isPulledLocalIcon) ? "↓ pulled" : undefined,
            tooltip: pulled
                ? `${element.itemDescriptor.tooltip ?? element.itemDescriptor.displayName}\n\nPulled to: ${pulled.localPath}`
                : (element.itemDescriptor.tooltip ?? undefined),
            iconPath,
            command: element.itemDescriptor.isFolder ? void 0 : {
                command: "vscode.open",
                arguments: [element.resource],
                title: "Open File"
            },
            contextValue: this.getContextValue(element)
        };

        // Let the SQL subtree adjust its own nodes.
        this.sqlObjectExplorer.decorateTreeItem(element, node);

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

    /**
     * Look up an existing pulled workspace for this tree node, if any.
     * Match key is `(serverUrl, descriptor.uri)` — the same pair stored by
     * the pull command. Returns `undefined` for server nodes (we never
     * pull a whole server) and for nodes with no URI.
     */
    private findPulledWorkspace(node: ITreeNode): ReturnType<PullRegistry["list"]>[number] | undefined {
        if (node.isServer) {
            return undefined;
        }
        if (!node.itemDescriptor.uri) {
            return undefined;
        }
        return this.pullRegistry
            .list()
            .find(w => w.serverUrl === node.serverUrl && w.rootUri === node.itemDescriptor.uri);
    }

    /** @inheritdoc */
    public async getChildren(element?: ITreeNode | undefined): Promise<ITreeNode[]> {
        if (!element) {
            return this.getServerNodes();
        }

        // The SQL subtree loads its own children.
        const sqlChildren = await this.sqlObjectExplorer.getChildren(element);

        if (sqlChildren) {
            return sqlChildren;
        }

        if (!element.itemDescriptor.uri && !element.isServer) {
            return [];
        }
        else {
            const childItemDescriptors = await this.api.getChildItems(element.serverUrl, element.itemDescriptor.uri ?? "");

            // Local-mode bookkeeping: when the parent of these children IS a
            // server (i.e. element is a server), each child is a top-level
            // group like "Mobile Apps". Children of THAT group get the group
            // name as `parentGroupName`, used by the pull command to lay out
            // disk paths like `<server>/Mobile Apps/My App/...`. For deeper
            // descendants we copy the parent's parentGroupName forward so a
            // sub-folder under an app still knows its top-level group.
            const childParentGroupName = element.isServer
                ? undefined
                : (element.parentGroupName ?? element.itemDescriptor.displayName);

            const items: ITreeNode[] = childItemDescriptors.map(item => {
                return {
                    serverUrl: element.serverUrl,
                    resource: this.getResourceFromWebUrl(element.serverUrl, item.uri),
                    itemDescriptor: item,
                    isServer: false,
                    parentGroupName: childParentGroupName
                };
            });

            for (const item of items) {
                this.parentItemLookup[item.resource.toString()] = element;
            }

            if (element.isServer) {
                items.push(this.sqlObjectExplorer.getSqlRootNode(element));
            }

            return items;
        }
    }

    /** @inheritdoc */
    public getParent(element: ITreeNode): ITreeNode | undefined {
        return this.sqlObjectExplorer.getParent(element)
            ?? this.parentItemLookup[element.resource.toString()];
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
     * Built synchronously from the saved `KnownServers` list, with no
     * network round-trips. We used to call `GetServer` per server here to obtain a
     * descriptor, but the server currently returns only a placeholder icon
     * string and no other useful fields, so the call blocked initial tree
     * rendering for no payoff (visibly slow with many servers). If/when the
     * server starts returning real per-server tooltips or menu URIs, re-add
     * the fetch lazily and repaint individual rows via `didChangeTreeData`.
     *
     * @returns An array of tree node items.
     */
    private getServerNodes(): ITreeNode[] {
        const nodes: ITreeNode[] = [];
        const servers = this.context.globalState.get<string[]>("KnownServers", []);

        for (const server of servers) {
            try {
                const uri = vscode.Uri.parse(server);

                nodes.push({
                    serverUrl: server,
                    isServer: true,
                    resource: vscode.Uri.from({
                        scheme: uri.scheme.toLowerCase() === "https" ? customUriSchemeSecure : customUriSchemeInsecure,
                        authority: uri.authority
                    }),
                    itemDescriptor: {
                        displayName: uri.authority,
                        tooltip: uri.authority,
                        isFolder: true,
                        icon: "$(server)",
                        iconDark: "$(server)",
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

        // Theme nodes get an additional marker so menus can show
        // "Compile Theme" instead of the default "Deploy" label. The
        // underlying command (`magnus.buildUrl`) is unchanged; only the
        // per-menu title differs based on this marker.
        if (isThemeNodeUri(node.itemDescriptor.uri)) {
            context = `${context}isTheme_`;
        }

        // Local-mode markers. Scoped to root nodes for content types
        // that local mode supports today: mobile-app roots
        // (`/mobileapps/app/<id>`), the AI Skills collection root
        // (`/aiskills/`), and theme roots (`/themes/theme/<Name>`).
        // Sub-folders and unsupported content types don't get the
        // marker — see `isLocalModePullableUri` for the current allow-list.
        if (
            !node.isServer
            && node.itemDescriptor.isFolder
            && isLocalModePullableUri(node.itemDescriptor.uri)
        ) {
            const pulled = this.findPulledWorkspace(node);
            context = `${context}${pulled ? "isPulledLocal_" : "canPullLocal_"}`;
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

        // Themes call this "Compile" rather than "Deploy" — the action is
        // a synchronous LESS recompile of the theme's Styles/ folder, not
        // a mobile-app push to a CDN. Switching the labels here keeps the
        // command id stable while the user-visible language tracks the
        // content type. The actionable result (responseMessage from the
        // server) is independent of which verb we used to launch.
        const isTheme = isThemeNodeUri(item.itemDescriptor.uri);
        const title = isTheme
            ? `Compiling ${item.itemDescriptor.displayName}`
            : `Deploying ${item.itemDescriptor.displayName}`;
        const failureFallback = isTheme ? "Compile failed." : "Deploy failed.";

        const options: vscode.ProgressOptions = {
            cancellable: false,
            location: vscode.ProgressLocation.Notification,
            title
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

                    vscode.window.showErrorMessage(response.responseMessage || failureFallback);
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
