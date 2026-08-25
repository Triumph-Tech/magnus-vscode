import { MagnusJson, readMagnusJson } from "./magnusJson";
import { Manifest, readManifest } from "./manifest";

/**
 * What a workspace folder is, as far as local mode is concerned.
 *
 * Its own module so both the SCM manager and the hydrate command can ask the
 * question without importing each other.
 *
 * The state that motivated this: `magnus.json` is committed and `.magnus/` is
 * gitignored, so `git clone` yields a folder that is unmistakably a Magnus
 * workspace and yet has no manifest. Before this existed, the manager saw only
 * "manifest or no manifest" and a clone fell into the same bucket as an
 * unrelated folder, which is why the Source Control panel simply never
 * appeared.
 */
export type WorkspaceLocalState =
    /** Neither file. Not a Magnus workspace. */
    | { kind: "none" }
    /** A manifest exists. The ordinary pulled workspace. */
    | { kind: "hydrated"; manifest: Manifest }
    /** `magnus.json` but no manifest: a clone waiting to be hydrated. */
    | { kind: "needs-hydrate"; magnusJson: MagnusJson }
    /** One of the two files is present but unreadable. */
    | { kind: "broken"; message: string };

/**
 * Classify one workspace folder.
 *
 * Reads the manifest first, because a hydrated workspace is the common case and
 * its state is authoritative: a workspace holds both files once it has been
 * pulled, and there the manifest wins.
 *
 * A manifest present at the wrong version reports `broken` rather than reading
 * as absent. That distinction is the entire diagnosis this work started from:
 * `safeReadManifest` collapsed a deliberate "pull again" error into null, so a
 * refused v1 manifest and a missing manifest produced identical, silent
 * behavior.
 */
export async function classifyWorkspace(root: string): Promise<WorkspaceLocalState> {
    try {
        const manifest = await readManifest(root);
        if (manifest) {
            return { kind: "hydrated", manifest };
        }
    }
    catch (err) {
        return { kind: "broken", message: err instanceof Error ? err.message : String(err) };
    }

    try {
        const magnusJson = await readMagnusJson(root);
        if (magnusJson) {
            return { kind: "needs-hydrate", magnusJson };
        }
    }
    catch (err) {
        return { kind: "broken", message: err instanceof Error ? err.message : String(err) };
    }

    return { kind: "none" };
}
