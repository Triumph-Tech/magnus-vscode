import { describe, expect, it } from "vitest";
import { assembleFlatTreePaths, normalizeFlatTreeResponse } from "../flatTree";

/**
 * Tests for the pure path-assembly helper used by the flat-tree pull/fetch
 * paths. The helper takes the server's flat list and produces a `URI -> relPath`
 * map using the same `nameForDescriptor` / `disambiguateName` logic the
 * recursive walk uses, which is what guarantees the two code paths produce
 * identical manifests.
 */

function leaf(uri: string, displayName: string, parentUri: string | null = null): IFlatTreeItem {
    return {
        uri,
        displayName,
        isFolder: false,
        parentUri
    };
}

function folder(uri: string, displayName: string, parentUri: string | null = null): IFlatTreeItem {
    return {
        uri,
        displayName,
        isFolder: true,
        parentUri
    };
}

describe("assembleFlatTreePaths", () => {
    it("returns an empty map for an empty list", () => {
        expect(assembleFlatTreePaths([])).toEqual(new Map());
    });

    it("assigns top-level item paths from the displayName", () => {
        const items = [
            folder("/api/Magnus/GetTreeItems/x/page-settings/1", "Settings"),
            leaf("/api/Magnus/FileContent/x/file.lava", "Content")
        ];
        const map = assembleFlatTreePaths(items);
        expect(map.get("/api/Magnus/GetTreeItems/x/page-settings/1")).toBe("Settings");
        expect(map.get("/api/Magnus/FileContent/x/file.lava")).toBe("Content.lava");
    });

    it("nests children under their parent's assembled path", () => {
        const items = [
            folder("/api/Magnus/GetTreeItems/x/page/1", "Home"),
            folder("/api/Magnus/GetTreeItems/x/page-settings/1", "Settings", "/api/Magnus/GetTreeItems/x/page/1"),
            leaf("/api/Magnus/FileContent/x/page-metadata/1/metadata.txt", "Metadata", "/api/Magnus/GetTreeItems/x/page-settings/1")
        ];
        const map = assembleFlatTreePaths(items);
        expect(map.get("/api/Magnus/GetTreeItems/x/page/1")).toBe("Home");
        expect(map.get("/api/Magnus/GetTreeItems/x/page-settings/1")).toBe("Home/Settings");
        expect(map.get("/api/Magnus/FileContent/x/page-metadata/1/metadata.txt")).toBe("Home/Settings/Metadata.txt");
    });

    it("disambiguates duplicate sibling display names with numeric suffixes", () => {
        // Two pages under the same parent share a display name; disambiguateName
        // should keep the first and append " (2)" to the second.
        const items = [
            folder("/api/Magnus/GetTreeItems/x/page/1", "Home"),
            folder("/api/Magnus/GetTreeItems/x/page/2", "Home")
        ];
        const map = assembleFlatTreePaths(items);
        expect(map.get("/api/Magnus/GetTreeItems/x/page/1")).toBe("Home");
        expect(map.get("/api/Magnus/GetTreeItems/x/page/2")).toBe("Home (2)");
    });

    it("recovers file extensions from the URI for leaves", () => {
        const items = [
            leaf("/api/Magnus/FileContent/x/page-styles.css", "CSS Styles"),
            leaf("/api/Magnus/FileContent/x/event-handler.lava", "Event Handler")
        ];
        const map = assembleFlatTreePaths(items);
        expect(map.get("/api/Magnus/FileContent/x/page-styles.css")).toBe("CSS Styles.css");
        expect(map.get("/api/Magnus/FileContent/x/event-handler.lava")).toBe("Event Handler.lava");
    });

    it("treats null, undefined, and empty parentUri all as 'subtree root'", () => {
        // The C# server defaults string properties to empty rather than null;
        // the helper has to accept all three forms.
        const a: IFlatTreeItem = {
            uri: "/api/Magnus/GetTreeItems/x/page/1",
            displayName: "A",
            isFolder: true,
            parentUri: null
        };
        const b: IFlatTreeItem = {
            uri: "/api/Magnus/GetTreeItems/x/page/2",
            displayName: "B",
            isFolder: true
        };
        const c: IFlatTreeItem = {
            uri: "/api/Magnus/GetTreeItems/x/page/3",
            displayName: "C",
            isFolder: true,
            parentUri: ""
        };
        const map = assembleFlatTreePaths([a, b, c]);
        // All three are at the root; they share the same disambiguation pool.
        expect(map.get("/api/Magnus/GetTreeItems/x/page/1")).toBe("A");
        expect(map.get("/api/Magnus/GetTreeItems/x/page/2")).toBe("B");
        expect(map.get("/api/Magnus/GetTreeItems/x/page/3")).toBe("C");
    });

    it("omits items pruned by shouldSkipDescriptor", () => {
        // Pre/post-content URIs match SKIP_CONTENT_URI_PATTERNS and should
        // not appear in the assembled map.
        const items = [
            leaf("/api/Magnus/FileContent/block-handler/1/pre-content", "Pre-XAML"),
            leaf("/api/Magnus/FileContent/block-handler/1/content.lava", "Content"),
            leaf("/api/Magnus/FileContent/block-handler/1/post-content", "Post-XAML")
        ];
        const map = assembleFlatTreePaths(items);
        expect(map.has("/api/Magnus/FileContent/block-handler/1/pre-content")).toBe(false);
        expect(map.has("/api/Magnus/FileContent/block-handler/1/post-content")).toBe(false);
        expect(map.get("/api/Magnus/FileContent/block-handler/1/content.lava")).toBe("Content.lava");
    });

    it("skips items without a URI", () => {
        // The server should never emit a URI-less item, but the assembler
        // shouldn't choke if it does — just drop them silently.
        const items: IFlatTreeItem[] = [
            { displayName: "Phantom", isFolder: false },
            leaf("/api/Magnus/FileContent/x/real.lava", "Real")
        ];
        const map = assembleFlatTreePaths(items);
        expect(map.size).toBe(1);
        expect(map.get("/api/Magnus/FileContent/x/real.lava")).toBe("Real.lava");
    });

    it("recurses into folders to assemble deep paths", () => {
        // Three-level nesting: app/Pages/Home/Blocks/Hero
        const items = [
            folder("/api/Magnus/GetTreeItems/x/page/1", "Home"),
            folder("/api/Magnus/GetTreeItems/x/page-blocks/1", "Blocks", "/api/Magnus/GetTreeItems/x/page/1"),
            folder("/api/Magnus/GetTreeItems/x/block/100", "Hero Block", "/api/Magnus/GetTreeItems/x/page-blocks/1"),
            leaf("/api/Magnus/FileContent/x/block/100/content.lava", "Content", "/api/Magnus/GetTreeItems/x/block/100")
        ];
        const map = assembleFlatTreePaths(items);
        expect(map.get("/api/Magnus/FileContent/x/block/100/content.lava"))
            .toBe("Home/Blocks/Hero Block/Content.lava");
    });

    it("does not let response order break parent-child resolution", () => {
        // The server may return items in any per-parent order. As long as
        // parentUri links are correct, paths must resolve.
        const child = leaf(
            "/api/Magnus/FileContent/x/page-metadata/1/metadata.txt",
            "Metadata",
            "/api/Magnus/GetTreeItems/x/page-settings/1"
        );
        const parent = folder(
            "/api/Magnus/GetTreeItems/x/page-settings/1",
            "Settings",
            "/api/Magnus/GetTreeItems/x/page/1"
        );
        const grandparent = folder("/api/Magnus/GetTreeItems/x/page/1", "Home");

        // Reverse order on purpose
        const map = assembleFlatTreePaths([child, parent, grandparent]);
        expect(map.get("/api/Magnus/FileContent/x/page-metadata/1/metadata.txt"))
            .toBe("Home/Settings/Metadata.txt");
    });

    it("omits items whose parent was pruned (subtree filter)", () => {
        // app-metadata folder URIs match SKIP_CONTENT_URI_PATTERNS at the file
        // level, but here we exercise that filtering a parent removes its
        // descendants from the map even when those descendants pass the filter.
        // (Setup: file leaf is fine on its own, but its parent was a skipped
        // folder in our fictional example. The current filter only skips at
        // the file level, so we use a kept folder + file relationship, then
        // demonstrate that without a parent in the map, the child path can't
        // be assembled.)
        const orphan = leaf(
            "/api/Magnus/FileContent/x/orphan.lava",
            "Orphan",
            "/api/Magnus/GetTreeItems/x/missing-parent/1"
        );
        // No parent folder is provided, so the orphan never gets visited
        // because processGroup walks down from the root.
        const map = assembleFlatTreePaths([orphan]);
        expect(map.has("/api/Magnus/FileContent/x/orphan.lava")).toBe(false);
    });
});

/**
 * `normalizeFlatTreeResponse` decides how much to trust a flat-tree response,
 * across three plugin generations. Getting the "unknown completeness" case wrong
 * in the optimistic direction deletes files the server still has, which is why
 * every branch is pinned.
 */
describe("normalizeFlatTreeResponse", () => {
    const item = (uri: string): IFlatTreeItem => ({
        uri,
        displayName: uri,
        isFolder: false
    } as IFlatTreeItem);

    it("reads a complete 2.4.0 envelope", () => {
        const result = normalizeFlatTreeResponse({
            items: [item("a"), item("b")],
            complete: true,
            incompleteReason: null
        });
        expect(result).not.toBeNull();
        expect(result!.items).toHaveLength(2);
        expect(result!.complete).toBe(true);
        expect(result!.incompleteReason).toBeNull();
    });

    it("reads an incomplete envelope and keeps the reason", () => {
        // The reason is for the message shown to the user, never for control
        // flow: callers branch on `complete` alone.
        const result = normalizeFlatTreeResponse({
            items: [item("a")],
            complete: false,
            incompleteReason: "item-cap"
        });
        expect(result!.complete).toBe(false);
        expect(result!.incompleteReason).toBe("item-cap");
        expect(result!.items).toHaveLength(1);
    });

    it("treats an envelope with an empty item list as valid, not as unsupported", () => {
        // A genuinely emptied resource reports zero items with complete: true.
        // Collapsing that into null would send the caller down the recursive
        // walk and lose the completeness signal it just received.
        const result = normalizeFlatTreeResponse({ items: [], complete: true });
        expect(result).not.toBeNull();
        expect(result!.items).toHaveLength(0);
        expect(result!.complete).toBe(true);
    });

    it("treats a bare array from an older plugin as incomplete", () => {
        // Plugin 2.3.x has no way to say whether the list is whole. Unknown must
        // read as incomplete: assuming complete deletes files that still exist,
        // while assuming incomplete only withholds deletions until upgrade.
        const result = normalizeFlatTreeResponse([item("a"), item("b")]);
        expect(result!.items).toHaveLength(2);
        expect(result!.complete).toBe(false);
        expect(result!.incompleteReason).toBe("no-completeness-signal");
    });

    it("treats an envelope with no completeness field as incomplete", () => {
        // Defensive: a partial upgrade, or a proxy stripping fields, must not
        // read as complete just because the items arrived.
        const result = normalizeFlatTreeResponse({ items: [item("a")] });
        expect(result!.complete).toBe(false);
        expect(result!.incompleteReason).toBe("no-completeness-signal");
    });

    it("treats a non-boolean completeness field as no signal", () => {
        // `complete: "true"` is not a signal, it is a bug somewhere upstream.
        const result = normalizeFlatTreeResponse({ items: [], complete: "true" });
        expect(result!.complete).toBe(false);
        expect(result!.incompleteReason).toBe("no-completeness-signal");
    });

    it("returns null for bodies that are neither shape", () => {
        // A 200 carrying an HTML error page or a Rock catch-all body means the
        // endpoint isn't really implemented. Callers read null as "fall back to
        // the recursive walk", which is the safe path.
        expect(normalizeFlatTreeResponse("<html>Not Found</html>")).toBeNull();
        expect(normalizeFlatTreeResponse(null)).toBeNull();
        expect(normalizeFlatTreeResponse(undefined)).toBeNull();
        expect(normalizeFlatTreeResponse({ message: "no route" })).toBeNull();
        expect(normalizeFlatTreeResponse({ items: "not an array" })).toBeNull();
    });
});
