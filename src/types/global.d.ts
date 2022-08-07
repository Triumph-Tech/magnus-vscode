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

        // These three items are not needed, they will be acquired automatically
        // in a HEAD request on the URI when requested by VS Code. This is because
        // it will make these requests even if we don't know the item descriptor.
        // Such as when first opening VS Code when a file is already open.
        contentLength?: number | null; // Not needed
        lastModifiedDateTime?: string | null; // Not needed
        createdDateTime?: string | null; // Not needed
    };

    export type ITreeNode = {
        serverUrl: string;

        resource: Uri;

        itemDescriptor: IItemDescriptor;

        isServer: boolean;
    };
}
