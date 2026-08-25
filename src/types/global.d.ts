import { Uri } from "vscode";

export { };

declare global {
    /**
     * Representation of an item from the Rock server that should be displayed
     * in the tree view.
     */
    export type IItemDescriptor = {
        /** The identifier of this item in Rock. */
        id?: string | null;

        /** The unique identifier of this item in Rock. */
        guid?: string | null;

        /** The name to use in the tree view. */
        displayName: string;

        /** The tooltip text to use in the tree view. */
        tooltip?: string | null;

        /** The unique URI that identifies this item in the tree view. */
        uri?: string | null;

        /** True if this item is a folder with child items. */
        isFolder: boolean;

        /** The icon to display next to the name in the tree view. */
        icon?: string | null;

        /** The icon to display in dark mode next to the name in the tree view. */
        iconDark?: string | null;

        /** True if the default open file action should be disabled. */
        disableOpenFile?: boolean;

        /** The URI to use to view the item in the web browser. */
        remoteViewUri?: string | null;

        /** The URI to use to edit the item in the web browser. */
        remoteEditUri?: string | null;

        /** The URI to use to upload new file items. */
        uploadFileUri?: string | null;

        /** The URI to use to upload a new set of recursive files (and entire folder). */
        uploadFolderUri?: string | null;

        /** The URI to use to request the server add a new (empty) file to a folder. */
        newFileUri?: string | null;

        /** The URI to use to request the server add a new folder to a parent folder. */
        newFolderUri?: string | null;

        /** The URI to use in response to a "Build" action. */
        buildUri?: string | null;

        /** The URI to use in response to a "Delete" action. */
        deleteUri?: string | null;

        /** The value to place in the clipboard in response to the Copy Value action. */
        copyValue?: string | null;
    };

    /**
     * One entry in a flat tree response from the server. Carries every
     * IItemDescriptor field plus a `parentUri` link so the client can
     * reconstruct the hierarchy without walking the tree level-by-level.
     *
     * `parentUri` is null/empty for items that are direct children of the
     * subtree root (the root itself is not included in the response).
     */
    export type IFlatTreeItem = IItemDescriptor & {
        /**
         * URI of the parent folder for this item, or null for items at the
         * subtree root. Used by the client to group siblings and assemble
         * relative paths.
         */
        parentUri?: string | null;

        /**
         * Lowercase hex sha256 of the item's content, present only when the
         * request asked for hashes and the server could read the item. Absent
         * means "not known", never "unchanged".
         */
        hash?: string | null;

        /**
         * When the item's content last changed, ISO 8601 UTC, or absent if the
         * server has no meaningful timestamp for it. Decides where to look;
         * never the answer on its own.
         */
        modifiedDateTime?: string | null;
    };

    /**
     * A flat-tree response, plus whether it is the whole subtree.
     *
     * `complete: false` means the server left something out: a cap, a cycle, or
     * a branch it could not enumerate. Such a response may be used to add and
     * update items, and must NEVER be used to compute deletions, because an
     * omission and a deletion are indistinguishable once it arrives here.
     */
    /**
     * What `GetServer` reports about a Magnus plugin, from 2.4.0 onwards.
     */
    export type IServerInfo = {
        icon?: string | null;

        /**
         * Plugin assembly version, three parts. Absent means a plugin older than
         * 2.4.0, which supports none of the capability contract.
         */
        pluginVersion?: string | null;

        /**
         * Enabled virtual filesystem identifiers, or null when the caller is not
         * entitled to know. Null and empty mean different things: see
         * `classifyRootAccess`.
         */
        enabledVirtualFilesystems?: string[] | null;
    };

    /**
     * The aggregate change token for one subtree, from `GetTreeStamp`.
     */
    export type ITreeStampResult = {
        /** Most recent modification time under the subtree, ISO 8601, or null. */
        stamp?: string | null;

        /** Number of items under the subtree, unfiltered by permissions. */
        itemCount?: number | null;
    };

    export type IFlatTreeResult = {
        items: IFlatTreeItem[];

        complete: boolean;

        /**
         * Server-supplied diagnostic token (`item-cap`, `depth-cap`,
         * `branch-error`). For display and logging only; never branch on it.
         */
        incompleteReason?: string | null;
    };

    export type ITreeNode = {
        serverUrl: string;

        resource: Uri;

        itemDescriptor: IItemDescriptor;

        isServer: boolean;

        /**
         * Tree role hint, populated only by code paths that need it.
         * Optional because upstream's tree provider builds nodes without
         * a tree-level concept; local-mode logic infers role from
         * `isServer` and `itemDescriptor.isFolder` instead.
         */
        kind?: "server" | "group" | "app";

        /**
         * If this item has already been pulled into a local workspace, the
         * absolute path to that workspace. Unset for unpulled items and for
         * server/group nodes.
         */
        pulledWorkspacePath?: string;

        /**
         * Display name of the parent group (e.g. "Mobile Apps", "Pages",
         * "Content Channels"). Used on app nodes to categorize pulled
         * workspaces on disk and in the manifest. Unset for server/group
         * nodes.
         */
        parentGroupName?: string;
    };

    /**
     * Defines the response to a remote action, such as build or delete.
     */
    export interface ActionResponse {
        /** A message to display to the person indicating the result. */
        responseMessage: string;

        /** Will be true if the operation is still running. */
        isAsynchronous: boolean;

        /** True if the action was successful, otherwise false. */
        actionSuccessful: boolean;
    }
}
