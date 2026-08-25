import { promises as fs } from "fs";
import * as path from "path";

/**
 * Sidecar file (`.magnus/incoming.json`) that tracks metadata for fetched
 * server files currently staged as "incoming" changes. Keyed by POSIX-style
 * local path relative to the workspace root.
 *
 * Two categories of incoming are surfaced together:
 *   - Conflicts: the file is tracked in `manifest.items` and the server bytes
 *     differ from both the baseline and the user's local edits. The manifest
 *     holds the authoritative metadata; the sidecar entry is mostly a marker
 *     plus timestamp.
 *   - New: the server has a file that is not yet in the manifest. The sidecar
 *     is the only place its server URI lives until the user pulls it.
 */

export const INCOMING_SIDECAR_PATH = ".magnus/incoming.json";

export type IncomingEntry = {
    uri: string;
    buildUri?: string | null;
    deleteUri?: string | null;
    displayName: string;
    fetchedAt: string;
    /** True when the entry is new to the workspace (not in the manifest). */
    isNew: boolean;
    /**
     * True when the server no longer has this file (i.e. the walk did not
     * encounter its URI). Only surfaces here when the local file also has
     * uncommitted edits; clean server-deletes are applied automatically.
     * Mutually exclusive with `isNew`.
     */
    isDeleted?: boolean;
};

export type IncomingSidecar = {
    version: 1;
    items: Record<string, IncomingEntry>;
};

export async function readIncomingSidecar(workspaceRoot: string): Promise<IncomingSidecar> {
    const p = path.join(workspaceRoot, INCOMING_SIDECAR_PATH);
    try {
        const raw = await fs.readFile(p, "utf8");
        const parsed = JSON.parse(raw) as IncomingSidecar;
        if (parsed.version !== 1) {
            return { version: 1, items: {} };
        }
        return parsed;
    }
    catch {
        return { version: 1, items: {} };
    }
}

export async function writeIncomingSidecar(workspaceRoot: string, sidecar: IncomingSidecar): Promise<void> {
    const dir = path.join(workspaceRoot, ".magnus");
    await fs.mkdir(dir, { recursive: true });
    const p = path.join(workspaceRoot, INCOMING_SIDECAR_PATH);
    const tmp = `${p}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(sidecar, null, 2), "utf8");
    await fs.rename(tmp, p);
}
