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

        /** The URI to use in response to a "Build" action. */
        buildUri?: string | null;

        /** The URI to use in response to a "Delete" action. */
        deleteUri?: string | null;

        /** The value to place in the clipboard in response to the Copy Value action. */
        copyValue?: string | null;
    };

    export type ITreeNode = {
        serverUrl: string;

        resource: Uri;

        itemDescriptor: IItemDescriptor;

        isServer: boolean;
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
