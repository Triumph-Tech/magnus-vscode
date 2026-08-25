/**
 * The paths of the Magnus plugin's `Sql/*` REST endpoints and the pure logic
 * that turns a saved server URL into a fully qualified endpoint URL.
 *
 * The tree contract elsewhere in this extension is descriptor driven and paths
 * must never be concatenated. The SQL endpoints are the documented exception:
 * they are a fixed, versioned surface of the plugin (see docs/sql-tools-spec.md
 * section 4) and are not advertised by any descriptor.
 */

/** The path of the endpoint that negotiates a SQL session. */
export const connectPath = "api/TriumphTech/Magnus/Sql/Connect";

/** The path of the endpoint that starts a query execution. */
export const executeQueryPath = "api/TriumphTech/Magnus/Sql/ExecuteQuery";

/** The path of the endpoint that reports the status of an execution. */
export const statusPath = "api/TriumphTech/Magnus/Sql/Status";

/** The path of the endpoint that cancels a running execution. */
export const cancelPath = "api/TriumphTech/Magnus/Sql/Cancel";

/** The path of the endpoint that lists the children of an explorer node. */
export const objectExplorerNodesPath = "api/TriumphTech/Magnus/Sql/ObjectExplorerNodes";

/** The path of the endpoint that lists the column names of a table. */
export const columnNamesPath = "api/TriumphTech/Magnus/Sql/ColumnNames";

/**
 * Builds the fully qualified URL of a SQL endpoint on the given server.
 *
 * @param serverUrl The saved server URL, with or without a scheme or trailing slash.
 * @param path The endpoint path, without a leading slash.
 *
 * @returns A string that contains the absolute URL of the endpoint.
 */
export function buildSqlEndpointUrl(serverUrl: string, path: string): string {
    let baseUrl = serverUrl.trim();

    if (!baseUrl.includes("://")) {
        baseUrl = `https://${baseUrl}`;
    }

    while (baseUrl.endsWith("/")) {
        baseUrl = baseUrl.substring(0, baseUrl.length - 1);
    }

    return `${baseUrl}/${path}`;
}
