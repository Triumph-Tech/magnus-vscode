import * as vscode from "vscode";

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
 * Provides secure storage of secret data.
 */
export class Secrets {
    /** The extension context that will be used to communicate with vscode. */
    private context: vscode.ExtensionContext;

    /**
     * Creates a new secret storage instance.
     *
     * @param context The Visual Studio Code extension context.
     */
    public constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * Gets the stored credentials for the given server URL.
     *
     * @param serverUrl The server URL that identifies the credentials to retrieve.
     *
     * @returns The credentials to authenticate to the server or null if not found.
     */
    public async getCredentials(serverUrl: string): Promise<Credentials | null> {
        const json = await this.context.secrets.get(serverUrl);

        if (!json) {
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
    public async saveCredentials(serverUrl: string, username: string, password: string): Promise<void> {
        const credentials: Credentials = {
            username,
            password
        };

        await this.context.secrets.store(serverUrl, JSON.stringify(credentials));
    }

    /**
     * Deletes the credentials from the store.
     *
     * @param serverUrl The server URL that identifies the credentials to delete.
     */
    public async deleteCredentials(serverUrl: string): Promise<void> {
        await this.context.secrets.delete(serverUrl);
    }

}
