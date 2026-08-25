import { createHash } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";

/** The current manifest schema version. */
export const MANIFEST_VERSION = 2;

/** The relative path (POSIX style) to the manifest file within a pulled workspace. */
export const MANIFEST_RELATIVE_PATH = ".magnus/manifest.json";

/**
 * A single entry in the manifest describing either a tracked file or a
 * tracked folder. Files include a hash and last-sync timestamp; folders
 * are purely structural and may carry a displayName for tree reconstruction.
 */
export type ManifestItem = {
    /** The server URI that this item corresponds to. */
    uri: string;

    /** The build URI if the item supports a server-side build action. */
    buildUri?: string | null;

    /** The delete URI if the item supports server-side deletion. */
    deleteUri?: string | null;

    /** True when this item is a folder; false for files. */
    isFolder: boolean;

    /** sha256 of the raw bytes last synced with the server. Required for files. */
    hash?: string;

    /** ISO-8601 timestamp of the last successful sync for this item. */
    lastSyncedAt?: string;

    /**
     * The server's own modified time for this item as of the last sync, when
     * the handler supplied one.
     *
     * Distinct from `lastSyncedAt`, which is when *we* looked. This is when the
     * *server* last changed the content, and it exists so a later scan can tell
     * "unchanged" from "changed" without reading content on either side.
     *
     * Absent means the handler does not report one, which is treated as "must
     * check properly" rather than "unchanged".
     */
    modifiedDateTime?: string;

    /** Original server display name, preserved for folders. */
    displayName?: string;
};

/**
 * The shape persisted to disk at `.magnus/manifest.json` in every pulled workspace.
 * Items are keyed by their POSIX-style local path relative to the workspace root;
 * folder keys end with a trailing slash.
 */
/**
 * One pulled resource inside a workspace.
 *
 * A workspace is a server, not a resource type (spec 7.3), so a single
 * workspace can hold a mobile app, two themes and a handful of AI Skills side
 * by side, each rooted at its own path prefix.
 */
export type ManifestRoot = {
    /** Server tree URI this root was pulled from. */
    uri: string;

    displayName: string;

    pulledAt: string;

    /** Display name of the parent group on the server (e.g. "Mobile Apps"). */
    platform?: string;

    /**
     * Server endpoint that triggers a build or deploy for this root, captured
     * from the tree descriptor at pull time so the panel can fire it without
     * walking back to the cloud-mode tree. Null for roots with no build action.
     */
    buildUri?: string | null;

    /**
     * POSIX path prefix, relative to the workspace root, that this root's items
     * live under. Always ends in `/`.
     *
     * This is what lets one workspace hold several roots and still answer "which
     * root does this file belong to", which matters most when a scan fails: only
     * the roots that scanned successfully may have deletions computed for them.
     */
    pathPrefix: string;
};

export type Manifest = {
    version: 2;
    server: {
        url: string;
        alias: string;
    };
    /**
     * Every resource pulled into this workspace. Ordered by when each was added.
     * Never empty in a valid manifest.
     */
    roots: ManifestRoot[];
    /**
     * Tracked items across every root, keyed by POSIX path relative to the
     * workspace root. Deliberately flat rather than nested per root: every
     * lookup in the sync engine is by path, and nesting would mean resolving the
     * root first on every one of them.
     */
    items: Record<string, ManifestItem>;
};

/**
 * Find the root a workspace-relative path belongs to, or null if none claims it.
 *
 * Matches the longest prefix, so a root nested inside another root's directory
 * still wins for its own files.
 */
export function rootForPath(manifest: Manifest, relPath: string): ManifestRoot | null {
    let best: ManifestRoot | null = null;

    for (const root of manifest.roots) {
        if (!relPath.startsWith(root.pathPrefix)) {
            continue;
        }
        if (best === null || root.pathPrefix.length > best.pathPrefix.length) {
            best = root;
        }
    }

    return best;
}

/**
 * Normalise a path prefix to the stored form: POSIX separators, no leading
 * slash, exactly one trailing slash.
 */
export function normalizePathPrefix(prefix: string): string {
    const posix = prefix.split("\\").join("/");
    const trimmed = posix.replace(/^\/+/, "").replace(/\/+$/, "");
    return trimmed.length > 0 ? `${trimmed}/` : "";
}

/**
 * Read the manifest for the given workspace root, returning null if none
 * exists. Throws only if the file is present but unreadable or malformed.
 *
 * @param workspaceRoot Absolute path to the pulled workspace root.
 */
export async function readManifest(workspaceRoot: string): Promise<Manifest | null> {
    const manifestPath = path.join(workspaceRoot, ".magnus", "manifest.json");

    let raw: string;
    try {
        raw = await fs.readFile(manifestPath, "utf8");
    }
    catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }
        throw err;
    }

    const parsed = JSON.parse(raw) as Manifest;

    if (parsed.version !== MANIFEST_VERSION) {
        // Deliberately no migration (spec 7.3). Paths on disk are unchanged
        // between v1 and v2, so re-pulling reproduces the same files; only the
        // bookkeeping shape moved. Say that, rather than leaving someone staring
        // at a version number.
        throw new Error(
            `This workspace was pulled by an older version of Magnus (manifest v${parsed.version}, `
            + `this build expects v${MANIFEST_VERSION}). Pull it again to continue; your files on disk `
            + "are unaffected and will come back to the same paths."
        );
    }

    return parsed;
}

/**
 * Atomically write the manifest to disk.
 *
 * @param workspaceRoot Absolute path to the pulled workspace root.
 * @param manifest The manifest to persist.
 */
export async function writeManifest(workspaceRoot: string, manifest: Manifest): Promise<void> {
    const dir = path.join(workspaceRoot, ".magnus");
    await fs.mkdir(dir, { recursive: true });

    const manifestPath = path.join(dir, "manifest.json");
    const tempPath = `${manifestPath}.tmp`;

    await fs.writeFile(tempPath, JSON.stringify(manifest, null, 2), "utf8");
    await fs.rename(tempPath, manifestPath);
}

/**
 * Update the hash and lastSyncedAt for a tracked item. No-op if the path
 * is not tracked or refers to a folder.
 */
export function updateItemHash(manifest: Manifest, localPath: string, hash: string): void {
    const entry = manifest.items[localPath];
    if (!entry || entry.isFolder) {
        return;
    }
    entry.hash = hash;
    entry.lastSyncedAt = new Date().toISOString();
}

/**
 * Compute the sha256 of a byte buffer, formatted as `sha256:<lowercase-hex>`.
 * Hashes are always computed on raw bytes, never on decoded text, to avoid
 * encoding-related spurious drift.
 */
export function hashBytes(bytes: Uint8Array): string {
    const digest = createHash("sha256").update(bytes).digest("hex");
    return `sha256:${digest}`;
}

/**
 * Count the number of tracked files (not folders) in the manifest.
 */
export function countTrackedFiles(manifest: Manifest): number {
    let count = 0;
    for (const key in manifest.items) {
        if (!manifest.items[key].isFolder) {
            count++;
        }
    }
    return count;
}
