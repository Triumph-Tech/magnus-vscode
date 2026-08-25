import * as vscode from "vscode";
import { BindingManager } from "./bindingManager";
import { emptyWarmState, forgetWarmedServer, markWarmFinished, markWarmStarted, shouldWarmTables, WarmState } from "./cacheWarming";
import { SqlObjectExplorer } from "./sqlObjectExplorer";

/**
 * Fills the object explorer's table cache in the background the first time a
 * document binds to a server.
 *
 * Table completion and hover read that cache and never fetch, which without
 * this would mean they stayed limited to the static Rock catalog until someone
 * happened to expand the tree. Binding is the earliest moment we know which
 * server a person is working against, so it is where the walk belongs.
 *
 * The walk itself is {@link SqlObjectExplorer.getTables}, the same one Go to
 * Table uses, so there is one implementation of walking and one cache. Nothing
 * here waits on it and nothing here reports a failure: a server that cannot be
 * walked simply leaves completion with the catalog, which is what it had before.
 *
 * Every decision about whether to walk lives in {@link cacheWarming}.
 */
export class TableCacheWarmer implements vscode.Disposable {
    // #region Private Properties

    /** The object explorer, which owns the walk and the cache. */
    private objectExplorer: SqlObjectExplorer;

    /** What has been warmed, or tried, in this session. */
    private warmState: WarmState = emptyWarmState;

    /** The things we have to let go of when the extension shuts down. */
    private disposables: vscode.Disposable[] = [];

    // #endregion

    // #region Constructors

    /**
     * Creates a new instance of the warmer and starts listening for bindings.
     *
     * @param bindings The bindings of the open documents.
     * @param objectExplorer The object explorer, which owns the walk and the cache.
     */
    public constructor(bindings: BindingManager, objectExplorer: SqlObjectExplorer) {
        this.objectExplorer = objectExplorer;

        this.disposables.push(bindings.onDidBindDocument(binding => this.warm(binding.serverUrl)));
        this.disposables.push(objectExplorer.onDidInvalidateServer(serverUrl => this.forget(serverUrl)));

    }

    /** @inheritdoc */
    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }

        this.disposables = [];
    }

    // #endregion

    // #region Private Functions

    /**
     * Forgets that a server was warmed, because the cache the walk filled has
     * just been thrown away.
     *
     * Without this a refresh of a server's subtree would leave the warmer
     * believing it had nothing to do, which permanently cost that server its
     * table completions.
     *
     * @param serverUrl The URL of the server whose cache was invalidated.
     */
    private forget(serverUrl: string): void {
        this.warmState = forgetWarmedServer(this.warmState, serverUrl);
    }

    /**
     * Walks a server's tables into the cache, unless that has already been done
     * or is under way.
     *
     * Deliberately not awaited by its caller: binding a document has to stay
     * instant, and nothing about the editor depends on the walk finishing.
     *
     * @param serverUrl The URL of the server a document just bound to.
     */
    private warm(serverUrl: string): void {
        if (!shouldWarmTables(this.warmState, serverUrl)) {
            return;
        }

        this.warmState = markWarmStarted(this.warmState, serverUrl);

        this.objectExplorer.getTables(serverUrl).then(
            () => {
                this.warmState = markWarmFinished(this.warmState, serverUrl, true);
            },
            () => {
                // Nothing to say. Completion falls back to the static catalog,
                // and the next binding of this server may try again.
                this.warmState = markWarmFinished(this.warmState, serverUrl, false);
            });
    }

    // #endregion
}
