/**
 * Translate raw Node/axios network error prose into something a human can
 * act on. Upstream errors leak `getaddrinfo ENOTFOUND host`, `connect
 * ECONNREFUSED 127.0.0.1:80`, `timeout of 60000ms exceeded` — accurate but
 * ugly. This wrapper recognizes the common system-error codes and replaces
 * them with a short sentence that tells the user *what to do*, without
 * swallowing the useful context (host, timeout value).
 */
export function friendlyNetworkMessage(raw: string, serverUrl: string): string {
    const host = hostFromUrl(serverUrl) ?? serverUrl;

    // DNS lookup failed — almost always "wrong VPN" or "server is internal-only."
    if (/ENOTFOUND/i.test(raw)) {
        return `Can't resolve ${host}. Check your connection or VPN.`;
    }

    // Host resolved but refused the connection — server down, or wrong port.
    if (/ECONNREFUSED/i.test(raw)) {
        return `${host} refused the connection. Is the server up and reachable on that port?`;
    }

    // TCP reset mid-request — unstable connection or a firewall dropping packets.
    if (/ECONNRESET/i.test(raw)) {
        return `Connection to ${host} was reset. Try again.`;
    }

    // Network layer timeout (different from axios's timeout, rarer but possible).
    if (/ETIMEDOUT/i.test(raw) || /network timeout/i.test(raw)) {
        return `${host} did not respond in time. Try again.`;
    }

    // Axios's own timeout (the 60s ceiling in api.ts).
    const axiosTimeout = raw.match(/timeout of (\d+)ms exceeded/i);
    if (axiosTimeout) {
        const seconds = Math.round(parseInt(axiosTimeout[1], 10) / 1000);
        return `${host} did not respond within ${seconds}s. Try again, or check server load.`;
    }

    // TLS/cert problems — uncommon against Rock, but distinctive enough to flag.
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(raw)) {
        return `TLS certificate problem reaching ${host}: ${raw}`;
    }

    // Fallback: show the raw message. Still useful, just not translated.
    return raw;
}

/**
 * Extract a compact host label from a server URL. Pure string-level parsing
 * so this module has no vscode / URL-class dep and stays testable.
 */
function hostFromUrl(serverUrl: string): string | null {
    const schemeEnd = serverUrl.indexOf("://");
    const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3;
    const authority = serverUrl.substring(authorityStart);
    const firstSlash = authority.indexOf("/");
    const host = firstSlash === -1 ? authority : authority.substring(0, firstSlash);
    return host.length > 0 ? host : null;
}
