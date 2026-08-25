/**
 * Content filter that narrows what Magnus Local materializes, tracks, and
 * fetches. Rock's Magnus endpoints expose every block setting, page-level
 * scaffolding, app chrome, and layout file as its own endpoint. Most of those
 * are rarely edited and dramatically inflate the per-app file count (~1000+
 * files for a 50-page mobile app).
 *
 * We keep only two categories of content:
 *   - Page metadata (one small text file per page)
 *   - Block content templates (the main Lava/XAML body of each block, NOT the
 *     pre/post wrappers, which every block handler always emits)
 *
 * Two filter types:
 *   - Content URI filter: applied to file-leaf `FileContent/…` URIs. Skipping
 *     means we don't fetch the bytes and don't track the file in the manifest.
 *   - Tree URI filter: applied to folder `GetTreeItems/…` URIs. Skipping
 *     means we don't even recurse into the subtree — cheaper than filtering
 *     each child afterward.
 *
 * Applied during recursive enumeration in `enumerateServerTree`, which both
 * pull and fetch use as their fallback when `GetFlatTree` is unavailable; the
 * flat-tree fast paths apply the same filter via `assembleFlatTreePaths`.
 * Upgrades are
 * self-healing: files tracked in older manifests that now fall outside the
 * filter will be flagged as server-deleted on the next fetch and (when local
 * is clean) auto-removed.
 */

/**
 * File-leaf URIs to skip. Each regex matches the server URI of a file
 * descriptor returned by `GetTreeItems`.
 */
const SKIP_CONTENT_URI_PATTERNS: RegExp[] = [
    // Block pre/post content wrappers (BlockTypeHandlerBase always emits these).
    /\/FileContent\/block-handler\/\d+\/pre-content(?:[./?#]|$)/i,
    /\/FileContent\/block-handler\/\d+\/post-content(?:[./?#]|$)/i,

    // Page-level chrome. Page metadata (…/page-metadata/…) is NOT in this list.
    /\/FileContent\/[^/]+\/page-settings\/\d+\/event-handler\.lava(?:[?#]|$)/i,
    /\/FileContent\/[^/]+\/page-settings\/\d+\/page-styles\.css(?:[?#]|$)/i,

    // App-level chrome XAML endpoints. App CSS styles are intentionally kept
    // (users edit them) and layouts are kept as read-only context.
    /\/FileContent\/[^/]+\/app-settings\/\d+\/flyout-xaml\.lava(?:[?#]|$)/i,
    /\/FileContent\/[^/]+\/app-settings\/\d+\/navigation-bar-xaml\.lava(?:[?#]|$)/i,
    /\/FileContent\/[^/]+\/app-settings\/\d+\/homepage-routing-logic\.lava(?:[?#]|$)/i,
    /\/FileContent\/[^/]+\/app-settings\/\d+\/toast-xaml\.lava(?:[?#]|$)/i,

    // App-level metadata dump (not user-editable content).
    /\/FileContent\/[^/]+\/app-metadata\/\d+\//i
];

/**
 * Folder URIs to prune. Skipping a folder means its entire subtree is never
 * walked — avoids both the tree GET and every descendant's file GET. Empty
 * for now: app-settings needs to be walked for the CSS file, and app-layouts
 * is walked so layout XAML files come through as context.
 */
const SKIP_TREE_URI_PATTERNS: RegExp[] = [];

/** True when the given file-leaf URI should NOT be materialized or tracked. */
export function shouldSkipContentUri(uri: string | undefined | null): boolean {
    if (!uri) {
        return false;
    }
    return SKIP_CONTENT_URI_PATTERNS.some(re => re.test(uri));
}

/** True when the given folder URI should NOT be recursed into. */
export function shouldSkipTreeUri(uri: string | undefined | null): boolean {
    if (!uri) {
        return false;
    }
    return SKIP_TREE_URI_PATTERNS.some(re => re.test(uri));
}

/**
 * Convenience wrapper that dispatches to the right filter based on whether
 * the descriptor represents a folder or a file.
 */
export function shouldSkipDescriptor(descriptor: { uri?: string | null; isFolder?: boolean }): boolean {
    if (!descriptor.uri) {
        return false;
    }
    return descriptor.isFolder
        ? shouldSkipTreeUri(descriptor.uri)
        : shouldSkipContentUri(descriptor.uri);
}
