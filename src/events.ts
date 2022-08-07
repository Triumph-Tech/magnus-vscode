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
    RefreshFolder = "refreshFolder"
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
    public onRefreshFolder(listener: ((uri: ITreeNode) => void)): void {
        this.eventEmitter?.on(EventName.RefreshFolder, listener);
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

    // #endregion
}
