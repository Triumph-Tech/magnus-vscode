import { describe, expect, it, vi } from "vitest";
import { FetchChildren, resolveRootDescriptors } from "../resolveDescriptor";

/**
 * Hydration has to recover a resource's descriptor from its URI alone, because
 * `magnus.json` records a selection and not descriptors.
 *
 * `GetFlatTree` cannot supply it: the plugin excludes the subtree root from its
 * own response by contract. So the descriptor is found by walking down from the
 * one hardcoded URL, the same way the tree view finds it.
 */

const folder = (uri: string, displayName = uri): IItemDescriptor =>
    ({ uri, displayName, isFolder: true } as IItemDescriptor);

const app = (uri: string, buildUri: string | null = null): IItemDescriptor =>
    ({ uri, displayName: uri, isFolder: false, buildUri } as IItemDescriptor);

/** A tree keyed by parent URI; `"__root__"` is the hardcoded tree root. */
const treeFetcher = (tree: Record<string, IItemDescriptor[]>): FetchChildren =>
    vi.fn(async (uri) => tree[uri ?? "__root__"] ?? []);

describe("resolveRootDescriptors", () => {
    it("finds a resource two levels down and keeps its buildUri", async () => {
        const fetch = treeFetcher({
            __root__: [folder("/mobileapps")],
            "/mobileapps": [app("/mobileapps/app/7", "/api/build/7")]
        });

        const found = await resolveRootDescriptors(fetch, ["/mobileapps/app/7"]);

        expect(found.get("/mobileapps/app/7")?.buildUri).toBe("/api/build/7");
    });

    it("resolves several targets in one walk", async () => {
        const fetch = treeFetcher({
            __root__: [folder("/mobileapps"), folder("/shortcodes")],
            "/mobileapps": [app("/mobileapps/app/7")],
            "/shortcodes": [app("/shortcodes/sc/3")]
        });

        const found = await resolveRootDescriptors(
            fetch, ["/mobileapps/app/7", "/shortcodes/sc/3"]
        );

        expect(found.size).toBe(2);
    });

    it("omits a target that does not exist", async () => {
        const fetch = treeFetcher({
            __root__: [folder("/mobileapps")],
            "/mobileapps": [app("/mobileapps/app/7")]
        });

        const found = await resolveRootDescriptors(fetch, ["/themes/theme/Rock"]);

        expect(found.size).toBe(0);
    });

    /**
     * The v2.2 case: a plugin with no Themes handler simply has no such branch,
     * so the theme is unresolved while a mobile app beside it still resolves.
     */
    it("resolves what exists when one content type is absent server-side", async () => {
        const fetch = treeFetcher({
            __root__: [folder("/mobileapps")],
            "/mobileapps": [app("/mobileapps/app/7")]
        });

        const found = await resolveRootDescriptors(
            fetch, ["/mobileapps/app/7", "/themes/theme/Rock"]
        );

        expect(found.has("/mobileapps/app/7")).toBe(true);
        expect(found.has("/themes/theme/Rock")).toBe(false);
    });

    it("keeps walking past a branch that throws", async () => {
        const fetch: FetchChildren = vi.fn(async (uri) => {
            if (uri === undefined) {
                return [folder("/forbidden"), folder("/mobileapps")];
            }
            if (uri === "/forbidden") {
                throw new Error("403");
            }
            return uri === "/mobileapps" ? [app("/mobileapps/app/7")] : [];
        });

        const found = await resolveRootDescriptors(fetch, ["/mobileapps/app/7"]);

        expect(found.has("/mobileapps/app/7")).toBe(true);
    });

    it("stops before an unbounded walk on a deep tree", async () => {
        // Every folder has one folder child, forever. Without the depth cap
        // this would never terminate.
        const fetch: FetchChildren = vi.fn(async (uri) =>
            [folder(`${uri ?? ""}/deeper`)]
        );

        const found = await resolveRootDescriptors(fetch, ["/never/found"]);

        expect(found.size).toBe(0);
        expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThan(10);
    });

    it("does not revisit a URI reachable by two paths", async () => {
        const fetch = treeFetcher({
            __root__: [folder("/a"), folder("/b")],
            "/a": [folder("/shared")],
            "/b": [folder("/shared")],
            "/shared": [app("/shared/app/1")]
        });

        await resolveRootDescriptors(fetch, ["/shared/app/1"]);

        const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
        expect(calls.filter(c => c === "/shared")).toHaveLength(1);
    });

    it("returns nothing for an empty target list without calling the server", async () => {
        const fetch = treeFetcher({ __root__: [folder("/mobileapps")] });

        const found = await resolveRootDescriptors(fetch, []);

        expect(found.size).toBe(0);
        expect(fetch).not.toHaveBeenCalled();
    });

    it("ignores blank target URIs", async () => {
        const fetch = treeFetcher({ __root__: [] });

        const found = await resolveRootDescriptors(fetch, ["", "   "]);

        expect(found.size).toBe(0);
        expect(fetch).not.toHaveBeenCalled();
    });

    it("finds a resource sitting directly at the tree root", async () => {
        const fetch = treeFetcher({ __root__: [app("/aiskills")] });

        const found = await resolveRootDescriptors(fetch, ["/aiskills"]);

        expect(found.has("/aiskills")).toBe(true);
    });

    it("finds a folder-shaped resource root, such as a collection", async () => {
        const fetch = treeFetcher({
            __root__: [folder("/persisteddatasets")]
        });

        const found = await resolveRootDescriptors(fetch, ["/persisteddatasets"]);

        expect(found.has("/persisteddatasets")).toBe(true);
    });
});
