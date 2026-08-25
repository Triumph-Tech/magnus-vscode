import { shouldSkipDescriptor } from "./contentFilter";
import { disambiguateName, nameForDescriptor } from "./pullHelpers";

/**
 * Sentinel used by `assembleFlatTreePaths` for items at the subtree root.
 * The server sends `parentUri: null` (or an empty string) for direct
 * children of the root; we group those under this key. Real URIs always
 * contain a path segment, so an empty string can't collide.
 */
const ROOT_KEY = "";

/**
 * Pure helper that converts a flat-tree response into a `URI -> relativePath`
 * map. The server ships items with a `parentUri` link but never computes
 * on-disk paths — the client owns that derivation so the flat-tree code path
 * and the recursive-walk fallback are guaranteed to produce identical paths
 * (both call `nameForDescriptor` + `disambiguateName`).
 *
 * The map only contains items that survive `shouldSkipDescriptor`. Filtered
 * folders prune their entire subtree, matching the recursive walk's behavior.
 *
 * Sibling ordering within each parent group is preserved from the input,
 * which is required for `disambiguateName` to be deterministic — first sibling
 * with a given name wins it, later duplicates get `(2)`, `(3)`, etc.
 */
export function assembleFlatTreePaths(items: IFlatTreeItem[]): Map<string, string> {
    // Bucket items by their parent URI. Treat null/undefined/empty-string
    // (C# default) all as "direct child of the subtree root".
    const byParent = new Map<string, IFlatTreeItem[]>();
    for (const item of items) {
        const key = item.parentUri ?? ROOT_KEY;
        const list = byParent.get(key) ?? [];
        list.push(item);
        byParent.set(key, list);
    }

    const uriToPath = new Map<string, string>();

    const processGroup = (parentUriKey: string, parentPath: string): void => {
        const siblings = byParent.get(parentUriKey) ?? [];
        const usedNames = new Set<string>();
        for (const item of siblings) {
            if (!item.uri) {
                continue;
            }
            if (shouldSkipDescriptor(item)) {
                // Drop this item AND anything that claimed it as a parent — the
                // entire pruned subtree is invisible to the rest of the pipeline.
                continue;
            }
            const name = disambiguateName(
                nameForDescriptor(item.displayName, item.isFolder, item.uri),
                usedNames
            );
            usedNames.add(name);
            const relPath = parentPath ? `${parentPath}/${name}` : name;
            uriToPath.set(item.uri, relPath);
            if (item.isFolder) {
                processGroup(item.uri, relPath);
            }
        }
    };

    processGroup(ROOT_KEY, "");
    return uriToPath;
}

/**
 * Normalise whatever the GetFlatTree endpoint returned into a single shape.
 *
 * Three cases have to be told apart, and conflating any two of them is a
 * data-loss bug rather than a cosmetic one:
 *
 *   1. Plugin 2.4.0+ returns `{ items, complete, incompleteReason }`.
 *   2. Plugin 2.3.x and earlier return a bare array, with no way to say whether
 *      it is the whole subtree.
 *   3. Anything else, including a 200 carrying an HTML error page or a Rock
 *      catch-all route body, means the endpoint is not really there.
 *
 * Case 2 is reported as `complete: false`. Unknown completeness has to be
 * treated as incomplete, because the two possible mistakes are not symmetric:
 * assuming complete deletes files the server still has, while assuming
 * incomplete only withholds deletions until the plugin is upgraded.
 *
 * Case 3 returns null, which callers read as "fall back to the recursive walk".
 */
export function normalizeFlatTreeResponse(data: unknown): IFlatTreeResult | null {
    const envelope = data as IFlatTreeResult | null;

    if (envelope && typeof envelope === "object" && Array.isArray(envelope.items)) {
        const hasSignal = typeof envelope.complete === "boolean";
        return {
            items: envelope.items,
            complete: hasSignal ? envelope.complete : false,
            incompleteReason: hasSignal
                ? envelope.incompleteReason ?? null
                : "no-completeness-signal"
        };
    }

    if (Array.isArray(data)) {
        return {
            items: data as IFlatTreeItem[],
            complete: false,
            incompleteReason: "no-completeness-signal"
        };
    }

    return null;
}
