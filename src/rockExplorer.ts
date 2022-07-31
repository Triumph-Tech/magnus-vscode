import * as vscode from "vscode";
import axios from "axios";

export interface ServerNode {
    resource: vscode.Uri;
    label: string;
    isDirectory: boolean;
    icon: string;
}

class FileStat implements vscode.FileStat {
    private itemSize: number;
    private itemIsDirectory: boolean;

    public constructor(itemSize: number, itemIsDirectory: boolean) {
        this.itemSize = itemSize;
        this.itemIsDirectory = itemIsDirectory;
    }

	public get type(): vscode.FileType {
        return this.itemIsDirectory ? vscode.FileType.Directory : vscode.FileType.File;
	}

    public get isFile(): boolean | undefined {
        return !this.itemIsDirectory;
	}

    public get isDirectory(): boolean | undefined {
        return this.itemIsDirectory;
	}

    public get isSymbolicLink(): boolean | undefined {
        return false;
	}

    public get size(): number {
        return this.itemSize;
	}

    public get ctime(): number {
        return 0;
	}

    public get mtime(): number {
        return 0;
    }
}

export class ServerTreeDataProvider implements vscode.TreeDataProvider<ServerNode>, vscode.FileSystemProvider {
    private iconData: Record<string, string> = {};
    private didChangeTreeData: vscode.EventEmitter<any> = new vscode.EventEmitter<any>();
    public readonly onDidChangeTreeData: vscode.Event<any> = this.didChangeTreeData.event;

    public async getTreeItem(element: ServerNode): Promise<vscode.TreeItem> {
        let icon = this.iconData[element.icon];

        if (!icon) {
            const response = await axios.get<string>(element.icon);
            if (response.status === 200) {
                icon = response.data.replace("\n", "").replace("\r", "");
                this.iconData[element.icon] = icon;
            }
        }

        return {
            resourceUri: element.resource,
            collapsibleState: element.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
            label: element.label,
            tooltip: `${element.label} tooltip`,
            iconPath: {
                light: vscode.Uri.from({
                    scheme: "data",
                    path: `image/svg+xml;urf8,${icon}`
                }),
                dark: "resources/rockrms.svg"
            },
            command: element.isDirectory ? void 0 : {
                command: "vscode.open",
                arguments: [element.resource],
                title: "Open File"
            },
            contextValue: element.isDirectory ? "folder" : "file"
        };
    }

    public getChildren(element?: ServerNode | undefined): vscode.ProviderResult<ServerNode[]> {
        if (!element) {
            return [
                {
                    label: "rock.blueboxmoon.com",
                    resource: vscode.Uri.parse("rockrms://rock.blueboxmoon.com"),
                    isDirectory: true,
                    icon: "https://raw.githubusercontent.com/SparkDevNetwork/Rock/develop/RockWeb/Assets/Images/rock-logo-circle-white.svg"
                }
            ];
        }
        else {
            return [
                {
                    label: "Pages",
                    resource: vscode.Uri.parse("rockrms://rock.blueboxmoon.com/pages.json"),
                    isDirectory: false,
                    icon: "https://raw.githubusercontent.com/SparkDevNetwork/Rock/develop/RockWeb/Assets/Images/rock-logo-circle.svg"
                }
            ];
        }
    }




    private didChangeFile: vscode.EventEmitter<vscode.FileChangeEvent[]> = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    public onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this.didChangeFile.event;

    public watch(uri: vscode.Uri, options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): vscode.Disposable {
        console.log("Watch", uri.toString());
        return {
            dispose: () => {
                console.log("watcher disposed");
            }
        };
    }

    public stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
        return new FileStat(0, false);
    }

    public readDirectory(uri: vscode.Uri): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
        throw new Error("Method not implemented.");
    }

    public createDirectory(uri: vscode.Uri): void | Thenable<void> {
        throw new Error("Method not implemented.");
    }

    public readFile(uri: vscode.Uri): Uint8Array | Thenable<Uint8Array> {
        return new Uint8Array();
    }

    public writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean; }): void | Thenable<void> {
        throw new Error("Method not implemented.");
    }

    public delete(uri: vscode.Uri, options: { readonly recursive: boolean; }): void | Thenable<void> {
        throw new Error("Method not implemented.");
    }

    public rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean; }): void | Thenable<void> {
        throw new Error("Method not implemented.");
    }
}

export class RockExplorer {
    public constructor(context: vscode.ExtensionContext) {
        const treeDataProvider = new ServerTreeDataProvider();

        context.subscriptions.push(vscode.workspace.registerFileSystemProvider("rockrms", treeDataProvider));
        context.subscriptions.push(vscode.window.registerTreeDataProvider("rockrms-interface-servers", treeDataProvider));
    }
}
