import EventEmitter = require("events");
import { Disposable } from "vscode";

/**
 * The names of the events that will be used with the internal emitter.
 */
enum EventName {
    /** A server has been added to the list of known servers. */
    ServerAdded = "serverAdded",

    /** A server has been removed from the list of known servers. */
    ServerRemoved = "serverRemoved",

    /** A folder should be refreshed. */
    RefreshFolder = "refreshFolder",

    /** An item in the tree should be (re-)built. */
    BuildUrl = "buildUrl",

    /** A new file should be created in the parent folder. */
    NewFile = "newFile",

    /** A new folder should be created in the parent folder. */
    NewFolder = "newFolder",

    /** An item in the tree should have a new file uploaded to it. */
    UploadUrl = "uploadUrl",

    /** An item in the tree should have a new folder uploaded to it. */
    UploadFolderUrl = "uploadFolderUrl",

    /** An item in the tree should be deleted. */
    DeleteUrl = "deleteUrl",

    /** An identifier should be copied to the clipboard. */
    CopyId = "copyId",

    /** An unique identifier should be copied to the clipboard. */
    CopyGuid = "copyGuid",

    /** A generic value should be copied to the clipboard. */
    CopyValue = "copyValue",

    /** An item should be viewed on the web. */
    RemoteView = "remoteView",

    /** An item should be edited on the web. */
    RemoteEdit = "remoteEdit"
}

/**
 * Custom helper class to handle common event subscription and emitting.
 */
export class Events implements Disposable {
    // #region Private Properties

    /** The intenral emitter for events. */
    private eventEmitter?: EventEmitter = new EventEmitter();

    // #endregion

    // #region Constructors

    /** @inheritdoc */
    public dispose(): void {
        this.eventEmitter = undefined;
    }

    // #endregion

    // #region Functions

    /**
     * Subscribe to the server added event. These callbacks are called
     * when the person adds a new server to the list of known servers.
     *
     * @param listener The callback to be called.
     */
    public onServerAdded(listener: (() => void)): void {
        this.eventEmitter?.on(EventName.ServerAdded, listener);
    }

    /**
     * Subscribe to the server removed event. These callbacks are called
     * when the person removes an existing server to the list of known servers.
     *
     * @param listener The callback to be called.
     */
    public onServerRemoved(listener: (() => void)): void {
        this.eventEmitter?.on(EventName.ServerRemoved, listener);
    }

    /**
     * Subscribe to the refresh folder event. These callbacks are called
     * when the person activites the Refresh command for a folder.
     *
     * @param listener The callback to be called.
     */
    public onRefreshFolder(listener: ((node: ITreeNode) => void)): void {
        this.eventEmitter?.on(EventName.RefreshFolder, listener);
    }

    /**
     * Subscribe to the build URL event. These callbacks are called when
     * the person activates the Build command for a tree node.
     *
     * @param listener The callback to be called.
     */
    public onBuildUrl(listener: ((node: ITreeNode) => void)): void {
        this.eventEmitter?.on(EventName.BuildUrl, listener);
    }

    /**
     * Subscribe to the new file event. These callbacks are called when
     * the person activates the New File command for a tree node.
     *
     * @param listener The callback to be called.
     */
    public onNewFile(listener: ((node: ITreeNode) => void)): void {
        this.eventEmitter?.on(EventName.NewFile, listener);
    }

    /**
     * Subscribe to the new folder event. These callbacks are called when
     * the person activates the New Folder command for a tree node.
     *
     * @param listener The callback to be called.
     */
    public onNewFolder(listener: ((node: ITreeNode) => void)): void {
        this.eventEmitter?.on(EventName.NewFolder, listener);
    }

    /**
     * Subscribe to the upload URL event. These callbacks are called when
     * the person activates the Upload command for a tree node.
     *
     * @param listener The callback to be called.
     */
    public onUploadUrl(listener: ((node: ITreeNode) => void)): void {
        this.eventEmitter?.on(EventName.UploadUrl, listener);
    }

    /**
     * Subscribe to the upload folder URL event. These callbacks are called
     * when the person activates the Upload Folder command for a tree node.
     *
     * @param listener The callback to be called.
     */
     public onUploadFolderUrl(listener: ((node: ITreeNode) => void)): void {
        this.eventEmitter?.on(EventName.UploadFolderUrl, listener);
    }

    /**
     * Subscribe to the delete URL event. These callbacks are called when
     * the person activates the Delete command for a tree node.
     *
     * @param listener The callback to be called.
     */
    public onDeleteUrl(listener: ((node: ITreeNode) => void)): void {
        this.eventEmitter?.on(EventName.DeleteUrl, listener);
    }

    /**
     * Subscribe to the copy id event. These callbacks are called
     * when the person activates the Copy Id command for an item.
     *
     * @param listener The callback to be called.
     */
    public onCopyId(listener: ((node: ITreeNode) => void)): void {
        this.eventEmitter?.on(EventName.CopyId, listener);
    }

    /**
     * Subscribe to the copy guid event. These callbacks are called
     * when the person activates the Copy Guid command for an item.
     *
     * @param listener The callback to be called.
     */
    public onCopyGuid(listener: ((node: ITreeNode) => void)): void {
        this.eventEmitter?.on(EventName.CopyGuid, listener);
    }

    /**
     * Subscribe to the copy value event. These callbacks are called
     * when the person activates the Copy Value command for an item.
     *
     * @param listener The callback to be called.
     */
    public onCopyValue(listener: ((node: ITreeNode) => void)): void {
        this.eventEmitter?.on(EventName.CopyValue, listener);
    }

    /**
     * Subscribe to the remote view event. These callbacks are called
     * when the person activates the View on Web command for an item.
     *
     * @param listener The callback to be called.
     */
    public onRemoteView(listener: ((node: ITreeNode) => void)): void {
        this.eventEmitter?.on(EventName.RemoteView, listener);
    }

    /**
     * Subscribe to the remote edit event. These callbacks are called
     * when the person activates the Edit on Web command for an item.
     *
     * @param listener The callback to be called.
     */
    public onRemoteEdit(listener: ((node: ITreeNode) => void)): void {
        this.eventEmitter?.on(EventName.RemoteEdit, listener);
    }

    /**
     * Emit the server added event. This should be called when a new server
     * is added to the list of known servers.
     */
    public emitServerAdded(): void {
        this.eventEmitter?.emit(EventName.ServerAdded);
    }

    /**
     * Emit the server removed event. This should be called when an existing
     * server is removed from the list of known servers.
     */
    public emitServerRemoved(): void {
        this.eventEmitter?.emit(EventName.ServerRemoved);
    }

    /**
     * Emit the refresh folder event. This should be called when the person
     * activates the Refresh command on a folder.
     *
     * @param node The node that is being refreshed.
     */
    public emitRefreshFolder(node: ITreeNode): void {
        this.eventEmitter?.emit(EventName.RefreshFolder, node);
    }

    /**
     * Emit the build URL event. This should be called when the person
     * activates the Build command on a tree node.
     *
     * @param node The node that should be built.
     */
    public emitBuildUrl(node: ITreeNode): void {
        this.eventEmitter?.emit(EventName.BuildUrl, node);
    }

    /**
     * Emit the new file event. This should be called when the person
     * activates the New File command on a tree node.
     *
     * @param node The parent node that should have a new file created under.
     */
    public emitNewFile(node: ITreeNode): void {
        this.eventEmitter?.emit(EventName.NewFile, node);
    }

    /**
     * Emit the new folder event. This should be called when the person
     * activates the New Folder command on a tree node.
     *
     * @param node The parent node that should have a new folder created under.
     */
    public emitNewFolder(node: ITreeNode): void {
        this.eventEmitter?.emit(EventName.NewFolder, node);
    }

    /**
     * Emit the upload URL event. This should be called when the person
     * activates the Upload command on a tree node.
     *
     * @param node The node that should be built.
     */
    public emitUploadUrl(node: ITreeNode): void {
        this.eventEmitter?.emit(EventName.UploadUrl, node);
    }

    /**
     * Emit the upload folder URL event. This should be called when the
     * person activates the Upload Folder command on a tree node.
     *
     * @param node The node that should be built.
     */
     public emitUploadFolderUrl(node: ITreeNode): void {
        this.eventEmitter?.emit(EventName.UploadFolderUrl, node);
    }

    /**
     * Emit the delete URL event. This should be called when the person
     * activates the Delete command on a tree node.
     *
     * @param node The node that should be built.
     */
    public emitDeleteUrl(node: ITreeNode): void {
        this.eventEmitter?.emit(EventName.DeleteUrl, node);
    }

    /**
     * Emit the copy id event. This should be called when the person
     * activates the Copy Id command on an item.
     *
     * @param node The node whose value should be copied.
     */
    public emitCopyId(node: ITreeNode): void {
        this.eventEmitter?.emit(EventName.CopyId, node);
    }

    /**
     * Emit the copy guid event. This should be called when the person
     * activates the Copy Guid command on an item.
     *
     * @param node The node whose value should be copied.
     */
    public emitCopyGuid(node: ITreeNode): void {
        this.eventEmitter?.emit(EventName.CopyGuid, node);
    }

    /**
     * Emit the copy value event. This should be called when the person
     * activates the Copy Value command on an item.
     *
     * @param node The node whose value should be copied.
     */
    public emitCopyValue(node: ITreeNode): void {
        this.eventEmitter?.emit(EventName.CopyValue, node);
    }

    /**
     * Emit the remote view event. This should be called when the person
     * activates the View on Web command on an item.
     *
     * @param node The node whose value should be copied.
     */
    public emitRemoteView(node: ITreeNode): void {
        this.eventEmitter?.emit(EventName.RemoteView, node);
    }

    /**
     * Emit the remote Edit event. This should be called when the person
     * activates the Edit on Web command on an item.
     *
     * @param node The node whose value should be copied.
     */
    public emitRemoteEdit(node: ITreeNode): void {
        this.eventEmitter?.emit(EventName.RemoteEdit, node);
    }

    // #endregion
}
