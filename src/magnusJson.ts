import { promises as fs } from "fs";
import * as path from "path";

/**
 * `magnus.json`: the committed record of what a workspace was told to hold.
 *
 * Deliberately outside `.magnus/`, which stays gitignored (spec 7.4). A
 * repository of pulled content is content history, not a syncable clone: nobody
 * clones and syncs from someone else's copy, each person pulls from the server.
 * So the sync state stays local and only the *intent* is committed.
 *
 * It has two jobs. It makes a cloned repository self-describing, and it is the
 * selection a later pull reads back.
 *
 * What it must never carry: hashes, the item list, or anything IdKey-shaped.
 * Committing the manifest while gitignoring baselines was considered and
 * rejected, because that combination manufactures the "manifest present,
 * baseline absent" state, which is precisely the condition the sync classifiers
 * handle worst.
 */

export const MAGNUS_JSON_NAME = "magnus.json";

export const MAGNUS_JSON_SCHEMA_VERSION = 1;

/**
 * One chosen resource.
 *
 * The selection is an explicit list of named resources, never an expression like
 * "all mobile apps". An expression silently changes meaning when somebody adds a
 * resource on the server; a named list changes only when a person edits it, and
 * that shows up in a diff.
 */
export type MagnusSelectionEntry = {
    /** Server tree URI, which is what a re-pull walks. */
    uri: string;

    displayName: string;

    /** Parent group on the server, e.g. "Mobile Apps". */
    platform?: string;

    /** Where this resource lives inside the workspace. Always ends in `/`. */
    pathPrefix: string;
};

export type MagnusJson = {
    schemaVersion: number;

    server: {
        url: string;
        alias: string;
    };

    selection: MagnusSelectionEntry[];

    /** When the selection was last acted on. */
    pulledAt: string;

    /**
     * Versions in play at pull time. This is not the runtime handshake (7.8):
     * it does not stop a mismatch, it makes "which plugin served this content"
     * answerable afterwards, which is the question you actually have when
     * something in the repository looks wrong months later.
     */
    versions: {
        extension: string;
        /** Null when the server was too old to report one. */
        plugin: string | null;
    };
};

/**
 * Read `magnus.json` from a workspace root, or null if there is none.
 *
 * Throws only if the file exists and cannot be parsed, because a corrupt
 * selection is worth stopping for: silently treating it as "no selection" would
 * present an empty dialog and invite the user to rebuild it from scratch.
 */
export async function readMagnusJson(workspaceRoot: string): Promise<MagnusJson | null> {
    const file = path.join(workspaceRoot, MAGNUS_JSON_NAME);

    let raw: string;
    try {
        raw = await fs.readFile(file, "utf8");
    }
    catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }
        throw err;
    }

    const parsed = JSON.parse(raw) as MagnusJson;

    if (!parsed || !Array.isArray(parsed.selection) || !parsed.server?.url) {
        throw new Error(
            `${MAGNUS_JSON_NAME} is present but does not look like a Magnus selection file.`
        );
    }

    return parsed;
}

/**
 * Write `magnus.json`, atomically.
 *
 * Trailing newline and two-space indent because this file is committed and will
 * be diffed by people.
 */
export async function writeMagnusJson(workspaceRoot: string, contents: MagnusJson): Promise<void> {
    const file = path.join(workspaceRoot, MAGNUS_JSON_NAME);
    const temp = `${file}.tmp`;

    await fs.writeFile(temp, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
    await fs.rename(temp, file);
}

/**
 * Make sure a pulled workspace ignores `.magnus/`.
 *
 * The committed/ignored split from 7.4 only works if the ignore half actually
 * happens. Without this, the first `git add .` in a pulled workspace commits
 * every baseline and every staged incoming file, which is both large and
 * exactly the "manifest present" state that makes a clone look syncable when it
 * is not.
 *
 * Appends rather than overwrites, and only when `.magnus` is not already
 * mentioned, because this is a file people edit.
 */
export async function ensureMagnusGitignore(workspaceRoot: string): Promise<void> {
    // A workspace is often not the repository root. Several partner folders can
    // live in one monorepo, each its own Magnus workspace, and the repository
    // root frequently ignores `.magnus/` already. Writing a fresh one-line
    // `.gitignore` into every workspace then litters the repository with
    // redundant files, which is what this check exists to prevent.
    if (await magnusAlreadyIgnored(workspaceRoot)) {
        return;
    }

    const file = path.join(workspaceRoot, ".gitignore");

    const block = [
        "# Magnus local-mode sync state. Content history belongs in this repo;",
        "# sync bookkeeping does not, and a clone is not a syncable workspace.",
        ".magnus/"
    ].join("\n");

    let existing: string | null = null;
    try {
        existing = await fs.readFile(file, "utf8");
    }
    catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
        }
    }

    if (existing === null) {
        await fs.writeFile(file, `${block}\n`, "utf8");
        return;
    }

    if (mentionsMagnus(existing)) {
        return;
    }

    const separator = existing.endsWith("\n") ? "" : "\n";
    await fs.appendFile(file, `${separator}\n${block}\n`, "utf8");
}

/** Whether a `.gitignore` body already ignores `.magnus/`. */
function mentionsMagnus(contents: string): boolean {
    return /^\s*\.magnus\/?\s*$/m.test(contents);
}

/**
 * Whether some `.gitignore` at or above `workspaceRoot` already covers
 * `.magnus/`.
 *
 * Walks up to and including the directory holding `.git`, because that is where
 * a monorepo usually declares this once for every workspace beneath it. Stops
 * there rather than continuing to the filesystem root, since `.gitignore` files
 * outside the repository do not apply to it.
 *
 * Deliberately not `git check-ignore`. That would be authoritative and would
 * also catch `core.excludesFile` and `.git/info/exclude`, but it means shelling
 * out to a binary that may not be present. Reading the files covers the case
 * that actually bites, a monorepo whose root already ignores `.magnus/`, and
 * the cost of missing an exotic case is one redundant `.gitignore` rather than
 * a broken workspace.
 */
async function magnusAlreadyIgnored(workspaceRoot: string): Promise<boolean> {
    let dir = path.resolve(workspaceRoot);

    for (;;) {
        try {
            const contents = await fs.readFile(path.join(dir, ".gitignore"), "utf8");
            if (mentionsMagnus(contents)) {
                return true;
            }
        }
        catch {
            // No `.gitignore` at this level, which is unremarkable.
        }

        // Having just checked the repository root's own rules, stop.
        try {
            await fs.stat(path.join(dir, ".git"));
            return false;
        }
        catch {
            // Not the repository root; keep walking up.
        }

        const parent = path.dirname(dir);
        if (parent === dir) {
            return false;
        }
        dir = parent;
    }
}
