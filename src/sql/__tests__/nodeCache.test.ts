import { describe, expect, it } from "vitest";
import { columnFetchFailureTtlMs, isCacheEntryExpired, isColumnFetchBlocked, makeChildrenCacheKey, makeColumnNamesCacheKey, makeServerCacheKeyPrefix, makeTableListCacheKey, NodeCache, normalizeServerUrl } from "../nodeCache";
import { ObjectExplorerNodeBag, ObjectExplorerNodeType } from "../types";

const serverUrl = "https://rock.example.org";

const tableNode: ObjectExplorerNodeBag = {
    id: "table-1",
    name: "Person",
    type: ObjectExplorerNodeType.Table
};

describe("normalizeServerUrl", () => {
    it("lower cases and trims the URL", () => {
        expect(normalizeServerUrl("  HTTPS://Rock.Example.Org  ")).toBe("https://rock.example.org");
    });

    it("removes trailing slashes", () => {
        expect(normalizeServerUrl("https://rock.example.org//")).toBe("https://rock.example.org");
    });
});

describe("cache keys", () => {
    it("gives different node identifiers different keys", () => {
        expect(makeChildrenCacheKey(serverUrl, "a")).not.toBe(makeChildrenCacheKey(serverUrl, "b"));
    });

    it("gives the root node a stable key", () => {
        expect(makeChildrenCacheKey(serverUrl, undefined)).toBe(makeChildrenCacheKey(serverUrl, undefined));
        expect(makeChildrenCacheKey(serverUrl, undefined)).not.toBe(makeChildrenCacheKey(serverUrl, "a"));
    });

    it("gives different servers different keys for the same node", () => {
        expect(makeChildrenCacheKey(serverUrl, "a")).not.toBe(makeChildrenCacheKey("https://other.example.org", "a"));
    });

    it("treats equivalent spellings of a server as the same server", () => {
        expect(makeChildrenCacheKey("https://Rock.Example.Org/", "a")).toBe(makeChildrenCacheKey(serverUrl, "a"));
    });

    it("does not collide across the kinds of cached data", () => {
        const keys = [
            makeChildrenCacheKey(serverUrl, "Person"),
            makeColumnNamesCacheKey(serverUrl, "Person"),
            makeTableListCacheKey(serverUrl)
        ];

        expect(new Set(keys).size).toBe(keys.length);
    });

    it("treats table names that differ only in case as one table", () => {
        expect(makeColumnNamesCacheKey(serverUrl, "Person")).toBe(makeColumnNamesCacheKey(serverUrl, "person"));
        expect(makeColumnNamesCacheKey(serverUrl, " PERSON ")).toBe(makeColumnNamesCacheKey(serverUrl, "person"));
    });

    it("still keeps different tables apart", () => {
        expect(makeColumnNamesCacheKey(serverUrl, "Person")).not.toBe(makeColumnNamesCacheKey(serverUrl, "PersonAlias"));
    });

    it("prefixes every key for a server with the server prefix", () => {
        const prefix = makeServerCacheKeyPrefix(serverUrl);

        expect(makeChildrenCacheKey(serverUrl, "a").startsWith(prefix)).toBe(true);
        expect(makeColumnNamesCacheKey(serverUrl, "Person").startsWith(prefix)).toBe(true);
        expect(makeTableListCacheKey(serverUrl).startsWith(prefix)).toBe(true);
    });
});

describe("isCacheEntryExpired", () => {
    it("treats a missing entry as expired", () => {
        expect(isCacheEntryExpired(undefined, 1000, 500)).toBe(true);
    });

    it("keeps an entry that is younger than the time to live", () => {
        expect(isCacheEntryExpired({ value: 1, storedAt: 1000 }, 1400, 500)).toBe(false);
    });

    it("expires an entry once the time to live has elapsed", () => {
        expect(isCacheEntryExpired({ value: 1, storedAt: 1000 }, 1500, 500)).toBe(true);
        expect(isCacheEntryExpired({ value: 1, storedAt: 1000 }, 5000, 500)).toBe(true);
    });

    it("never expires an entry when the time to live is zero or negative", () => {
        expect(isCacheEntryExpired({ value: 1, storedAt: 0 }, 9999999, 0)).toBe(false);
        expect(isCacheEntryExpired({ value: 1, storedAt: 0 }, 9999999, -1)).toBe(false);
    });
});

describe("isColumnFetchBlocked", () => {
    it("does not block a table that has never failed", () => {
        expect(isColumnFetchBlocked(undefined, 1000, 500)).toBe(false);
    });

    it("blocks a table whose failure is still remembered", () => {
        expect(isColumnFetchBlocked(1000, 1400, 500)).toBe(true);
    });

    it("stops blocking once the failure has been forgotten", () => {
        expect(isColumnFetchBlocked(1000, 1500, 500)).toBe(false);
        expect(isColumnFetchBlocked(1000, 9000, 500)).toBe(false);
    });

    it("remembers nothing when the time to live is zero or negative", () => {
        expect(isColumnFetchBlocked(1000, 1000, 0)).toBe(false);
        expect(isColumnFetchBlocked(1000, 1000, -1)).toBe(false);
    });

    it("defaults to the shared failure time to live", () => {
        expect(isColumnFetchBlocked(1000, 1000 + columnFetchFailureTtlMs - 1)).toBe(true);
        expect(isColumnFetchBlocked(1000, 1000 + columnFetchFailureTtlMs)).toBe(false);
    });
});

describe("NodeCache", () => {
    it("returns a stored value", () => {
        const cache = new NodeCache(1000);

        cache.setChildren(serverUrl, "db-1", [tableNode]);

        expect(cache.getChildren(serverUrl, "db-1")).toEqual([tableNode]);
    });

    it("returns undefined for a value that was never stored", () => {
        const cache = new NodeCache(1000);

        expect(cache.getChildren(serverUrl, "db-1")).toBeUndefined();
    });

    it("stops returning a value once it has expired", () => {
        const cache = new NodeCache(1000);

        cache.set("key", "value", 0);

        expect(cache.get("key", 999)).toBe("value");
        expect(cache.get("key", 1000)).toBeUndefined();
    });

    it("invalidates only the requested server", () => {
        const cache = new NodeCache(1000);
        const otherUrl = "https://other.example.org";

        cache.setChildren(serverUrl, undefined, [tableNode]);
        cache.setChildren(otherUrl, undefined, [tableNode]);

        cache.invalidateServer(serverUrl);

        expect(cache.getChildren(serverUrl, undefined)).toBeUndefined();
        expect(cache.getChildren(otherUrl, undefined)).toEqual([tableNode]);
    });

    it("invalidates every kind of data for a server", () => {
        const cache = new NodeCache(1000);

        cache.setChildren(serverUrl, "db-1", [tableNode]);
        cache.set(makeTableListCacheKey(serverUrl), []);
        cache.set(makeColumnNamesCacheKey(serverUrl, "Person"), ["Id"]);

        cache.invalidateServer(serverUrl);

        expect(cache.getChildren(serverUrl, "db-1")).toBeUndefined();
        expect(cache.get(makeTableListCacheKey(serverUrl))).toBeUndefined();
        expect(cache.get(makeColumnNamesCacheKey(serverUrl, "Person"))).toBeUndefined();
    });

    it("invalidates everything when asked", () => {
        const cache = new NodeCache(1000);

        cache.setChildren(serverUrl, undefined, [tableNode]);
        cache.setChildren("https://other.example.org", undefined, [tableNode]);

        cache.invalidateAll();

        expect(cache.getChildren(serverUrl, undefined)).toBeUndefined();
        expect(cache.getChildren("https://other.example.org", undefined)).toBeUndefined();
    });
});
