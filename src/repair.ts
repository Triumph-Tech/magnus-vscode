import { Manifest } from "./manifest";

/**
 * Deciding which tracked files have unusable bookkeeping (spec 7.7).
 *
 * A file with neither a baseline on disk nor a recorded hash cannot be compared
 * against anything. The panel cannot say whether it changed, and push cannot
 * tell whether the server moved. That is Magnus's bookkeeping problem, not the
 * user's, so it gets repaired eagerly when a workspace opens rather than being
 * surfaced as a question.
 */

export interface IRepairPlanInput {
    manifest: Manifest;
    /** Whether `.magnus/baseline/<relPath>` exists. */
    hasBaseline: (relPath: string) => boolean;
}

/**
 * List the tracked files whose baseline must be reconstructed from the server.
 *
 * Only files with *both* sources missing qualify. A file with a manifest hash
 * but no baseline is recoverable without a round trip if its local content
 * happens to match, which the refresh path already handles lazily; pulling it
 * into the eager pass would mean a network fetch per file on every open.
 *
 * Folders never qualify: there is nothing to hash and nothing to diff.
 */
export function planBaselineRepair(input: IRepairPlanInput): string[] {
    const { manifest, hasBaseline } = input;
    const needsRepair: string[] = [];

    for (const relPath of Object.keys(manifest.items)) {
        const entry = manifest.items[relPath];

        if (entry.isFolder) {
            continue;
        }
        if (entry.hash) {
            continue;
        }
        if (hasBaseline(relPath)) {
            continue;
        }

        needsRepair.push(relPath);
    }

    return needsRepair.sort();
}
