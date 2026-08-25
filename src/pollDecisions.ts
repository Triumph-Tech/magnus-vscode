/**
 * Decisions for the server-awareness poll (spec 7.8).
 *
 * The panel is baseline-relative and never contacted the server, so it could
 * report what you changed but was blind to what anyone else changed. A
 * development session commonly leaves it open for hours, which is why open-time
 * and manual-refresh checks were not enough.
 *
 * Polling is tiered so the steady state is one cheap query per root:
 *
 *   1. Aggregate stamp per root, every tick. One indexed query, no enumeration.
 *   2. Per-item timestamps, only when tier 1 moved.
 *   3. Content, only for the items tier 2 implicated.
 *
 * Everything here is pure. The tier-1 comparison in particular has an
 * asymmetric failure cost: a false "unchanged" means the user keeps editing
 * against stale content, so anything ambiguous resolves to "changed".
 */

/**
 * A server-side stamp: an aggregate change token for one subtree.
 *
 * Compared only against the previous stamp for the same root, never against the
 * client's own item count. The server cannot filter these by the caller's
 * permissions without loading and authorising every row, which is the
 * enumeration tier 1 exists to avoid, so the counts here are unfiltered and only
 * meaningful relative to themselves.
 */
export interface IStampObservation {
    /** Most recent modification time under the subtree, ISO 8601, or null. */
    stamp: string | null;
    /** Number of items under the subtree, unfiltered. */
    itemCount: number;
}

/**
 * Outcome of comparing a fresh stamp against the last one seen.
 *
 *   - `first-observation`: nothing to compare against yet.
 *   - `changed`: something under this root moved; escalate to the next tier.
 *   - `unchanged`: steady state, which is the common case; stop here.
 */
export type StampVerdict = "first-observation" | "changed" | "unchanged";

/**
 * Decide whether a root needs a closer look.
 *
 * `first-observation` is reported separately from `changed` so the caller can
 * choose: on the very first tick after a workspace opens there is genuinely no
 * prior state, and treating that as a change would mean every open triggers a
 * full sweep whether or not anything happened.
 *
 * The count is compared as well as the timestamp because deleting an item does
 * not move a maximum modification time. A timestamp alone misses deletions
 * entirely, which is the change most worth noticing.
 */
export function classifyStampChange(
    previous: IStampObservation | null | undefined,
    current: IStampObservation
): StampVerdict {
    if (!previous) {
        return "first-observation";
    }

    if (previous.itemCount !== current.itemCount) {
        return "changed";
    }

    // Compared as strings deliberately. These are opaque tokens echoed back from
    // the server, and parsing them into dates would introduce timezone and
    // precision questions that cannot change the answer: any difference at all
    // means something moved.
    return previous.stamp === current.stamp ? "unchanged" : "changed";
}

/**
 * Turns the configured poll interval into milliseconds, or null to disable.
 *
 * Zero disables, per 7.8. Anything unusable, negative, fractional, NaN, or
 * missing, falls back to the default rather than disabling: silently stopping
 * because a setting was malformed would leave the user believing they were being
 * warned about server changes when they were not.
 */
export function resolvePollIntervalMs(
    configuredSeconds: unknown,
    defaultSeconds = 60,
    minimumSeconds = 15
): number | null {
    // Only an explicit zero disables. Nothing else may reach `null`, including a
    // fractional value that would floor to zero: 0.5 means "very often", not
    // "stop watching", and the two must not be one keystroke apart.
    if (configuredSeconds === 0) {
        return null;
    }

    if (typeof configuredSeconds !== "number"
        || !Number.isFinite(configuredSeconds)
        || configuredSeconds < 0) {
        return defaultSeconds * 1000;
    }

    // A floor exists because the cost of a tick is not entirely the server's:
    // each one is an HTTP round trip from every open workspace. Someone setting
    // 1 second almost certainly wants "responsive", not "sixty times the load".
    return Math.max(Math.floor(configuredSeconds), minimumSeconds) * 1000;
}

/**
 * Fold the stamps from several roots into one observation for the workspace.
 *
 * Returns null only when no root answered at all, which the caller reads as
 * "nothing here is pollable, stop asking".
 *
 * Roots that decline are simply absent from the fold rather than being treated
 * as unchanged. That distinction matters: a workspace holding a mobile app and a
 * theme polls on the app alone, because themes decline, and the fold must not
 * imply the theme was checked and found quiet.
 *
 * Summing counts across roots is safe for the same reason a single root's count
 * is: the result is only ever compared against its own previous value. It does
 * mean one root gaining an item while another loses one nets to zero, which the
 * timestamp still catches, since any edit that adds or removes also moves a
 * modified time.
 */
export function foldStampObservations(
    observations: Array<IStampObservation | null>
): IStampObservation | null {
    const answered = observations.filter((o): o is IStampObservation => o !== null);

    if (answered.length === 0) {
        return null;
    }

    let stamp: string | null = null;
    let itemCount = 0;

    for (const observation of answered) {
        itemCount += observation.itemCount;
        if (observation.stamp !== null && (stamp === null || observation.stamp > stamp)) {
            stamp = observation.stamp;
        }
    }

    return { stamp, itemCount };
}
