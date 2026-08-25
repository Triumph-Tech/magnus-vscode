import { Api } from "../api";
import { buildSqlEndpointUrl, cancelPath, columnNamesPath, connectPath, executeQueryPath, objectExplorerNodesPath, statusPath } from "./sqlEndpoints";
import { classifySqlError } from "./sqlErrors";
import { ConnectResponseBag, ExecuteQueryProgress, ExecuteQueryRequest, GetColumnNamesRequestBag, GetColumnNamesResponseBag, ObjectExplorerNodeBag, ObjectExplorerNodesRequestBag, ObjectExplorerNodesResponseBag } from "./types";

/**
 * Provides functions for interacting with the Magnus plugin's `Sql/*` API
 * endpoints.
 *
 * This is a thin layer over the shared {@link Api} class rather than a second
 * HTTP client. `Api.actionUrl` already owns authentication, the cached login
 * cookie, camel case response parsing and the status code checks, so riding on
 * it means there is no second login and no duplicated auth logic. The cost is
 * that a 404 arrives as a plain error message, which {@link classifySqlError}
 * translates back into a typed error.
 */
export class SqlApi {
    // #region Private Properties

    /** The shared Api instance that performs the authenticated requests. */
    private api: Api;

    // #endregion

    // #region Constructors

    /**
     * Creates a new instance of SqlApi.
     *
     * @param api The shared Api instance that will perform the requests.
     */
    public constructor(api: Api) {
        this.api = api;
    }

    // #endregion

    // #region Private Functions

    /**
     * Sends a request to one of the SQL endpoints on the server.
     *
     * @param method The HTTP method verb to use for the request.
     * @param serverUrl The URL of the server to send the request to.
     * @param path The path of the endpoint, without a leading slash.
     * @param body The object to send as the JSON request body, if any.
     *
     * @returns The parsed response body.
     */
    private async request<T>(method: "POST" | "GET" | "DELETE", serverUrl: string, path: string, body?: unknown): Promise<T> {
        const url = buildSqlEndpointUrl(serverUrl, path);

        try {
            const response = await this.api.actionUrl(method, url, body === undefined ? undefined : JSON.stringify(body));

            return response as unknown as T;
        }
        catch (error) {
            throw classifySqlError(error, serverUrl);
        }
    }

    // #endregion

    // #region Public Functions

    /**
     * Negotiates a SQL session with the server and gets the details about it.
     *
     * @param serverUrl The URL of the server to connect to.
     *
     * @returns An object that describes the server and its database.
     */
    public connect(serverUrl: string): Promise<ConnectResponseBag> {
        return this.request<ConnectResponseBag>("POST", serverUrl, connectPath, {});
    }

    /**
     * Starts executing a query on the server.
     *
     * @param serverUrl The URL of the server to execute the query on.
     * @param query The SQL statement text to execute.
     *
     * @returns The initial progress of the execution, including its identifier.
     */
    public executeQuery(serverUrl: string, query: string): Promise<ExecuteQueryProgress> {
        const body: ExecuteQueryRequest = {
            query
        };

        return this.request<ExecuteQueryProgress>("POST", serverUrl, executeQueryPath, body);
    }

    /**
     * Gets the current progress of a query execution.
     *
     * @param serverUrl The URL of the server the query is running on.
     * @param identifier The identifier of the execution.
     *
     * @returns The current progress of the execution.
     */
    public getQueryStatus(serverUrl: string, identifier: string): Promise<ExecuteQueryProgress> {
        return this.request<ExecuteQueryProgress>("GET", serverUrl, `${statusPath}/${encodeURIComponent(identifier)}`);
    }

    /**
     * Asks the server to cancel a running query. Failures are swallowed, since
     * the query may well have finished on its own by the time we ask.
     *
     * The retired Azure Data Studio client used DELETE for this endpoint, so
     * that is what is used here even though the spec table records it as GET.
     *
     * @param serverUrl The URL of the server the query is running on.
     * @param identifier The identifier of the execution to cancel.
     */
    public async cancelQuery(serverUrl: string, identifier: string): Promise<void> {
        try {
            await this.request("DELETE", serverUrl, `${cancelPath}/${encodeURIComponent(identifier)}`);
        }
        catch (error) {
            console.log("Failed to cancel the query.", error);
        }
    }

    /**
     * Gets the child nodes of an object explorer node.
     *
     * @param serverUrl The URL of the server to query.
     * @param nodeId The identifier of the parent node, or undefined for the root node.
     *
     * @returns An array of node bags that describe the child nodes.
     */
    public async getChildNodes(serverUrl: string, nodeId: string | undefined): Promise<ObjectExplorerNodeBag[]> {
        const body: ObjectExplorerNodesRequestBag = {
            nodeId
        };

        const response = await this.request<ObjectExplorerNodesResponseBag>("POST", serverUrl, objectExplorerNodesPath, body);

        return response.nodes ?? [];
    }

    /**
     * Gets the names of the columns of a table.
     *
     * @param serverUrl The URL of the server to query.
     * @param tableName The name of the table whose column names are requested.
     *
     * @returns An array of column names.
     */
    public async getColumnNames(serverUrl: string, tableName: string): Promise<string[]> {
        const body: GetColumnNamesRequestBag = {
            tableName
        };

        const response = await this.request<GetColumnNamesResponseBag>("POST", serverUrl, columnNamesPath, body);

        return response.columns ?? [];
    }

    // #endregion
}
