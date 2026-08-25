import { describe, expect, it } from "vitest";
import { classifyStampChange, resolvePollIntervalMs } from "../pollDecisions";

/**
 * Tier 1 of the polling design (spec 7.8). These two functions decide how often
 * the client asks the server anything, and whether the answer means "go look".
 *
 * The failure costs are asymmetric in both. A false "unchanged" leaves the user
 * editing against content someone else already moved; a false "disabled" leaves
 * them believing they are being warned when nothing is watching.
 */

describe("classifyStampChange", () => {
    const obs = (stamp: string | null, itemCount: number) => ({ stamp, itemCount });

    it("reports the first tick as first-observation, not as a change", () => {
        // Nothing to compare against. Calling this "changed" would mean every
        // window reload triggered a full sweep whether or not anything happened.
        expect(classifyStampChange(null, obs("2026-08-18T10:00:00Z", 12)))
            .toBe("first-observation");
        expect(classifyStampChange(undefined, obs("2026-08-18T10:00:00Z", 12)))
            .toBe("first-observation");
    });

    it("reports an identical stamp and count as unchanged", () => {
        // The common case, and the one that has to stay cheap.
        expect(classifyStampChange(
            obs("2026-08-18T10:00:00Z", 12),
            obs("2026-08-18T10:00:00Z", 12)
        )).toBe("unchanged");
    });

    it("reports a moved timestamp as changed", () => {
        expect(classifyStampChange(
            obs("2026-08-18T10:00:00Z", 12),
            obs("2026-08-18T10:04:31Z", 12)
        )).toBe("changed");
    });

    it("reports a changed count as changed even when the timestamp holds still", () => {
        // The deletion case, and the whole reason itemCount is carried alongside
        // the stamp. Deleting an item does not move a maximum modified time, so a
        // timestamp on its own misses deletions entirely.
        expect(classifyStampChange(
            obs("2026-08-18T10:00:00Z", 12),
            obs("2026-08-18T10:00:00Z", 11)
        )).toBe("changed");
    });

    it("reports a count increase as changed", () => {
        // A newly added item whose modified time somehow sorts no later than the
        // previous maximum, e.g. a backdated import.
        expect(classifyStampChange(
            obs("2026-08-18T10:00:00Z", 12),
            obs("2026-08-18T10:00:00Z", 13)
        )).toBe("changed");
    });

    it("handles a null stamp on either side", () => {
        // An empty subtree has no maximum modified time. Going from empty to
        // populated, or back, is a change.
        expect(classifyStampChange(obs(null, 0), obs(null, 0))).toBe("unchanged");
        expect(classifyStampChange(obs(null, 0), obs("2026-08-18T10:00:00Z", 1)))
            .toBe("changed");
        expect(classifyStampChange(obs("2026-08-18T10:00:00Z", 1), obs(null, 0)))
            .toBe("changed");
    });

    it("compares stamps as opaque strings, not as parsed dates", () => {
        // Two spellings of the same instant count as changed. That is deliberate:
        // these are tokens echoed back from the server, and any difference is
        // enough to justify a closer look. Treating them as equal would require
        // date parsing whose timezone and precision behaviour could only ever
        // turn a real change into a missed one.
        expect(classifyStampChange(
            obs("2026-08-18T10:00:00Z", 5),
            obs("2026-08-18T10:00:00.000Z", 5)
        )).toBe("changed");
    });
});

describe("resolvePollIntervalMs", () => {
    it("returns the configured interval in milliseconds", () => {
        expect(resolvePollIntervalMs(60)).toBe(60_000);
        expect(resolvePollIntervalMs(120)).toBe(120_000);
    });

    it("treats exactly zero as disabled", () => {
        // The documented off switch (7.8).
        expect(resolvePollIntervalMs(0)).toBeNull();
    });

    it("raises values below the floor rather than honouring them", () => {
        // Each tick is an HTTP round trip from every open workspace, so someone
        // typing 1 wants "responsive", not sixty times the load.
        expect(resolvePollIntervalMs(1)).toBe(15_000);
        expect(resolvePollIntervalMs(14)).toBe(15_000);
        expect(resolvePollIntervalMs(15)).toBe(15_000);
        expect(resolvePollIntervalMs(16)).toBe(16_000);
    });

    it("falls back to the default for unusable values instead of disabling", () => {
        // Silently stopping because a setting was malformed would leave the user
        // believing they were being warned about server changes when nothing was
        // watching. Only an explicit 0 disables. A non-default fallback is passed
        // so these assertions cannot pass by coincidence.
        expect(resolvePollIntervalMs(undefined, 30)).toBe(30_000);
        expect(resolvePollIntervalMs(null, 30)).toBe(30_000);
        expect(resolvePollIntervalMs("60", 30)).toBe(30_000);
        expect(resolvePollIntervalMs(NaN, 30)).toBe(30_000);
        expect(resolvePollIntervalMs(Infinity, 30)).toBe(30_000);
        expect(resolvePollIntervalMs(-5, 30)).toBe(30_000);
    });

    it("floors a fractional interval", () => {
        expect(resolvePollIntervalMs(90.7)).toBe(90_000);
    });

    it("does not let a fractional value below one disable polling", () => {
        // Math.floor(0.5) is 0, which must not be mistaken for the explicit off
        // switch: "very often" and "stop watching" must not be one keystroke
        // apart. It clamps to the floor like any other too-small value.
        expect(resolvePollIntervalMs(0.5)).toBe(15_000);
        expect(resolvePollIntervalMs(0.999)).toBe(15_000);
    });

    it("honours caller-supplied default and floor", () => {
        expect(resolvePollIntervalMs(undefined, 30, 10)).toBe(30_000);
        expect(resolvePollIntervalMs(5, 30, 10)).toBe(10_000);
    });
});
