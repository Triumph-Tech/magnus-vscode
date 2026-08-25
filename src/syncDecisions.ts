import { hashBytes } from "./manifest";
import { isEmptyContent } from "./pullHelpers";

/**
 * Pure decision logic for Magnus Local sync operations. Extracted from
 * `magnusSourceControl.ts` so tests can exercise the routing rules without
 * a VS Code host. Every function here takes plain inputs (bytes, hashes,
 * manifest entries) and returns plain outcomes: no disk I/O, no UI calls.
 */

/**
 * Byte-level equality. Sync classifiers compare local against baseline to
 * decide "did the user touch this?" — the answer must depend on raw bytes,
 * not normalized text, so EOL and trailing-whitespace edits register as
 * real changes.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

/**
 * Outcome of classifying one server-side file during fetch.
 *
 *   - `unchanged`: server bytes match the baseline; nothing to do.
 *   - `fast-forward`: server diverged from baseline but local equals baseline,
 *     so we can silently overwrite local + baseline with server bytes.
 *   - `conflict`: both server and local diverged from baseline; stage server
 *     bytes as incoming and let the user pick.
 *   - `new`: server has a file not in the manifest (and it has real content);
 *     stage as incoming with isNew=true.
 *   - `skip-empty`: server has a file not in the manifest, but the bytes are
 *     empty/whitespace-only (Rock returns these for unset block templates,
 *     pre/post wrappers, etc.). Pull-time skips these, so fetch must too,
 *     or every empty endpoint would re-flag as "new" forever.
 */
export type FetchClassification =
    | "unchanged"
    | "fast-forward"
    | "conflict"
    | "new"
    | "skip-empty";

export interface IFetchClassifyInput {
    /** Bytes the server returned for this file. */
    serverBytes: Uint8Array;
    /** Bytes from .magnus/baseline/<relPath>, or null if no baseline on disk. */
    baselineBytes: Uint8Array | null;
    /** Bytes from the local working file, or null if missing on disk. */
    localBytes: Uint8Array | null;
    /**
     * The manifest entry for this file's relPath, or null if the path is not
     * in the manifest. A null entry means "candidate for new".
     */
    manifestEntry: { hash?: string | null } | null;
}

/**
 * Decide what fetch should do with a single file given the four states it
 * can observe (server, baseline, local, manifest). No side effects.
 *
 * Baseline source-of-truth: prefer the on-disk baseline file when present;
 * fall back to the manifest's recorded hash for pre-baseline workspaces.
 * If neither is available (deeply degraded state), every server byte counts
 * as a divergence and we route conservatively to `conflict`.
 */
export function classifyFetchedFile(input: IFetchClassifyInput): FetchClassification {
    const { serverBytes, baselineBytes, localBytes, manifestEntry } = input;

    if (!manifestEntry) {
        return isEmptyContent(serverBytes) ? "skip-empty" : "new";
    }

    const serverHash = hashBytes(serverBytes);
    const baselineHash = baselineBytes
        ? hashBytes(baselineBytes)
        : (manifestEntry.hash ?? null);

    if (baselineHash && serverHash === baselineHash) {
        return "unchanged";
    }

    const localClean = localBytes !== null
        && baselineBytes !== null
        && bytesEqual(localBytes, baselineBytes);

    return localClean ? "fast-forward" : "conflict";
}

/**
 * Outcome of classifying a server-side deletion (a file tracked in the
 * manifest whose URI was not seen during the server walk).
 *
 *   - `auto-delete`: local is clean (missing on disk, or matches baseline);
 *     safe to silently apply the deletion locally.
 *   - `flag-conflict`: local has uncommitted edits or no baseline to verify
 *     against; surface as an `isDeleted` incoming entry and let the user
 *     decide whether to accept the deletion or push their version back.
 */
export type ServerDeleteClassification = "auto-delete" | "flag-conflict";

export interface IServerDeleteClassifyInput {
    /** Bytes from the local working file, or null if missing on disk. */
    localBytes: Uint8Array | null;
    /** Bytes from .magnus/baseline/<relPath>, or null if no baseline on disk. */
    baselineBytes: Uint8Array | null;
}

/**
 * Decide whether a server-side deletion can be applied silently or must
 * be surfaced for user confirmation. No side effects.
 *
 * "Local clean" means one of: the local file is already gone, or the local
 * file matches the baseline. If we have a non-null local file but no
 * baseline at all (legacy workspace), we route conservatively to
 * `flag-conflict` rather than risk deleting work we can't verify.
 */
export function classifyServerDeletion(input: IServerDeleteClassifyInput): ServerDeleteClassification {
    const { localBytes, baselineBytes } = input;
    const localClean = localBytes === null
        || (baselineBytes !== null && bytesEqual(localBytes, baselineBytes));
    return localClean ? "auto-delete" : "flag-conflict";
}

/**
 * Outcome of classifying a tracked file's local state during SCM refresh.
 *
 *   - `unchanged`: local file equals the baseline; not surfaced in any group.
 *   - `modified`: local file differs from the baseline; surfaced in Changes.
 *   - `deleted`: local file is missing on disk; surfaced in Changes as
 *     a deletion.
 *   - `unknown`: the local file exists but there is no baseline to compare
 *     it against, so whether it changed cannot be determined. Surfaced in
 *     Changes as unverified rather than hidden.
 */
export type LocalStateClassification = "unchanged" | "modified" | "deleted" | "unknown";

export interface ILocalStateClassifyInput {
    /** Bytes from the local working file, or null if missing on disk. */
    localBytes: Uint8Array | null;
    /**
     * Bytes from .magnus/baseline/<relPath>, post-backfill if applicable.
     * A null baseline (caller could not resolve one even after backfill)
     * produces `unknown`, not `unchanged`.
     */
    baselineBytes: Uint8Array | null;
}

/**
 * Decide what SCM group (if any) a tracked file belongs to, given its
 * current local-disk and baseline state. No side effects.
 *
 * Caller is responsible for resolving `baselineBytes` (including any
 * on-the-fly backfill from the manifest hash or server). If that resolution
 * fails, pass `null` and the classifier returns `unknown`.
 *
 * `unknown` deliberately does not collapse into either neighbour. Calling it
 * `modified` would nag about a file nobody touched; calling it `unchanged`
 * hides a tracked file with unverifiable content from the panel entirely,
 * which is how it behaved before and is the worse of the two (spec 8.2). The
 * file is real, the user may well have edited it, and the panel is the only
 * place they would find out. Push gates it separately: with no baseline and
 * no manifest hash, `classifyPushSafety` returns `requires-confirm`.
 */
export function classifyLocalState(input: ILocalStateClassifyInput): LocalStateClassification {
    const { localBytes, baselineBytes } = input;
    if (localBytes === null) {
        return "deleted";
    }
    if (baselineBytes === null) {
        return "unknown";
    }
    return bytesEqual(localBytes, baselineBytes) ? "unchanged" : "modified";
}

/**
 * Outcome of checking whether a push needs user confirmation.
 *
 *   - `safe`: the server still holds the bytes we last synced, so the user
 *     is overwriting their own version.
 *   - `requires-confirm`: the server moved since last sync, or we cannot
 *     establish what we last synced. Either way, pushing might overwrite
 *     someone else's edits, so we show the warning modal.
 */
export type PushClassification = "safe" | "requires-confirm";

export interface IPushSafetyInput {
    /** sha256 of the bytes the server holds right now. */
    currentServerHash: string;
    /**
     * sha256 of `.magnus/baseline/<relPath>`, or null when no baseline is on
     * disk. This is the preferred comparand: it is the actual content of the
     * last sync rather than a recorded claim about it.
     */
    baselineHash: string | null | undefined;
    /** The hash recorded in the manifest at last sync, if any. */
    manifestHash: string | null | undefined;
}

/**
 * Decide whether a push must be gated behind the conflict modal.
 *
 * Push is the only operation that writes to the server, so this gate is the
 * last thing standing between an agent's local edit and someone else's work.
 * It therefore **fails closed**: anything other than positive evidence that
 * the server is where we left it returns `requires-confirm`.
 *
 * Order of preference, and why:
 *
 *   1. The baseline hash. `.magnus/baseline/` holds the exact bytes of the
 *      last sync, so hashing them answers "has the server moved" directly.
 *   2. The manifest hash, when no baseline is on disk.
 *   3. Neither: `requires-confirm`.
 *
 * Case 3 previously returned `safe` on the reasoning that a comparison was
 * impossible so the gate was meaningless (spec 8.1). That inverts the gate's
 * purpose. "We cannot tell whether this would destroy someone's work" is the
 * strongest possible reason to ask, not a reason to proceed silently. And the
 * case was largely self-inflicted: push never read the baseline, so a
 * workspace with perfectly good baselines on disk still landed here whenever
 * the manifest hash was missing.
 *
 * A baseline that disagrees with the manifest hash is not treated specially;
 * the baseline wins. That matches `classifyFetchedFile`, which resolves the
 * same two sources in the same order.
 */
export function classifyPushSafety(input: IPushSafetyInput): PushClassification {
    const { currentServerHash, baselineHash, manifestHash } = input;
    const lastSyncedHash = baselineHash || manifestHash;
    if (!lastSyncedHash) {
        return "requires-confirm";
    }
    return currentServerHash === lastSyncedHash ? "safe" : "requires-confirm";
}

/**
 * Outcome of deciding whether a completed server scan may be used to infer
 * deletions.
 *
 *   - `trust`: the scan looks like a real picture of the server.
 *   - `distrust-empty-scan`: the scan produced nothing while the manifest
 *     tracks files, so it is evidence the scan failed, not evidence the
 *     server is empty.
 */
export type DeletionScanVerdict =
    | "trust"
    | "distrust-empty-scan"
    | "distrust-incomplete-scan";

export interface IDeletionScanInput {
    /** Number of files the scan actually produced. */
    scannedFileCount: number;
    /** Number of non-folder items the manifest tracks. */
    trackedFileCount: number;
    /**
     * False when the server reported its response as partial, or could not
     * report either way. Undefined means the caller is not asserting anything,
     * which only happens in tests exercising the other inputs.
     */
    scanComplete?: boolean;
    /**
     * Set once the user has explicitly confirmed an empty result is real.
     * The caller re-scans before honouring this, so proceeding requires two
     * independent empty scans plus consent.
     */
    userConfirmedEmpty?: boolean;
}

/**
 * Decide whether the deletion pass may run against a scan result.
 *
 * The deletion pass treats absence from the scan as proof of server-side
 * deletion, so a scan that is missing things deletes files that still exist.
 * Two distinct ways that happens, and they need different handling:
 *
 *   - `distrust-incomplete-scan`: the server said its answer was partial, or is
 *     too old to say. The items it did return are still good, so the caller
 *     should apply adds and updates and skip only deletions. **Not
 *     user-overridable**: there is nothing for a person to confirm, because
 *     nobody knows what was left out.
 *   - `distrust-empty-scan`: a complete-looking scan produced nothing while the
 *     manifest tracks files. Far more likely a scan that did not work than a
 *     resource genuinely emptied, but the latter does happen, so it is worth
 *     asking about rather than refusing forever.
 *
 * Checked in that order, because "we know something is missing" outranks "we
 * found nothing", and because a user confirmation must never be able to
 * override the first.
 */
export function classifyDeletionScan(input: IDeletionScanInput): DeletionScanVerdict {
    const { scannedFileCount, trackedFileCount, scanComplete, userConfirmedEmpty } = input;

    // Nothing tracked means nothing to lose, and returning a distrust verdict
    // here would nag on every fetch of an empty workspace.
    if (trackedFileCount === 0) {
        return "trust";
    }

    if (scanComplete === false) {
        return "distrust-incomplete-scan";
    }

    if (scannedFileCount === 0 && !userConfirmedEmpty) {
        return "distrust-empty-scan";
    }

    return "trust";
}
