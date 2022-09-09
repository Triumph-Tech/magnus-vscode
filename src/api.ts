import { Axios, AxiosRequestConfig, Method } from "axios";
import * as FormData from "form-data";
import { Uri } from "vscode";
import { promises } from "fs";
import { getCredentials } from "./auth";
import { LightFileStat } from "./lightFileStat";
import { basename } from "path";

const authenticationCookies: Record<string, string> = {};

const axios = new Axios({
    headers: {
        "Content-Type": "application/json"
    },
    timeout: 10000,
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

// #region Private Funcations

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
 * Get the URL that will be used by an API request.
 *
 * @param serverUrl The fully qualified scheme and authority of the server.
 * @param pathAndQuery The path and query string parameters to use. This should not include the leading /.
 *
 * @returns A string that represents the URL to be used in API requests.
 */
function getApiUrl(serverUrl: string, pathAndQuery: string): string {
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
async function requestAuthorizationCookie(serverUrl: string, username: string, password: string): Promise<string | null> {
    const loginUrl = getApiUrl(serverUrl, "api/Auth/Login");

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
async function getAuthorizationCookie(serverUrl: string): Promise<string | null> {
    if (authenticationCookies[serverUrl]) {
        return authenticationCookies[serverUrl];
    }

    if (! await login(serverUrl)) {
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
function getServerBaseUrl(url: string): string {
    const uri = Uri.parse(url);

    return `${uri.scheme}://${uri.authority}`;
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
export async function login(serverUrl: string, username?: string, password?: string): Promise<boolean> {
    try {
        if (username === undefined || password === undefined) {
            const credentials = await getCredentials(serverUrl);

            if (credentials === null) {
                return false;
            }

            username = credentials.username;
            password = credentials.password;
        }

        const cookie = await requestAuthorizationCookie(serverUrl, username, password);

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
 * Gets the server item descriptor of the server.
 *
 * @param baseServerUrl The base server URL that uniquely identifies the server.
 *
 * @returns An object that describes the server node.
 */
export async function getServerDescriptor(baseServerUrl: string): Promise<IItemDescriptor> {
    const url = getApiUrl(baseServerUrl, "api/TriumphTech/Magnus/GetServer");
    const cookie = await getAuthorizationCookie(baseServerUrl);

    if (cookie === null) {
        throw new Error("Unable to authorize with the server.");
    }

    const result = await axios.get<IItemDescriptor>(url, {
        headers: {
            "Cookie": cookie
        }
    });

    if (result.status === 403) {
        throw new Error("Server has denied you access to this resource.");
    }
    else if (result.status === 404) {
        throw new Error("Requested resource was not found.");
    }
    else if (result.status < 200 || result.status >= 300 || !result.data) {
        const message = typeof result.data === "object" ? JSON.stringify(result.data) : result.data;
        console.error(`Error in response to '${url}' - ${result.status}: ${message}}`);

        throw new Error("Unexpected response received from server.");
    }

    return result.data;
}

/**
 * Gets the child item descriptors of the given path on the server.
 *
 * @param baseServerUrl The base server URL that uniquely identifies the server.
 * @param absolutePath The absolute path that will be requested.
 *
 * @returns An array of objects that describe the items.
 */
export async function getChildItems(baseServerUrl: string, absolutePath: string | undefined): Promise<IItemDescriptor[]> {
    if (!absolutePath) {
        return getChildItems(baseServerUrl, "api/TriumphTech/Magnus/GetTreeItems/root");
    }

    const url = getApiUrl(baseServerUrl, absolutePath);
    const cookie = await getAuthorizationCookie(baseServerUrl);

    if (cookie === null) {
        throw new Error("Unable to authorize with the server.");
    }

    const result = await axios.get<IItemDescriptor[]>(url, {
        headers: {
            "Cookie": cookie
        }
    });

    if (result.status === 403) {
        throw new Error("Server has denied you access to this resource.");
    }
    else if (result.status === 404) {
        throw new Error("Requested resource was not found.");
    }
    else if (result.status < 200 || result.status >= 300 || !result.data) {
        const message = typeof result.data === "object" ? JSON.stringify(result.data) : result.data;
        console.error(`Error in response to '${url}' - ${result.status}: ${message}}`);

        throw new Error("Unexpected response received from server.");
    }

    return result.data;
}

/**
 * Gets the file status information for the given URL.
 *
 * @param url The URL that will be requested to get the status information.
 *
 * @returns An object that describes the file status.
 */
export async function getFileStat(url: string): Promise<LightFileStat> {
    const cookie = await getAuthorizationCookie(getServerBaseUrl(url));

    if (cookie === null) {
        throw new Error("Unable to authorize with the server.");
    }

    let result = await axios.head(url, {
        headers: {
            "Cookie": cookie
        }
    });

    if (result.status === 405) {
        // Server doesn't support HEAD request. Try again with a GET.
        result = await axios.get(url, {
            headers: {
                "Cookie": cookie
            }
        });
    }

    if (result.status === 404) {
        throw new Error("Requested resource was not found.");
    }
    else if (result.status === 403) {
        throw new Error("Server has denied you access to this resource.");
    }
    else if (result.status < 200 || result.status >= 300) {
        const message = typeof result.data === "object" ? JSON.stringify(result.data) : result.data;
        console.error(`Error in response to '${url}' - ${result.status}: ${message}}`);

        throw new Error("Unexpected response received from server.");
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
export async function getFileContent(url: string): Promise<Uint8Array> {
    const cookie = await getAuthorizationCookie(getServerBaseUrl(url));

    if (cookie === null) {
        console.log("auth failure: ", url);
        throw new Error("Unable to authorize with the server.");
    }

    const result = await axios.get<ArrayBuffer>(url, {
        responseType: "arraybuffer",
        headers: {
            "Cookie": cookie
        }
    });

    if (result.status === 404) {
        throw new Error("Requested resource was not found.");
    }
    else if (result.status === 403) {
        throw new Error("Server has denied you access to this resource.");
    }
    else if (result.status < 200 || result.status >= 300 || !result.data) {
        const message = typeof result.data === "object" ? JSON.stringify(result.data) : result.data;
        console.error(`Error in response to '${url}' - ${result.status}: ${message}}`);

        throw new Error("Unexpected response received from server.");
    }

    return new Uint8Array(result.data);
}

/**
 * Updates the contents of the file at the specified URL.
 *
 * @param url The URL to be used for the POST request.
 * @param content The contents of the file that should be sent to the server.
 */
export async function updateFileContent(url: string, content: Uint8Array): Promise<void> {
    const cookie = await getAuthorizationCookie(getServerBaseUrl(url));

    if (cookie === null) {
        throw new Error("Unable to authorize with the server.");
    }

    const result = await axios.post<ArrayBuffer>(url, content, {
        responseType: "arraybuffer",
        headers: {
            "Content-Type": "application/octet-stream",
            "Cookie": cookie
        }
    });

    if (result.status === 404) {
        throw new Error("Requested resource was not found.");
    }
    else if (result.status === 403) {
        throw new Error("Server has denied you access to this resource.");
    }
    else if (result.status < 200 || result.status >= 300 || !result.data) {
        const message = typeof result.data === "object" ? JSON.stringify(result.data) : result.data;
        console.error(`Error in response to '${url}' - ${result.status}: ${message}}`);

        throw new Error("Unexpected response received from server.");
    }
}

/**
 * Requests the server to build the resource at the specified URL.
 *
 * @param url The URL to be used for the POST request.
 */
export function buildUrl(url: string): Promise<ActionResponse> {
    return actionUrl("POST", url);
}

/**
 * Requests the server to delete the resource at the specified URL.
 *
 * @param url The URL to be used for the POST request.
 */
export function deleteUrl(url: string): Promise<ActionResponse> {
    return actionUrl("DELETE", url);
}

/**
 * Requests the server to create a new file in the given folder.
 *
 * @param url The URL to be used for the POST request.
 * @param filename The name of the file that should be created.
 */
export function createNewFile(url: string, filename: string): Promise<ActionResponse> {
    return actionUrl("POST", url, filename, request => {
        request.headers!.contentType = "text/plain";
    });
}

/**
 * Requests the server to create a new folder in the given parent folder.
 *
 * @param url The URL to be used for the POST request.
 * @param name The name of the folder that should be created.
 */
export function createNewFolder(url: string, name: string): Promise<ActionResponse> {
    return actionUrl("POST", url, name, request => {
        request.headers!.contentType = "text/plain";
    });
}

/**
 * Requests the server to run an action at the specified URL.
 *
 * @param method The HTTP method verb to use for the action.
 * @param url The URL to be used for the POST request.
 */
export async function actionUrl(method: Method, url: string, data?: unknown, updateRequest?: ((request: AxiosRequestConfig) => void)): Promise<ActionResponse> {
    const cookie = await getAuthorizationCookie(getServerBaseUrl(url));

    if (cookie === null) {
        throw new Error("Unable to authorize with the server.");
    }

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

    const result = await axios.request<ActionResponse>(requestConfig);
    console.log(result);

    if (result.status === 404) {
        throw new Error("Requested resource was not found.");
    }
    else if (result.status === 403) {
        throw new Error("Server has denied you access to this resource.");
    }
    else if (result.status < 200 || result.status >= 300 || !result.data) {
        const message = typeof result.data === "object" ? JSON.stringify(result.data) : result.data;
        console.error(`Error in response to '${url}' - ${result.status}: ${message}}`);

        throw new Error("Unexpected response received from server.");
    }

    return result.data;
}

/**
 * Requests the server to upload new file content at the specified URL.
 *
 * @param url The URL to be used for the POST request.
 * @param localUris The URIs to the local files to be uploaded.
 */
export async function uploadUrl(url: string, localUris: Uri[]): Promise<ActionResponse> {
    const formData = new FormData();

    for (const filePath of localUris.map(uri => uri.fsPath)) {
        const file = await promises.readFile(filePath);

        formData.append("files", file, basename(filePath));
    }

    return await actionUrl("POST", url, formData, request => {
        request.headers = {
            ...formData.getHeaders(),
            ...request.headers
        };
    });
}

// #endregion
