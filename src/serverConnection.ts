/**
 * Is this machine set up to talk to a given Magnus server?
 *
 * Cloud mode never had to ask. You add a server, you use that server, and the
 * two happen in the same sitting on the same machine. Local mode broke that
 * assumption the moment `magnus.json` became committed: a clone names a server
 * that the person who cloned it may have no credentials for, and with many
 * partners across many machines that is the common case, not the edge one.
 *
 * Today an unconfigured server surfaces only as a late `AuthenticationError` on
 * the first Fetch, which reads as "Magnus is broken" rather than "you have not
 * connected to this server yet". These helpers let the UI say the true thing up
 * front, before any network call.
 */

import { Secrets } from "./secrets";

/**
 * Reduce a server URL to a stable comparison key.
 *
 * `KnownServers` entries are normalized to `scheme://authority` when added
 * (`commands.ts`), but a URL arriving from `magnus.json` was written by whoever
 * last pulled, possibly on a different machine and a different extension
 * version. Comparing raw strings would report a perfectly good server as
 * disconnected over a trailing slash, so both sides get normalized here.
 *
 * Host is lowercased because DNS is case-insensitive; the path is dropped
 * because the server identity is the origin.
 */
export function normalizeServerUrl(serverUrl: string): string {
    const trimmed = serverUrl.trim();
    const schemeEnd = trimmed.indexOf("://");

    if (schemeEnd === -1) {
        return trimmed.replace(/\/+$/, "").toLowerCase();
    }

    const scheme = trimmed.substring(0, schemeEnd).toLowerCase();
    const afterScheme = trimmed.substring(schemeEnd + 3);
    const firstSlash = afterScheme.indexOf("/");
    const authority = firstSlash === -1 ? afterScheme : afterScheme.substring(0, firstSlash);

    return `${scheme}://${authority.toLowerCase()}`;
}

/** Whether a URL appears in the saved server list, comparing normalized forms. */
export function isServerKnown(knownServers: string[], serverUrl: string): boolean {
    const target = normalizeServerUrl(serverUrl);
    return knownServers.some(known => normalizeServerUrl(known) === target);
}

/**
 * How this machine stands relative to one server.
 *
 * Deliberately two states, not three. "Credentials exist but are wrong" is not
 * distinguishable without a network round trip, and the existing
 * `AuthenticationError` path already handles it with a re-authenticate toast.
 * Adding a third state here would mean blocking the UI on a login attempt just
 * to draw an icon.
 */
export type ServerConnectionState =
    /** Credentials are stored for this server. Sync operations can be attempted. */
    | "connected"
    /** No credentials on this machine. Sync operations will fail; offer to connect. */
    | "disconnected";

/**
 * Resolve connection state for a server URL.
 *
 * Keyed on stored credentials rather than `KnownServers` membership, and that
 * choice is load-bearing. `commands.ts` calls `api.login(...)` without awaiting
 * it, testing a Promise object for truthiness, so a failed add still lands the
 * URL in `KnownServers`. List membership therefore is not evidence that
 * anything works. Credentials in SecretStorage are the honest signal.
 */
export async function resolveServerConnection(
    secrets: Secrets,
    serverUrl: string
): Promise<ServerConnectionState> {
    const credentials = await secrets.getCredentials(serverUrl);
    return credentials ? "connected" : "disconnected";
}

/**
 * Add a URL to the saved server list if it is not already there.
 *
 * Returns whether the list changed, so callers can skip firing a tree refresh
 * for a no-op. `reauthenticateServer` saves credentials but never touches this
 * list, which is why connecting a workspace's server has to do it explicitly:
 * otherwise you end up with working credentials for a server the tree refuses
 * to show.
 */
export async function addKnownServer(
    globalState: { get<T>(key: string, fallback: T): T; update(key: string, value: unknown): Thenable<void> },
    serverUrl: string
): Promise<boolean> {
    const known = globalState.get<string[]>("KnownServers", []);
    if (isServerKnown(known, serverUrl)) {
        return false;
    }
    await globalState.update("KnownServers", [...known, normalizeServerUrl(serverUrl)]);
    return true;
}
