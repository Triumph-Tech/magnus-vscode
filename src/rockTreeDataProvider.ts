import * as vscode from "vscode";
import * as api from "./api";
import { Events } from "./events";
import { IconCache } from "./iconCache";

/** The custom scheme used in building URIs for Visual Studio Code. */
const customUriScheme = "ttrockiface";

export class RockTreeDataProvider implements vscode.Disposable, vscode.TreeDataProvider<ITreeNode | undefined>, vscode.FileSystemProvider {
    private context: vscode.ExtensionContext;
    private events?: Events;
    private iconCache: IconCache = new IconCache();
    private didChangeTreeData: vscode.EventEmitter<ITreeNode | undefined> = new vscode.EventEmitter<ITreeNode | undefined>();
    private treeNodeTable: Record<string, ITreeNode> = {};

    // #region Constructors

    public constructor(context: vscode.ExtensionContext, events: Events) {
        this.context = context;
        this.events = events;

        context.subscriptions.push(vscode.workspace.registerFileSystemProvider(customUriScheme, this));
        context.subscriptions.push(vscode.window.registerTreeDataProvider("rockrms-interface-servers", this));
        context.subscriptions.push(this);

        this.events.onServerAdded(this.onKnownServersChanged.bind(this));
        this.events.onRefreshFolder(this.onRefreshFolder.bind(this));
    }

    public dispose(): void {
        this.events = undefined;
    }

    // #endregion

    // #region TreeDataProvider<ITreeNode>

    /** @inheritdoc */
    public readonly onDidChangeTreeData: vscode.Event<ITreeNode | undefined> = this.didChangeTreeData.event;

    /** @inheritdoc */
    public async getTreeItem(element: ITreeNode): Promise<vscode.TreeItem> {
        const iconPath = await this.getTreeItemIconPath(element.itemDescriptor.icon);

        this.treeNodeTable[element.resource.toString()] = element;

        return {
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
            contextValue: element.itemDescriptor.isFolder ? "folder" : "file"
        };
    }

    /** @inheritdoc */
    public async getChildren(element?: ITreeNode | undefined): Promise<ITreeNode[]> {
        if (!element) {
            return this.getServerNodes();
        }
        else {
            const childItemDescriptors = await api.getChildItems(element.serverUrl, element.itemDescriptor.uri);
            const serverUri = vscode.Uri.parse(element.serverUrl);

            return childItemDescriptors.map(item => {
                return {
                    serverUrl: element.serverUrl,
                    resource: vscode.Uri.parse(`${customUriScheme}://${serverUri.authority}${item.uri}`),
                    itemDescriptor: item
                };
            });
        }
    }

    // #endregion

    // #region Private Functions

    private getServerNodes(): ITreeNode[] {
        const nodes: ITreeNode[] = [];
        const servers = this.context.globalState.get<string[]>("KnownServers", []);

        for (const server of servers) {
            try {
                const uri = vscode.Uri.parse(server);

                nodes.push({
                    serverUrl: server,
                    resource: vscode.Uri.from({
                        scheme: customUriScheme,
                        authority: uri.authority
                    }),
                    itemDescriptor: {
                        displayName: uri.authority,
                        tooltip: uri.authority,
                        isFolder: true,
                        icon: "$(server)",
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
     * Gets the icon path element for a tree item.
     *
     * @param uri The URI of the icon. This should be changed to the object interface.
     *
     * @returns The iconPath object that can be used for a TreeItem.
     */
    private async getTreeItemIconPath(uri: string): Promise<{ light: vscode.Uri, dark: vscode.Uri } | vscode.ThemeIcon | undefined> {
        // Check if the icon is a standard icon reference.
        const themeIconMatch = uri.match(/^\$\(([^)]+)\)/);
        if (themeIconMatch !== null) {
            return new vscode.ThemeIcon(themeIconMatch[1]);
        }

        const iconData = await this.iconCache.getIcon(uri);

        if (iconData === null) {
            return undefined;
        }

        return {
            light: vscode.Uri.parse(iconData),
            dark: vscode.Uri.parse(iconData)
        };
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
        let url = uri.toString();

        if (url.startsWith(customUriScheme)) {
            url = `https${url.substring(customUriScheme.length)}`;
        }

        return await api.getFileStat(url);
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
        let url = uri.toString();

        if (url.startsWith(customUriScheme)) {
            url = `https${url.substring(customUriScheme.length)}`;
        }

        return await api.getFileContent(url);
    }

    /** @inheritdoc */
    public async writeFile(uri: vscode.Uri, content: Uint8Array, _options: { readonly create: boolean; readonly overwrite: boolean; }): Promise<void> {
        let url = uri.toString();

        if (url.startsWith(customUriScheme)) {
            url = `https${url.substring(customUriScheme.length)}`;
        }

        await api.updateFileContent(url, content);
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
