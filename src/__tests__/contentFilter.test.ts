import { describe, expect, it } from "vitest";
import {
    shouldSkipContentUri,
    shouldSkipDescriptor,
    shouldSkipTreeUri
} from "../contentFilter";

/**
 * Pattern-based filter tests. For each URI we care about two outcomes:
 *   - "kept" = the content is real, user-editable, and should be materialized.
 *   - "skipped" = the content is pre/post chrome or upstream-generated metadata.
 *
 * If one of these ever flips, the pull/fetch surface quietly drifts from the
 * documented content model — hence the tests.
 */

describe("shouldSkipContentUri", () => {
    it("returns false for undefined / null / empty URIs", () => {
        expect(shouldSkipContentUri(undefined)).toBe(false);
        expect(shouldSkipContentUri(null)).toBe(false);
        expect(shouldSkipContentUri("")).toBe(false);
    });

    describe("kept (should NOT be skipped)", () => {
        const keptUris = [
            // Block content templates — the main editable bodies.
            "/api/FileContent/block-handler/42/content.lava",
            "/api/FileContent/block-handler/42/template.lava",

            // Page metadata — one file per page, kept.
            "/api/FileContent/my-app/page-metadata/5/metadata.lava",

            // App CSS — users edit this.
            "/api/FileContent/my-app/app-settings/1/css-styles.css",

            // App layouts — kept as read-only context.
            "/api/FileContent/my-app/app-layouts/1/layout.xaml"
        ];

        for (const uri of keptUris) {
            it(`keeps ${uri}`, () => {
                expect(shouldSkipContentUri(uri)).toBe(false);
            });
        }
    });

    describe("skipped (should be filtered out)", () => {
        const skippedUris = [
            // Block pre/post wrappers — always emitted by BlockTypeHandlerBase.
            "/api/FileContent/block-handler/42/pre-content.lava",
            "/api/FileContent/block-handler/42/post-content.lava",

            // Page-level chrome (NOT page metadata).
            "/api/FileContent/my-app/page-settings/5/event-handler.lava",
            "/api/FileContent/my-app/page-settings/5/page-styles.css",

            // App-level chrome XAML.
            "/api/FileContent/my-app/app-settings/1/flyout-xaml.lava",
            "/api/FileContent/my-app/app-settings/1/navigation-bar-xaml.lava",
            "/api/FileContent/my-app/app-settings/1/homepage-routing-logic.lava",
            "/api/FileContent/my-app/app-settings/1/toast-xaml.lava",

            // App metadata dump.
            "/api/FileContent/my-app/app-metadata/1/metadata.json"
        ];

        for (const uri of skippedUris) {
            it(`skips ${uri}`, () => {
                expect(shouldSkipContentUri(uri)).toBe(true);
            });
        }
    });

    it("matches case-insensitively", () => {
        expect(shouldSkipContentUri("/api/FileContent/BLOCK-HANDLER/42/PRE-CONTENT.lava")).toBe(true);
    });

    it("skips pre-content even with trailing query strings", () => {
        expect(shouldSkipContentUri("/api/FileContent/block-handler/42/pre-content?t=1")).toBe(true);
    });

    it("does not match similar-but-not-identical segments", () => {
        // 'pre-content-something' is not the same leaf as 'pre-content.lava'.
        // The anchor `(?:[./?#]|$)` prevents substring-style matches.
        expect(shouldSkipContentUri("/api/FileContent/block-handler/42/pre-content-extra.lava")).toBe(false);
    });
});

describe("shouldSkipTreeUri", () => {
    it("currently skips nothing (walks the whole tree)", () => {
        // app-settings is walked for the CSS file; app-layouts is walked for
        // layout XAML context. If you add patterns here, update the test.
        expect(shouldSkipTreeUri("/api/GetTreeItems/app-settings/1")).toBe(false);
        expect(shouldSkipTreeUri("/api/GetTreeItems/app-layouts/1")).toBe(false);
    });
});

describe("shouldSkipDescriptor", () => {
    it("applies the content filter to file descriptors", () => {
        expect(shouldSkipDescriptor({
            uri: "/api/FileContent/block-handler/42/pre-content.lava",
            isFolder: false
        })).toBe(true);

        expect(shouldSkipDescriptor({
            uri: "/api/FileContent/block-handler/42/content.lava",
            isFolder: false
        })).toBe(false);
    });

    it("applies the tree filter to folder descriptors", () => {
        expect(shouldSkipDescriptor({
            uri: "/api/GetTreeItems/app-settings/1",
            isFolder: true
        })).toBe(false);
    });

    it("never skips a descriptor without a URI", () => {
        expect(shouldSkipDescriptor({ uri: undefined, isFolder: false })).toBe(false);
        expect(shouldSkipDescriptor({ uri: null, isFolder: false })).toBe(false);
    });
});
