import { Api } from "./api";
import { mapWithConcurrency } from "./asyncUtils";
import { shouldSkipDescriptor } from "./contentFilter";
import { disambiguateName, nameForDescriptor } from "./pullHelpers";

/**
 * Default concurrency for `GetTreeItems` calls during recursive enumeration.
 * Tree walks only move metadata (child descriptors, no content bytes) so the
 * server cost per call is much lower than a content GET — we can run more in
 * parallel without strain. `enumerateServerTree` invokes `mapWithConcurrency`
 * recursively, one budget per folder's fanout, so real peak parallelism is
 * already higher than this number on deep trees. Tuning this mainly helps
 * the top level where the widest fanout usually lives.
 */
export const DEFAULT_WALK_CONCURRENCY = 12;

export type ServerTreeItem = {
    naiveRelPath: string;
    descriptor: IItemDescriptor;
};

/**
 * Recursively enumerate every descriptor under `rootDescriptor`, returning
 * `{ naiveRelPath, descriptor }` pairs for both folders and leaves. The root
 * descriptor itself is not emitted; only its descendants.
 *
 * Naming uses `nameForDescriptor` + `disambiguateName` so the on-disk paths
 * line up with what `pullCommand`'s flat-tree fast path produces — fetch and
 * pull MUST agree on relPaths or URI-keyed lookup misses and the user sees
 * phantom "deleted on server" entries.
 *
 * `shouldSkipDescriptor` prunes entire subtrees we never want to materialize
 * (app-level settings/chrome, layouts) so callers don't have to filter.
 *
 * Folders are emitted before their children so callers iterating the result
 * in order can pre-create directories (callers using `mkdir({ recursive: true })`
 * don't depend on this, but it's still useful).
 *
 * Per-sibling-fanout calls run in parallel under `concurrency` (default 12);
 * the result array order across siblings is therefore non-deterministic.
 * Callers that care about order sort by `naiveRelPath`.
 *
 * Used by:
 *   - `magnusSourceControl.fetch()` as the fallback when `GetFlatTree` is not
 *     available, filtering out folders before feeding leaves to its content
 *     worker pool.
 *   - `pullCommand` as the fallback when `GetFlatTree` is not available,
 *     splitting folders/leaves and feeding both to the shared materialize
 *     step that the flat-tree fast path also uses.
 */
export async function enumerateServerTree(
    api: Api,
    serverUrl: string,
    rootDescriptor: IItemDescriptor,
    options?: {
        onFolderWalked?: (count: number) => void;
        concurrency?: number;
    }
): Promise<ServerTreeItem[]> {
    const concurrency = options?.concurrency ?? DEFAULT_WALK_CONCURRENCY;
    const results: ServerTreeItem[] = [];
    let foldersWalked = 0;

    async function walk(descriptor: IItemDescriptor, relativePath: string): Promise<void> {
        // Content filter: prune the same branches pull prunes so fetch never
        // tries to match content we wouldn't have materialized.
        if (relativePath !== "" && shouldSkipDescriptor(descriptor)) {
            return;
        }

        if (descriptor.isFolder) {
            if (!descriptor.uri && relativePath !== "") {
                return;
            }

            // Emit the folder before recursing. Pull uses these to mkdir +
            // record manifest folder entries; fetch ignores them.
            if (relativePath !== "") {
                results.push({ naiveRelPath: relativePath, descriptor });
            }

            const children = await api.getChildItems(serverUrl, descriptor.uri ?? "");
            foldersWalked++;
            options?.onFolderWalked?.(foldersWalked);

            // Dev-console trace of every folder URI we visit, plus a compact
            // summary of its children's URIs (folder vs. leaf). Invisible to
            // normal users (no toast), but gives us a concrete dump of what
            // Rock's tree actually looks like so we can write skip patterns
            // that prune branches whose contents are fully filtered out.
            const childSummary = children.length === 0
                ? "(empty)"
                : children.map(c => `${c.isFolder ? "📁" : "📄"} ${c.uri ?? "(no-uri)"}`).join(" | ");
            console.log(`[Magnus walk] ${descriptor.uri ?? "(root)"} → ${children.length} children: ${childSummary}`);

            // Name assignment is serial so disambiguation is deterministic
            // (parallel assignment could hand the same name to two siblings).
            const usedNames = new Set<string>();
            const namedChildren = children.map(child => {
                const childName = disambiguateName(
                    nameForDescriptor(child.displayName, child.isFolder, child.uri),
                    usedNames
                );
                usedNames.add(childName);
                return { child, childName };
            });

            // Recursive walks are independent so we fan them out.
            await mapWithConcurrency(namedChildren, concurrency, async ({ child, childName }) => {
                const childRel = relativePath ? `${relativePath}/${childName}` : childName;
                await walk(child, childRel);
            });
            return;
        }

        if (!descriptor.uri) {
            return;
        }
        results.push({ naiveRelPath: relativePath, descriptor });
    }

    await walk(rootDescriptor, "");
    return results;
}
