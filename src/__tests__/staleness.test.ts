import { describe, expect, it } from "vitest";
import { ManifestItem } from "../manifest";
import { canSkipByTimestamp } from "../staleness";

/**
 * Tier 2 of the polling design (spec 7.8): decide which items a scan can leave
 * alone without reading anyone's content.
 *
 * The asymmetry is the whole design. Skipping something that did change means
 * the user keeps working against stale content and never finds out, so every
 * uncertain case has to resolve to "check it".
 */

const entry = (over: Partial<ManifestItem> = {}): ManifestItem => ({
    uri: "/api/x",
    isFolder: false,
    hash: "abc",
    modifiedDateTime: "2026-08-18T10:00:00Z",
    ...over
});

describe("canSkipByTimestamp", () => {
    it("skips when the server's timestamp matches the one recorded at last sync", () => {
        expect(canSkipByTimestamp(entry(), "2026-08-18T10:00:00Z")).toBe(true);
    });

    it("checks when the server's timestamp has moved", () => {
        expect(canSkipByTimestamp(entry(), "2026-08-18T11:00:00Z")).toBe(false);
    });

    it("checks when the server reports no timestamp", () => {
        // A handler that does not populate the field must not be read as
        // "nothing changed". This is what makes partial handler coverage safe:
        // an unpopulated type simply keeps the old behaviour.
        expect(canSkipByTimestamp(entry(), null)).toBe(false);
        expect(canSkipByTimestamp(entry(), undefined)).toBe(false);
    });

    it("checks when nothing was recorded at last sync", () => {
        // First scan after upgrading, or an item synced before the field
        // existed. There is nothing to compare against.
        expect(canSkipByTimestamp(entry({ modifiedDateTime: undefined }), "2026-08-18T10:00:00Z"))
            .toBe(false);
    });

    it("checks when the item has no recorded hash", () => {
        // A matching timestamp says the server did not change. It says nothing
        // about whether our bookkeeping is usable, and an item with no hash
        // cannot be compared against later anyway, so skipping would strand it
        // permanently in the state eager repair exists to fix.
        expect(canSkipByTimestamp(entry({ hash: undefined }), "2026-08-18T10:00:00Z"))
            .toBe(false);
    });

    it("checks a folder rather than skipping it", () => {
        // Folders are not downloaded, so this should never be asked, but a
        // "skip" here would be a silent no-op that looks like success.
        expect(canSkipByTimestamp(entry({ isFolder: true }), "2026-08-18T10:00:00Z"))
            .toBe(false);
    });

    it("checks when there is no manifest entry at all", () => {
        // A new file on the server. Nothing recorded, so nothing to skip.
        expect(canSkipByTimestamp(undefined, "2026-08-18T10:00:00Z")).toBe(false);
    });

    it("compares timestamps exactly, not by parsed instant", () => {
        // Deliberate: the value is an opaque token echoed back from the server.
        // Parsing invites timezone and precision differences to read as changes,
        // or worse, two genuinely different values to compare equal.
        expect(canSkipByTimestamp(entry({ modifiedDateTime: "2026-08-18T10:00:00.000Z" }),
            "2026-08-18T10:00:00Z")).toBe(false);
    });
});
