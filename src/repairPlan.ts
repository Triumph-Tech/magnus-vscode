import { Manifest } from "./manifest";
import { extensionFromUri } from "./pullHelpers";

/**
 * Pure migration math for the v1.2.1 file-extension repair, kept out of
 * `repairExtensions.ts` so vitest can import it without dragging in the
 * VS Code API surface. The vscode-wired command in `repairExtensions.ts`
 * delegates here and adds the I/O.
 */

/**
 * Compute what `relPath` should become under the v1.2.1 naming rule, given
 * the recorded server URI. Only the leaf segment changes; folder segments
 * pass through untouched. Returns `relPath` unchanged when the leaf already
 * has an extension (idempotent re-run safety) or when the URI has no
 * extension to lift.
 */
export function migratedRelPath(relPath: string, uri: string): string {
    const lastSlash = relPath.lastIndexOf("/");
    const dir = lastSlash >= 0 ? relPath.slice(0, lastSlash + 1) : "";
    const leaf = lastSlash >= 0 ? relPath.slice(lastSlash + 1) : relPath;
    if (/\.[a-z0-9]+$/i.test(leaf)) {
        return relPath;
    }
    const ext = extensionFromUri(uri);
    return ext ? `${dir}${leaf}.${ext}` : relPath;
}

/**
 * Compute the rename map for a single manifest. Returns old-relPath →
 * new-relPath for every file entry whose leaf would gain an extension under
 * the v1.2.1 naming rule. Skips folders, entries without a URI, and any
 * rename that would collide with an existing manifest key or another
 * planned rename target (defensive — shouldn't happen in practice but the
 * alternative is silent overwrite).
 */
export function planRename(manifest: Manifest): Map<string, string> {
    const out = new Map<string, string>();
    const claimed = new Set<string>(Object.keys(manifest.items));
    for (const [relPath, entry] of Object.entries(manifest.items)) {
        if (entry.isFolder) {
            continue;
        }
        if (!entry.uri) {
            continue;
        }
        const next = migratedRelPath(relPath, entry.uri);
        if (next === relPath) {
            continue;
        }
        if (claimed.has(next) || Array.from(out.values()).includes(next)) {
            continue;
        }
        out.set(relPath, next);
    }
    return out;
}
