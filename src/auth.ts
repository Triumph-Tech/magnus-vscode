import { getPassword, setPassword, deletePassword } from "keytar";

const serviceKey = "tech.triumph.vscode-plugin";

/**
 * The credentials that make up a username and password pair.
 */
export type Credentials = {
    /** The username for these credentials. */
    username: string;

    /** The password for these credentials. */
    password: string;
};

/**
 * Gets the stored credentials for the given server URL.
 *
 * @param serverUrl The server URL that identifies the credentials to retrieve.
 *
 * @returns The credentials to authenticate to the server or null if not found.
 */
export async function getCredentials(serverUrl: string): Promise<Credentials | null> {
    const json = await getPassword(serviceKey, serverUrl);

    if (json === null) {
        return null;
    }

    try {
        return JSON.parse(json);
    }
    catch {
        return null;
    }
}

/**
 * Saves the credentials in the store.
 *
 * @param serverUrl The server URL that identifies the credentials to store.
 * @param username The username to store in the credentials.
 * @param password The password to store in the credentials.
 */
export async function saveCredentials(serverUrl: string, username: string, password: string): Promise<void> {
    const credentials: Credentials = {
        username,
        password
    };

    await setPassword(serviceKey, serverUrl, JSON.stringify(credentials));
}

/**
 * Deletes the credentials from the store.
 *
 * @param serverUrl The server URL that identifies the credentials to delete.
 */
export async function deleteCredentials(serverUrl: string): Promise<void> {
    await deletePassword(serviceKey, serverUrl);
}
