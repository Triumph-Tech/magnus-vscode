import { describe, expect, it } from "vitest";
import { classifyServerDeletion } from "../syncDecisions";

/**
 * `classifyServerDeletion` decides whether a manifest-tracked file that the
 * server walk no longer reports should be silently removed locally, or
 * surfaced as a conflict the user must resolve. This is the only sync path
 * that *removes files from disk without explicit user click*, so the
 * routing rules are pinned aggressively here.
 */

const bytes = (s: string) => Buffer.from(s, "utf8");

describe("classifyServerDeletion", () => {
    it("returns 'auto-delete' when the local file is already missing", () => {
        // No file on disk to lose — accepting the deletion is a no-op locally.
        const decision = classifyServerDeletion({
            localBytes: null,
            baselineBytes: bytes("baseline")
        });
        expect(decision).toBe("auto-delete");
    });

    it("returns 'auto-delete' when the local file matches the baseline", () => {
        // User hasn't touched the file since last sync; safe to remove.
        const baseline = bytes("baseline content");
        const decision = classifyServerDeletion({
            localBytes: baseline,
            baselineBytes: baseline
        });
        expect(decision).toBe("auto-delete");
    });

    it("returns 'flag-conflict' when local has uncommitted edits", () => {
        // User's edits would be lost — must surface for confirmation.
        const decision = classifyServerDeletion({
            localBytes: bytes("local edits"),
            baselineBytes: bytes("baseline content")
        });
        expect(decision).toBe("flag-conflict");
    });

    it("returns 'flag-conflict' when local exists but no baseline is on disk (legacy workspace)", () => {
        // Pre-baseline workspace: we can't prove local is clean. Conservative
        // default is to refuse silent deletion. The user can still accept it
        // through the Incoming Changes UI.
        const decision = classifyServerDeletion({
            localBytes: bytes("some local content"),
            baselineBytes: null
        });
        expect(decision).toBe("flag-conflict");
    });

    it("returns 'auto-delete' when both local and baseline are absent", () => {
        // Edge case: the file was never materialized locally and there's no
        // baseline either. Nothing to lose; clean delete.
        const decision = classifyServerDeletion({
            localBytes: null,
            baselineBytes: null
        });
        expect(decision).toBe("auto-delete");
    });

    it("returns 'flag-conflict' when local differs from baseline by a single trailing newline", () => {
        // Byte-level comparison must not normalize whitespace, or we'd
        // silently delete files that look "the same" but have a stray newline.
        const decision = classifyServerDeletion({
            localBytes: bytes("hello\n"),
            baselineBytes: bytes("hello")
        });
        expect(decision).toBe("flag-conflict");
    });

    it("returns 'auto-delete' when local and baseline are both empty", () => {
        // Empty files are still legitimately tracked content; equality holds.
        const decision = classifyServerDeletion({
            localBytes: bytes(""),
            baselineBytes: bytes("")
        });
        expect(decision).toBe("auto-delete");
    });
});
