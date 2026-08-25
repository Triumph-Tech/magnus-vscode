/**
 * Reading what a server says it can do, and deciding what that means for a
 * pulled workspace.
 *
 * Plugin 2.4.0 is the first version that identifies itself (`GetServer` returns
 * a version and the list of enabled virtual filesystems). Everything here is
 * pure so the three-way distinction below stays pinned by tests, because two of
 * the three outcomes look similar and behave very differently.
 */

/**
 * What a workspace is allowed to do against the server right now.
 *
 *   - `allowed`: the resource type is enabled; behave normally.
 *   - `push-blocked-disabled`: an administrator turned this resource type off.
 *     Local files are left completely alone, remain fully editable and keep
 *     their permissions; only the ability to send them back is withdrawn.
 *   - `unknown`: the server did not say, because the plugin predates capability
 *     reporting or the caller was not authorised to be told. Block nothing on
 *     this basis.
 */
export type RootAccess = "allowed" | "push-blocked-disabled" | "unknown";

export interface IRootAccessInput {
    /**
     * The virtual filesystem identifier this workspace was pulled from, or null
     * if it could not be determined from the manifest.
     */
    filesystemIdentifier: string | null;
    /**
     * The identifiers the server reports as enabled. Null means "not known",
     * which is emphatically not the same as an empty array meaning "known, and
     * nothing is enabled".
     */
    enabledFilesystems: string[] | null | undefined;
}

/**
 * Decide whether a pulled workspace may still push.
 *
 * The null-versus-empty distinction is the whole reason this is a function
 * rather than an `includes` call at the call site. An expired session and a
 * genuinely empty allow-list arrive as different values and must produce
 * different behaviour: collapsing them either blocks a user whose login merely
 * lapsed, or silently permits pushes to a resource type an administrator
 * deliberately turned off.
 */
export function classifyRootAccess(input: IRootAccessInput): RootAccess {
    const { filesystemIdentifier, enabledFilesystems } = input;

    if (enabledFilesystems === null || enabledFilesystems === undefined) {
        return "unknown";
    }

    if (!filesystemIdentifier) {
        // The server told us what is enabled, but we cannot tell which of those
        // this workspace is. Guessing in the blocking direction would strand a
        // legitimate workspace, so treat our own ignorance as unknown.
        return "unknown";
    }

    return enabledFilesystems.includes(filesystemIdentifier)
        ? "allowed"
        : "push-blocked-disabled";
}

/**
 * Pulls the virtual filesystem identifier out of a root's server URI.
 *
 * Root URIs are `GetTreeItems` URIs, so the identifier is the segment straight
 * after that marker: `/api/TriumphTech/Magnus/GetTreeItems/mobileapps/app/5`
 * yields `mobileapps`.
 *
 * Deliberately does not accept a `FileContent` URI. Those carry `block-handler`
 * in the same position for block content, which is not a virtual filesystem at
 * all, and treating it as one would compare it against the enabled list and
 * conclude the workspace was disabled.
 */
export function extractFilesystemIdentifier(rootUri: string | null | undefined): string | null {
    if (!rootUri) {
        return null;
    }

    const marker = "/GetTreeItems/";
    const index = rootUri.indexOf(marker);

    if (index < 0) {
        return null;
    }

    const remainder = rootUri.substring(index + marker.length);
    const identifier = remainder.split("/")[0];

    return identifier ? identifier : null;
}
