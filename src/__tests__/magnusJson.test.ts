import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    MAGNUS_JSON_SCHEMA_VERSION,
    MagnusJson,
    ensureMagnusGitignore,
    readMagnusJson,
    writeMagnusJson
} from "../magnusJson";

/**
 * `magnus.json` is the committed half of a pulled workspace (spec 7.4): it
 * records intent, not sync state, so a clone is self-describing without
 * pretending to be syncable.
 */

const sample = (): MagnusJson => ({
    schemaVersion: MAGNUS_JSON_SCHEMA_VERSION,
    server: { url: "https://rock.example.com", alias: "rock-example-com" },
    selection: [
        {
            uri: "/api/TriumphTech/Magnus/GetTreeItems/themes/theme/Rock",
            displayName: "Rock",
            platform: "Themes",
            pathPrefix: "Themes/Rock/"
        }
    ],
    pulledAt: "2026-08-18T12:00:00.000Z",
    versions: { extension: "1.2.0", plugin: "2.4.0" }
});

describe("magnus.json read/write", () => {
    let tmp: string;

    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), "magnus-json-test-"));
    });

    afterEach(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    it("round-trips a selection", async () => {
        await writeMagnusJson(tmp, sample());
        expect(await readMagnusJson(tmp)).toEqual(sample());
    });

    it("returns null when there is no file", async () => {
        expect(await readMagnusJson(tmp)).toBeNull();
    });

    it("lands at the workspace root, outside .magnus", async () => {
        // Being outside .magnus/ is the whole point: .magnus/ is gitignored and
        // this file has to be committed.
        await writeMagnusJson(tmp, sample());
        await expect(fs.stat(path.join(tmp, "magnus.json"))).resolves.toBeTruthy();
    });

    it("carries no hashes and no item list", async () => {
        // Committing sync state would manufacture the "manifest present,
        // baseline absent" state that the sync classifiers handle worst.
        await writeMagnusJson(tmp, sample());
        const raw = await fs.readFile(path.join(tmp, "magnus.json"), "utf8");
        expect(raw).not.toMatch(/"hash"/);
        expect(raw).not.toMatch(/"items"/);
        expect(raw).not.toMatch(/idkey/i);
    });

    it("is written for humans to diff", async () => {
        await writeMagnusJson(tmp, sample());
        const raw = await fs.readFile(path.join(tmp, "magnus.json"), "utf8");
        expect(raw.endsWith("\n")).toBe(true);
        expect(raw).toContain("\n  \"server\"");
    });

    it("throws on a file that is present but not a selection", async () => {
        // Treating a corrupt file as "no selection" would present an empty
        // dialog and invite rebuilding the list from scratch.
        await fs.writeFile(path.join(tmp, "magnus.json"), JSON.stringify({ hello: true }), "utf8");
        await expect(readMagnusJson(tmp)).rejects.toThrow(/does not look like/);
    });
});

describe("ensureMagnusGitignore", () => {
    let tmp: string;

    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), "magnus-ignore-test-"));
    });

    afterEach(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    const read = () => fs.readFile(path.join(tmp, ".gitignore"), "utf8");

    it("creates a .gitignore that ignores .magnus/", async () => {
        await ensureMagnusGitignore(tmp);
        expect(await read()).toMatch(/^\.magnus\/$/m);
    });

    it("appends to an existing .gitignore without disturbing it", async () => {
        await fs.writeFile(path.join(tmp, ".gitignore"), "node_modules\n*.log\n", "utf8");
        await ensureMagnusGitignore(tmp);

        const contents = await read();
        expect(contents).toContain("node_modules");
        expect(contents).toContain("*.log");
        expect(contents).toMatch(/^\.magnus\/$/m);
    });

    it("adds a newline first when the existing file lacks a trailing one", async () => {
        // Otherwise the entry gets glued onto the last rule and ignores nothing.
        await fs.writeFile(path.join(tmp, ".gitignore"), "node_modules", "utf8");
        await ensureMagnusGitignore(tmp);
        expect(await read()).toMatch(/^node_modules$/m);
        expect(await read()).toMatch(/^\.magnus\/$/m);
    });

    it("is idempotent", async () => {
        await ensureMagnusGitignore(tmp);
        await ensureMagnusGitignore(tmp);
        const occurrences = (await read()).match(/^\.magnus\/$/gm) ?? [];
        expect(occurrences).toHaveLength(1);
    });

    it("recognises an existing entry without a trailing slash", async () => {
        await fs.writeFile(path.join(tmp, ".gitignore"), ".magnus\n", "utf8");
        await ensureMagnusGitignore(tmp);
        expect(await read()).toBe(".magnus\n");
    });

    it("does not mistake a different rule for the entry", async () => {
        // ".magnus-backup/" is not ".magnus/", and matching loosely would leave
        // real sync state committed.
        await fs.writeFile(path.join(tmp, ".gitignore"), ".magnus-backup/\n", "utf8");
        await ensureMagnusGitignore(tmp);
        expect(await read()).toMatch(/^\.magnus\/$/m);
    });
});

/**
 * A workspace is often not the repository root: several partner folders can
 * live in one monorepo, each its own Magnus workspace. Writing a redundant
 * one-line `.gitignore` into every one of them litters the repository.
 */
describe("ensureMagnusGitignore in a monorepo", () => {
    let tmp: string;

    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), "magnus-monorepo-test-"));
        await fs.mkdir(path.join(tmp, ".git"), { recursive: true });
        await fs.mkdir(path.join(tmp, "partner-a"), { recursive: true });
    });

    afterEach(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    const exists = async (p: string) => {
        try { await fs.stat(p); return true; }
        catch { return false; }
    };

    it("writes nothing when the repository root already ignores .magnus/", async () => {
        await fs.writeFile(path.join(tmp, ".gitignore"), "node_modules\n.magnus/\n", "utf8");

        await ensureMagnusGitignore(path.join(tmp, "partner-a"));

        expect(await exists(path.join(tmp, "partner-a", ".gitignore"))).toBe(false);
    });

    it("still writes one when no ancestor covers it", async () => {
        await fs.writeFile(path.join(tmp, ".gitignore"), "node_modules\n", "utf8");

        await ensureMagnusGitignore(path.join(tmp, "partner-a"));

        const written = await fs.readFile(path.join(tmp, "partner-a", ".gitignore"), "utf8");
        expect(written).toContain(".magnus/");
    });

    it("matches an ancestor entry written without the trailing slash", async () => {
        await fs.writeFile(path.join(tmp, ".gitignore"), ".magnus\n", "utf8");

        await ensureMagnusGitignore(path.join(tmp, "partner-a"));

        expect(await exists(path.join(tmp, "partner-a", ".gitignore"))).toBe(false);
    });

    it("finds the rule several levels up", async () => {
        await fs.writeFile(path.join(tmp, ".gitignore"), ".magnus/\n", "utf8");
        const deep = path.join(tmp, "partner-a", "Mobile Apps", "The App");
        await fs.mkdir(deep, { recursive: true });

        await ensureMagnusGitignore(deep);

        expect(await exists(path.join(deep, ".gitignore"))).toBe(false);
    });

    /**
     * `.gitignore` files outside the repository do not apply to it, so the walk
     * stops at the directory holding `.git` rather than running to the
     * filesystem root.
     */
    it("ignores a .gitignore above the repository root", async () => {
        const repo = path.join(tmp, "inner-repo");
        await fs.mkdir(path.join(repo, ".git"), { recursive: true });
        await fs.mkdir(path.join(repo, "partner-b"), { recursive: true });
        await fs.writeFile(path.join(tmp, ".gitignore"), ".magnus/\n", "utf8");

        await ensureMagnusGitignore(path.join(repo, "partner-b"));

        expect(await exists(path.join(repo, "partner-b", ".gitignore"))).toBe(true);
    });

    it("does not duplicate the rule in the workspace's own .gitignore", async () => {
        await fs.writeFile(path.join(tmp, "partner-a", ".gitignore"), ".magnus/\n", "utf8");

        await ensureMagnusGitignore(path.join(tmp, "partner-a"));

        const written = await fs.readFile(path.join(tmp, "partner-a", ".gitignore"), "utf8");
        expect(written.match(/\.magnus/g)).toHaveLength(1);
    });
});
