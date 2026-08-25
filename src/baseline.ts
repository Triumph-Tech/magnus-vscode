import { promises as fs } from "fs";
import * as path from "path";

/**
 * Baseline fs helpers extracted from `baselineContentProvider.ts` so tests can
 * import them without pulling the VS Code API surface. The provider file
 * re-exports the same names so existing call sites are unaffected.
 */

/** On-disk folder, relative to a pulled workspace, where baselines are stored. */
export const BASELINE_DIR = ".magnus/baseline";

/** Write (or overwrite) the baseline copy for a pulled file. */
export async function writeBaseline(workspaceRoot: string, relPath: string, bytes: Uint8Array): Promise<void> {
    const baselinePath = path.join(workspaceRoot, BASELINE_DIR, relPath);
    await fs.mkdir(path.dirname(baselinePath), { recursive: true });
    await fs.writeFile(baselinePath, bytes);
}

/** Read the baseline bytes for a pulled file, or null if absent. */
export async function readBaseline(workspaceRoot: string, relPath: string): Promise<Uint8Array | null> {
    const baselinePath = path.join(workspaceRoot, BASELINE_DIR, relPath);
    try {
        return await fs.readFile(baselinePath);
    }
    catch {
        return null;
    }
}

/** Remove the baseline copy for a pulled file. No-op if it doesn't exist. */
export async function removeBaseline(workspaceRoot: string, relPath: string): Promise<void> {
    try {
        await fs.unlink(path.join(workspaceRoot, BASELINE_DIR, relPath));
    }
    catch {
        // ignore
    }
}
