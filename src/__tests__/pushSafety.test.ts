import { describe, expect, it } from "vitest";
import { hashBytes } from "../manifest";
import { classifyPushSafety } from "../syncDecisions";

/**
 * `classifyPushSafety` decides whether a push must be gated behind the
 * "server moved since you last synced" warning modal. Push is the only
 * operation that mutates server-side data, so the routing is pinned tightly.
 *
 * The gate fails CLOSED. It previously returned `safe` whenever it had
 * nothing to compare against, on the reasoning that the check was meaningless
 * without a recorded hash (spec 8.1). That inverted its purpose: "we cannot
 * tell whether this would destroy someone's work" is the strongest reason to
 * ask, not a reason to proceed silently.
 */

const bytes = (s: string) => Buffer.from(s, "utf8");

describe("classifyPushSafety", () => {
    it("returns 'safe' when the server hash equals the baseline hash", () => {
        // Server has not moved since last sync; the user is overwriting
        // only their own version.
        const h = hashBytes(bytes("synced content"));
        expect(classifyPushSafety({
            currentServerHash: h,
            baselineHash: h,
            manifestHash: h
        })).toBe("safe");
    });

    it("returns 'requires-confirm' when the server hash differs from the baseline", () => {
        // Someone else pushed, or the content was edited in cloud mode.
        expect(classifyPushSafety({
            currentServerHash: hashBytes(bytes("server moved")),
            baselineHash: hashBytes(bytes("last synced")),
            manifestHash: hashBytes(bytes("last synced"))
        })).toBe("requires-confirm");
    });

    it("uses the baseline when the manifest hash is missing", () => {
        // This is the case the old implementation waved through. The baseline
        // was sitting on disk the whole time; push simply never read it.
        const h = hashBytes(bytes("synced content"));
        expect(classifyPushSafety({
            currentServerHash: h,
            baselineHash: h,
            manifestHash: null
        })).toBe("safe");

        expect(classifyPushSafety({
            currentServerHash: hashBytes(bytes("server moved")),
            baselineHash: h,
            manifestHash: null
        })).toBe("requires-confirm");
    });

    it("falls back to the manifest hash when no baseline is on disk", () => {
        // Legacy workspace with a manifest but no `.magnus/baseline/`.
        const h = hashBytes(bytes("synced content"));
        expect(classifyPushSafety({
            currentServerHash: h,
            baselineHash: null,
            manifestHash: h
        })).toBe("safe");

        expect(classifyPushSafety({
            currentServerHash: hashBytes(bytes("server moved")),
            baselineHash: null,
            manifestHash: h
        })).toBe("requires-confirm");
    });

    it("prefers the baseline over the manifest hash when they disagree", () => {
        // An interrupted sync can leave the two out of step. The baseline is
        // the actual bytes; the manifest hash is a recorded claim about them.
        // Matches how `classifyFetchedFile` resolves the same two sources.
        const serverAndBaseline = hashBytes(bytes("what the server holds"));
        expect(classifyPushSafety({
            currentServerHash: serverAndBaseline,
            baselineHash: serverAndBaseline,
            manifestHash: hashBytes(bytes("a stale manifest claim"))
        })).toBe("safe");
    });

    it("returns 'requires-confirm' when neither baseline nor manifest hash exists", () => {
        // The fail-closed case, and the whole point of 8.1. Nothing on disk
        // tells us what the server looked like at last sync, so pushing might
        // silently overwrite someone else's work. Ask.
        const serverHash = hashBytes(bytes("anything"));
        expect(classifyPushSafety({
            currentServerHash: serverHash,
            baselineHash: null,
            manifestHash: null
        })).toBe("requires-confirm");
    });

    it("treats undefined and empty-string hashes as absent, not comparable", () => {
        // Both shapes appear in the manifest type, and a malformed manifest
        // with an empty hash field is indistinguishable from no hash at all.
        const serverHash = hashBytes(bytes("anything"));
        expect(classifyPushSafety({
            currentServerHash: serverHash,
            baselineHash: undefined,
            manifestHash: undefined
        })).toBe("requires-confirm");

        expect(classifyPushSafety({
            currentServerHash: serverHash,
            baselineHash: "",
            manifestHash: ""
        })).toBe("requires-confirm");
    });

    it("does not treat an empty-string baseline as a reason to skip the manifest hash", () => {
        // Guards the `||` fallback: an empty baseline hash must fall through
        // to the manifest hash rather than short-circuit to 'requires-confirm'.
        const h = hashBytes(bytes("synced content"));
        expect(classifyPushSafety({
            currentServerHash: h,
            baselineHash: "",
            manifestHash: h
        })).toBe("safe");
    });
});
