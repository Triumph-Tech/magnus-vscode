import { describe, expect, it } from "vitest";
import { MagnusSelectionEntry } from "../magnusJson";
import { diffSelection } from "../selectionDiff";

/**
 * `diffSelection` turns "what the user just checked" into "what to pull and what
 * to offer to delete".
 *
 * The two mistakes cost very different amounts. A resource wrongly in `added`
 * causes a redundant pull. One wrongly in `removed` puts a "delete these files?"
 * prompt in front of someone who never asked for it, over a directory that may
 * hold hours of their work.
 */

const entry = (
    prefix: string,
    overrides: Partial<MagnusSelectionEntry> = {}
): MagnusSelectionEntry => ({
    uri: `/api/TriumphTech/Magnus/GetTreeItems/mobileapps/app/${prefix}`,
    displayName: prefix.replace(/\/$/, ""),
    platform: "Mobile Apps",
    pathPrefix: prefix,
    ...overrides
});

describe("diffSelection", () => {
    it("reports a newly checked resource as added", () => {
        const d = diffSelection([], [entry("Mobile Apps/Church App/")]);
        expect(d.added.map(e => e.pathPrefix)).toEqual(["Mobile Apps/Church App/"]);
        expect(d.removed).toEqual([]);
        expect(d.unchanged).toEqual([]);
    });

    it("reports an unchecked resource as removed", () => {
        const d = diffSelection([entry("Themes/Rock/")], []);
        expect(d.removed.map(e => e.pathPrefix)).toEqual(["Themes/Rock/"]);
        expect(d.added).toEqual([]);
    });

    it("leaves a still-checked resource alone", () => {
        // Not re-pulled. Re-pulling something the user did not ask about would
        // overwrite local edits as a side effect of opening the dialog.
        const d = diffSelection([entry("Themes/Rock/")], [entry("Themes/Rock/")]);
        expect(d.unchanged.map(e => e.pathPrefix)).toEqual(["Themes/Rock/"]);
        expect(d.added).toEqual([]);
        expect(d.removed).toEqual([]);
    });

    it("handles adds and removes in the same edit", () => {
        const d = diffSelection(
            [entry("Themes/Rock/"), entry("Mobile Apps/Church App/")],
            [entry("Mobile Apps/Church App/"), entry("AI Skills/Summarize/")]
        );
        expect(d.added.map(e => e.pathPrefix)).toEqual(["AI Skills/Summarize/"]);
        expect(d.removed.map(e => e.pathPrefix)).toEqual(["Themes/Rock/"]);
        expect(d.unchanged.map(e => e.pathPrefix)).toEqual(["Mobile Apps/Church App/"]);
    });

    it("identifies entries by path prefix, not display name", () => {
        // A resource renamed on the server keeps its prefix until it is
        // re-pulled. Matching on displayName would read that as one resource
        // removed and another added, and offer to delete a directory of work.
        const before = [entry("Mobile Apps/Church App/", { displayName: "Church App" })];
        const after = [entry("Mobile Apps/Church App/", { displayName: "Church App (2026)" })];

        const d = diffSelection(before, after);
        expect(d.removed).toEqual([]);
        expect(d.added).toEqual([]);
        expect(d.unchanged).toHaveLength(1);
    });

    it("identifies entries by path prefix, not URI", () => {
        // Server URIs can be reissued (a rebuilt tree, a changed id scheme)
        // without the content moving. The files on disk have not gone anywhere,
        // so neither has the entry.
        const before = [entry("Themes/Rock/", { uri: "/old/uri" })];
        const after = [entry("Themes/Rock/", { uri: "/new/uri" })];

        const d = diffSelection(before, after);
        expect(d.removed).toEqual([]);
        expect(d.unchanged).toHaveLength(1);
    });

    it("carries the freshly chosen entry into unchanged, not the stale one", () => {
        // So a re-written magnus.json picks up a renamed displayName without
        // needing a re-pull.
        const before = [entry("Themes/Rock/", { displayName: "Rock" })];
        const after = [entry("Themes/Rock/", { displayName: "Rock Theme" })];

        expect(diffSelection(before, after).unchanged[0].displayName).toBe("Rock Theme");
    });

    it("returns empty everything for two empty selections", () => {
        const d = diffSelection([], []);
        expect(d).toEqual({ added: [], removed: [], unchanged: [] });
    });
});
