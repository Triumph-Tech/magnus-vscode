import { MagnusSelectionEntry } from "./magnusJson";

/**
 * Comparing a workspace's committed selection against what the user just
 * checked, so the caller knows what to pull and what to let go of.
 *
 * Pure, because the consequences are asymmetric and worth pinning: a resource
 * wrongly in `added` costs a redundant pull, while one wrongly in `removed`
 * puts a "delete these files?" prompt in front of someone who never asked for
 * it.
 */

export type SelectionDiff = {
    /** Chosen now, absent before. These get pulled. */
    added: MagnusSelectionEntry[];
    /** Present before, unchecked now. The user is asked about these. */
    removed: MagnusSelectionEntry[];
    /** Chosen in both. Left alone; a re-pull is a separate, explicit action. */
    unchanged: MagnusSelectionEntry[];
};

/**
 * Diff two selections by `pathPrefix`.
 *
 * The prefix is the identity, not the URI or the display name. It is what the
 * files on disk are actually keyed by, so it is the only field where "same
 * entry" and "same files" mean the same thing. A resource renamed on the server
 * keeps its prefix until it is re-pulled, and matching on `displayName` would
 * have read that rename as one resource removed and a different one added,
 * which would offer to delete a directory full of the user's work.
 */
export function diffSelection(
    previous: MagnusSelectionEntry[],
    chosen: MagnusSelectionEntry[]
): SelectionDiff {
    const previousByPrefix = new Map(previous.map(e => [e.pathPrefix, e]));
    const chosenPrefixes = new Set(chosen.map(e => e.pathPrefix));

    const added: MagnusSelectionEntry[] = [];
    const unchanged: MagnusSelectionEntry[] = [];

    for (const entry of chosen) {
        if (previousByPrefix.has(entry.pathPrefix)) {
            unchanged.push(entry);
        }
        else {
            added.push(entry);
        }
    }

    const removed = previous.filter(e => !chosenPrefixes.has(e.pathPrefix));

    return { added, removed, unchanged };
}
