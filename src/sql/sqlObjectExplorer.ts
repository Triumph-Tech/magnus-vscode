import * as vscode from "vscode";
import { columnFetchFailureTtlMs, isColumnFetchBlocked, makeColumnNamesCacheKey, makeServerCacheKeyPrefix, makeTableListCacheKey, NodeCache } from "./nodeCache";
import { SqlApi } from "./sqlApi";
import { getNodePresentation, sqlRootContextValue, sqlRootLabel, SqlTableReference } from "./sqlNodeMapping";
import { ObjectExplorerNodeBag, ObjectExplorerNodeType } from "./types";

/** The scheme used for the resource URIs of the SQL tree nodes. */
const sqlUriScheme = "magnus-sql";

/** The custom schemes used by the tree for server nodes. */
const customUriSchemeInsecure = "ttmagnus";
const customUriSchemeSecure = "ttmagnuss";

/** The greatest number of levels the table walk will descend. */
const maximumWalkDepth = 6;

/**
 * A tree node that belongs to a server's SQL subtree. It is a regular tree node
 * so that the existing tree data provider can render it, with an extra property
 * that identifies the object explorer node behind it.
 */
export interface ISqlTreeNode extends ITreeNode {
    /** The object explorer details of this node. */
    sql: {
        /** The server side node identifier, or undefined for the "SQL" root node. */
        nodeId: string | undefined;

        /** The kind of object, or undefined for the "SQL" root node. */
        nodeType: ObjectExplorerNodeType | undefined;

        /** The name of the database that contains this node, when known. */
        databaseName?: string;
    };
}

/**
 * Determines if a tree node belongs to a server's SQL subtree.
 *
 * @param node The tree node to check.
 *
 * @returns True if the node is a SQL node.
 */
export function isSqlTreeNode(node: ITreeNode | undefined): node is ISqlTreeNode {
    return !!node && typeof (node as ISqlTreeNode).sql === "object";
}

/**
 * Supplies the "SQL" node under each server in the Magnus tree along with its
 * lazily loaded children, and the navigation helpers the SQL commands need.
 */
export class SqlObjectExplorer implements vscode.Disposable {
    // #region Private Properties

    /** The client used to talk to the server's SQL endpoints. */
    private sqlApi: SqlApi;

    /** The cache of object explorer data, keyed per server. */
    private cache: NodeCache = new NodeCache();

    /** The tree view, once the tree data provider has attached it. */
    private treeView?: vscode.TreeView<ITreeNode | undefined>;

    /** The nodes we have handed out, so parents and identity stay stable. */
    private nodesByResource: Record<string, ISqlTreeNode> = {};

    /** The parent of each node we have handed out, keyed by resource URI. */
    private parentByResource: Record<string, ITreeNode> = {};

    /** The server nodes we have been asked for a SQL root node for. */
    private serverNodes: Record<string, ITreeNode> = {};

    /** The emitter used to ask the tree to refresh one of our nodes. */
    private didChangeNode: vscode.EventEmitter<ITreeNode | undefined> = new vscode.EventEmitter<ITreeNode | undefined>();

    /** The emitter used to tell anyone caching alongside us that a server's data has gone. */
    private didInvalidateServer: vscode.EventEmitter<string> = new vscode.EventEmitter<string>();

    /**
     * The column fetches that are in flight, keyed by
     * {@link makeColumnNamesCacheKey}.
     *
     * Completion fires on a keystroke and hover fires on a mouse rest, so the
     * same table is asked for several times before the first answer arrives.
     * Sharing the promise turns that into one request.
     */
    private columnFetchesInFlight: Map<string, Promise<string[]>> = new Map<string, Promise<string[]>>();

    /**
     * When each column fetch last failed, keyed by
     * {@link makeColumnNamesCacheKey}.
     *
     * A name that is not a table on this server fails every time it is asked
     * for, and hovering it repeatedly must not mean a POST per hover. The failure
     * is remembered only briefly, so a table added since is picked up soon.
     */
    private columnFetchFailures: Map<string, number> = new Map<string, number>();

    // #endregion

    // #region Constructors

    /**
     * Creates a new instance of the SQL object explorer.
     *
     * @param sqlApi The client used to talk to the server's SQL endpoints.
     */
    public constructor(sqlApi: SqlApi) {
        this.sqlApi = sqlApi;
    }

    /** @inheritdoc */
    public dispose(): void {
        this.didChangeNode.dispose();
        this.didInvalidateServer.dispose();
    }

    // #endregion

    // #region Public Properties

    /** Fired when one of our nodes should be refreshed by the tree. */
    public readonly onDidChangeNode: vscode.Event<ITreeNode | undefined> = this.didChangeNode.event;

    /**
     * Fired with a server's URL when everything cached for it has been
     * discarded.
     *
     * The cache warmer listens so that a refresh leads to a fresh walk rather
     * than to a server that is believed warm and is in fact empty.
     */
    public readonly onDidInvalidateServer: vscode.Event<string> = this.didInvalidateServer.event;

    // #endregion

    // #region Private Functions

    /**
     * Gets the resource URI that uniquely identifies a SQL node in the tree.
     *
     * @param serverUrl The URL of the server the node belongs to.
     * @param nodeId The server side node identifier, or undefined for the root node.
     *
     * @returns A URI that uniquely identifies the node.
     */
    private getResource(serverUrl: string, nodeId: string | undefined): vscode.Uri {
        const authority = vscode.Uri.parse(serverUrl).authority;

        return vscode.Uri.from({
            scheme: sqlUriScheme,
            authority,
            path: nodeId === undefined ? "/" : `/node/${encodeURIComponent(nodeId)}`
        });
    }

    /**
     * Creates, or returns the already created, tree node for an object
     * explorer node.
     *
     * @param serverUrl The URL of the server the node belongs to.
     * @param nodeBag The node received from the server.
     * @param parent The node that this node is a child of.
     * @param databaseName The name of the database that contains the node, when known.
     *
     * @returns The tree node that represents the object explorer node.
     */
    private getOrCreateNode(serverUrl: string, nodeBag: ObjectExplorerNodeBag, parent: ITreeNode, databaseName?: string): ISqlTreeNode {
        const resource = this.getResource(serverUrl, nodeBag.id);
        const key = resource.toString();
        const presentation = getNodePresentation(nodeBag);

        const node: ISqlTreeNode = this.nodesByResource[key] ?? {
            serverUrl,
            resource,
            isServer: false,
            itemDescriptor: {
                displayName: presentation.label,
                tooltip: presentation.label,
                isFolder: presentation.isExpandable,
                icon: presentation.icon,
                iconDark: presentation.icon,
                disableOpenFile: true,
                uri: null
            },
            sql: {
                nodeId: nodeBag.id,
                nodeType: nodeBag.type,
                databaseName
            }
        };

        node.sql.databaseName = databaseName ?? node.sql.databaseName;

        this.nodesByResource[key] = node;
        this.parentByResource[key] = parent;

        return node;
    }

    /**
     * Gets the child nodes of an object explorer node, using the cache when it
     * still holds them.
     *
     * @param serverUrl The URL of the server to query.
     * @param nodeId The identifier of the parent node, or undefined for the root node.
     *
     * @returns An array of node bags that describe the child nodes.
     */
    private async getChildNodeBags(serverUrl: string, nodeId: string | undefined): Promise<ObjectExplorerNodeBag[]> {
        const cached = this.cache.getChildren(serverUrl, nodeId);

        if (cached) {
            return cached;
        }

        const nodes = await this.sqlApi.getChildNodes(serverUrl, nodeId);

        this.cache.setChildren(serverUrl, nodeId, nodes);

        return nodes;
    }

    /**
     * Synthesizes the tree node for a server. Used when a reveal needs the
     * server node but the tree has not handed us one yet. The resource and
     * label match what the tree data provider builds so that the tree view can
     * still resolve the node.
     *
     * @param serverUrl The URL of the server.
     *
     * @returns A tree node that represents the server.
     */
    private getServerNode(serverUrl: string): ITreeNode {
        const existing = this.serverNodes[serverUrl];

        if (existing) {
            return existing;
        }

        const uri = vscode.Uri.parse(serverUrl);

        return {
            serverUrl,
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
        };
    }

    /**
     * Gets the cache key used to hold the node chains that lead to each table.
     *
     * @param serverUrl The URL of the server.
     *
     * @returns The cache key for the chains.
     */
    private getTableChainCacheKey(serverUrl: string): string {
        return `${makeTableListCacheKey(serverUrl)}|chains`;
    }

    /**
     * Walks a server's object explorer hierarchy collecting every table, along
     * with the chain of nodes that leads to it.
     *
     * @param serverUrl The URL of the server to walk.
     *
     * @returns An array of the chains of node bags, each ending in a table.
     */
    private async walkTables(serverUrl: string): Promise<ObjectExplorerNodeBag[][]> {
        const chains: ObjectExplorerNodeBag[][] = [];

        const descend = async (nodeId: string | undefined, chain: ObjectExplorerNodeBag[]): Promise<void> => {
            if (chain.length >= maximumWalkDepth) {
                return;
            }

            const children = await this.getChildNodeBags(serverUrl, nodeId);

            for (const child of children) {
                if (child.type === ObjectExplorerNodeType.Table) {
                    chains.push([...chain, child]);
                }
                else if (child.type !== ObjectExplorerNodeType.Column) {
                    await descend(child.id, [...chain, child]);
                }
            }
        };

        await descend(undefined, []);

        return chains;
    }

    /**
     * Asks the server for a table's columns and records what happened.
     *
     * @param serverUrl The URL of the server the table lives on.
     * @param tableName The name of the table.
     * @param cacheKey The cache key the answer belongs under.
     *
     * @returns The names of the columns, in the order the server reported them.
     */
    private async fetchColumnNames(serverUrl: string, tableName: string, cacheKey: string): Promise<string[]> {
        try {
            const columns = await this.sqlApi.getColumnNames(serverUrl, tableName);

            this.columnFetchFailures.delete(cacheKey);
            this.cache.set(cacheKey, columns);

            return columns;
        }
        catch (error) {
            this.columnFetchFailures.set(cacheKey, Date.now());

            throw error;
        }
    }

    /**
     * Forgets the failed column fetches of one server, so that a refresh gives
     * every table another chance straight away.
     *
     * @param serverUrl The URL of the server that was refreshed.
     */
    private forgetColumnFetchFailures(serverUrl: string): void {
        const prefix = makeServerCacheKeyPrefix(serverUrl);

        for (const key of Array.from(this.columnFetchFailures.keys())) {
            if (key.startsWith(prefix)) {
                this.columnFetchFailures.delete(key);
            }
        }
    }

    // #endregion

    // #region Public Functions

    /**
     * Attaches the tree view so that nodes can be revealed in it.
     *
     * @param treeView The tree view that renders the Magnus servers tree.
     */
    public attachTreeView(treeView: vscode.TreeView<ITreeNode | undefined>): void {
        this.treeView = treeView;
    }

    /**
     * Gets the "SQL" node that roots a server's SQL subtree.
     *
     * @param serverNode The server node the SQL node belongs under.
     *
     * @returns The tree node to append to the server's children.
     */
    public getSqlRootNode(serverNode: ITreeNode): ISqlTreeNode {
        const resource = this.getResource(serverNode.serverUrl, undefined);
        const key = resource.toString();

        this.serverNodes[serverNode.serverUrl] = serverNode;

        const node: ISqlTreeNode = this.nodesByResource[key] ?? {
            serverUrl: serverNode.serverUrl,
            resource,
            isServer: false,
            itemDescriptor: {
                displayName: sqlRootLabel,
                tooltip: "Browse this server's database objects",
                isFolder: true,
                icon: "$(database)",
                iconDark: "$(database)",
                disableOpenFile: true,
                uri: null
            },
            sql: {
                nodeId: undefined,
                nodeType: undefined
            }
        };

        this.nodesByResource[key] = node;
        this.parentByResource[key] = serverNode;

        return node;
    }

    /**
     * Gets the children of a SQL node.
     *
     * @param element The tree node whose children were requested.
     *
     * @returns The child nodes, or undefined if the node is not a SQL node.
     */
    public async getChildren(element: ITreeNode): Promise<ITreeNode[] | undefined> {
        if (!isSqlTreeNode(element)) {
            return undefined;
        }

        if (element.sql.nodeType === ObjectExplorerNodeType.Column) {
            return [];
        }

        try {
            const children = await this.getChildNodeBags(element.serverUrl, element.sql.nodeId);

            return children.map(child => {
                const databaseName = child.type === ObjectExplorerNodeType.Database
                    ? child.name
                    : element.sql.databaseName;

                return this.getOrCreateNode(element.serverUrl, child, element, databaseName);
            });
        }
        catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(error.message);
            }

            return [];
        }
    }

    /**
     * Applies the SQL specific parts of a tree item that the shared tree data
     * provider cannot know about.
     *
     * @param element The tree node the item was built for.
     * @param item The tree item to adjust in place.
     */
    public decorateTreeItem(element: ITreeNode, item: vscode.TreeItem): void {
        if (!isSqlTreeNode(element)) {
            return;
        }

        item.contextValue = element.sql.nodeType === undefined
            ? sqlRootContextValue
            : getNodePresentation({
                id: element.sql.nodeId ?? "",
                name: element.itemDescriptor.displayName,
                type: element.sql.nodeType
            }).contextValue;

        // Nothing in the SQL subtree can be opened as a file.
        item.command = undefined;
    }

    /**
     * Gets the parent of one of our nodes.
     *
     * @param element The node whose parent is requested.
     *
     * @returns The parent node, or undefined if it is not one of our nodes.
     */
    public getParent(element: ITreeNode): ITreeNode | undefined {
        if (!isSqlTreeNode(element)) {
            return undefined;
        }

        return this.parentByResource[element.resource.toString()];
    }

    /**
     * Discards everything cached for a server and asks the tree to reload that
     * server's SQL subtree.
     *
     * @param node A node belonging to the server that should be refreshed.
     */
    public refresh(node: ITreeNode): void {
        this.cache.invalidateServer(node.serverUrl);
        this.forgetColumnFetchFailures(node.serverUrl);

        const rootKey = this.getResource(node.serverUrl, undefined).toString();
        const rootNode = this.nodesByResource[rootKey];

        for (const key of Object.keys(this.nodesByResource)) {
            if (key !== rootKey && this.nodesByResource[key].serverUrl === node.serverUrl) {
                delete this.nodesByResource[key];
                delete this.parentByResource[key];
            }
        }

        this.didChangeNode.fire(rootNode ?? node);
        this.didInvalidateServer.fire(node.serverUrl);
    }

    /**
     * Gets every table on a server, fetching and caching the hierarchy the
     * first time it is asked for.
     *
     * @param serverUrl The URL of the server whose tables are requested.
     *
     * @returns An array of references to the tables on the server.
     */
    public async getTables(serverUrl: string): Promise<SqlTableReference[]> {
        const cacheKey = makeTableListCacheKey(serverUrl);
        const cached = this.cache.get<SqlTableReference[]>(cacheKey);

        if (cached) {
            return cached;
        }

        const chains = await this.walkTables(serverUrl);

        const tables = chains.map(chain => {
            const tableBag = chain[chain.length - 1];
            const databaseBag = chain.find(node => node.type === ObjectExplorerNodeType.Database);

            return {
                serverUrl,
                nodeId: tableBag.id,
                tableName: tableBag.name,
                databaseName: databaseBag?.name ?? ""
            };
        });

        this.cache.set(cacheKey, tables);
        this.cache.set(this.getTableChainCacheKey(serverUrl), chains);

        return tables;
    }

    /**
     * Gets the names of the columns of a table, fetching them the first time.
     *
     * The cache is the same one the tree uses, so Select Top 1000 on a table
     * whose columns have already been expanded costs nothing, and a later
     * refresh of the server drops both together.
     *
     * Two guards live here rather than in the callers, because completion and
     * hover both fire while someone is working and both used to be able to
     * stampede this. Concurrent callers for one table share a single request,
     * and a table whose fetch has just failed is refused from memory for
     * {@link columnFetchFailureTtlMs} rather than asked for again.
     *
     * @param serverUrl The URL of the server the table lives on.
     * @param tableName The name of the table.
     *
     * @returns The names of the columns, in the order the server reported them.
     */
    public async getColumnNames(serverUrl: string, tableName: string): Promise<string[]> {
        const cacheKey = makeColumnNamesCacheKey(serverUrl, tableName);
        const cached = this.cache.get<string[]>(cacheKey);

        if (cached) {
            return cached;
        }

        const inFlight = this.columnFetchesInFlight.get(cacheKey);

        if (inFlight) {
            return await inFlight;
        }

        if (isColumnFetchBlocked(this.columnFetchFailures.get(cacheKey), Date.now(), columnFetchFailureTtlMs)) {
            throw new Error(`The columns of '${tableName}' could not be read.`);
        }

        const request = this.fetchColumnNames(serverUrl, tableName, cacheKey);

        this.columnFetchesInFlight.set(cacheKey, request);

        try {
            return await request;
        }
        finally {
            this.columnFetchesInFlight.delete(cacheKey);
        }
    }

    /**
     * Gets the column names of a table only if they are already cached.
     *
     * The completion and hover providers use this rather than
     * {@link getColumnNames} wherever a miss should simply mean a shorter list.
     * A hover is not worth an HTTP request, and neither is the table list of a
     * completion: both fire while someone is typing, and a request per keystroke
     * would be felt.
     *
     * @param serverUrl The URL of the server the table lives on.
     * @param tableName The name of the table.
     *
     * @returns The column names, or undefined when they have not been fetched yet.
     */
    public getCachedColumnNames(serverUrl: string, tableName: string): string[] | undefined {
        return this.cache.get<string[]>(makeColumnNamesCacheKey(serverUrl, tableName));
    }

    /**
     * Gets a server's tables only if they are already cached.
     *
     * @param serverUrl The URL of the server whose tables are requested.
     *
     * @returns The tables, or undefined when the hierarchy has not been walked yet.
     */
    public getCachedTables(serverUrl: string): SqlTableReference[] | undefined {
        return this.cache.get<SqlTableReference[]>(makeTableListCacheKey(serverUrl));
    }

    /**
     * Expands the tree down to a table and selects it.
     *
     * @param table The table that should be revealed.
     */
    public async revealTable(table: SqlTableReference): Promise<void> {
        if (!this.treeView) {
            return;
        }

        const chains = this.cache.get<ObjectExplorerNodeBag[][]>(this.getTableChainCacheKey(table.serverUrl));
        const chain = chains?.find(c => c[c.length - 1].id === table.nodeId);

        if (!chain) {
            return;
        }

        let parent: ITreeNode = this.getSqlRootNode(this.getServerNode(table.serverUrl));
        let node: ISqlTreeNode | undefined;
        let databaseName: string | undefined;

        for (const bag of chain) {
            databaseName = bag.type === ObjectExplorerNodeType.Database ? bag.name : databaseName;
            node = this.getOrCreateNode(table.serverUrl, bag, parent, databaseName);
            parent = node;
        }

        if (!node) {
            return;
        }

        await this.treeView.reveal(node, {
            select: true,
            focus: true,
            expand: true
        });
    }

    // #endregion
}
