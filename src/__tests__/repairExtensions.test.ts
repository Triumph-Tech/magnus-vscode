import { describe, expect, it } from "vitest";
import { Manifest, MANIFEST_VERSION } from "../manifest";
import { migratedRelPath, planRename } from "../repairPlan";

describe("migratedRelPath", () => {
    it("appends the extension parsed from the URI", () => {
        expect(
            migratedRelPath("Landing/Settings/Metadata", "/api/Magnus/FileContent/x/metadata.txt")
        ).toBe("Landing/Settings/Metadata.txt");
    });

    it("appends .lava for content URIs", () => {
        expect(
            migratedRelPath("Foo/Blocks/Bar/Content", "/api/Magnus/FileContent/x/content.lava")
        ).toBe("Foo/Blocks/Bar/Content.lava");
    });

    it("leaves the path alone when leaf already has an extension", () => {
        // Idempotent — re-running migration on a previously migrated workspace
        // shouldn't double-append.
        expect(
            migratedRelPath("Foo/Bar/Content.lava", "/api/Magnus/FileContent/x/content.lava")
        ).toBe("Foo/Bar/Content.lava");
    });

    it("leaves the path alone when URI has no extension", () => {
        expect(
            migratedRelPath("Foo/Bar/Mystery", "/api/Magnus/x/no-ext-here")
        ).toBe("Foo/Bar/Mystery");
    });

    it("preserves the directory portion exactly", () => {
        // Folder names with spaces and brackets must survive untouched —
        // they're part of the user's pulled tree structure.
        expect(
            migratedRelPath(
                "[v2] Watch/Blocks/[Main] Content - Content/Content",
                "/api/Magnus/FileContent/foo/content.lava"
            )
        ).toBe("[v2] Watch/Blocks/[Main] Content - Content/Content.lava");
    });

    it("handles a single-segment relPath (no parent folder)", () => {
        expect(migratedRelPath("Content", "/x/content.lava")).toBe("Content.lava");
    });
});

describe("planRename", () => {
    function buildManifest(items: Record<string, { uri: string; isFolder: boolean }>): Manifest {
        return {
            version: MANIFEST_VERSION,
            server: { url: "https://x", alias: "x" },
            roots: [{
                uri: "",
                displayName: "Test",
                pulledAt: "2026-04-01T00:00:00Z",
                pathPrefix: ""
            }],
            items: Object.fromEntries(
                Object.entries(items).map(([k, v]) => [k, { ...v }])
            )
        };
    }

    it("plans renames for files that gain extensions", () => {
        const m = buildManifest({
            "Landing/Settings/Metadata": {
                uri: "/api/Magnus/FileContent/x/metadata.txt",
                isFolder: false
            },
            "Landing/Blocks/X/Content": {
                uri: "/api/Magnus/FileContent/x/content.lava",
                isFolder: false
            }
        });
        const plan = planRename(m);
        expect(plan.size).toBe(2);
        expect(plan.get("Landing/Settings/Metadata")).toBe("Landing/Settings/Metadata.txt");
        expect(plan.get("Landing/Blocks/X/Content")).toBe("Landing/Blocks/X/Content.lava");
    });

    it("skips folder entries", () => {
        // Folders don't have leaf extensions and shouldn't be renamed.
        const m = buildManifest({
            "Landing": { uri: "/api/x/folder", isFolder: true },
            "Landing/Settings": { uri: "/api/x/settings", isFolder: true },
            "Landing/Settings/Metadata": {
                uri: "/api/Magnus/FileContent/x/metadata.txt",
                isFolder: false
            }
        });
        const plan = planRename(m);
        expect(plan.size).toBe(1);
        expect(plan.has("Landing")).toBe(false);
        expect(plan.has("Landing/Settings")).toBe(false);
    });

    it("skips files whose leaf already has an extension", () => {
        // Idempotent on a workspace that's already been migrated.
        const m = buildManifest({
            "Landing/Settings/Metadata.txt": {
                uri: "/api/Magnus/FileContent/x/metadata.txt",
                isFolder: false
            }
        });
        expect(planRename(m).size).toBe(0);
    });

    it("skips files whose URI carries no extension", () => {
        const m = buildManifest({
            "Foo/Bar/Mystery": {
                uri: "/api/Magnus/FileContent/x/no-extension",
                isFolder: false
            }
        });
        expect(planRename(m).size).toBe(0);
    });

    it("avoids planning a rename that would collide with another existing entry", () => {
        // Edge case: if the workspace somehow has both `Foo/Bar` (no ext) AND
        // `Foo/Bar.lava` already, don't clobber the latter.
        const m = buildManifest({
            "Foo/Bar": {
                uri: "/api/Magnus/FileContent/x/bar.lava",
                isFolder: false
            },
            "Foo/Bar.lava": {
                uri: "/api/Magnus/FileContent/x/different.lava",
                isFolder: false
            }
        });
        expect(planRename(m).size).toBe(0);
    });

    it("returns an empty plan for a fully-migrated workspace", () => {
        const m = buildManifest({
            "Foo/Bar.lava": {
                uri: "/api/Magnus/FileContent/x/bar.lava",
                isFolder: false
            },
            "Foo/Baz.txt": {
                uri: "/api/Magnus/FileContent/x/baz.txt",
                isFolder: false
            }
        });
        expect(planRename(m).size).toBe(0);
    });
});
