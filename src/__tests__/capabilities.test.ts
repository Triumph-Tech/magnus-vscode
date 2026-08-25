import { describe, expect, it } from "vitest";
import { classifyRootAccess, extractFilesystemIdentifier } from "../capabilities";

/**
 * `classifyRootAccess` decides whether a pulled workspace may still push, from
 * what the server reports as enabled.
 *
 * Two of its three outcomes are easy to confuse and behave very differently, so
 * every combination is pinned. Getting it wrong towards `allowed` lets pushes
 * reach a resource type an administrator turned off; getting it wrong towards
 * `push-blocked-disabled` strands a user whose session merely lapsed.
 */

describe("classifyRootAccess", () => {
    it("allows a workspace whose resource type is enabled", () => {
        expect(classifyRootAccess({
            filesystemIdentifier: "mobileapps",
            enabledFilesystems: ["mobileapps", "themes"]
        })).toBe("allowed");
    });

    it("blocks push when the resource type is absent from the enabled list", () => {
        // An administrator turned mobile apps off. Files stay put and stay
        // editable; only push is withdrawn.
        expect(classifyRootAccess({
            filesystemIdentifier: "mobileapps",
            enabledFilesystems: ["themes", "aiskills"]
        })).toBe("push-blocked-disabled");
    });

    it("blocks push against a known-empty enabled list", () => {
        // Known and empty: everything is off. Distinct from not knowing.
        expect(classifyRootAccess({
            filesystemIdentifier: "mobileapps",
            enabledFilesystems: []
        })).toBe("push-blocked-disabled");
    });

    it("returns 'unknown' when the server did not report a list", () => {
        // An older plugin, or a caller who was not authorised to be told, which
        // is what an expired session looks like. Blocking here would strand a
        // working workspace on a transient condition.
        expect(classifyRootAccess({
            filesystemIdentifier: "mobileapps",
            enabledFilesystems: null
        })).toBe("unknown");

        expect(classifyRootAccess({
            filesystemIdentifier: "mobileapps",
            enabledFilesystems: undefined
        })).toBe("unknown");
    });

    it("returns 'unknown' when we cannot tell what this workspace is", () => {
        // The server answered, but the manifest root gave us no identifier to
        // compare. Our own ignorance must not present as the server's refusal.
        expect(classifyRootAccess({
            filesystemIdentifier: null,
            enabledFilesystems: ["mobileapps"]
        })).toBe("unknown");
    });

    it("does not treat an empty enabled list plus no identifier as blocked", () => {
        // Both unknowns at once. Still unknown, not blocked.
        expect(classifyRootAccess({
            filesystemIdentifier: null,
            enabledFilesystems: []
        })).toBe("unknown");
    });

    it("matches identifiers exactly, not by prefix", () => {
        // "themes" must not be satisfied by "themes-legacy" or vice versa.
        expect(classifyRootAccess({
            filesystemIdentifier: "themes",
            enabledFilesystems: ["themes-legacy"]
        })).toBe("push-blocked-disabled");
    });
});

describe("extractFilesystemIdentifier", () => {
    it("reads the identifier from a root tree URI", () => {
        expect(extractFilesystemIdentifier(
            "/api/TriumphTech/Magnus/GetTreeItems/mobileapps/app/5"
        )).toBe("mobileapps");
    });

    it("reads the identifier when the root has no trailing path", () => {
        expect(extractFilesystemIdentifier(
            "/api/TriumphTech/Magnus/GetTreeItems/themes"
        )).toBe("themes");
    });

    it("handles an absolute URL", () => {
        expect(extractFilesystemIdentifier(
            "https://rock.example.com/api/TriumphTech/Magnus/GetTreeItems/aiskills/skill/3"
        )).toBe("aiskills");
    });

    it("returns null for a FileContent URI", () => {
        // Important: FileContent URIs carry "block-handler" in the same position
        // for block content, which is not a virtual filesystem. Accepting one
        // would compare "block-handler" against the enabled list and conclude
        // the workspace had been disabled.
        expect(extractFilesystemIdentifier(
            "/api/TriumphTech/Magnus/FileContent/block-handler/42/content"
        )).toBeNull();
        expect(extractFilesystemIdentifier(
            "/api/TriumphTech/Magnus/FileContent/mobileapps/page-settings/7/settings.json"
        )).toBeNull();
    });

    it("returns null for empty and missing input", () => {
        expect(extractFilesystemIdentifier(null)).toBeNull();
        expect(extractFilesystemIdentifier(undefined)).toBeNull();
        expect(extractFilesystemIdentifier("")).toBeNull();
    });

    it("returns null when the marker is present but nothing follows it", () => {
        expect(extractFilesystemIdentifier(
            "/api/TriumphTech/Magnus/GetTreeItems/"
        )).toBeNull();
    });
});
