import { describe, expect, it } from "vitest";
import { classifyDeletionScan } from "../syncDecisions";

/**
 * `classifyDeletionScan` is the floor under fetch's deletion pass (spec 8.3.1).
 *
 * That pass reads a tracked file's absence from the server scan as proof it was
 * deleted server-side. An empty scan against a populated manifest therefore
 * reads as "everything was deleted" and wipes the workspace in one pass. This
 * function is what stops that.
 *
 * Two distinct distrust verdicts, because they need different handling. An
 * EMPTY scan is caught locally by comparing counts, and is worth asking the user
 * about since a resource really can be emptied. A PARTIAL scan can only be
 * detected from the server's `complete` flag (spec 11.4), and cannot be
 * confirmed away by anyone, because nobody knows what was left out.
 */

describe("classifyDeletionScan", () => {
    it("distrusts an empty scan when the manifest tracks files", () => {
        // The case that wipes a workspace.
        expect(classifyDeletionScan({
            scannedFileCount: 0,
            trackedFileCount: 412
        })).toBe("distrust-empty-scan");
    });

    it("distrusts an empty scan even for a single tracked file", () => {
        // No lower bound below which a wipe is acceptable.
        expect(classifyDeletionScan({
            scannedFileCount: 0,
            trackedFileCount: 1
        })).toBe("distrust-empty-scan");
    });

    it("trusts a scan that produced items", () => {
        expect(classifyDeletionScan({
            scannedFileCount: 412,
            trackedFileCount: 412
        })).toBe("trust");
    });

    it("trusts a drastic but complete scan", () => {
        // 411 files really were deleted on the server. A complete scan saying so
        // is exactly the case the deletion pass exists for, and the size of the
        // drop is not itself evidence of a problem.
        expect(classifyDeletionScan({
            scannedFileCount: 1,
            trackedFileCount: 412,
            scanComplete: true
        })).toBe("trust");
    });

    it("distrusts an incomplete scan even when it returned plenty of items", () => {
        // The case no amount of local counting can catch, and the reason the
        // server had to grow a completeness flag. Without it, the 371 items this
        // response omitted all read as deleted.
        expect(classifyDeletionScan({
            scannedFileCount: 41,
            trackedFileCount: 412,
            scanComplete: false
        })).toBe("distrust-incomplete-scan");
    });

    it("reports incompleteness ahead of emptiness", () => {
        // Both conditions hold. Incomplete wins because it is the one the user
        // cannot resolve by confirming, so it must not be masked by a prompt
        // that offers to proceed.
        expect(classifyDeletionScan({
            scannedFileCount: 0,
            trackedFileCount: 412,
            scanComplete: false
        })).toBe("distrust-incomplete-scan");
    });

    it("does not let a user confirmation override an incomplete scan", () => {
        // "Server really is empty" is a statement about an empty result, not a
        // waiver on unknown omissions. An incomplete scan stays distrusted.
        expect(classifyDeletionScan({
            scannedFileCount: 0,
            trackedFileCount: 412,
            scanComplete: false,
            userConfirmedEmpty: true
        })).toBe("distrust-incomplete-scan");
    });

    it("trusts an incomplete scan when the manifest tracks nothing", () => {
        // Nothing to lose, so no reason to warn. Keeps a fresh workspace quiet
        // when talking to a plugin too old to report completeness.
        expect(classifyDeletionScan({
            scannedFileCount: 0,
            trackedFileCount: 0,
            scanComplete: false
        })).toBe("trust");
    });

    it("trusts an empty scan when the manifest tracks nothing", () => {
        // Fresh or fully-emptied workspace. Nothing to lose, and returning
        // 'distrust' would nag on every fetch of an empty workspace.
        expect(classifyDeletionScan({
            scannedFileCount: 0,
            trackedFileCount: 0
        })).toBe("trust");
    });

    it("trusts an empty scan once the user has confirmed it", () => {
        // The escape hatch for a resource genuinely emptied on the server.
        // The caller re-scans before passing this, so honouring it takes two
        // independent empty scans plus explicit consent.
        expect(classifyDeletionScan({
            scannedFileCount: 0,
            trackedFileCount: 412,
            userConfirmedEmpty: true
        })).toBe("trust");
    });

    it("treats an absent confirmation flag as not confirmed", () => {
        // Guards against the flag being optional: omitted and explicit-false
        // must behave identically.
        expect(classifyDeletionScan({
            scannedFileCount: 0,
            trackedFileCount: 5,
            userConfirmedEmpty: false
        })).toBe("distrust-empty-scan");
        expect(classifyDeletionScan({
            scannedFileCount: 0,
            trackedFileCount: 5
        })).toBe("distrust-empty-scan");
    });
});
