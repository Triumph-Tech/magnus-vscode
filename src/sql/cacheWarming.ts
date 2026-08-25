/**
 * The rule that decides whether binding a document to a server should kick off
 * a background walk of that server's tables.
 *
 * The point of warming is that table completion and hover are only as good as
 * what the object explorer cache holds, and nothing puts anything in it until
 * someone expands the tree. Binding a document is the moment we learn which
 * server matters, so it is the moment to fill the cache.
 *
 * The rule has to be careful in one direction only: never walk the same server
 * twice while the walk is still worth something, and never turn a failure into a
 * loop. A walk is several requests deep, and every editor that opens fires a
 * binding.
 *
 * "Worth something" is why a warm has a time on it. The cache the walk fills
 * expires after {@link defaultCacheTtlMs}, so a warm recorded before that has
 * elapsed is a warm of a cache that is no longer there; treating it as warm
 * forever is how completion used to fall back to the static catalog five minutes
 * in and never recover.
 *
 * Nothing here touches vscode, so the rule is unit testable.
 */

import { defaultCacheTtlMs, normalizeServerUrl } from "./nodeCache";

/** What has happened to the warming of one server in this session. */
export type WarmStatus =
    /** A walk is running right now. */
    | "running"

    /** A walk finished and the cache holds the tables. */
    | "warmed"

    /** A walk failed. A later binding of the same server may try once more. */
    | "failed";

/** What has happened to the warming of one server, and when. */
export type WarmEntry = {
    /** How the last walk of the server left it. */
    status: WarmStatus;

    /** The value of `Date.now()` when the status was recorded. */
    at: number;
};

/** What has happened to the warming of each server, keyed by normalized server URL. */
export type WarmState = Readonly<Record<string, WarmEntry>>;

/** The state before anything has been warmed. */
export const emptyWarmState: WarmState = {};

/**
 * Decides whether a binding should start a walk.
 *
 * A server that is warm and whose warm is still inside the cache's time to live
 * needs nothing, and one that is mid walk must not be walked again. A server
 * whose last walk failed is allowed one more try, but only because something
 * else bound to it: the failure alone never reschedules anything, which is what
 * keeps an unreachable server from being retried forever. A warm older than the
 * time to live counts as cold, because the entries it produced have expired.
 *
 * @param state What has happened so far.
 * @param serverUrl The URL of the server a document just bound to.
 * @param now The current time, as returned by `Date.now()`.
 * @param ttlMs The number of milliseconds a warm stays good for, which is the cache's own time to live.
 *
 * @returns True if a walk should be started.
 */
export function shouldWarmTables(state: WarmState, serverUrl: string, now: number = Date.now(), ttlMs: number = defaultCacheTtlMs): boolean {
    if (serverUrl.trim().length === 0) {
        return false;
    }

    const entry = state[normalizeServerUrl(serverUrl)];

    if (!entry) {
        return true;
    }

    if (entry.status === "running") {
        return false;
    }

    if (entry.status === "failed") {
        return true;
    }

    return isWarmStale(entry, now, ttlMs);
}

/**
 * Determines if a recorded warm has outlived the cache it filled.
 *
 * A time to live of zero or less never expires, matching the cache itself, so a
 * cache configured to hold forever is never re-walked.
 *
 * @param entry The entry to judge.
 * @param now The current time, as returned by `Date.now()`.
 * @param ttlMs The number of milliseconds a warm stays good for.
 *
 * @returns True if the warm is old enough that the cache behind it has gone.
 */
export function isWarmStale(entry: WarmEntry, now: number, ttlMs: number): boolean {
    if (ttlMs <= 0) {
        return false;
    }

    return now - entry.at >= ttlMs;
}

/**
 * Records that a walk of a server has started.
 *
 * @param state What has happened so far.
 * @param serverUrl The URL of the server being walked.
 * @param now The current time, as returned by `Date.now()`.
 *
 * @returns The new state. The input is never modified.
 */
export function markWarmStarted(state: WarmState, serverUrl: string, now: number = Date.now()): WarmState {
    return {
        ...state,
        [normalizeServerUrl(serverUrl)]: {
            status: "running",
            at: now
        }
    };
}

/**
 * Records how a walk of a server ended.
 *
 * @param state What has happened so far.
 * @param serverUrl The URL of the server that was walked.
 * @param succeeded True if the tables are now cached.
 * @param now The current time, as returned by `Date.now()`.
 *
 * @returns The new state. The input is never modified.
 */
export function markWarmFinished(state: WarmState, serverUrl: string, succeeded: boolean, now: number = Date.now()): WarmState {
    return {
        ...state,
        [normalizeServerUrl(serverUrl)]: {
            status: succeeded ? "warmed" : "failed",
            at: now
        }
    };
}

/**
 * Forgets what is known about a server so that the next binding warms it again.
 *
 * Called when the person refreshes that server's subtree, which throws away
 * every cached entry the walk produced. A walk that is still running is left
 * alone: it will record its own outcome, and starting a second one alongside it
 * is exactly what the state exists to prevent.
 *
 * @param state What has happened so far.
 * @param serverUrl The URL of the server whose cache was thrown away.
 *
 * @returns The new state. The input is never modified.
 */
export function forgetWarmedServer(state: WarmState, serverUrl: string): WarmState {
    const key = normalizeServerUrl(serverUrl);
    const entry = state[key];

    if (!entry || entry.status === "running") {
        return state;
    }

    const next = { ...state };

    delete next[key];

    return next;
}
