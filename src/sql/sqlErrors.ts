/**
 * The errors that the SQL tools raise, and the pure logic that classifies a
 * failed request into one of them.
 *
 * There is no runtime handshake that tells us whether a server's Magnus plugin
 * supports the `Sql/*` endpoints. A plugin older than v2.0 simply has no route
 * registered, so the request comes back as a 404. Reporting that as "resource
 * not found" is useless to the person, so it is translated here instead.
 */

/**
 * The message that the shared {@link Api} class throws for an HTTP 404. The SQL
 * client rides on that class's public surface, so this string is the only
 * signal available that a route does not exist. It is duplicated here on
 * purpose, and the unit tests document the coupling.
 */
export const notFoundMessage = "Requested resource was not found.";

/** The message shown when a server's plugin has no SQL endpoints. */
export const unsupportedPluginMessage = "This server's Magnus plugin does not support SQL tools (requires plugin version 2.0 or later).";

/**
 * Raised when a `Sql/*` endpoint does not exist on the server, which means the
 * installed Magnus plugin predates SQL tools support.
 */
export class SqlToolsUnsupportedError extends Error {
    /**
     * Creates a new instance of {@link SqlToolsUnsupportedError}.
     *
     * @param serverUrl The URL of the server that does not support SQL tools.
     */
    public constructor(public readonly serverUrl?: string) {
        super(unsupportedPluginMessage);

        this.name = "SqlToolsUnsupportedError";
    }
}

/**
 * Determines if an HTTP status code means the endpoint does not exist on the
 * server, and therefore that the plugin does not support SQL tools.
 *
 * @param status The HTTP status code returned by the server.
 *
 * @returns True if the status indicates an unsupported plugin.
 */
export function isUnsupportedPluginStatus(status: number): boolean {
    return status === 404;
}

/**
 * Translates an error raised while calling a `Sql/*` endpoint into the most
 * meaningful error we can report.
 *
 * @param error The error that was raised by the request.
 * @param serverUrl The URL of the server the request was sent to.
 *
 * @returns The error that should be reported to the person.
 */
export function classifySqlError(error: unknown, serverUrl?: string): Error {
    if (error instanceof SqlToolsUnsupportedError) {
        return error;
    }

    if (error instanceof Error) {
        if (error.message === notFoundMessage) {
            return new SqlToolsUnsupportedError(serverUrl);
        }

        return error;
    }

    return new Error(typeof error === "string" && error !== "" ? error : "Unable to complete the SQL request.");
}
