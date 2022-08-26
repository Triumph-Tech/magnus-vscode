import { Uri } from "vscode";

export { };

declare global {
    export type IItemDescriptor = {
        displayName: string;

        tooltip?: string | null;

        uri?: string | null;

        isFolder: boolean;

        icon?: string | null;

        remoteViewUri?: string | null;

        remoteEditUri?: string | null;

        dropUploadUri?: string | null;
    };

    export type ITreeNode = {
        serverUrl: string;

        resource: Uri;

        itemDescriptor: IItemDescriptor;

        isServer: boolean;
    };
}
