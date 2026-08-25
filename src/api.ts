import { Axios, AxiosRequestConfig, AxiosResponse, Method } from "axios";
import * as FormData from "form-data";
import { Uri } from "vscode";
import { promises } from "fs";
import { join as pathJoin } from "path";
import { LightFileStat } from "./lightFileStat";
import { basename } from "path";
import { Secrets } from "./secrets";
import { MagnusHttpError } from "./httpErrors";
import { normalizeFlatTreeResponse } from "./flatTree";
import { IStampObservation } from "./pollDecisions";

const authenticationCookies: Record<string, string> = {};

const axios = new Axios({
    headers: {
        "Content-Type": "application/json"
    },
    // Global per-request timeout. Upstream Magnus used 10s, but a fork-local
    // fetch can fire hundreds of requests back-to-back against a Rock server
    // that sometimes takes >10s on cold paths — any single slow call would
    // kill the whole fetch. 60s is generous enough to tolerate cold starts
    // without sitting forever on a genuinely hung connection.
    timeout: 60000,
    // Accept every status code so the per-method branches (401/403/404/…)
    // actually run. Without this, axios throws on any non-2xx and the status
    // checks below become dead code — user-facing errors degrade to generic
    // "Request failed with status code 401" messages.
    validateStatus: () => true,
    transformResponse: (data: unknown): unknown => {
        if (typeof data === "string" && data !== "") {
            try {
                return jsonParse(data);
            }
            catch {
                return data;
            }
        }

        return data;
    }
});

/**
 * Thrown when the server rejects a request due to authentication failure
 * (missing/expired cookie, or credentials the server refuses). Lets callers
 * distinguish "session died" from "network error" / "server returned 500"
 * so they can offer re-authentication instead of a generic "try again".
 */
export class AuthenticationError extends Error {
    public readonly serverUrl: string;

    public constructor(serverUrl: string, message: string) {
        super(message);
        this.name = "AuthenticationError";
        this.serverUrl = serverUrl;
    }
}

/**
 * A special reviver method for JSON.parse that forces any object keys to be
 * camel case.
 *
 * @param _key The key related to the value we are currently reviving.
 * @param value The value currently being revived.
 *
 * @returns The value.
 */
function toCamelCaseReviver(_key: string, value: unknown): unknown {
    if (value && typeof value === "object") {
        const valueObject = value as Record<string, unknown>;

        for (const valueKey in valueObject) {
            if (/^[A-Z]/.test(valueKey) && Object.hasOwnProperty.call(valueObject, valueKey)) {
                valueObject[valueKey.charAt(0).toLocaleLowerCase() + valueKey.substring(1)] = valueObject[valueKey];
                delete valueObject[valueKey];
            }
        }
    }

    return value;
}

/**
 * Special JSON.parse method that forces all objects to conform to camel case.
 *
 * @param json the JSON data to parse.
 *
 * @returns The object that was parsed.
 */
function jsonParse<T>(json: string): T {
    return JSON.parse(json, toCamelCaseReviver) as T;
}

/**
 * Provides functions for interacting with the Magnus API endpoints.
 */
export class Api {
    /** Provides access to secure secret storage. */
    private secrets: Secrets;

    /**
     * Creates a new instance of Api that can be used to communicate
     * with the Magnus API endpoints.
     *
     * @param secrets The secret storage provider.
     */
    public constructor(secrets: Secrets) {
        this.secrets = secrets;
    }

    // #region Private Functions

    /**
     * Get the URL that will be used by an API request.
     *
     * @param serverUrl The fully qualified scheme and authority of the server.
     * @param pathAndQuery The path and query string parameters to use. This should not include the leading /.
     *
     * @returns A string that represents the URL to be used in API requests.
     */
    private getApiUrl(serverUrl: string, pathAndQuery: string): string {
        const uri = Uri.parse(serverUrl);

        return `${uri.scheme}://${uri.authority}/${pathAndQuery}`;
    }

    /**
     * Get the authorization cookie required to authenticate to the server with
     * the given username and password.
     *
     * @param serverUrl The URL of the server to authenticate to.
     * @param username The username to use when authenticating.
     * @param password The password to use when authenticating.
     *
     * @returns A string that contains the cookie to be set with further requests or null if authorization failed.
     */
    private async requestAuthorizationCookie(serverUrl: string, username: string, password: string): Promise<string | null> {
        const loginUrl = this.getApiUrl(serverUrl, "api/Auth/Login");

        const response = await axios.post(loginUrl, JSON.stringify({
            username,
            password
        }));

        if (response.status !== 200 && response.status !== 204) {
            return null;
        }

        if (!response.headers["set-cookie"]) {
            return null;
        }

        const cookie = response.headers["set-cookie"].find(c => c.startsWith(".ROCK="));

        if (!cookie) {
            return null;
        }

        return cookie.split(";")[0];
    }

    /**
     * Get the cached authorization cookie or request a new cookie for the server.
     *
     * @param serverUrl The URL that identifies the server to be authenticated against.
     *
     * @returns A string with the authorization cookie or null if it could not be obtained.
     */
    private async getAuthorizationCookie(serverUrl: string): Promise<string | null> {
        if (authenticationCookies[serverUrl]) {
            return authenticationCookies[serverUrl];
        }

        if (! await this.login(serverUrl)) {
            return null;
        }

        return authenticationCookies[serverUrl];
    }

    /**
     * Gets the server base URL from the full URL.
     *
     * @param url The URL that represents the request to be made.
     *
     * @returns The standardized base URL that can be used for cookie lookup.
     */
    private getServerBaseUrl(url: string): string {
        const uri = Uri.parse(url);

        return `${uri.scheme}://${uri.authority}`;
    }

    /**
     * Runs an authenticated request against the server, transparently
     * recovering from a single expired-cookie scenario by forcing a fresh
     * login and retrying once. Any repeat 401 — or a failed re-login —
     * surfaces as an `AuthenticationError` that callers can treat as a
     * "please re-authenticate" signal.
     *
     * @param serverBaseUrl The base URL (scheme + authority) of the server.
     * @param makeRequest Callback that performs the actual HTTP call given a cookie value.
     *
     * @returns The axios response. Callers should still inspect non-2xx statuses
     * for application-level errors (404, 403-forbidden, 5xx, etc.).
     */
    private async authenticatedRequest<T>(
        serverBaseUrl: string,
        makeRequest: (cookie: string) => Promise<AxiosResponse<T>>
    ): Promise<AxiosResponse<T>> {
        let cookie = await this.getAuthorizationCookie(serverBaseUrl);
        if (cookie === null) {
            throw new AuthenticationError(
                serverBaseUrl,
                "Unable to authorize with the server. Re-authenticate to restore the session."
            );
        }

        let response = await makeRequest(cookie);
        if (response.status !== 401) {
            return response;
        }

        // Session expired. Clear the cached cookie, force a fresh login,
        // and retry once. Rock's /api/Auth/Login returns 401 on bad creds,
        // not a different status, so a second 401 after re-login means the
        // stored credentials are no longer valid.
        delete authenticationCookies[serverBaseUrl];
        const reloggedIn = await this.login(serverBaseUrl);
        if (!reloggedIn) {
            throw new AuthenticationError(
                serverBaseUrl,
                "Session expired and re-authentication failed. Update this server's credentials and try again."
            );
        }
        cookie = authenticationCookies[serverBaseUrl];
        response = await makeRequest(cookie);
        if (response.status === 401) {
            delete authenticationCookies[serverBaseUrl];
            throw new AuthenticationError(
                serverBaseUrl,
                "Server rejected credentials after re-authentication. Update this server's credentials and try again."
            );
        }
        return response;
    }

    // #endregion

    // #region Public Functions

    /**
     * Attempts to login to the server with the given username and password.
     * If the login is successful the authorization cookie is cached so it
     * can be used by subsequent requests.
     *
     * @param serverUrl The fully qualified URL to reach the server.
     * @param username The name of the user to login as. If not specified then it will be retrieved from secure storage.
     * @param password The password to authenticate with. If not specified then it will be retrieved from secure storage.
     *
     * @returns True if the login was successful, false otherwise.
     */
    public async login(serverUrl: string, username?: string, password?: string): Promise<boolean> {
        try {
            if (username === undefined || password === undefined) {
                const credentials = await this.secrets.getCredentials(serverUrl);

                if (credentials === null) {
                    return false;
                }

                username = credentials.username;
                password = credentials.password;
            }

            const cookie = await this.requestAuthorizationCookie(serverUrl, username, password);

            if (cookie === null) {
                return false;
            }

            authenticationCookies[serverUrl] = cookie;

            return true;
        }
        catch {
            return false;
        }
    }

    /**
     * Gets the child item descriptors of the given path on the server.
     *
     * @param baseServerUrl The base server URL that uniquely identifies the server.
     * @param absolutePath The absolute path that will be requested.
     *
     * @returns An array of objects that describe the items.
     */
    public async getChildItems(baseServerUrl: string, absolutePath: string | undefined): Promise<IItemDescriptor[]> {
        if (!absolutePath) {
            return this.getChildItems(baseServerUrl, "api/TriumphTech/Magnus/GetTreeItems/root");
        }

        const url = this.getApiUrl(baseServerUrl, absolutePath);

        const result = await this.authenticatedRequest<IItemDescriptor[]>(
            baseServerUrl,
            cookie => axios.get<IItemDescriptor[]>(url, {
                headers: {
                    "Cookie": cookie
                }
            })
        );

        if (result.status === 403) {
            throw new MagnusHttpError(result.status, "Server has denied you access to this resource.", url);
        }
        else if (result.status === 404) {
            throw new Error("Requested resource was not found.");
        }
        else if (result.status < 200 || result.status >= 300 || !result.data) {
            const message = typeof result.data === "object" ? JSON.stringify(result.data) : result.data;
            console.error(`Error in response to '${url}' - ${result.status}: ${message}}`);

            throw new MagnusHttpError(result.status, "Unexpected response received from server.", url);
        }

        return result.data;
    }

    /**
     * Fetches the entire subtree rooted at the given URI as a flat list, in a
     * single round trip. Each returned item carries a `parentUri` link so the
     * caller can assemble the hierarchy locally.
     *
     * Returns null when the server doesn't support the flat tree endpoint
     * (404), or when the specific VFS handler hasn't opted in. Callers fall
     * back to the recursive `getChildItems` walk in that case.
     *
     * @param baseServerUrl The base server URL that uniquely identifies the server.
     * @param rootUri The URI of the subtree root — typically the same value
     *   the caller would pass as the first `getChildItems` call. Must contain
     *   `/GetTreeItems/`; the segment is rewritten to `/GetFlatTree/` to hit
     *   the new endpoint without changing the rest of the path.
     */
    /**
     * Asks a server what it is and what it can do.
     *
     * Returns null when the server does not answer usefully, which covers every
     * plugin before 2.4.0 as well as an unreachable or non-Magnus host. Callers
     * treat null as "no capability information", never as "nothing is enabled".
     *
     * Note this is deliberately not wired back into the servers tree, which
     * dropped its per-server `GetServer` call because it blocked initial render
     * for no payoff. Local mode calls it per workspace instead, which is
     * naturally lazy and off the render path.
     */
    public async getServerInfo(baseServerUrl: string): Promise<IServerInfo | null> {
        const url = this.getApiUrl(baseServerUrl, "api/TriumphTech/Magnus/GetServer");

        try {
            const result = await this.authenticatedRequest<IServerInfo>(
                baseServerUrl,
                cookie => axios.get<IServerInfo>(url, {
                    headers: {
                        "Cookie": cookie
                    }
                })
            );

            if (result.status < 200 || result.status >= 300) {
                return null;
            }

            const data = result.data;

            if (!data || typeof data !== "object" || Array.isArray(data)) {
                return null;
            }

            return data;
        }
        catch {
            // Capability discovery is an enhancement, never a gate. A failure
            // here must not stop a workspace opening or a fetch running, so it
            // degrades to "no information" rather than propagating.
            return null;
        }
    }

    /**
     * Asks the server whether anything under a subtree has changed, without
     * enumerating it. Tier 1 of the polling design.
     *
     * Returns null when the handler cannot answer cheaply, which it signals with
     * a 404. Callers must stop polling that root rather than falling back to
     * something expensive: an unsupported stamp means "do not ask again", not
     * "go and look the slow way every minute".
     */
    public async getTreeStamp(
        baseServerUrl: string,
        rootUri: string
    ): Promise<IStampObservation | null> {
        if (!rootUri || !rootUri.includes("/GetTreeItems/")) {
            return null;
        }

        const stampPath = rootUri.replace("/GetTreeItems/", "/GetTreeStamp/");
        const url = this.getApiUrl(baseServerUrl, stampPath.replace(/^\/+/, ""));

        const result = await this.authenticatedRequest<ITreeStampResult>(
            baseServerUrl,
            cookie => axios.get<ITreeStampResult>(url, {
                headers: {
                    "Cookie": cookie
                }
            })
        );

        // 404 = this handler (or this whole plugin version) has no cheap answer.
        if (result.status === 404) {
            return null;
        }
        if (result.status === 403) {
            throw new MagnusHttpError(result.status, "Server has denied you access to this resource.", url);
        }
        if (result.status < 200 || result.status >= 300) {
            throw new MagnusHttpError(result.status, "Unexpected response received from server.", url);
        }

        const data = result.data;

        // Guard the same way the flat tree does: a 200 carrying an HTML error
        // page or a Rock catch-all body is not an answer. `itemCount` must be a
        // real number, because defaulting it to 0 would make every tick compare
        // equal and silently pin the poll to "nothing ever changes".
        if (!data || typeof data !== "object" || typeof data.itemCount !== "number") {
            return null;
        }

        return {
            stamp: data.stamp ?? null,
            itemCount: data.itemCount
        };
    }

    public async getFlatTree(
        baseServerUrl: string,
        rootUri: string,
        detail?: "tree" | "hash"
    ): Promise<IFlatTreeResult | null> {
        if (!rootUri || !rootUri.includes("/GetTreeItems/")) {
            // No way to derive the flat-tree path from a root URI that doesn't
            // contain the tree segment — caller is expected to pass a real
            // GetTreeItems-style URI (the same shape used for getChildItems).
            return null;
        }

        const flatPath = rootUri.replace("/GetTreeItems/", "/GetFlatTree/");
        // `detail` is omitted rather than sent as "tree", so the default stays
        // the server's default. A plugin too old to know the parameter ignores
        // it and returns the cheap response, which is the safe direction.
        const query = detail === "hash" ? "?detail=hash" : "";
        const url = `${this.getApiUrl(baseServerUrl, flatPath.replace(/^\/+/, ""))}${query}`;

        const result = await this.authenticatedRequest<IFlatTreeItem[] | IFlatTreeResult>(
            baseServerUrl,
            cookie => axios.get<IFlatTreeItem[] | IFlatTreeResult>(url, {
                headers: {
                    "Cookie": cookie
                }
            })
        );

        // 404 = handler doesn't implement flat tree yet; signal "fall back" to
        // the caller. Other non-2xx statuses are real errors and propagate.
        if (result.status === 404) {
            return null;
        }
        if (result.status === 403) {
            throw new MagnusHttpError(result.status, "Server has denied you access to this resource.", url);
        }
        if (result.status < 200 || result.status >= 300 || !result.data) {
            const message = typeof result.data === "object" ? JSON.stringify(result.data) : result.data;
            console.error(`Error in response to '${url}' - ${result.status}: ${message}}`);
            throw new MagnusHttpError(result.status, "Unexpected response received from server.", url);
        }

        // Shape handling lives in `normalizeFlatTreeResponse`, which is pure and
        // covered by tests: the old bare-array shape, the 2.4.0 envelope, and
        // "this endpoint isn't really here" all have to stay distinguishable.
        return normalizeFlatTreeResponse(result.data);
    }

    /**
     * Gets the file status information for the given URL.
     *
     * @param url The URL that will be requested to get the status information.
     *
     * @returns An object that describes the file status.
     */
    public async getFileStat(url: string): Promise<LightFileStat> {
        const result = await this.authenticatedRequest(
            this.getServerBaseUrl(url),
            async (cookie) => {
                const headResult = await axios.head(url, {
                    headers: {
                        "Cookie": cookie
                    }
                });

                if (headResult.status === 405) {
                    // Server doesn't support HEAD request. Try again with a GET.
                    return axios.get(url, {
                        headers: {
                            "Cookie": cookie
                        }
                    });
                }

                return headResult;
            }
        );

        if (result.status === 404) {
            throw new Error("Requested resource was not found.");
        }
        else if (result.status === 403) {
            throw new MagnusHttpError(result.status, "Server has denied you access to this resource.", url);
        }
        else if (result.status < 200 || result.status >= 300) {
            const message = typeof result.data === "object" ? JSON.stringify(result.data) : result.data;
            console.error(`Error in response to '${url}' - ${result.status}: ${message}}`);

            throw new MagnusHttpError(result.status, "Unexpected response received from server.", url);
        }

        const date = result.headers["date"];
        const fileSize = parseInt(result.headers["content-length"]);

        const isReadOnly = result.headers["x-readonly"] === "true";

        return new LightFileStat(isNaN(fileSize) ? 0 : fileSize, date, date, isReadOnly);
    }

    /**
     * Gets the contents of the file at the specified URL.
     *
     * @param url The URL that identifies the file to be requested.
     *
     * @returns An array of 8-bit unsigned integers representing the contents of the URL.
     */
    public async getFileContent(url: string): Promise<Uint8Array> {
        const result = await this.authenticatedRequest<ArrayBuffer>(
            this.getServerBaseUrl(url),
            cookie => axios.get<ArrayBuffer>(url, {
                responseType: "arraybuffer",
                headers: {
                    "Cookie": cookie
                }
            })
        );

        if (result.status === 404) {
            throw new Error("Requested resource was not found.");
        }
        else if (result.status === 403) {
            throw new MagnusHttpError(result.status, "Server has denied you access to this resource.", url);
        }
        else if (result.status < 200 || result.status >= 300 || !result.data) {
            const message = typeof result.data === "object" ? JSON.stringify(result.data) : result.data;
            console.error(`Error in response to '${url}' - ${result.status}: ${message}}`);

            throw new MagnusHttpError(result.status, "Unexpected response received from server.", url);
        }

        return new Uint8Array(result.data);
    }

    /**
     * Updates the contents of the file at the specified URL.
     *
     * @param url The URL to be used for the POST request.
     * @param content The contents of the file that should be sent to the server.
     */
    public async updateFileContent(url: string, content: Uint8Array): Promise<void> {
        const result = await this.authenticatedRequest<ArrayBuffer>(
            this.getServerBaseUrl(url),
            cookie => axios.post<ArrayBuffer>(url, content, {
                responseType: "arraybuffer",
                headers: {
                    "Content-Type": "application/octet-stream",
                    "Cookie": cookie
                }
            })
        );

        if (result.status === 404) {
            throw new Error("Requested resource was not found.");
        }
        else if (result.status === 403) {
            throw new MagnusHttpError(result.status, "Server has denied you access to this resource.", url);
        }
        else if (result.status < 200 || result.status >= 300 || !result.data) {
            const message = typeof result.data === "object" ? JSON.stringify(result.data) : result.data;
            console.error(`Error in response to '${url}' - ${result.status}: ${message}}`);

            throw new MagnusHttpError(result.status, "Unexpected response received from server.", url);
        }
    }

    /**
     * Requests the server to build the resource at the specified URL.
     *
     * @param url The URL to be used for the POST request.
     */
    public buildUrl(url: string): Promise<ActionResponse> {
        return this.actionUrl("POST", url);
    }

    /**
     * Requests the server to delete the resource at the specified URL.
     *
     * @param url The URL to be used for the POST request.
     */
    public deleteUrl(url: string): Promise<ActionResponse> {
        return this.actionUrl("DELETE", url);
    }

    /**
     * Requests the server to create a new file in the given folder.
     *
     * @param url The URL to be used for the POST request.
     * @param filename The name of the file that should be created.
     */
    public createNewFile(url: string, filename: string): Promise<ActionResponse> {
        return this.actionUrl("POST", url, filename, request => {
            request.headers!["Content-Type"] = "text/plain";
        });
    }

    /**
     * Requests the server to create a new folder in the given parent folder.
     *
     * @param url The URL to be used for the POST request.
     * @param name The name of the folder that should be created.
     */
    public createNewFolder(url: string, name: string): Promise<ActionResponse> {
        return this.actionUrl("POST", url, name, request => {
            request.headers!["Content-Type"] = "text/plain";
        });
    }

    /**
     * Requests the server to run an action at the specified URL.
     *
     * @param method The HTTP method verb to use for the action.
     * @param url The URL to be used for the POST request.
     */
    public async actionUrl(method: Method, url: string, data?: unknown, updateRequest?: ((request: AxiosRequestConfig) => void)): Promise<ActionResponse> {
        const result = await this.authenticatedRequest<ActionResponse>(
            this.getServerBaseUrl(url),
            cookie => {
                const requestConfig: AxiosRequestConfig = {
                    method: method,
                    url: url,
                    data: data,
                    headers: {
                        "Cookie": cookie
                    },
                    timeout: 30000
                };

                if (updateRequest) {
                    updateRequest(requestConfig);
                }

                return axios.request<ActionResponse>(requestConfig);
            }
        );
        console.log(result);

        if (result.status === 404) {
            throw new Error("Requested resource was not found.");
        }
        else if (result.status === 403) {
            throw new MagnusHttpError(result.status, "Server has denied you access to this resource.", url);
        }
        else if (result.status < 200 || result.status >= 300 || !result.data) {
            const message = typeof result.data === "object" ? JSON.stringify(result.data) : result.data;
            console.error(`Error in response to '${url}' - ${result.status}: ${message}}`);

            throw new MagnusHttpError(result.status, "Unexpected response received from server.", url);
        }

        return result.data;
    }

    /**
     * Requests the server to upload new file content at the specified URL.
     *
     * @param url The URL to be used for the POST request.
     * @param localUris The URIs to the local files to be uploaded.
     */
    public async uploadUrl(url: string, localUris: Uri[]): Promise<ActionResponse> {
        const formData = new FormData();

        for (const filePath of localUris.map(uri => uri.fsPath)) {
            const file = await promises.readFile(filePath);

            formData.append("files", file, basename(filePath));
        }

        return await this.actionUrl("POST", url, formData, request => {
            request.headers = {
                ...formData.getHeaders(),
                ...request.headers
            };
        });
    }

    /**
     * Requests the server to upload a folder to the specified URL.
     *
     * @param url The URL to be used for the POST request.
     * @param localUri The URI to the local folder to be uploaded.
     */
    public async uploadFolderUrl(url: string, localUri: Uri): Promise<ActionResponse> {
        const formData = new FormData();
        let fileCount = 0;
        let totalSize = 0;

        async function appendDirectory(path: string, relativePath: string[]): Promise<void> {
            const childNames = await promises.readdir(path);

            for (const childName of childNames) {
                const childPath = pathJoin(path, childName);
                const childStat = await promises.stat(childPath);

                if (childStat.isFile()) {
                    fileCount++;
                    totalSize += childStat.size;

                    if (fileCount > 10_000) {
                        throw new Error("Cannot upload more than 10,000 files at one time.");
                    }

                    if (totalSize > 100_000_000) {
                        throw new Error("Cannot upload more than 100MB at one time.");
                    }

                    const file = await promises.readFile(childPath);
                    formData.append("files", file, {
                        filepath: [...relativePath, childName].join("/")
                    });
                }
                else if (childStat.isDirectory()) {
                    await appendDirectory(childPath, [...relativePath, childName]);
                }
            }
        }

        await appendDirectory(localUri.fsPath, []);

        return await this.actionUrl("POST", url, formData, request => {
            request.headers = {
                ...formData.getHeaders(),
                ...request.headers
            };
        });
    }

    // #endregion
}
