/**
 * The wire types used by the Magnus plugin's `Sql/*` REST endpoints.
 *
 * These are ported from the retired Azure Data Studio extension
 * (Triumph-Tech/magnus-ads `src/types.ts`) and describe the server contract
 * exactly. Do not change a shape here without a matching server change.
 */

/**
 * The kind of data that a result set column contains. This drives how a cell
 * value is formatted for display.
 */
export enum QueryColumnType {
    /** The type of the column could not be determined. */
    Unknown = 0,

    /** The column contains textual data. */
    String = 1,

    /** The column contains numeric data. */
    Number = 2,

    /** The column contains boolean data. */
    Boolean = 3,

    /** The column contains date and time data. */
    DateTime = 4,

    /** The column contains raw binary data. */
    ByteArray = 5
}

/**
 * The request body sent to the `Sql/ExecuteQuery` endpoint.
 */
export type ExecuteQueryRequest = {
    /** The SQL statement text to execute. */
    query: string;
};

/**
 * The progress of a single query execution. Returned by `Sql/ExecuteQuery` and
 * then repeatedly by `Sql/Status/{identifier}` until `isComplete` is true.
 */
export type ExecuteQueryProgress = {
    /** The server side identifier of this execution. */
    identifier: string;

    /** True when the server has finished executing the query. */
    isComplete: boolean;

    /** The number of milliseconds the server has spent on this query. */
    duration: number;

    /** The messages emitted by the server since the query started. */
    messages: QueryMessage[];

    /** The result sets produced by the query, only populated once complete. */
    resultSets?: QueryResultSet[] | null;
};

/**
 * A single column of a result set.
 */
export type QueryColumn = {
    /** The name of the column as reported by the database. */
    name: string;

    /** The kind of data this column contains. */
    type: QueryColumnType;
};

/**
 * A single result set produced by a query.
 */
export type QueryResultSet = {
    /** The columns that describe each row. */
    columns: QueryColumn[];

    /** The rows, each of which has one entry per column. */
    rows: unknown[][];
};

/**
 * A message emitted by the server while executing a query. This covers PRINT
 * output, row counts and SQL errors.
 */
export type QueryMessage = {
    /** The text of the message. */
    message: string;

    /** The SQL error number, when the message represents an error. */
    code?: number | null;

    /** The severity level reported by SQL Server. */
    level?: number | null;

    /** The state reported by SQL Server. */
    state?: number | null;

    /** The line number in the statement text the message relates to. */
    lineNumber?: number | null;
};

/**
 * The request body sent to the `Sql/ObjectExplorerNodes` endpoint.
 */
export type ObjectExplorerNodesRequestBag = {
    /** The node whose children are requested, or undefined for the root. */
    nodeId: string | undefined;
};

/**
 * The response body returned by the `Sql/ObjectExplorerNodes` endpoint.
 */
export type ObjectExplorerNodesResponseBag = {
    /** The child nodes of the requested node. */
    nodes: ObjectExplorerNodeBag[];
};

/**
 * A single node of the database object explorer hierarchy.
 */
export type ObjectExplorerNodeBag = {
    /** The opaque server side identifier of this node. */
    id: string;

    /** The kind of object this node represents. */
    type: ObjectExplorerNodeType;

    /** The name to display for this node. */
    name: string;
};

/**
 * The kinds of nodes returned by the `Sql/ObjectExplorerNodes` endpoint. The
 * hierarchy is DatabasesFolder, Database, TablesFolder, Table, ColumnsFolder,
 * Column.
 */
export enum ObjectExplorerNodeType {
    /** The folder that contains the databases. */
    DatabasesFolder = 0,

    /** A single database. */
    Database = 1,

    /** The folder that contains the tables of a database. */
    TablesFolder = 2,

    /** A single table. */
    Table = 3,

    /** The folder that contains the columns of a table. */
    ColumnsFolder = 4,

    /** A single column of a table. */
    Column = 5
}

/**
 * The request body sent to the `Sql/Connect` endpoint. The endpoint takes no
 * parameters but still requires a body.
 */
export type ConnectRequestBag = Record<string, never>;

/**
 * The response body returned by the `Sql/Connect` endpoint. It describes the
 * server that the SQL session was negotiated with.
 */
export type ConnectResponseBag = {
    /** The name of the database the session is connected to. */
    databaseName: string;

    /** The version of the operating system hosting SQL Server. */
    oSVersion: string;

    /** The version of Rock running on the server. */
    rockVersion: string;

    /** The edition of SQL Server, such as Developer or Standard. */
    sqlEdition: string;

    /** The version of SQL Server. */
    sqlVersion: string;
};

/**
 * The request body sent to the `Sql/ColumnNames` endpoint.
 */
export type GetColumnNamesRequestBag = {
    /** The name of the table whose column names are requested. */
    tableName: string;
};

/**
 * The response body returned by the `Sql/ColumnNames` endpoint.
 */
export type GetColumnNamesResponseBag = {
    /** The names of the columns in the requested table. */
    columns: string[];
};
