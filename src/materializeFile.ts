import { promises as fs } from "fs";
import * as path from "path";
import { writeBaseline } from "./baseline";

/**
 * Write one file's server bytes to a workspace.
 *
 * Its own module, free of the VS Code API, because this is where local mode's
 * newest safety rule lives and it needs to be testable against a real
 * filesystem rather than only through the concurrent loop that calls it.
 */

/**
 * How a materialization pass is allowed to treat the working tree.
 *
 * `pull` owns the working tree because it just created it, so server bytes go
 * straight to disk. `hydrate` inherits a working tree that arrived by `git
 * clone`, so it may write a baseline for every file but may only create a
 * working file that is absent. Overwriting there would destroy committed work
 * the server has never seen, which is the one thing hydration must never do.
 */
export type MaterializeMode = "pull" | "hydrate";

export type FileOutcome =
    /** The file was absent locally and was written from the server. */
    | "written"
    /** The file was already present and already matched the server. */
    | "unchanged"
    /** The file was present, differed from the server, and was replaced by it. */
    | "replaced";

/**
 * Write `bytes` for `relPath`.
 *
 * **The server is the authority.** Hydration replaces whatever is on disk with
 * the server's version, so a restored workspace is byte-identical to the server
 * and its Source Control panel comes up empty. What changed relative to the
 * repository is then an ordinary `git diff`, and committing that is how the
 * repository catches up.
 *
 * An earlier version of this tried to preserve local content and represent the
 * difference inside Magnus, which inverted the direction of every server-side
 * advance: files the user had never touched appeared as their own outgoing
 * edits, and Push would have overwritten newer server content with a stale
 * clone. Git already models "what changed here" better than a second mechanism
 * layered on top, so the outcome distinctions here exist only to report what
 * happened, never to change what is written.
 *
 * `mode` no longer changes what lands on disk, only what the caller is told.
 * `pull` never reports `replaced`, because it materializes into a directory it
 * has just verified is empty.
 *
 * A baseline is always written, so hydration can never produce the "manifest
 * present, baseline absent" state that `magnusJson.ts` singles out as the one
 * the sync classifiers handle worst.
 */
export async function materializeFile(
    absRoot: string,
    relPath: string,
    bytes: Uint8Array,
    mode: MaterializeMode
): Promise<FileOutcome> {
    const target = path.join(absRoot, relPath);
    const existing = mode === "hydrate" ? await readFileOrNull(target) : null;

    // Defense-in-depth: if the server somehow omits a folder descriptor for an
    // intermediate directory, this still lets the file land.
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    await writeBaseline(absRoot, relPath, bytes);

    if (existing === null) {
        return "written";
    }
    return bytesEqual(existing, bytes) ? "unchanged" : "replaced";
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
}

/**
 * Read a regular file, or null when it is absent.
 *
 * A directory standing where a file belongs reads as absent, so the write
 * proceeds and fails loudly. Quietly adopting it would record a baseline for a
 * file that was never created.
 */
async function readFileOrNull(target: string): Promise<Uint8Array | null> {
    try {
        const stat = await fs.stat(target);
        if (!stat.isFile()) {
            return null;
        }
        return await fs.readFile(target);
    }
    catch {
        return null;
    }
}

