import * as vscode from "vscode";
import { addAlwaysAllowServer, alwaysAllowDestructiveStateKey, buildServerPickItems, buildStatusBarPresentation, findSavedServer, getServerEnvironment, lastUsedServerStateKey, resolveScratchServer, serverEnvironmentsStateKey, ServerEnvironmentMap, setServerEnvironment } from "./bindingDecisions";
import { bindDocument, BindingState, emptyBindingState, getBinding, parseMagnusJson, resolveBinding, ServerEnvironment, unbindDocument } from "./documentBindings";

/** The language identifier of the documents this feature works with. */
export const sqlLanguageId = "sql";

/** The name of the file that names a pulled workspace's server. */
const magnusJsonFileName = "magnus.json";

/** What happened when a document was bound to a server. */
export type DocumentBinding = {
    /** The URI of the document that was bound. */
    documentUri: vscode.Uri;

    /** The URL of the server it was bound to. */
    serverUrl: string;
};

/**
 * Tracks which server each open SQL document runs against, and shows that in the
 * status bar.
 *
 * This is the side effecting shell over {@link documentBindings} and
 * {@link bindingDecisions}: it holds the state, watches the editors, reads
 * `magnus.json` out of the workspace and asks the person to pick a server when
 * nothing else names one. Every rule it follows lives in those two pure modules.
 */
export class BindingManager implements vscode.Disposable {
    // #region Private Properties

    /** The context that identifies our extension instance. */
    private context: vscode.ExtensionContext;

    /** The server each open document is bound to. */
    private bindings: BindingState = emptyBindingState;

    /** The status bar item that shows the binding of the active editor. */
    private statusBarItem: vscode.StatusBarItem;

    /** The documents that currently have a query in flight. */
    private runningDocuments: Set<string> = new Set<string>();

    /** The `magnus.json` binding of each workspace folder, once it has been read. */
    private workspaceBindings: Record<string, string | null> = {};

    /** The emitter used to tell anyone who cares that a document was bound. */
    private didBindDocument: vscode.EventEmitter<DocumentBinding> = new vscode.EventEmitter<DocumentBinding>();

    /** The things we have to let go of when the extension shuts down. */
    private disposables: vscode.Disposable[] = [];

    // #endregion

    // #region Public Properties

    /**
     * Fired every time a document is bound to a server, whether that was the
     * picker, a rebind, a new query editor or an automatic bind from
     * `magnus.json`.
     *
     * Deliberately fired on every bind and not only on the first one for a
     * server. Subscribers that only want the first are better placed to say so,
     * and the alternative is this class keeping a set it has no other use for.
     */
    public readonly onDidBindDocument: vscode.Event<DocumentBinding> = this.didBindDocument.event;

    // #endregion

    // #region Constructors

    /**
     * Creates a new instance of the binding manager.
     *
     * @param context The context that identifies our extension instance.
     */
    public constructor(context: vscode.ExtensionContext) {
        this.context = context;

        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.name = "Magnus SQL";

        this.disposables.push(this.statusBarItem);
        this.disposables.push(vscode.window.onDidChangeActiveTextEditor(() => this.updateStatusBar()));
        this.disposables.push(vscode.workspace.onDidCloseTextDocument(document => this.forget(document)));
        this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.workspaceBindings = {};
        }));

        this.updateStatusBar();
    }

    /** @inheritdoc */
    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }

        this.disposables = [];
        this.didBindDocument.dispose();
    }

    // #endregion

    // #region Private Functions

    /**
     * Forgets the binding of a document that was closed.
     *
     * @param document The document that was closed.
     */
    private forget(document: vscode.TextDocument): void {
        const key = document.uri.toString();

        this.bindings = unbindDocument(this.bindings, key);
        this.runningDocuments.delete(key);

        this.updateStatusBar();
    }

    /**
     * Reads the server URL out of the `magnus.json` at the root of a document's
     * workspace folder.
     *
     * Only the root is looked at. A deep search would make every run command
     * wait on the file system, and a pulled workspace always has the file at its
     * root by definition.
     *
     * @param documentUri The URI of the document.
     *
     * @returns The URL of the workspace's server, or null when there is none.
     */
    private async readWorkspaceServer(documentUri: vscode.Uri): Promise<string | null> {
        const folder = vscode.workspace.getWorkspaceFolder(documentUri);

        if (!folder) {
            return null;
        }

        const folderKey = folder.uri.toString();
        const cached = this.workspaceBindings[folderKey];

        if (cached !== undefined) {
            return cached;
        }

        let serverUrl: string | null = null;

        try {
            const fileUri = vscode.Uri.joinPath(folder.uri, magnusJsonFileName);
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            const parsed = parseMagnusJson(Buffer.from(bytes).toString("utf8"));

            serverUrl = parsed?.serverUrl ?? null;
        }
        catch {
            // No `magnus.json`, or one we cannot read. Either way the document
            // falls back to the picker rather than failing.
            serverUrl = null;
        }

        this.workspaceBindings[folderKey] = serverUrl;

        return serverUrl;
    }

    // #endregion

    // #region Public Functions

    /**
     * Gets the URLs of the saved Magnus servers.
     *
     * This is the same list the tree view and the Add Server command work with,
     * so there is no second notion of which servers exist.
     *
     * @returns The URLs of the saved servers.
     */
    public getSavedServers(): string[] {
        return this.context.globalState.get<string[]>("KnownServers", []);
    }

    /**
     * Gets the environment tag of each server.
     *
     * @returns The tags, keyed by normalized server URL.
     */
    public getServerEnvironments(): ServerEnvironmentMap {
        return this.context.globalState.get<ServerEnvironmentMap>(serverEnvironmentsStateKey, {});
    }

    /**
     * Gets the environment a server is tagged with.
     *
     * @param serverUrl The URL of the server.
     *
     * @returns The tag, or undefined when the server is untagged.
     */
    public getEnvironment(serverUrl: string): ServerEnvironment {
        return getServerEnvironment(this.getServerEnvironments(), serverUrl);
    }

    /**
     * Records the environment a server is tagged with.
     *
     * @param serverUrl The URL of the server.
     * @param environment The tag to apply, or undefined to remove the tag.
     */
    public async setEnvironment(serverUrl: string, environment: ServerEnvironment): Promise<void> {
        const next = setServerEnvironment(this.getServerEnvironments(), serverUrl, environment);

        await this.context.globalState.update(serverEnvironmentsStateKey, next);

        this.updateStatusBar();
    }

    /**
     * Gets the servers that no longer prompt before a destructive statement runs.
     *
     * @returns The URLs of those servers.
     */
    public getAlwaysAllowServers(): string[] {
        return this.context.globalState.get<string[]>(alwaysAllowDestructiveStateKey, []);
    }

    /**
     * Stops asking for confirmation before destructive statements run on a
     * server. Only the confirmation dialog itself calls this.
     *
     * @param serverUrl The URL of the server.
     */
    public async addAlwaysAllow(serverUrl: string): Promise<void> {
        const next = addAlwaysAllowServer(this.getAlwaysAllowServers(), serverUrl);

        await this.context.globalState.update(alwaysAllowDestructiveStateKey, next);
    }

    /**
     * Gets the server a scratch query should bind to without asking.
     *
     * @returns The URL of the server, or undefined when the person has to pick.
     */
    public getScratchServer(): string | undefined {
        const lastUsed = this.context.globalState.get<string>(lastUsedServerStateKey);

        return resolveScratchServer(lastUsed, this.getSavedServers());
    }

    /**
     * Binds a document to a server and remembers that server for the next
     * scratch query.
     *
     * @param documentUri The URI of the document.
     * @param serverUrl The URL of the server to bind it to.
     */
    public async bind(documentUri: vscode.Uri, serverUrl: string): Promise<void> {
        this.bindings = bindDocument(this.bindings, documentUri.toString(), serverUrl);

        await this.context.globalState.update(lastUsedServerStateKey, serverUrl);

        this.updateStatusBar();

        this.didBindDocument.fire({ documentUri, serverUrl });
    }

    /**
     * Gets the server a document is bound to, without asking or auto binding.
     *
     * @param documentUri The URI of the document.
     *
     * @returns The URL of the server, or undefined when the document is unbound.
     */
    public getBoundServer(documentUri: vscode.Uri): string | undefined {
        return getBinding(this.bindings, documentUri.toString());
    }

    /**
     * Asks the person which of the saved servers to use.
     *
     * @param title The title of the quick pick.
     *
     * @returns The URL of the chosen server, or undefined if the person cancelled.
     */
    public async pickServer(title: string): Promise<string | undefined> {
        const servers = this.getSavedServers();

        if (servers.length === 0) {
            await vscode.window.showInformationMessage("You don't have any saved Magnus servers.");

            return undefined;
        }

        if (servers.length === 1) {
            return servers[0];
        }

        const picked = await vscode.window.showQuickPick(buildServerPickItems(servers, this.getServerEnvironments()), {
            title,
            placeHolder: "Select a server"
        });

        return picked?.serverUrl;
    }

    /**
     * Works out which server a document runs against, asking the person only
     * when nothing else names one.
     *
     * A document inside a pulled workspace binds to that workspace's server on
     * the spot, which is what makes a committed `queries/*.sql` runnable with no
     * setup on a fresh clone, but only when that server is one of the person's
     * own saved servers. `magnus.json` is a committed file: a repository that
     * named a server nobody here has ever added would otherwise be choosing
     * where someone's SQL goes, so an unknown URL falls through to the picker.
     *
     * @param document The document that is about to run something.
     *
     * @returns The URL of the server, or undefined if the person cancelled the picker.
     */
    public async resolveServer(document: vscode.TextDocument): Promise<string | undefined> {
        const key = document.uri.toString();
        const workspaceServer = await this.readWorkspaceServer(document.uri);
        const resolution = resolveBinding(key, this.bindings, workspaceServer === null ? null : { serverUrl: workspaceServer });

        if (resolution.kind === "bound") {
            return resolution.serverUrl;
        }

        if (resolution.kind === "autoBind") {
            const saved = findSavedServer(this.getSavedServers(), resolution.serverUrl);

            if (saved !== undefined) {
                await this.bind(document.uri, saved);

                return saved;
            }
        }

        const picked = await this.pickServer("Run SQL on");

        if (picked === undefined) {
            return undefined;
        }

        await this.bind(document.uri, picked);

        return picked;
    }

    /**
     * Records whether a document has a query in flight, which the status bar
     * shows as a spinner that cancels on click.
     *
     * @param documentUri The URI of the document.
     * @param isRunning True while the query is in flight.
     */
    public setRunning(documentUri: vscode.Uri, isRunning: boolean): void {
        const key = documentUri.toString();

        if (isRunning) {
            this.runningDocuments.add(key);
        }
        else {
            this.runningDocuments.delete(key);
        }

        this.updateStatusBar();
    }

    /**
     * Determines if a document has a query in flight.
     *
     * @param documentUri The URI of the document.
     *
     * @returns True if a query from this document is running.
     */
    public isRunning(documentUri: vscode.Uri): boolean {
        return this.runningDocuments.has(documentUri.toString());
    }

    /**
     * Brings the status bar item in line with the active editor.
     */
    public updateStatusBar(): void {
        const editor = vscode.window.activeTextEditor;

        if (!editor || editor.document.languageId !== sqlLanguageId) {
            this.statusBarItem.hide();

            return;
        }

        const documentUri = editor.document.uri;
        const serverUrl = this.getBoundServer(documentUri);
        const isRunning = this.isRunning(documentUri);
        const presentation = buildStatusBarPresentation(serverUrl, serverUrl === undefined ? undefined : this.getEnvironment(serverUrl), isRunning);

        if (!presentation) {
            this.statusBarItem.hide();

            return;
        }

        this.statusBarItem.text = presentation.text;
        this.statusBarItem.tooltip = presentation.tooltip;
        this.statusBarItem.backgroundColor = presentation.backgroundColorId === undefined
            ? undefined
            : new vscode.ThemeColor(presentation.backgroundColorId);
        this.statusBarItem.command = isRunning ? "magnus.sql.cancelQuery" : "magnus.sql.rebindDocument";

        this.statusBarItem.show();
    }

    // #endregion
}
