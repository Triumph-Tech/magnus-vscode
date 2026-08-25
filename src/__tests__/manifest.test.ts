import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    MANIFEST_VERSION,
    Manifest,
    countTrackedFiles,
    hashBytes,
    readManifest,
    updateItemHash,
    writeManifest
, normalizePathPrefix, rootForPath} from "../manifest";

describe("hashBytes", () => {
    it("returns the sha256 prefix + lowercase hex digest", () => {
        const hash = hashBytes(Buffer.from("hello"));
        expect(hash).toBe("sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    });

    it("is stable across calls", () => {
        const bytes = Buffer.from("stable content");
        expect(hashBytes(bytes)).toBe(hashBytes(bytes));
    });

    it("differs for different byte sequences", () => {
        expect(hashBytes(Buffer.from("a"))).not.toBe(hashBytes(Buffer.from("b")));
    });

    it("is sensitive to trailing whitespace (raw-bytes hashing)", () => {
        // Important: hashing happens on raw bytes, NOT on normalized text, so
        // EOL or trailing-whitespace edits do drift the hash. This test pins
        // the contract.
        expect(hashBytes(Buffer.from("x"))).not.toBe(hashBytes(Buffer.from("x\n")));
    });
});

describe("manifest read/write round-trip", () => {
    let tmp: string;

    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), "magnus-manifest-test-"));
    });

    afterEach(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    const sampleManifest = (): Manifest => ({
        version: MANIFEST_VERSION,
        server: { url: "https://rock.example.com", alias: "rock-example-com" },
        roots: [{
            uri: "/api/tree/1",
            displayName: "My App",
            pulledAt: "2026-04-21T12:34:56.000Z",
            platform: "Mobile Apps",
            pathPrefix: ""
        }],
        items: {
            "Pages/Home/content.lava": {
                uri: "/api/FileContent/block-handler/42/content",
                isFolder: false,
                hash: "sha256:abc",
                lastSyncedAt: "2026-04-21T12:34:56.000Z"
            },
            "Pages/": {
                uri: "/api/tree/pages",
                isFolder: true,
                displayName: "Pages"
            }
        }
    });

    it("returns null when no manifest exists", async () => {
        expect(await readManifest(tmp)).toBeNull();
    });

    it("round-trips a manifest losslessly", async () => {
        const original = sampleManifest();
        await writeManifest(tmp, original);
        const roundtripped = await readManifest(tmp);
        expect(roundtripped).toEqual(original);
    });

    it("writes to the expected path", async () => {
        await writeManifest(tmp, sampleManifest());
        const raw = await fs.readFile(path.join(tmp, ".magnus", "manifest.json"), "utf8");
        expect(JSON.parse(raw).version).toBe(MANIFEST_VERSION);
    });

    it("rejects an unsupported version with an actionable message", async () => {
        await fs.mkdir(path.join(tmp, ".magnus"), { recursive: true });
        await fs.writeFile(
            path.join(tmp, ".magnus", "manifest.json"),
            JSON.stringify({ version: 999, server: {}, roots: [], items: {} }),
            "utf8"
        );
        await expect(readManifest(tmp)).rejects.toThrow(/Pull it again/);
    });

    it("rejects a v1 manifest and says the files are safe", async () => {
        // There is deliberately no migration (spec 7.3). Paths on disk are the
        // same in v1 and v2, so re-pulling reproduces the same files and only
        // the bookkeeping shape moves. The message has to say that, or someone
        // stares at a version number wondering what they lost.
        await fs.mkdir(path.join(tmp, ".magnus"), { recursive: true });
        await fs.writeFile(
            path.join(tmp, ".magnus", "manifest.json"),
            JSON.stringify({
                version: 1,
                server: { url: "https://rock.example.com", alias: "rock" },
                root: { uri: "/api/x", displayName: "My App", pulledAt: "2026-04-01T00:00:00Z" },
                items: {}
            }),
            "utf8"
        );
        await expect(readManifest(tmp)).rejects.toThrow(/older version of Magnus/);
        await expect(readManifest(tmp)).rejects.toThrow(/files on disk are unaffected/);
    });

    it("throws on malformed JSON (vs silently returning null)", async () => {
        await fs.mkdir(path.join(tmp, ".magnus"), { recursive: true });
        await fs.writeFile(path.join(tmp, ".magnus", "manifest.json"), "{ not json", "utf8");
        await expect(readManifest(tmp)).rejects.toThrow();
    });

    it("atomically writes via a .tmp rename (no .tmp file left behind)", async () => {
        await writeManifest(tmp, sampleManifest());
        const entries = await fs.readdir(path.join(tmp, ".magnus"));
        expect(entries).toContain("manifest.json");
        expect(entries).not.toContain("manifest.json.tmp");
    });
});

describe("updateItemHash", () => {
    it("updates an existing file entry's hash and bumps lastSyncedAt", () => {
        const manifest: Manifest = {
            version: MANIFEST_VERSION,
            server: { url: "x", alias: "x" },
            roots: [{ uri: "/", displayName: "r", pulledAt: "2026-04-21T00:00:00.000Z",
            pathPrefix: ""
        }],
            items: {
                "foo.lava": { uri: "/f", isFolder: false, hash: "sha256:old", lastSyncedAt: "2020-01-01T00:00:00.000Z" }
            }
        };
        updateItemHash(manifest, "foo.lava", "sha256:new");
        expect(manifest.items["foo.lava"].hash).toBe("sha256:new");
        expect(manifest.items["foo.lava"].lastSyncedAt).not.toBe("2020-01-01T00:00:00.000Z");
    });

    it("no-ops on unknown paths", () => {
        const manifest: Manifest = {
            version: MANIFEST_VERSION,
            server: { url: "x", alias: "x" },
            roots: [{ uri: "/", displayName: "r", pulledAt: "2026-04-21T00:00:00.000Z",
            pathPrefix: ""
        }],
            items: {}
        };
        updateItemHash(manifest, "missing.lava", "sha256:new");
        expect(manifest.items["missing.lava"]).toBeUndefined();
    });

    it("no-ops on folder entries", () => {
        const manifest: Manifest = {
            version: MANIFEST_VERSION,
            server: { url: "x", alias: "x" },
            roots: [{ uri: "/", displayName: "r", pulledAt: "2026-04-21T00:00:00.000Z",
            pathPrefix: ""
        }],
            items: {
                "dir/": { uri: "/d", isFolder: true, displayName: "dir" }
            }
        };
        updateItemHash(manifest, "dir/", "sha256:new");
        expect(manifest.items["dir/"].hash).toBeUndefined();
    });
});

describe("countTrackedFiles", () => {
    it("counts only files, not folders", () => {
        const manifest: Manifest = {
            version: MANIFEST_VERSION,
            server: { url: "x", alias: "x" },
            roots: [{ uri: "/", displayName: "r", pulledAt: "2026-04-21T00:00:00.000Z",
            pathPrefix: ""
        }],
            items: {
                "a.lava": { uri: "/a", isFolder: false, hash: "sha256:1" },
                "b.lava": { uri: "/b", isFolder: false, hash: "sha256:2" },
                "dir/":   { uri: "/d", isFolder: true, displayName: "dir" }
            }
        };
        expect(countTrackedFiles(manifest)).toBe(2);
    });

    it("returns 0 for an empty manifest", () => {
        const manifest: Manifest = {
            version: MANIFEST_VERSION,
            server: { url: "x", alias: "x" },
            roots: [{ uri: "/", displayName: "r", pulledAt: "2026-04-21T00:00:00.000Z",
            pathPrefix: ""
        }],
            items: {}
        };
        expect(countTrackedFiles(manifest)).toBe(0);
    });
});

/**
 * `rootForPath` is what makes a multi-root workspace safe to sync. Every
 * decision that must not cross a root boundary goes through it: which root a
 * file belongs to when push is gated, and which items may have deletions
 * computed after a partial scan.
 */
describe("rootForPath", () => {
    const manifest = (prefixes: string[]): Manifest => ({
        version: MANIFEST_VERSION,
        server: { url: "https://rock.example.com", alias: "rock" },
        roots: prefixes.map(p => ({
            uri: `/api/TriumphTech/Magnus/GetTreeItems/x/${p}`,
            displayName: p || "root",
            pulledAt: "2026-08-18T00:00:00Z",
            pathPrefix: p
        })),
        items: {}
    });

    it("finds the root a file belongs to", () => {
        const m = manifest(["Mobile Apps/Church App/", "Themes/Rock/"]);
        expect(rootForPath(m, "Themes/Rock/Styles/_variables.less")?.pathPrefix)
            .toBe("Themes/Rock/");
    });

    it("prefers the longest matching prefix", () => {
        // A root nested inside another root's directory still owns its own
        // files. Shortest-match would hand them to the outer root and gate
        // pushes against the wrong resource type.
        const m = manifest(["Apps/", "Apps/Inner/"]);
        expect(rootForPath(m, "Apps/Inner/page.xaml")?.pathPrefix).toBe("Apps/Inner/");
        expect(rootForPath(m, "Apps/outer.xaml")?.pathPrefix).toBe("Apps/");
    });

    it("returns null for a path under no root", () => {
        // Not a crash and not a default root: an unclaimed path means we cannot
        // say which resource it belongs to, and callers must decide for
        // themselves rather than be handed a plausible guess.
        const m = manifest(["Themes/Rock/"]);
        expect(rootForPath(m, "Mobile Apps/Church App/page.xaml")).toBeNull();
    });

    it("matches everything against a workspace-root prefix", () => {
        // Single-resource workspaces pulled at the root use an empty prefix.
        const m = manifest([""]);
        expect(rootForPath(m, "anything/at/all.txt")?.pathPrefix).toBe("");
    });

    it("does not match a partial directory name", () => {
        // "Themes/RockShop/" must not be claimed by the "Themes/Rock/" root.
        const m = manifest(["Themes/Rock/"]);
        expect(rootForPath(m, "Themes/RockShop/theme.less")).toBeNull();
    });
});

describe("normalizePathPrefix", () => {
    it("adds exactly one trailing slash", () => {
        expect(normalizePathPrefix("Themes/Rock")).toBe("Themes/Rock/");
        expect(normalizePathPrefix("Themes/Rock/")).toBe("Themes/Rock/");
        expect(normalizePathPrefix("Themes/Rock///")).toBe("Themes/Rock/");
    });

    it("strips leading slashes", () => {
        expect(normalizePathPrefix("/Themes/Rock")).toBe("Themes/Rock/");
    });

    it("converts Windows separators", () => {
        // Prefixes are compared against POSIX manifest keys, so a backslash
        // arriving from path.join on Windows would never match anything.
        expect(normalizePathPrefix("Mobile Apps\\Church App")).toBe("Mobile Apps/Church App/");
    });

    it("maps empty input to the empty prefix, not to a bare slash", () => {
        expect(normalizePathPrefix("")).toBe("");
        expect(normalizePathPrefix("/")).toBe("");
    });
});
