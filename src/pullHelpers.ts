import * as path from "path";

/**
 * Pure helpers extracted from `pullCommand.ts` so tests can import them
 * without pulling in the VS Code API surface. `pullCommand.ts` re-exports
 * the same names so existing call sites are unaffected.
 */

/**
 * Turn a server URL into a filesystem-safe alias. Hostnames with non-default
 * ports get the port appended so two servers on the same host don't collide.
 */
export function aliasFromUrl(serverUrl: string): string {
    let host: string;
    let port: string | null = null;

    // Simple URL authority extraction — avoids the `vscode.Uri` dep so this
    // module stays pure. Handles `scheme://host[:port]/path` and bare strings.
    let authority = serverUrl;
    const schemeEnd = serverUrl.indexOf("://");
    if (schemeEnd !== -1) {
        const afterScheme = serverUrl.substring(schemeEnd + 3);
        const firstSlash = afterScheme.indexOf("/");
        authority = firstSlash === -1 ? afterScheme : afterScheme.substring(0, firstSlash);
    }
    else {
        const firstSlash = serverUrl.indexOf("/");
        if (firstSlash !== -1) {
            authority = serverUrl.substring(0, firstSlash);
        }
    }

    const colonIdx = authority.lastIndexOf(":");
    if (colonIdx !== -1 && /^\d+$/.test(authority.substring(colonIdx + 1))) {
        host = authority.substring(0, colonIdx);
        port = authority.substring(colonIdx + 1);
    }
    else {
        host = authority;
    }

    const alias = host.replace(/\./g, "-").toLowerCase();
    return port ? `${alias}-${port}` : alias;
}

/** Replace filesystem-unsafe characters in a display name with dashes. */
export function sanitizeForFs(name: string): string {
    return name
        .replace(/[/\\:*?"<>|]/g, "-")
        .replace(/^\.+/, "-")  // no leading dots (avoids hidden files)
        .trim();
}

/**
 * Ensure a sanitized name doesn't collide with a sibling already claimed in
 * this folder. Case-insensitive match — macOS filesystems are typically
 * case-insensitive and `Home` vs `home` would otherwise overwrite.
 */
export function disambiguateName(name: string, used: Set<string>): string {
    const lowerUsed = new Set(Array.from(used).map(n => n.toLowerCase()));
    if (!lowerUsed.has(name.toLowerCase())) {
        return name;
    }

    const ext = path.extname(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    for (let i = 2; i < 1000; i++) {
        const candidate = `${base} (${i})${ext}`;
        if (!lowerUsed.has(candidate.toLowerCase())) {
            console.warn(`Magnus pull: renamed duplicate sibling "${name}" to "${candidate}"`);
            return candidate;
        }
    }
    return name;
}

/**
 * Resolve an `IItemDescriptor.uri` value to a fully qualified HTTP URL. The
 * server may return fully qualified URLs, root-relative paths, or bare
 * `api/…` paths; normalize all three.
 */
export function toFullUrl(serverUrl: string, uri: string): string {
    if (uri.includes("://")) {
        return uri;
    }
    const base = serverUrl.replace(/\/+$/, "");
    if (uri.startsWith("/")) {
        return `${base}${uri}`;
    }
    return `${base}/${uri}`;
}

/** Treat zero-byte and whitespace-only content as "nothing to materialize". */
export function isEmptyContent(bytes: Uint8Array): boolean {
    if (bytes.length === 0) {
        return true;
    }
    return Buffer.from(bytes).toString("utf8").trim().length === 0;
}

/**
 * Compute the on-disk filename for a tree item.
 *
 * Rock's API returns user-friendly `displayName`s without file extensions
 * ("Content", "Metadata", "CSS Styles") but the content URIs *do* carry the
 * extension ("…/content.lava", "…/page-styles.css"). Materializing the
 * displayName as-is leaves VS Code with nothing to language-detect on, so
 * Lava files show as plain text or sniff as HTML. This helper recovers the
 * extension from the URI and appends it to the sanitized displayName.
 *
 * Folders are passed through untouched (their URIs don't carry leaf
 * extensions, and folder names with dots would just be confusing). If
 * displayName already ends in `.something` we trust the server.
 *
 * Pure string-level — no I/O, no VS Code dep.
 */
export function nameForDescriptor(
    displayName: string,
    isFolder: boolean,
    uri: string | undefined | null
): string {
    const base = sanitizeForFs(displayName) || "item";
    if (isFolder) {
        return base;
    }
    if (/\.[a-z0-9]+$/i.test(base)) {
        return base;
    }
    if (!uri) {
        return base;
    }
    const m = extensionFromUri(uri);
    return m ? `${base}.${m}` : base;
}

/**
 * Pull the file extension out of the last path segment of a URI, ignoring
 * any query string or fragment. Returns the lowercased extension without
 * the leading dot, or null if the last segment has no extension.
 *
 * Exposed for the workspace-extension migration which needs to recompute
 * leaf names from the manifest's recorded URIs.
 */
export function extensionFromUri(uri: string): string | null {
    const m = uri.match(/\/[^/?#]+\.([a-z0-9]+)(?:[?#]|$)/i);
    return m ? m[1].toLowerCase() : null;
}

/**
 * Whether a tree-node URI points at the root of a Rock mobile app.
 *
 * Mobile-app roots live at `/mobileapps/app/<id>` in the Magnus API tree.
 * Descendants under the app (page-settings, blocks, layouts, etc.) won't
 * match — neither will other top-level groupings like web pages or
 * content channels.
 */
export function isMobileAppNodeUri(uri: string | undefined | null): boolean {
    if (!uri) {
        return false;
    }
    // After the numeric app id, the URI must end (optionally with a
    // trailing slash, query, or fragment). A slash followed by *more*
    // path means we're on a descendant node, which we don't want to
    // match.
    return /\/mobileapps\/app\/\d+\/?(?:[?#]|$)/i.test(uri);
}

/**
 * Whether a tree-node URI points at the AI Skills collection root.
 *
 * The AI Skills VFS handler exposes a single top-level collection node
 * at `/api/TriumphTech/Magnus/GetTreeItems/aiskills/`. Unlike mobile
 * apps (where each app is its own pull target), AI Skills are pulled
 * as a single collection: every skill the user can edit lands in one
 * workspace, organized into per-skill subfolders.
 *
 * Descendants under the collection (`/aiskills/skill/<id>`, individual
 * tool URIs) won't match — those aren't valid pull targets on their
 * own, only the collection root is.
 */
export function isAISkillsCollectionNodeUri(uri: string | undefined | null): boolean {
    if (!uri) {
        return false;
    }
    // The collection root URI ends with `/aiskills/` (or `/aiskills`)
    // optionally followed by query/fragment. A slash followed by more
    // path puts us on a per-skill or per-tool descendant.
    return /\/GetTreeItems\/aiskills\/?(?:[?#]|$)/i.test(uri);
}

/**
 * Whether a tree-node URI points at the root of a Rock website theme.
 *
 * Theme roots live at `/themes/theme/<ThemeName>` in the Magnus API tree.
 * The VFS root (`/themes/` or `/themes`) and any descendant subfolders
 * inside a theme won't match — only the theme directory itself is a valid
 * pull target. Theme names may contain spaces and other URL-encoded
 * characters; the regex accepts any non-slash characters between
 * `theme/` and the next slash, query, or fragment.
 */
export function isThemeNodeUri(uri: string | undefined | null): boolean {
    if (!uri) {
        return false;
    }
    return /\/themes\/theme\/[^/?#]+\/?(?:[?#]|$)/i.test(uri);
}

/**
 * Whether a tree-node URI points at the Persisted Datasets collection
 * root.
 *
 * The Persisted Datasets VFS handler exposes a single top-level
 * collection node at
 * `/api/TriumphTech/Magnus/GetTreeItems/persisteddatasets/`. Like AI
 * Skills, datasets are pulled as a single collection: every dataset the
 * user can edit lands in one workspace, organized into per-dataset
 * subfolders.
 *
 * Descendants under the collection (`/persisteddatasets/dataset/<id>`,
 * individual file URIs) won't match — only the collection root is a
 * valid pull target.
 */
export function isPersistedDatasetsCollectionNodeUri(uri: string | undefined | null): boolean {
    if (!uri) {
        return false;
    }
    return /\/GetTreeItems\/persisteddatasets\/?(?:[?#]|$)/i.test(uri);
}

/**
 * Whether a tree-node URI points at the Lava Shortcodes collection root.
 *
 * Shortcodes are pulled as a collection, like AI Skills: each one is a small
 * folder of two files, so per-shortcode workspaces would be all overhead.
 * Descendants (`/shortcodes/shortcode/<id>`) are not pull targets on their own.
 */
export function isShortcodesCollectionNodeUri(uri: string | undefined | null): boolean {
    if (!uri) {
        return false;
    }
    return /\/GetTreeItems\/shortcodes\/?(?:[?#]|$)/i.test(uri);
}

/**
 * Whether a tree-node URI points at a Lava application root.
 *
 * Pulled per application rather than as a collection, because each one is a
 * self-contained unit with its own endpoints and blocks. Note the doubled
 * segment: the filesystem identifier is `lavaapplication` and so is the path
 * kind, so a real URI reads `/lavaapplication/lavaapplication/<id>`.
 */
export function isLavaApplicationNodeUri(uri: string | undefined | null): boolean {
    if (!uri) {
        return false;
    }
    return /\/lavaapplication\/lavaapplication\/\d+\/?(?:[?#]|$)/i.test(uri);
}

/**
 * Whether a tree-node URI points at an Apple TV app root.
 *
 * Same shape as mobile apps, one workspace per app.
 */
export function isAppleTvAppNodeUri(uri: string | undefined | null): boolean {
    if (!uri) {
        return false;
    }
    return /\/appletvapps\/app\/\d+\/?(?:[?#]|$)/i.test(uri);
}

/**
 * Whether a tree-node URI is a valid target for "Pull to Local Workspace".
 *
 * Used to scope local-mode entry points (the `canPullLocal_` /
 * `isPulledLocal_` viewItem markers, the pull command's eligibility
 * gate). Currently accepts:
 *   - Mobile app roots (`/mobileapps/app/<id>`) — pull per app
 *   - AI Skills collection root (`/aiskills/`) — pull all skills at once
 *   - Theme roots (`/themes/theme/<ThemeName>`) — pull per theme
 *   - Persisted Datasets collection root (`/persisteddatasets/`) — pull
 *     all datasets at once
 *   - Lava Shortcodes collection root (`/shortcodes/`) — pull all at once
 *   - Lava application roots (`/lavaapplication/lavaapplication/<id>`)
 *   - Apple TV app roots (`/appletvapps/app/<id>`)
 *
 * Deliberately absent: `websites`, which 7.12 treats as its own scoped project
 * because it combines a deep tree with open-ended block coverage, and
 * `serverfs`, which has no local-mode story at all.
 *
 * Other Rock content types don't yet have a local-mode story; add their
 * URI shapes here when the SCM provider, baselines, and pull workflow
 * are confirmed to work for them.
 */
export function isLocalModePullableUri(uri: string | undefined | null): boolean {
    return isMobileAppNodeUri(uri)
        || isAISkillsCollectionNodeUri(uri)
        || isThemeNodeUri(uri)
        || isPersistedDatasetsCollectionNodeUri(uri)
        || isShortcodesCollectionNodeUri(uri)
        || isLavaApplicationNodeUri(uri)
        || isAppleTvAppNodeUri(uri);
}
