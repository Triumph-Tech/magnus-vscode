import { Uri } from "vscode";

export { };

declare global {
    export type IItemDescriptor = {
        displayName: string;

        tooltip?: string | null;

        uri: string;

        isFolder: boolean;

        icon: string;

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
