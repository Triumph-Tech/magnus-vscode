import { ObjectExplorerNodeBag } from "./types";

/**
 * A per-server cache of object explorer nodes and table column names.
 *
 * Expanding the tree, fuzzy finding a table and (later) completion all want the
 * same data, so it is fetched once and held for a short time. The decision
 * logic (keying and expiry) is pure and lives in the exported functions; the
 * class is a thin holder of state.
 */

/** The default number of milliseconds a cache entry remains usable. */
export const defaultCacheTtlMs = 5 * 60 * 1000;

/**
 * The number of milliseconds a failed column fetch is remembered for.
 *
 * Much shorter than {@link defaultCacheTtlMs} on purpose. A failure is usually a
 * name that was never a table, and remembering that for a few seconds is enough
 * to turn a hover storm into one request; remembering it for minutes would hide
 * a table that has just been created or a server that has just come back.
 */
export const columnFetchFailureTtlMs = 45 * 1000;

/**
 * A single cached value along with the time it was stored.
 */
export type CacheEntry<T> = {
    /** The value that was cached. */
    value: T;

    /** The value of `Date.now()` when the value was stored. */
    storedAt: number;
};

/**
 * Builds the cache key for the children of an object explorer node.
 *
 * @param serverUrl The URL of the server the node belongs to.
 * @param nodeId The identifier of the node, or undefined for the root node.
 *
 * @returns A string that uniquely identifies the node within the cache.
 */
export function makeChildrenCacheKey(serverUrl: string, nodeId: string | undefined): string {
    return `${normalizeServerUrl(serverUrl)}|children|${nodeId ?? ""}`;
}

/**
 * Builds the cache key for the column names of a table.
 *
 * The table name is lower cased along with the server URL, because SQL Server
 * table names are matched case insensitively. Keeping the spelling would mean
 * `Person` and `person` each getting their own entry and their own request.
 *
 * @param serverUrl The URL of the server the table belongs to.
 * @param tableName The name of the table.
 *
 * @returns A string that uniquely identifies the table within the cache.
 */
export function makeColumnNamesCacheKey(serverUrl: string, tableName: string): string {
    return `${normalizeServerUrl(serverUrl)}|columns|${tableName.trim().toLowerCase()}`;
}

/**
 * Decides whether a column fetch should be skipped because the last attempt at
 * it failed recently.
 *
 * @param failedAt The value of `Date.now()` when the fetch last failed, or undefined if it never has.
 * @param now The current time, as returned by `Date.now()`.
 * @param ttlMs The number of milliseconds a failure is remembered for. A value of 0 or less remembers nothing.
 *
 * @returns True if the fetch should not be attempted again yet.
 */
export function isColumnFetchBlocked(failedAt: number | undefined, now: number, ttlMs: number = columnFetchFailureTtlMs): boolean {
    if (failedAt === undefined) {
        return false;
    }

    if (ttlMs <= 0) {
        return false;
    }

    return now - failedAt < ttlMs;
}

/**
 * Builds the cache key for the flattened table list of a server.
 *
 * @param serverUrl The URL of the server whose tables are cached.
 *
 * @returns A string that uniquely identifies the table list within the cache.
 */
export function makeTableListCacheKey(serverUrl: string): string {
    return `${normalizeServerUrl(serverUrl)}|tables`;
}

/**
 * Builds the prefix shared by every cache key belonging to a server. Used to
 * invalidate a whole server at once.
 *
 * @param serverUrl The URL of the server.
 *
 * @returns A string that every key for that server starts with.
 */
export function makeServerCacheKeyPrefix(serverUrl: string): string {
    return `${normalizeServerUrl(serverUrl)}|`;
}

/**
 * Normalizes a server URL so that two spellings of the same server share cache
 * entries.
 *
 * @param serverUrl The URL of the server.
 *
 * @returns The normalized form of the URL.
 */
export function normalizeServerUrl(serverUrl: string): string {
    let normalized = serverUrl.trim().toLowerCase();

    while (normalized.endsWith("/")) {
        normalized = normalized.substring(0, normalized.length - 1);
    }

    return normalized;
}

/**
 * Determines if a cache entry has outlived its time to live.
 *
 * @param entry The entry to check, which may be missing.
 * @param now The current time, as returned by `Date.now()`.
 * @param ttlMs The number of milliseconds an entry remains usable. A value of 0 or less never expires.
 *
 * @returns True if the entry is missing or expired and must be fetched again.
 */
export function isCacheEntryExpired<T>(entry: CacheEntry<T> | undefined, now: number, ttlMs: number): boolean {
    if (!entry) {
        return true;
    }

    if (ttlMs <= 0) {
        return false;
    }

    return now - entry.storedAt >= ttlMs;
}

/**
 * Holds object explorer data for the servers whose SQL subtree has been
 * browsed.
 */
export class NodeCache {
    // #region Private Properties

    /** The cached values, keyed by the functions in this module. */
    private entries: Record<string, CacheEntry<unknown>> = {};

    /** The number of milliseconds an entry remains usable. */
    private ttlMs: number;

    // #endregion

    // #region Constructors

    /**
     * Creates a new cache.
     *
     * @param ttlMs The number of milliseconds an entry remains usable.
     */
    public constructor(ttlMs: number = defaultCacheTtlMs) {
        this.ttlMs = ttlMs;
    }

    // #endregion

    // #region Public Functions

    /**
     * Gets a cached value if one is present and has not expired.
     *
     * @param key The cache key, built by one of this module's key functions.
     * @param now The current time, as returned by `Date.now()`.
     *
     * @returns The cached value or undefined if it must be fetched again.
     */
    public get<T>(key: string, now: number = Date.now()): T | undefined {
        const entry = this.entries[key] as CacheEntry<T> | undefined;

        if (isCacheEntryExpired(entry, now, this.ttlMs)) {
            return undefined;
        }

        return entry?.value;
    }

    /**
     * Stores a value in the cache.
     *
     * @param key The cache key, built by one of this module's key functions.
     * @param value The value to store.
     * @param now The current time, as returned by `Date.now()`.
     */
    public set<T>(key: string, value: T, now: number = Date.now()): void {
        this.entries[key] = {
            value,
            storedAt: now
        };
    }

    /**
     * Removes every entry belonging to a single server. Called when the person
     * refreshes that server's SQL subtree.
     *
     * @param serverUrl The URL of the server to invalidate.
     */
    public invalidateServer(serverUrl: string): void {
        const prefix = makeServerCacheKeyPrefix(serverUrl);

        for (const key of Object.keys(this.entries)) {
            if (key.startsWith(prefix)) {
                delete this.entries[key];
            }
        }
    }

    /**
     * Removes every entry from the cache.
     */
    public invalidateAll(): void {
        this.entries = {};
    }

    /**
     * Gets the cached children of an object explorer node.
     *
     * @param serverUrl The URL of the server the node belongs to.
     * @param nodeId The identifier of the node, or undefined for the root node.
     *
     * @returns The cached child nodes or undefined if they must be fetched.
     */
    public getChildren(serverUrl: string, nodeId: string | undefined): ObjectExplorerNodeBag[] | undefined {
        return this.get<ObjectExplorerNodeBag[]>(makeChildrenCacheKey(serverUrl, nodeId));
    }

    /**
     * Stores the children of an object explorer node.
     *
     * @param serverUrl The URL of the server the node belongs to.
     * @param nodeId The identifier of the node, or undefined for the root node.
     * @param nodes The child nodes to store.
     */
    public setChildren(serverUrl: string, nodeId: string | undefined, nodes: ObjectExplorerNodeBag[]): void {
        this.set(makeChildrenCacheKey(serverUrl, nodeId), nodes);
    }

    // #endregion
}
