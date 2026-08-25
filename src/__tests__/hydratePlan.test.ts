import { describe, expect, it } from "vitest";
import { MagnusSelectionEntry } from "../magnusJson";
import {
    changedCount,
    describeSummary,
    emptySummary,
    planHydrateScope,
    rootForEntry
} from "../hydratePlan";

/**
 * Hydration rebuilds `.magnus/` for a workspace that arrived by `git clone`.
 * The safety property under test throughout: a file the clone already has is
 * adopted, never overwritten.
 */

const entry = (over: Partial<MagnusSelectionEntry> = {}): MagnusSelectionEntry => ({
    uri: "/api/TriumphTech/Magnus/GetTreeItems/mobileapps/app/7",
    displayName: "Rockit App",
    platform: "Mobile Apps",
    pathPrefix: "Mobile Apps/Rockit App/",
    ...over
});

describe("planHydrateScope", () => {
    it("accepts a well-formed selection", () => {
        const { accepted, rejected } = planHydrateScope([entry()]);

        expect(rejected).toEqual([]);
        expect(accepted).toHaveLength(1);
        expect(accepted[0].pathPrefix).toBe("Mobile Apps/Rockit App/");
    });

    it("normalizes a prefix that is missing its trailing slash", () => {
        const { accepted } = planHydrateScope([entry({ pathPrefix: "Themes/Rock" })]);

        expect(accepted[0].pathPrefix).toBe("Themes/Rock/");
    });

    it("normalizes Windows separators", () => {
        const { accepted } = planHydrateScope([entry({ pathPrefix: "Themes\\Rock\\" })]);

        expect(accepted[0].pathPrefix).toBe("Themes/Rock/");
    });

    it("orders accepted entries by prefix so hydration is deterministic", () => {
        const { accepted } = planHydrateScope([
            entry({ pathPrefix: "Themes/Rock/", displayName: "Rock" }),
            entry({ pathPrefix: "AI Skills/", displayName: "Skills" })
        ]);

        expect(accepted.map(a => a.pathPrefix)).toEqual(["AI Skills/", "Themes/Rock/"]);
    });

    it("rejects an entry with no server URI", () => {
        const { accepted, rejected } = planHydrateScope([entry({ uri: "" })]);

        expect(accepted).toEqual([]);
        expect(rejected[0].reason).toMatch(/no server URI/);
    });

    it("rejects an entry with no pathPrefix", () => {
        const { rejected } = planHydrateScope([entry({ pathPrefix: "" })]);

        expect(rejected[0].reason).toMatch(/no pathPrefix/);
    });

    it("rejects a prefix that escapes the workspace", () => {
        const { accepted, rejected } = planHydrateScope([
            entry({ pathPrefix: "../../etc/" })
        ]);

        expect(accepted).toEqual([]);
        expect(rejected[0].reason).toMatch(/escapes the workspace/);
    });

    it("rejects a prefix that resolves to the workspace root", () => {
        const { rejected } = planHydrateScope([entry({ pathPrefix: "/" })]);

        expect(rejected[0].reason).toMatch(/workspace root/);
    });

    it("rejects a duplicate prefix but keeps the first", () => {
        const { accepted, rejected } = planHydrateScope([
            entry({ displayName: "First" }),
            entry({ displayName: "Second" })
        ]);

        expect(accepted).toHaveLength(1);
        expect(accepted[0].displayName).toBe("First");
        expect(rejected[0].reason).toMatch(/duplicate pathPrefix/);
    });

    it("treats prefixes differing only by trailing slash as duplicates", () => {
        const { accepted, rejected } = planHydrateScope([
            entry({ pathPrefix: "Themes/Rock" }),
            entry({ pathPrefix: "Themes/Rock/" })
        ]);

        expect(accepted).toHaveLength(1);
        expect(rejected).toHaveLength(1);
    });

    it("hydrates the good entries alongside a bad one", () => {
        const { accepted, rejected } = planHydrateScope([
            entry({ pathPrefix: "Themes/Rock/" }),
            entry({ uri: "", pathPrefix: "Broken/" }),
            entry({ pathPrefix: "AI Skills/" })
        ]);

        expect(accepted).toHaveLength(2);
        expect(rejected).toHaveLength(1);
    });
});

describe("rootForEntry", () => {
    it("carries the recovered build URI", () => {
        const root = rootForEntry(entry(), "2026-08-21T00:00:00.000Z", "/api/build/7");

        expect(root.buildUri).toBe("/api/build/7");
        expect(root.pathPrefix).toBe("Mobile Apps/Rockit App/");
        expect(root.pulledAt).toBe("2026-08-21T00:00:00.000Z");
    });

    it("records a null build URI rather than guessing one", () => {
        const root = rootForEntry(entry(), "2026-08-21T00:00:00.000Z", null);

        expect(root.buildUri).toBeNull();
    });
});

describe("describeSummary", () => {
    it("leads with what changed, because that is the git diff to review", () => {
        const text = describeSummary({
            ...emptySummary(), replaced: 12, materialized: 3, unchanged: 400
        });

        expect(text).toBe(
            "12 files updated from the server, 3 new files added, 400 already current"
        );
    });

    it("says so plainly when the clone was already current", () => {
        const text = describeSummary({ ...emptySummary(), unchanged: 468 });

        expect(text).toBe("already up to date with the server (468 files)");
    });

    it("singularizes", () => {
        const text = describeSummary({
            ...emptySummary(), replaced: 1, materialized: 1, unchanged: 2
        });

        expect(text).toBe("1 file updated from the server, 1 new file added, 2 already current");
    });

    it("omits the update clause when nothing was replaced", () => {
        const text = describeSummary({ ...emptySummary(), materialized: 9, unchanged: 1 });

        expect(text).toBe("9 new files added, 1 already current");
    });
});

describe("changedCount", () => {
    it("counts replacements and additions, not files already current", () => {
        expect(changedCount({
            ...emptySummary(), replaced: 12, materialized: 3, unchanged: 400
        })).toBe(15);
    });

    it("is zero for a workspace that was already current", () => {
        expect(changedCount({ ...emptySummary(), unchanged: 468 })).toBe(0);
    });
});
