import { ObjectExplorerNodeBag, ObjectExplorerNodeType } from "./types";

/**
 * The pure translation of server side object explorer nodes into the shape the
 * tree view and the quick picks need. Nothing here touches vscode, so every
 * rule is unit testable.
 */

/** The label of the node that roots a server's SQL subtree. */
export const sqlRootLabel = "SQL";

/** The context value of the node that roots a server's SQL subtree. */
export const sqlRootContextValue = "sqlRoot_canRefreshSql_canGoToTable_";

/**
 * How a single object explorer node should be presented in the tree.
 */
export type SqlNodePresentation = {
    /** The text to display for the node. */
    label: string;

    /** The codicon reference to display next to the label. */
    icon: string;

    /** True if the node can be expanded to show child nodes. */
    isExpandable: boolean;

    /** The context value used by the `when` clauses of the tree menus. */
    contextValue: string;
};

/**
 * A table located somewhere in a server's object explorer hierarchy. This is
 * what the "Go to table" quick pick works with.
 */
export type SqlTableReference = {
    /** The URL of the server the table lives on. */
    serverUrl: string;

    /** The object explorer identifier of the table node. */
    nodeId: string;

    /** The name of the table. */
    tableName: string;

    /** The name of the database that contains the table. */
    databaseName: string;
};

/**
 * The identifiers of the actions offered after a table is picked.
 */
export enum SqlTableActionKind {
    /** Expand the tree down to the table and select it. */
    Reveal = "reveal",

    /** Insert the table name at the cursor of the active editor. */
    Insert = "insert",

    /** Copy the table name to the clipboard. */
    Copy = "copy",

    /** Open a query editor holding the first thousand rows of the table. */
    SelectTop1000 = "selectTop1000"
}

/**
 * One entry of the "what do you want to do with this table" quick pick.
 */
export type SqlTableActionItem = {
    /** The text to display, which may include a codicon reference. */
    label: string;

    /** The supporting text shown next to the label. */
    description: string;

    /** The action this entry performs. */
    action: SqlTableActionKind;
};

/**
 * One entry of the "Go to table" quick pick.
 */
export type SqlTableQuickPickItem = {
    /** The text to display, which is the table name. */
    label: string;

    /** The supporting text shown next to the label. */
    description: string;

    /** The table this entry refers to. */
    table: SqlTableReference;
};

/**
 * Gets the codicon reference that represents a node in the tree.
 *
 * @param nodeType The kind of node received from the server.
 *
 * @returns A codicon reference such as `$(table)`.
 */
export function getNodeIcon(nodeType: ObjectExplorerNodeType): string {
    switch (nodeType) {
        case ObjectExplorerNodeType.Database:
            return "$(database)";

        case ObjectExplorerNodeType.Table:
            return "$(table)";

        case ObjectExplorerNodeType.Column:
            return "$(symbol-field)";

        default:
            return "$(folder)";
    }
}

/**
 * Gets a value indicating if a node can have child nodes.
 *
 * @param nodeType The kind of node received from the server.
 *
 * @returns True if the node can be expanded, otherwise false.
 */
export function getNodeIsExpandable(nodeType: ObjectExplorerNodeType): boolean {
    return nodeType !== ObjectExplorerNodeType.Column;
}

/**
 * Gets the context value of a node, which the `when` clauses of the tree
 * menus in package.json match against.
 *
 * @param nodeType The kind of node received from the server.
 *
 * @returns A string to use as the tree item's context value.
 */
export function getNodeContextValue(nodeType: ObjectExplorerNodeType): string {
    switch (nodeType) {
        case ObjectExplorerNodeType.Database:
            return "sqlDatabase_";

        case ObjectExplorerNodeType.Table:
            return "sqlTable_canSelectTop1000_";

        case ObjectExplorerNodeType.Column:
            return "sqlColumn_";

        default:
            return "sqlFolder_";
    }
}

/**
 * Translates a node received from the server into the way it should be
 * presented in the tree.
 *
 * @param nodeBag The node received from the server.
 *
 * @returns An object that describes how to present the node.
 */
export function getNodePresentation(nodeBag: ObjectExplorerNodeBag): SqlNodePresentation {
    return {
        label: nodeBag.name,
        icon: getNodeIcon(nodeBag.type),
        isExpandable: getNodeIsExpandable(nodeBag.type),
        contextValue: getNodeContextValue(nodeBag.type)
    };
}

/**
 * Builds the entries of the "Go to table" quick pick.
 *
 * @param tables The tables that were found on the server.
 *
 * @returns An array of quick pick entries, sorted by table name.
 */
export function buildTableQuickPickItems(tables: SqlTableReference[]): SqlTableQuickPickItem[] {
    return tables
        .map(table => ({
            label: table.tableName,
            description: table.databaseName,
            table
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Builds the entries of the quick pick shown once a table has been chosen.
 *
 * @param tableName The name of the table that was chosen.
 * @param hasActiveEditor True if there is an editor that a name could be inserted into.
 *
 * @returns An array of action entries.
 */
export function buildTableActionItems(tableName: string, hasActiveEditor: boolean): SqlTableActionItem[] {
    const items: SqlTableActionItem[] = [
        {
            label: "$(list-tree) Reveal in tree",
            description: `Show ${tableName} in the Magnus servers view`,
            action: SqlTableActionKind.Reveal
        },
        {
            label: "$(play) Select Top 1000",
            description: `Query the first 1000 rows of ${tableName}`,
            action: SqlTableActionKind.SelectTop1000
        }
    ];

    if (hasActiveEditor) {
        items.push({
            label: "$(edit) Insert name at cursor",
            description: `Insert ${tableName} into the active editor`,
            action: SqlTableActionKind.Insert
        });
    }

    items.push({
        label: "$(clippy) Copy name",
        description: `Copy ${tableName} to the clipboard`,
        action: SqlTableActionKind.Copy
    });

    return items;
}
