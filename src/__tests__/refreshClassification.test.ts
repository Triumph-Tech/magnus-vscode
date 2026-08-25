import { describe, expect, it } from "vitest";
import { classifyLocalState } from "../syncDecisions";

/**
 * `classifyLocalState` drives what the SCM Changes group shows for each
 * tracked file every time refresh runs (which is on every save and most
 * state changes). False positives nag the user and erode trust; false
 * negatives let real changes go unnoticed.
 */

const bytes = (s: string) => Buffer.from(s, "utf8");

describe("classifyLocalState", () => {
    it("returns 'unchanged' when local equals baseline", () => {
        const same = bytes("identical content");
        expect(classifyLocalState({ localBytes: same, baselineBytes: same })).toBe("unchanged");
    });

    it("returns 'modified' when local differs from baseline", () => {
        expect(classifyLocalState({
            localBytes: bytes("local edits"),
            baselineBytes: bytes("baseline content")
        })).toBe("modified");
    });

    it("returns 'deleted' when local file is missing", () => {
        // Surfaces as a deletion in the Changes group regardless of baseline state.
        expect(classifyLocalState({
            localBytes: null,
            baselineBytes: bytes("anything")
        })).toBe("deleted");
    });

    it("returns 'deleted' when both local and baseline are missing", () => {
        // Edge case: caller's baseline-resolution returned null AND the
        // local file is gone. Local-missing wins; this is a deletion.
        expect(classifyLocalState({
            localBytes: null,
            baselineBytes: null
        })).toBe("deleted");
    });

    it("returns 'unknown' when baseline is null but local exists", () => {
        // Backfill failed (server unreachable, no manifest hash). This used to
        // return 'unchanged', and the caller then skipped the file entirely, so
        // a tracked file with unverifiable content was invisible in the only UI
        // that would have reported it (spec 8.2).
        //
        // 'unknown' is the honest answer: the file is real, it may well have
        // been edited, and we cannot tell. The panel shows it as unverified and
        // push gates it via classifyPushSafety.
        expect(classifyLocalState({
            localBytes: bytes("local content"),
            baselineBytes: null
        })).toBe("unknown");
    });

    it("returns 'unknown' for an empty local file with no baseline", () => {
        // Empty content is not the same as absent content: the file exists, so
        // this is 'unknown' rather than 'deleted'.
        expect(classifyLocalState({
            localBytes: bytes(""),
            baselineBytes: null
        })).toBe("unknown");
    });

    it("still returns 'deleted' when local is missing, baseline or not", () => {
        // Local-missing outranks the unknown-baseline case in both directions,
        // so introducing 'unknown' must not have shadowed it.
        expect(classifyLocalState({ localBytes: null, baselineBytes: null })).toBe("deleted");
        expect(classifyLocalState({
            localBytes: null,
            baselineBytes: bytes("anything")
        })).toBe("deleted");
    });

    it("treats a single trailing newline as 'modified' (raw-bytes comparison)", () => {
        // Mirrors the manifest's raw-bytes hashing contract — EOL drift
        // counts as a real change.
        expect(classifyLocalState({
            localBytes: bytes("hello\n"),
            baselineBytes: bytes("hello")
        })).toBe("modified");
    });

    it("treats two empty buffers as 'unchanged'", () => {
        // Empty files are still legitimately tracked content.
        expect(classifyLocalState({
            localBytes: bytes(""),
            baselineBytes: bytes("")
        })).toBe("unchanged");
    });

    it("returns 'modified' when local is empty but baseline is not", () => {
        // User cleared the file but didn't delete it — that's a real edit,
        // distinct from a deletion.
        expect(classifyLocalState({
            localBytes: bytes(""),
            baselineBytes: bytes("had content")
        })).toBe("modified");
    });
});
