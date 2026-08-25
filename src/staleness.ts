import { ManifestItem } from "./manifest";

/**
 * Tier 2 of the polling design (spec 7.8): deciding what a scan can leave alone.
 *
 * Tier 1 says something under a root moved. Tier 3 confirms with real content.
 * This is the middle step that stops tier 3 from having to look at everything,
 * and it matters because the alternative, asking the server for a hash per item,
 * makes the server read every item's content to produce them.
 *
 * Timestamps decide *where to look*, never what to report. Their imprecision
 * therefore does not matter: a save that changes nothing still moves the
 * timestamp, which costs one unnecessary content read and reports nothing to
 * the user, because content is compared before anything reaches them.
 */

/**
 * Whether a scan can skip downloading this item's content.
 *
 * Returns false for every uncertain case. Skipping something that did change
 * leaves the user working against stale content with no indication, which is the
 * one outcome the polling design exists to prevent; skipping nothing costs a
 * download.
 */
export function canSkipByTimestamp(
    entry: ManifestItem | undefined,
    serverModifiedDateTime: string | null | undefined
): boolean {
    if (!entry || entry.isFolder) {
        return false;
    }

    // No hash means the bookkeeping is unusable regardless of what the server
    // says, and skipping would strand the item in exactly the state eager
    // repair exists to fix.
    if (!entry.hash) {
        return false;
    }

    if (!serverModifiedDateTime || !entry.modifiedDateTime) {
        return false;
    }

    // Exact string comparison, deliberately. The value is an opaque token we
    // echoed back from the server; parsing it invites timezone and precision
    // differences to read as changes.
    return entry.modifiedDateTime === serverModifiedDateTime;
}
