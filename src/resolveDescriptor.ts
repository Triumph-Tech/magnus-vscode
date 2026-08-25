/**
 * Find the server descriptors for a set of resource roots.
 *
 * Hydration needs this because `magnus.json` records only a selection: a URI, a
 * display name, a path prefix. Pull never had the problem, because the user
 * right-clicked a tree node and the node carried its own descriptor with every
 * action URI on it.
 *
 * The obvious shortcut does not work. Asking `GetFlatTree` for a root returns
 * that root's *contents*, and the plugin excludes the root itself from the
 * response on purpose ("The subtree root itself is not included", per its wire
 * contract). So the descriptor has to be found the way the tree finds it: by
 * walking down from the one URL the client is allowed to hardcode.
 */

import { Api } from "./api";

/** Fetch one folder's children. Injected so this module is testable. */
export type FetchChildren = (uri: string | undefined) => Promise<IItemDescriptor[]>;

/**
 * How deep to search before giving up.
 *
 * Resource roots are shallow: root, then a grouping like "Mobile Apps", then
 * the resource. Four levels is generous. The cap exists so a server with an
 * unexpected tree shape costs a bounded number of round trips rather than an
 * unbounded walk during what should be a quick operation.
 */
const MAX_DEPTH = 4;

/**
 * Resolve descriptors for several target URIs in a single breadth-first walk.
 *
 * Batched deliberately: hydrating a workspace with six resources should not
 * walk the tree six times. Returns a map keyed by the target URI, omitting any
 * that were not found.
 */
export async function resolveRootDescriptors(
    fetchChildren: FetchChildren,
    targetUris: string[]
): Promise<Map<string, IItemDescriptor>> {
    const wanted = new Set(targetUris.filter(u => u && u.trim() !== ""));
    const found = new Map<string, IItemDescriptor>();

    if (wanted.size === 0) {
        return found;
    }

    // `undefined` means "the tree root", the single hardcoded URL.
    let frontier: Array<string | undefined> = [undefined];
    const visited = new Set<string>();

    for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0 && found.size < wanted.size; depth++) {
        const next: Array<string | undefined> = [];

        for (const parent of frontier) {
            let children: IItemDescriptor[];
            try {
                children = await fetchChildren(parent);
            }
            catch {
                // A branch the user cannot read is not a reason to abandon the
                // walk; the resource we want may well be under a sibling.
                continue;
            }

            for (const child of children) {
                if (!child.uri || visited.has(child.uri)) {
                    continue;
                }
                visited.add(child.uri);

                if (wanted.has(child.uri)) {
                    found.set(child.uri, child);
                    continue;
                }

                if (child.isFolder) {
                    next.push(child.uri);
                }
            }
        }

        // Search the branches that could contain a target before the ones that
        // cannot. Purely an ordering heuristic over URIs the server gave us:
        // nothing is constructed, and correctness does not depend on it, so a
        // server whose URIs do not nest this way just searches in a less lucky
        // order and still finds everything.
        next.sort((a, b) => score(b, wanted) - score(a, wanted));
        frontier = next;
    }

    return found;
}

function score(uri: string | undefined, wanted: Set<string>): number {
    if (!uri) {
        return 0;
    }
    for (const target of wanted) {
        if (target.startsWith(uri)) {
            return 1;
        }
    }
    return 0;
}

/** Bind the walk to a real `Api` instance. */
export function apiFetchChildren(api: Api, serverUrl: string): FetchChildren {
    return (uri) => api.getChildItems(serverUrl, uri);
}
