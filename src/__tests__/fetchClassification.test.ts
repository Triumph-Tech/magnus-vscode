import { describe, expect, it } from "vitest";
import { hashBytes } from "../manifest";
import { bytesEqual, classifyFetchedFile } from "../syncDecisions";

/**
 * `classifyFetchedFile` is the routing function fetch runs for every server
 * file. A miscategorized fast-forward silently overwrites local edits, which
 * is the single most damaging bug class in local-mode sync. These tests pin
 * down every reachable branch.
 */

const bytes = (s: string) => Buffer.from(s, "utf8");

describe("bytesEqual", () => {
    it("returns true for identical content", () => {
        expect(bytesEqual(bytes("hello"), bytes("hello"))).toBe(true);
    });

    it("returns false when lengths differ", () => {
        expect(bytesEqual(bytes("hello"), bytes("hello!"))).toBe(false);
    });

    it("returns false when only the trailing byte differs", () => {
        // Pinned because a length-only check would let this slip through.
        expect(bytesEqual(bytes("hello"), bytes("hellp"))).toBe(false);
    });

    it("treats two empty arrays as equal", () => {
        expect(bytesEqual(bytes(""), bytes(""))).toBe(true);
    });
});

describe("classifyFetchedFile — file is in the manifest", () => {
    const baseline = bytes("baseline content");
    const baselineEntry = { hash: hashBytes(baseline) };

    it("returns 'unchanged' when server matches baseline (regardless of local)", () => {
        const decision = classifyFetchedFile({
            serverBytes: baseline,
            baselineBytes: baseline,
            localBytes: bytes("local edits"),
            manifestEntry: baselineEntry
        });
        expect(decision).toBe("unchanged");
    });

    it("returns 'fast-forward' when server diverged but local equals baseline", () => {
        // Safe to silently overwrite: user has not touched the file.
        const decision = classifyFetchedFile({
            serverBytes: bytes("server moved"),
            baselineBytes: baseline,
            localBytes: baseline,
            manifestEntry: baselineEntry
        });
        expect(decision).toBe("fast-forward");
    });

    it("returns 'conflict' when both server and local diverged from baseline", () => {
        // Both sides changed — must surface to the user, never silently overwrite.
        const decision = classifyFetchedFile({
            serverBytes: bytes("server moved"),
            baselineBytes: baseline,
            localBytes: bytes("local moved"),
            manifestEntry: baselineEntry
        });
        expect(decision).toBe("conflict");
    });

    it("returns 'conflict' when server diverged and local file is missing", () => {
        // Missing local is ambiguous (delete? clear? user intent?) — treat as
        // a conflict so the user has to act explicitly.
        const decision = classifyFetchedFile({
            serverBytes: bytes("server moved"),
            baselineBytes: baseline,
            localBytes: null,
            manifestEntry: baselineEntry
        });
        expect(decision).toBe("conflict");
    });

    it("returns 'conflict' when baseline is missing on disk and manifest hash mismatches local", () => {
        // Legacy workspace (no .magnus/baseline/). Without a real baseline we
        // can't prove local is clean, so route to conflict.
        const decision = classifyFetchedFile({
            serverBytes: bytes("server"),
            baselineBytes: null,
            localBytes: bytes("local"),
            manifestEntry: { hash: hashBytes(bytes("recorded-but-not-on-disk")) }
        });
        expect(decision).toBe("conflict");
    });

    it("returns 'unchanged' via manifest-hash fallback when baseline missing but server matches recorded hash", () => {
        // Pre-baseline workspaces still need a way to recognize "in sync".
        // The manifest's recorded hash stands in for a missing baseline file.
        const recorded = bytes("in-sync content");
        const decision = classifyFetchedFile({
            serverBytes: recorded,
            baselineBytes: null,
            localBytes: recorded,
            manifestEntry: { hash: hashBytes(recorded) }
        });
        expect(decision).toBe("unchanged");
    });

    it("returns 'conflict' when baseline missing and manifest entry has no hash", () => {
        // Maximally degraded: no baseline file, no recorded hash. Every
        // server byte counts as divergence; we can't prove local is clean.
        const decision = classifyFetchedFile({
            serverBytes: bytes("server"),
            baselineBytes: null,
            localBytes: bytes("local"),
            manifestEntry: { hash: null }
        });
        expect(decision).toBe("conflict");
    });
});

describe("classifyFetchedFile — file is not in the manifest", () => {
    it("returns 'new' when server has real content for an unknown URI", () => {
        const decision = classifyFetchedFile({
            serverBytes: bytes("brand new file"),
            baselineBytes: null,
            localBytes: null,
            manifestEntry: null
        });
        expect(decision).toBe("new");
    });

    it("returns 'skip-empty' when the server returns zero-byte content for an unknown URI", () => {
        // Rock returns empty bytes for unset block templates and pre/post
        // wrappers. Pull-time skips these; fetch must too, or every empty
        // endpoint re-flags as 'new' on every fetch.
        const decision = classifyFetchedFile({
            serverBytes: bytes(""),
            baselineBytes: null,
            localBytes: null,
            manifestEntry: null
        });
        expect(decision).toBe("skip-empty");
    });

    it("returns 'skip-empty' when the server returns whitespace-only content for an unknown URI", () => {
        // isEmptyContent normalizes by trimming — content that's only spaces,
        // tabs, and newlines counts as empty.
        const decision = classifyFetchedFile({
            serverBytes: bytes("   \n\t  \n"),
            baselineBytes: null,
            localBytes: null,
            manifestEntry: null
        });
        expect(decision).toBe("skip-empty");
    });

    it("returns 'new' when server has a single non-whitespace character", () => {
        // Boundary case for the trim-based emptiness check.
        const decision = classifyFetchedFile({
            serverBytes: bytes("x"),
            baselineBytes: null,
            localBytes: null,
            manifestEntry: null
        });
        expect(decision).toBe("new");
    });
});

describe("classifyFetchedFile — byte-level sensitivity", () => {
    it("treats trailing-newline difference as divergence (raw-bytes comparison)", () => {
        // Manifest hashing is raw-bytes (see manifest.test.ts), so the
        // classifier must agree: a stray newline counts as a real change.
        const baseline = bytes("hello");
        const decision = classifyFetchedFile({
            serverBytes: bytes("hello\n"),
            baselineBytes: baseline,
            localBytes: baseline,
            manifestEntry: { hash: hashBytes(baseline) }
        });
        expect(decision).toBe("fast-forward");
    });

    it("does not confuse an empty server response with 'unchanged' for a tracked entry", () => {
        // An in-manifest file whose server returned empty bytes is *not*
        // "skip-empty" — that branch only applies to untracked URIs. Here
        // it should classify as fast-forward (or conflict, if local is dirty).
        const baseline = bytes("non-empty baseline");
        const decision = classifyFetchedFile({
            serverBytes: bytes(""),
            baselineBytes: baseline,
            localBytes: baseline,
            manifestEntry: { hash: hashBytes(baseline) }
        });
        expect(decision).toBe("fast-forward");
    });
});
