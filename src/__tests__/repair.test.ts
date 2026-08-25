import { describe, expect, it } from "vitest";
import { Manifest, MANIFEST_VERSION } from "../manifest";
import { planBaselineRepair } from "../repair";

/**
 * `planBaselineRepair` picks the tracked files whose bookkeeping is unusable
 * (spec 7.7): neither a baseline on disk nor a recorded hash, so nothing can be
 * compared against anything.
 *
 * Repair exists because that state is Magnus's fault, not the user's, so it is
 * fixed on open rather than surfaced as a question. The plan has to be narrow:
 * every entry it returns costs a network round trip when a workspace opens.
 */

const manifest = (items: Manifest["items"]): Manifest => ({
    version: MANIFEST_VERSION,
    server: { url: "https://rock.example.com", alias: "rock" },
    roots: [{
        uri: "/api/x",
        displayName: "App",
        pulledAt: "2026-08-18T00:00:00Z",
        pathPrefix: ""
    }],
    items
});

const file = (over: Partial<Manifest["items"][string]> = {}) => ({
    uri: "/api/TriumphTech/Magnus/FileContent/mobileapps/page/1/content.xaml",
    isFolder: false,
    ...over
});

describe("planBaselineRepair", () => {
    it("selects a file with neither a hash nor a baseline", () => {
        const plan = planBaselineRepair({
            manifest: manifest({ "a.xaml": file() }),
            hasBaseline: () => false
        });
        expect(plan).toEqual(["a.xaml"]);
    });

    it("skips a file that already has a baseline", () => {
        const plan = planBaselineRepair({
            manifest: manifest({ "a.xaml": file() }),
            hasBaseline: () => true
        });
        expect(plan).toEqual([]);
    });

    it("skips a file with a recorded hash even when the baseline is missing", () => {
        // Recoverable without a round trip if local content matches, which the
        // refresh path handles lazily. Including it here would mean a network
        // fetch per file on every workspace open.
        const plan = planBaselineRepair({
            manifest: manifest({ "a.xaml": file({ hash: "abc123" }) }),
            hasBaseline: () => false
        });
        expect(plan).toEqual([]);
    });

    it("skips folders", () => {
        // Nothing to hash and nothing to diff.
        const plan = planBaselineRepair({
            manifest: manifest({ "Pages/": file({ isFolder: true }) }),
            hasBaseline: () => false
        });
        expect(plan).toEqual([]);
    });

    it("treats an empty-string hash as no hash", () => {
        // A malformed manifest with a blank hash is indistinguishable from one
        // with no hash, and pretending otherwise leaves the file uncomparable.
        const plan = planBaselineRepair({
            manifest: manifest({ "a.xaml": file({ hash: "" }) }),
            hasBaseline: () => false
        });
        expect(plan).toEqual(["a.xaml"]);
    });

    it("returns a stable, sorted plan", () => {
        // So repeated opens do the same work in the same order, and a log from
        // one run can be compared against another.
        const plan = planBaselineRepair({
            manifest: manifest({
                "z.xaml": file(),
                "a.xaml": file(),
                "m.xaml": file()
            }),
            hasBaseline: () => false
        });
        expect(plan).toEqual(["a.xaml", "m.xaml", "z.xaml"]);
    });

    it("consults hasBaseline per path, not once for the workspace", () => {
        const seen: string[] = [];
        const plan = planBaselineRepair({
            manifest: manifest({ "a.xaml": file(), "b.xaml": file() }),
            hasBaseline: (p) => { seen.push(p); return p === "a.xaml"; }
        });
        expect(seen.sort()).toEqual(["a.xaml", "b.xaml"]);
        expect(plan).toEqual(["b.xaml"]);
    });
});
