import { MagnusSelectionEntry } from "./magnusJson";
import { ManifestRoot, normalizePathPrefix } from "./manifest";

/**
 * Pure planning for workspace hydration.
 *
 * Hydration is what a *cloned* repository needs. `magnus.json` is committed and
 * `.magnus/` is not (see the header of `magnusJson.ts`), so `git clone` hands
 * you the content and the intent but none of the sync state.
 *
 * **The server is the authority.** Hydrate rebuilds the sync state and brings
 * the content to match the server, so the restored workspace is byte-identical
 * to it and the Source Control panel comes up empty. What changed relative to
 * the repository is then a `git diff`, and committing that is how the
 * repository catches up. See `materializeFile.ts` for why representing that
 * difference inside Magnus instead was the wrong call.
 *
 * Hydrate never produces the "manifest present, baseline absent" state that
 * `magnusJson.ts` calls out as the one the sync classifiers handle worst,
 * because it writes every baseline as it goes.
 */

/** A selection entry that cannot be hydrated, and why. */
export type RejectedEntry = {
    entry: MagnusSelectionEntry;
    reason: string;
};

export type HydrateScope = {
    /** Entries that will be hydrated, in stable `pathPrefix` order. */
    accepted: MagnusSelectionEntry[];
    /** Entries skipped, each with a human-readable reason. */
    rejected: RejectedEntry[];
};

/**
 * Validate and order a committed selection before any network call.
 *
 * `magnus.json` is hand-editable and diffed by people (that is why it is
 * committed at all), so it can arrive malformed in ways a machine-written
 * manifest never would. Catching that here means a bad entry costs an error
 * message instead of a half-hydrated workspace.
 *
 * Rejects rather than throws, because one unusable entry among six should
 * hydrate the other five and say so. A selection where *every* entry is
 * rejected is the caller's cue to stop.
 */
export function planHydrateScope(selection: MagnusSelectionEntry[]): HydrateScope {
    const accepted: MagnusSelectionEntry[] = [];
    const rejected: RejectedEntry[] = [];
    const seenPrefixes = new Set<string>();

    for (const entry of selection) {
        if (!entry.uri || entry.uri.trim() === "") {
            rejected.push({ entry, reason: "no server URI recorded" });
            continue;
        }

        if (!entry.pathPrefix || entry.pathPrefix.trim() === "") {
            rejected.push({ entry, reason: "no pathPrefix recorded" });
            continue;
        }

        const prefix = normalizePathPrefix(entry.pathPrefix);

        // `normalizePathPrefix` strips leading slashes, so an absolute-looking
        // prefix is already declawed by the time we see it. What it does not
        // strip is `..`, which is the one sequence that genuinely writes
        // outside the workspace. `magnus.json` arrives from whoever last pushed
        // to the repository, so this is a trust boundary and not a typo check.
        if (prefix.split("/").includes("..")) {
            rejected.push({ entry, reason: "pathPrefix escapes the workspace" });
            continue;
        }

        // A prefix of "/" normalizes to the empty string, which would anchor a
        // root at the workspace root itself and put its items in the same key
        // space as `.magnus/`. Pull can never produce this; a hand-edited
        // selection can.
        if (prefix === "") {
            rejected.push({ entry, reason: "pathPrefix resolves to the workspace root" });
            continue;
        }

        // Two roots at one prefix would interleave their items under the same
        // keys, and the second would silently win. Pull keeps prefixes unique
        // by filtering on re-pull; hydrate has to check, because it is reading
        // a file a person may have merged by hand.
        if (seenPrefixes.has(prefix)) {
            rejected.push({ entry, reason: `duplicate pathPrefix "${prefix}"` });
            continue;
        }

        seenPrefixes.add(prefix);
        accepted.push({ ...entry, pathPrefix: prefix });
    }

    accepted.sort((a, b) => a.pathPrefix.localeCompare(b.pathPrefix));
    return { accepted, rejected };
}

/**
 * Build the `ManifestRoot` for one hydrated selection entry.
 *
 * `buildUri` is the one field a clone cannot know. `magnus.json` deliberately
 * carries only the selection, so the deploy endpoint has to be recovered from
 * the server's own tree during hydration; when the server does not surface it,
 * null is recorded and the Deploy button stays hidden rather than pointing at a
 * guessed URL. Never construct it by concatenation (see CLAUDE.md on the
 * descriptor contract).
 */
export function rootForEntry(
    entry: MagnusSelectionEntry,
    hydratedAt: string,
    buildUri: string | null
): ManifestRoot {
    return {
        uri: entry.uri,
        displayName: entry.displayName,
        pulledAt: hydratedAt,
        platform: entry.platform,
        buildUri,
        pathPrefix: normalizePathPrefix(entry.pathPrefix)
    };
}

export type HydrateSummary = {
    /** Files already present and already identical to the server. */
    unchanged: number;
    /** Files present locally that the server's version replaced. */
    replaced: number;
    /** Files absent locally, written from the server. */
    materialized: number;
    /** Roots whose deploy endpoint could not be recovered. */
    rootsMissingBuildUri: string[];
    /**
     * Resources named in `magnus.json` that could not be found on the server.
     *
     * Usually a content type this plugin version does not serve, or a resource
     * this account cannot see. Skipped rather than fatal: the rest of the
     * selection is still worth restoring.
     */
    unresolved: string[];
};

export function emptySummary(): HydrateSummary {
    return {
        unchanged: 0,
        replaced: 0,
        materialized: 0,
        rootsMissingBuildUri: [],
        unresolved: []
    };
}

/** Files whose content on disk is not what the repository last committed. */
export function changedCount(summary: HydrateSummary): number {
    return summary.replaced + summary.materialized;
}

/**
 * One-line result for the completion notification.
 *
 * Leads with what changed on disk, because that is the number the user acts on:
 * it is the size of the `git diff` they are about to review and commit. Files
 * that were already current are reported last, as reassurance rather than as
 * the headline.
 */
export function describeSummary(summary: HydrateSummary): string {
    const parts: string[] = [];

    if (summary.replaced > 0) {
        parts.push(
            summary.replaced === 1
                ? "1 file updated from the server"
                : `${summary.replaced} files updated from the server`
        );
    }

    if (summary.materialized > 0) {
        parts.push(
            summary.materialized === 1
                ? "1 new file added"
                : `${summary.materialized} new files added`
        );
    }

    if (parts.length === 0) {
        return `already up to date with the server (${summary.unchanged} files)`;
    }

    parts.push(`${summary.unchanged} already current`);
    return parts.join(", ");
}
