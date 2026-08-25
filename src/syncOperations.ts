import { promises as fs } from "fs";
import * as path from "path";
import { Manifest, hashBytes, writeManifest } from "./manifest";
import { BASELINE_DIR, readBaseline, removeBaseline, writeBaseline } from "./baseline";
import { readIncomingSidecar, writeIncomingSidecar } from "./incomingSidecar";
import { bytesEqual, classifyPushSafety } from "./syncDecisions";
import { toFullUrl } from "./pullHelpers";

/**
 * Suffix used during case-only renames. Renaming "Foo" -> "foo" is a no-op
 * on case-insensitive filesystems (macOS APFS default, Windows NTFS default),
 * so we go through this temp name to force the case change.
 */
const RENAME_TMP_SUFFIX = ".magnus-rename-tmp";

/**
 * Vscode-free orchestration for Magnus Local sync operations. Each function
 * takes an explicit callback for any UI prompt (modal confirmations, "show
 * server version" actions) so the orchestration body can be unit-tested
 * against a real tmp directory without a VS Code host. The class methods in
 * `magnusSourceControl.ts` supply vscode-bound implementations of those
 * callbacks at runtime.
 */

/** On-disk folder, relative to a pulled workspace, where fetched-but-not-applied server bytes live. */
export const INCOMING_DIR = ".magnus/incoming";

export function incomingAbsPath(root: string, relPath: string): string {
    return path.join(root, INCOMING_DIR, relPath);
}

export async function writeIncoming(root: string, relPath: string, bytes: Uint8Array): Promise<void> {
    const abs = incomingAbsPath(root, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
}

export async function readIncoming(root: string, relPath: string): Promise<Uint8Array | null> {
    try {
        return await fs.readFile(incomingAbsPath(root, relPath));
    }
    catch {
        return null;
    }
}

export async function removeIncoming(root: string, relPath: string): Promise<void> {
    try {
        await fs.unlink(incomingAbsPath(root, relPath));
    }
    catch {
        // best-effort; file may already be gone
    }
}

export async function removeIncomingSidecarEntry(root: string, relPath: string): Promise<void> {
    const sidecar = await readIncomingSidecar(root);
    if (sidecar.items[relPath]) {
        delete sidecar.items[relPath];
        await writeIncomingSidecar(root, sidecar);
    }
}

export async function pathExists(p: string): Promise<boolean> {
    try {
        await fs.stat(p);
        return true;
    }
    catch {
        return false;
    }
}

/**
 * Walk upward from `dir`, removing each directory that is empty. Stops at
 * `stopAt` (a root we will never disturb) or the first non-empty parent.
 * Best-effort: any error stops the walk silently.
 *
 * Used after a rename moves the last child out of a folder, so leftover
 * empty `OldName/.../[Main] X/` chains don't clutter the file explorer.
 */
export async function pruneEmptyParents(dir: string, stopAt: string): Promise<void> {
    while (dir !== stopAt && dir.startsWith(stopAt + path.sep)) {
        let entries: string[];
        try {
            entries = await fs.readdir(dir);
        }
        catch {
            return;
        }
        if (entries.length > 0) {
            return;
        }
        try {
            await fs.rmdir(dir);
        }
        catch {
            return;
        }
        dir = path.dirname(dir);
    }
}

export interface IRenameTrackedInput {
    /** Absolute path to the workspace root. */
    root: string;
    /** Existing POSIX-style relPath of the tracked file. Must exist on disk. */
    oldRelPath: string;
    /** Desired POSIX-style relPath. */
    newRelPath: string;
    /**
     * Renames the working file. Production callers pass an implementation
     * backed by `vscode.workspace.fs.rename` so open editor tabs and dirty
     * buffers retarget. Tests pass `fs.promises.rename` (or a fake). Receives
     * absolute paths.
     */
    renameWorkingFile: (oldAbsPath: string, newAbsPath: string) => Promise<void>;
    /**
     * Baseline bytes to land at `newRelPath`. When provided (the production
     * path), the helper writes these bytes to the new baseline location and
     * removes the old one — robust against subtle `fs.rename` quirks on
     * paths with special characters, where Phase 1 saw renames silently land
     * in a half-state. When omitted, falls back to `fs.rename` of the
     * baseline file with ENOENT swallowed (used by older tests).
     */
    baselineBytes?: Uint8Array | null;
}

/**
 * Move a tracked file to a new relPath. Renames the working file via the
 * caller-supplied callback (so VS Code's editor surface retargets) and
 * either re-writes the baseline at the new location (preferred) or moves
 * it via `fs.rename` (legacy fallback). Caller is responsible for mutating
 * the manifest key after this returns successfully.
 *
 * Case-only renames of the working file go through a temporary
 * intermediate so they survive case-insensitive filesystems (macOS APFS
 * default, Windows NTFS default).
 *
 * Throws on rename failure of the working file or on the baseline write
 * (when `baselineBytes` was provided). The legacy ENOENT-swallowing path
 * is kept only when no `baselineBytes` are passed.
 */
export async function renameTracked(input: IRenameTrackedInput): Promise<void> {
    const { root, oldRelPath, newRelPath, renameWorkingFile, baselineBytes } = input;
    if (oldRelPath === newRelPath) {
        return;
    }

    const oldWorking = path.join(root, oldRelPath);
    const newWorking = path.join(root, newRelPath);
    await fs.mkdir(path.dirname(newWorking), { recursive: true });

    const caseOnly = oldRelPath.toLowerCase() === newRelPath.toLowerCase();

    if (caseOnly) {
        const tmp = oldWorking + RENAME_TMP_SUFFIX;
        await renameWorkingFile(oldWorking, tmp);
        try {
            await renameWorkingFile(tmp, newWorking);
        }
        catch (err) {
            try { await renameWorkingFile(tmp, oldWorking); } catch { /* best effort */ }
            throw err;
        }
    }
    else {
        await renameWorkingFile(oldWorking, newWorking);
    }

    if (baselineBytes !== undefined) {
        // Preferred path: caller already read the baseline bytes during
        // their pre-rename clean check, so write them at the new location
        // and remove the old. This dodges whatever `fs.rename` quirk
        // bracketed paths were hitting on macOS APFS in Phase 1 testing.
        if (baselineBytes !== null) {
            await writeBaseline(root, newRelPath, baselineBytes);
            await removeBaseline(root, oldRelPath);
        }
        // Clean up empty parent directories the move left behind. A page
        // rename moves every leaf out of the old page's subtree; without
        // this, the empty `OldPageName/Blocks/[Main] X/` chain lingers in
        // the explorer.
        await pruneEmptyParents(path.dirname(path.join(root, oldRelPath)), root);
        await pruneEmptyParents(path.dirname(path.join(root, BASELINE_DIR, oldRelPath)), path.join(root, BASELINE_DIR));
        return;
    }

    // Legacy fallback (used by tests without explicit baselineBytes):
    // try to move the baseline file with `fs.rename` and swallow ENOENT.
    const oldBaseline = path.join(root, BASELINE_DIR, oldRelPath);
    const newBaseline = path.join(root, BASELINE_DIR, newRelPath);
    await fs.mkdir(path.dirname(newBaseline), { recursive: true });

    try {
        if (caseOnly) {
            const tmp = oldBaseline + RENAME_TMP_SUFFIX;
            await fs.rename(oldBaseline, tmp);
            try {
                await fs.rename(tmp, newBaseline);
            }
            catch (err) {
                try { await fs.rename(tmp, oldBaseline); } catch { /* best effort */ }
                throw err;
            }
        }
        else {
            await fs.rename(oldBaseline, newBaseline);
        }
    }
    catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
        }
    }
}

/**
 * The user's choice from the push-conflict modal.
 *
 *   - `view-server`: open a preview of the server's current bytes; abort the push.
 *   - `force-overwrite`: proceed despite the divergence.
 *   - `cancel`: abort without showing anything.
 */
export type PushConfirmChoice = "view-server" | "force-overwrite" | "cancel";

/** The slice of the Magnus API needed for a push. */
export interface IPushFileApi {
    getFileContent(url: string): Promise<Uint8Array>;
    updateFileContent(url: string, bytes: Uint8Array): Promise<void>;
}

export interface IPushFileInput {
    /** Absolute path to the workspace root. */
    root: string;
    /** Manifest object. Mutated in place: the entry's hash and lastSyncedAt are updated on success. */
    manifest: Manifest;
    /** POSIX-style relative path of the file under `root`. */
    relPath: string;
    api: IPushFileApi;
    /** Invoked when the server moved since last sync. Caller maps the user's modal click to a `PushConfirmChoice`. */
    onConflictPrompt: () => Promise<PushConfirmChoice>;
    /** Invoked when the user picks `view-server` from the conflict prompt. Implementation typically opens a preview document. */
    onShowServerVersion: (serverBytes: Uint8Array) => Promise<void>;
}

/**
 * The outcome of a `performFilePush` call.
 *
 *   - `applied`: server PUT succeeded; manifest, baseline, and incoming
 *     state are all updated. Carries the new manifest hash (= hash of
 *     the bytes that were pushed) and the server bytes seen at the
 *     pre-push divergence check.
 *   - `cancelled`: user clicked Cancel on the conflict modal. No side
 *     effects. The class wrapper should NOT surface this as an error.
 *   - `viewing-server`: user clicked View Server Version on the conflict
 *     modal. `onShowServerVersion` was invoked and the push was aborted.
 *     Like `cancelled`, this is a normal user-driven outcome, not a failure.
 */
export type PushFileOutcome =
    | { kind: "applied"; newLocalHash: string; serverBytesAtCheck: Uint8Array }
    | { kind: "cancelled" }
    | { kind: "viewing-server" };

/**
 * Push one local file's bytes to the server.
 *
 * Order of operations:
 *   1. Validate: must be a tracked non-folder entry, must exist on disk.
 *   2. GET current server bytes for a divergence check.
 *   3. If the server moved since last sync, ask via `onConflictPrompt`.
 *      `view-server` invokes `onShowServerVersion` and returns `viewing-server`;
 *      `cancel` returns `cancelled`; `force-overwrite` proceeds.
 *   4. PUT local bytes.
 *   5. Update manifest hash, manifest lastSyncedAt, on-disk baseline.
 *   6. Clear any stale incoming bytes and sidecar entry for this file.
 *
 * Throws on validation failure (untracked entry, folder, missing local file).
 * Returns a `PushFileOutcome` discriminator otherwise; user cancellation and
 * view-server are normal returns, not exceptions, so the caller can avoid
 * surfacing them as "push failed".
 */
export async function performFilePush(input: IPushFileInput): Promise<PushFileOutcome> {
    const { root, manifest, relPath, api, onConflictPrompt, onShowServerVersion } = input;

    const entry = manifest.items[relPath];
    if (!entry || entry.isFolder) {
        throw new Error(`Not a tracked file: ${relPath}`);
    }

    const absPath = path.join(root, relPath);
    if (!(await pathExists(absPath))) {
        // Missing local is ambiguous (accidental delete? property clear?
        // server-side delete request?). Magnus Local never drives server
        // deletions implicitly — make the user act explicitly.
        throw new Error(
            `${relPath} was deleted locally. Magnus Local doesn't delete server items — use Discard to restore from the last-synced version.`
        );
    }

    const localBytes = await fs.readFile(absPath);
    const fullUrl = toFullUrl(manifest.server.url, entry.uri);

    const serverBytes = await api.getFileContent(fullUrl);
    const serverHash = hashBytes(serverBytes);

    // Prefer the baseline over the manifest hash. The baseline is the actual
    // bytes of the last sync, sitting on disk a few directories away, and push
    // simply never looked at it — so a workspace with a good baseline could
    // still fall through the gate whenever the manifest hash was missing.
    const baselineBytes = await readBaseline(root, relPath);
    const baselineHash = baselineBytes ? hashBytes(baselineBytes) : null;

    const safety = classifyPushSafety({
        currentServerHash: serverHash,
        baselineHash,
        manifestHash: entry.hash
    });

    if (safety === "requires-confirm") {
        const choice = await onConflictPrompt();
        if (choice === "view-server") {
            await onShowServerVersion(serverBytes);
            return { kind: "viewing-server" };
        }
        if (choice !== "force-overwrite") {
            return { kind: "cancelled" };
        }
    }

    await api.updateFileContent(fullUrl, localBytes);

    const newLocalHash = hashBytes(localBytes);
    entry.hash = newLocalHash;
    entry.lastSyncedAt = new Date().toISOString();
    await writeManifest(root, manifest);
    await writeBaseline(root, relPath, localBytes);
    await removeIncoming(root, relPath);
    await removeIncomingSidecarEntry(root, relPath);

    return { kind: "applied", newLocalHash, serverBytesAtCheck: serverBytes };
}

/**
 * The kind of confirmation prompt `performPullFromServer` is asking for.
 * The class wrapper maps each kind to a distinct modal string.
 *
 *   - `accept-deletion`: server deleted the file but the user has uncommitted local edits.
 *   - `overwrite-existing-new`: server marked the file "new" but the path already exists locally.
 *   - `overwrite-conflict-dirty`: standard conflict resolution and local has uncommitted edits.
 */
export type PullConfirmKind =
    | "accept-deletion"
    | "overwrite-existing-new"
    | "overwrite-conflict-dirty";

/**
 * The outcome of a `performPullFromServer` call. `*-applied` means the
 * operation completed and side effects landed; `*-cancelled` means the
 * user declined and nothing changed; `no-server-bytes` means the staged
 * incoming file is missing on disk and the caller should surface an
 * error to the user.
 */
export type PullFromServerOutcome =
    | "deletion-applied"
    | "deletion-cancelled"
    | "new-applied"
    | "new-cancelled"
    | "conflict-applied"
    | "conflict-cancelled"
    | "no-server-bytes";

export interface IPullFromServerInput {
    /** Absolute path to the workspace root. */
    root: string;
    /** Manifest object. Mutated in place: entries may be added, updated, or deleted. */
    manifest: Manifest;
    /** POSIX-style relative path of the file under `root`. */
    relPath: string;
    /** Asks the user for confirmation. Caller maps the `kind` to a vscode modal and returns true if the user accepted. */
    confirm: (kind: PullConfirmKind) => Promise<boolean>;
}

/**
 * Apply a fetched-but-not-merged incoming entry to the working tree.
 *
 * Three branches, dispatched by the sidecar entry shape:
 *   1. `isDeleted`: server removed the file. Confirms with the user (the
 *      sidecar only flags this when local has uncommitted edits, so by
 *      construction the user has work that would be lost). On confirm,
 *      removes the local file, baseline, manifest entry, and sidecar entry.
 *   2. `isNew`: server has a file not yet in the manifest. Confirms only
 *      if the path already exists locally (otherwise the create is unambiguous).
 *      Materializes the file, writes a baseline, adds a manifest entry.
 *   3. Plain conflict: tracked entry whose server bytes diverged. Confirms
 *      only if local is dirty against baseline. Overwrites local with
 *      server bytes, updates baseline and manifest hash.
 *
 * All three branches end with `removeIncoming` + sidecar-entry deletion.
 *
 * Returns a discriminator describing what happened. No side effects on
 * cancellation. Does not throw on user-cancel: returns the matching
 * `*-cancelled` outcome instead.
 */
export async function performPullFromServer(input: IPullFromServerInput): Promise<PullFromServerOutcome> {
    const { root, manifest, relPath, confirm } = input;
    const sidecar = await readIncomingSidecar(root);
    const sidecarEntry = sidecar.items[relPath];
    const absPath = path.join(root, relPath);

    if (sidecarEntry?.isDeleted) {
        const accepted = await confirm("accept-deletion");
        if (!accepted) {
            return "deletion-cancelled";
        }
        try { await fs.unlink(absPath); } catch { /* may already be gone */ }
        await removeBaseline(root, relPath);
        delete manifest.items[relPath];
        await writeManifest(root, manifest);
        delete sidecar.items[relPath];
        await writeIncomingSidecar(root, sidecar);
        await removeIncoming(root, relPath);
        return "deletion-applied";
    }

    const serverBytes = await readIncoming(root, relPath);
    if (serverBytes === null) {
        // The sidecar pointed at incoming bytes that no longer exist on disk
        // (manual cleanup, partial fetch, etc.). Caller surfaces an error so
        // the user can re-run Fetch.
        return "no-server-bytes";
    }

    if (sidecarEntry?.isNew) {
        const localExists = await pathExists(absPath);
        if (localExists) {
            const accepted = await confirm("overwrite-existing-new");
            if (!accepted) {
                return "new-cancelled";
            }
        }
        await fs.mkdir(path.dirname(absPath), { recursive: true });
        await fs.writeFile(absPath, serverBytes);
        await writeBaseline(root, relPath, serverBytes);
        manifest.items[relPath] = {
            uri: sidecarEntry.uri,
            buildUri: sidecarEntry.buildUri ?? null,
            deleteUri: sidecarEntry.deleteUri ?? null,
            isFolder: false,
            hash: hashBytes(serverBytes),
            lastSyncedAt: new Date().toISOString()
        };
        await writeManifest(root, manifest);
        await removeIncoming(root, relPath);
        delete sidecar.items[relPath];
        await writeIncomingSidecar(root, sidecar);
        return "new-applied";
    }

    let localBytes: Uint8Array | null = null;
    try {
        localBytes = await fs.readFile(absPath);
    }
    catch {
        localBytes = null;
    }
    const baselineBytes = await readBaseline(root, relPath);
    const localDirty = localBytes !== null
        && baselineBytes !== null
        && !bytesEqual(localBytes, baselineBytes);

    if (localDirty) {
        const accepted = await confirm("overwrite-conflict-dirty");
        if (!accepted) {
            return "conflict-cancelled";
        }
    }

    await fs.writeFile(absPath, serverBytes);
    await writeBaseline(root, relPath, serverBytes);

    const entry = manifest.items[relPath];
    if (entry) {
        entry.hash = hashBytes(serverBytes);
        entry.lastSyncedAt = new Date().toISOString();
        await writeManifest(root, manifest);
    }

    await removeIncoming(root, relPath);
    delete sidecar.items[relPath];
    await writeIncomingSidecar(root, sidecar);
    return "conflict-applied";
}

/**
 * Rebuild missing baselines from current server content (spec 7.7, work item 18).
 *
 * Writes only inside `.magnus/`. Working files are never touched, which is what
 * makes this safe to run unattended when a workspace opens: the worst case is a
 * wasted request.
 *
 * Baselines are set to **current server content**, deliberately, and this is
 * load-bearing rather than incidental. It makes the resulting SCM diff mean
 * "what I am about to change on the server", which is the only reading that
 * makes reviewing-before-pushing a real safeguard. Seeding from the local file
 * instead would produce an empty diff and quietly assert the two sides already
 * agreed.
 *
 * A file that cannot be fetched is left alone rather than guessed at. It stays
 * unverified in the panel, which is honest, and the next open tries again.
 */
export async function repairMissingBaselines(
    root: string,
    manifest: Manifest,
    api: IPushFileApi,
    relPaths: string[]
): Promise<{ repaired: number; failed: number }> {
    let repaired = 0;
    let failed = 0;

    for (const relPath of relPaths) {
        const entry = manifest.items[relPath];

        if (!entry || entry.isFolder || !entry.uri) {
            continue;
        }

        try {
            const serverBytes = await api.getFileContent(toFullUrl(manifest.server.url, entry.uri));

            await writeBaseline(root, relPath, serverBytes);

            // Recording the hash alongside the baseline is what closes the gap
            // for push: with both present the divergence check has something to
            // compare against, instead of failing closed on every push of a file
            // whose bookkeeping was never the user's fault.
            entry.hash = hashBytes(serverBytes);
            entry.lastSyncedAt = new Date().toISOString();
            repaired++;
        }
        catch {
            failed++;
        }
    }

    return { repaired, failed };
}
