import * as vscode from "vscode";
import { buildDestructiveConfirmationMessage, destructiveConfirmationDetail, environmentPickItems } from "./bindingDecisions";
import { BindingManager, sqlLanguageId } from "./bindingManager";
import { normalizeServerUrl } from "./nodeCache";
import { effectiveEnvironment, ServerEnvironment } from "./documentBindings";
import { summarizeResultSets } from "./panelProtocol";
import { buildUntitledQueryUri, nextQueryDocumentName, queryDocumentLabel, untitledScheme } from "./queryDocumentNames";
import { buildHistoryPickItems, filterEntries, HistoryEntry, HistoryOutcome, HistoryResultSummary } from "./queryHistory";
import { QueryHistoryStore } from "./queryHistoryStore";
import { QueryRunner } from "./queryRunner";
import { ResultsPanelManager } from "./resultsPanel";
import { buildSelectTopStatement } from "./selectTopQuery";
import { resolveRunTarget, resolveStatementTarget, RunTarget, runNeedsConfirmation, summarizeStatement } from "./runDecisions";
import { SqlApi } from "./sqlApi";
import { isSqlTreeNode, SqlObjectExplorer } from "./sqlObjectExplorer";
import { ObjectExplorerNodeType } from "./types";

/** The button of the production confirmation dialog that runs the statement once. */
const runOnceButton = "Run";

/** The button of the production confirmation dialog that stops asking for this server. */
const alwaysAllowButton = "Always allow on this server";

/** The button of the clear history dialog that goes ahead. */
const clearHistoryButton = "Clear History";

/** The label of the history action that runs the statement again. */
const rerunActionLabel = "Re-run";

/** The label of the history action that opens the statement without running it. */
const openActionLabel = "Open in editor";

/** The label of the history action that copies the statement to the clipboard. */
const copyActionLabel = "Copy statement";

/** The note that replaces the Re-run action when the stored statement is not the whole statement. */
const truncatedRerunNote = "(truncated — open only)";

/** One row of the quick pick that offers what to do with a history entry. */
type HistoryActionItem = vscode.QuickPickItem & {
    /** Which action the row stands for. */
    action: "rerun" | "open" | "copy";
};

/**
 * The argument a CodeLens passes when it runs the statement it sits above.
 */
type RunStatementArgument = {
    /** The URI of the document the lens belongs to, as a string. */
    documentUri: string;

    /** The offset into that document of the first character of the statement. */
    offset: number;
};

/**
 * Registers and responds to the commands that run SQL: creating query editors,
 * running a query, a statement or a selection, cancelling a run, rebinding a
 * document and tagging a server's environment.
 *
 * This is deliberately a second registrar rather than more methods on
 * {@link SqlCommands}: that class owns browsing the object explorer, this one
 * owns executing, and the two have no state in common.
 */
export class SqlRunCommands implements vscode.Disposable {
    // #region Private Properties

    /** The client used to talk to the server's SQL endpoints. */
    private sqlApi: SqlApi;

    /** The bindings of the open documents and the status bar that shows them. */
    private bindings: BindingManager;

    /** The results panels, one per query editor. */
    private panels: ResultsPanelManager;

    /** The object explorer, used for the column names Select Top 1000 needs. */
    private objectExplorer: SqlObjectExplorer;

    /** The recorded runs, which the Query History quick pick shows. */
    private history: QueryHistoryStore;

    /** The runner of each query editor that has run something, keyed by document URI. */
    private runners: Map<string, QueryRunner> = new Map<string, QueryRunner>();

    /**
     * The documents that have a run being set up right now, keyed by document
     * URI.
     *
     * A run is not in flight until {@link QueryRunner.run} has been called, and
     * getting there involves resolving a server and possibly a modal, both of
     * which yield. Without a reservation taken before the first of those awaits,
     * a second `Ctrl+Enter` walks straight past the running check and wipes the
     * first run's grid on its way to being rejected.
     */
    private pendingRuns: Set<string> = new Set<string>();

    /** The number the next query editor of this window is named after. */
    private nextQueryNumber: number = 1;

    /** The things we have to let go of when the extension shuts down. */
    private disposables: vscode.Disposable[] = [];

    // #endregion

    // #region Constructors

    /**
     * Creates a new instance of the run command handler. The commands it
     * registers are owned by the instance, which `extension.ts` puts in the
     * extension's subscriptions.
     *
     * @param sqlApi The client used to talk to the server's SQL endpoints.
     * @param bindings The bindings of the open documents.
     * @param panels The results panels, one per query editor.
     * @param objectExplorer The object explorer, which owns the cached column names.
     * @param history The store of recorded runs.
     */
    public constructor(sqlApi: SqlApi, bindings: BindingManager, panels: ResultsPanelManager, objectExplorer: SqlObjectExplorer, history: QueryHistoryStore) {
        this.sqlApi = sqlApi;
        this.bindings = bindings;
        this.panels = panels;
        this.objectExplorer = objectExplorer;
        this.history = history;

        this.disposables.push(vscode.commands.registerCommand("magnus.sql.newQuery", this.newQuery, this));
        this.disposables.push(vscode.commands.registerCommand("magnus.sql.scratchQuery", this.scratchQuery, this));
        this.disposables.push(vscode.commands.registerCommand("magnus.sql.selectTop1000", this.selectTop1000, this));
        this.disposables.push(vscode.commands.registerCommand("magnus.sql.runQuery", this.runQuery, this));
        this.disposables.push(vscode.commands.registerCommand("magnus.sql.runStatement", this.runStatement, this));
        this.disposables.push(vscode.commands.registerCommand("magnus.sql.cancelQuery", this.cancelQuery, this));
        this.disposables.push(vscode.commands.registerCommand("magnus.sql.rebindDocument", this.rebindDocument, this));
        this.disposables.push(vscode.commands.registerCommand("magnus.sql.setServerEnvironment", this.setServerEnvironment, this));
        this.disposables.push(vscode.commands.registerCommand("magnus.sql.showHistory", this.showHistory, this));
        this.disposables.push(vscode.commands.registerCommand("magnus.sql.clearHistory", this.clearHistory, this));

        this.disposables.push(panels.onDidRequestCancel(documentUri => this.cancelForDocument(documentUri)));
        this.disposables.push(vscode.workspace.onDidCloseTextDocument(document => this.forgetRunner(document.uri.toString())));

    }

    /** @inheritdoc */
    public dispose(): void {
        for (const key of Array.from(this.runners.keys())) {
            this.forgetRunner(key);
        }

        this.pendingRuns.clear();

        for (const disposable of this.disposables) {
            disposable.dispose();
        }

        this.disposables = [];
    }

    // #endregion

    // #region Private Functions

    /**
     * Gets the runner of a query editor, creating it the first time.
     *
     * One runner per editor is what lets one editor's query be cancelled while
     * another editor's keeps going.
     *
     * @param documentUri The URI of the query editor.
     *
     * @returns The runner of that editor.
     */
    private getRunner(documentUri: vscode.Uri): QueryRunner {
        const key = documentUri.toString();
        const existing = this.runners.get(key);

        if (existing) {
            return existing;
        }

        const runner = new QueryRunner(this.sqlApi);

        this.runners.set(key, runner);

        return runner;
    }

    /**
     * Drops the runner of a query editor, cancelling whatever it still has in
     * flight.
     *
     * Closing the tab is the person saying they are done with that query, and a
     * run nobody is going to see the results of should not keep working the
     * server. The cancel is deliberately not awaited: the runner tells the server
     * on its own, and a close handler must not block. Cancelling a runner with
     * nothing in flight is a no-op.
     *
     * @param key The URI of the document, as a string.
     */
    private forgetRunner(key: string): void {
        const runner = this.runners.get(key);

        this.runners.delete(key);

        if (runner) {
            void runner.cancel();
        }
    }

    /**
     * Gets the active editor, if it holds a SQL document.
     *
     * @returns The editor, or undefined when the active editor is something else.
     */
    private getActiveSqlEditor(): vscode.TextEditor | undefined {
        const editor = vscode.window.activeTextEditor;

        if (!editor || editor.document.languageId !== sqlLanguageId) {
            return undefined;
        }

        return editor;
    }

    /**
     * Gets the names of the untitled documents that are already open.
     *
     * @returns One name per open untitled document.
     */
    private getOpenUntitledNames(): string[] {
        return vscode.workspace.textDocuments
            .filter(document => document.uri.scheme === untitledScheme)
            .map(document => queryDocumentLabel(document.uri.path));
    }

    /**
     * Opens a new untitled SQL editor bound to a server.
     *
     * The document is opened by URI rather than by content so that it carries a
     * name of our choosing. An anonymous untitled document takes its tab caption
     * from its first line, which means the tab renames and resizes itself as
     * someone types; `untitled:Query-1.sql` does not. The `.sql` extension is
     * what gives the editor its language mode, and it is set explicitly as well
     * in case the extension is ever not enough.
     *
     * @param serverUrl The URL of the server to bind the editor to.
     * @param initialText The text to put in the editor, if any.
     *
     * @returns The document that was opened.
     */
    private async openBoundQueryEditor(serverUrl: string, initialText?: string): Promise<vscode.TextDocument> {
        const chosen = nextQueryDocumentName(this.nextQueryNumber, this.getOpenUntitledNames());

        this.nextQueryNumber = chosen.nextCounter;

        const uri = vscode.Uri.parse(buildUntitledQueryUri(chosen.name));
        let document = await vscode.workspace.openTextDocument(uri);

        if (document.languageId !== sqlLanguageId) {
            document = await vscode.languages.setTextDocumentLanguage(document, sqlLanguageId);
        }

        await this.bindings.bind(document.uri, serverUrl);

        const editor = await vscode.window.showTextDocument(document);

        if (initialText !== undefined && initialText !== "") {
            await editor.edit(builder => builder.insert(new vscode.Position(0, 0), initialText));
        }

        this.bindings.updateStatusBar();

        return document;
    }

    /**
     * Asks the person to confirm a destructive statement on a server treated as
     * production.
     *
     * @param serverUrl The URL of the bound server.
     *
     * @returns True if the statement may run.
     */
    private async confirmDestructive(serverUrl: string): Promise<boolean> {
        const choice = await vscode.window.showWarningMessage(buildDestructiveConfirmationMessage(serverUrl), {
            modal: true,
            detail: destructiveConfirmationDetail
        }, runOnceButton, alwaysAllowButton);

        if (choice === alwaysAllowButton) {
            await this.bindings.addAlwaysAllow(serverUrl);

            return true;
        }

        return choice === runOnceButton;
    }

    /**
     * Runs some SQL from a document and reports on it in that document's panel.
     *
     * @param document The document the text came from.
     * @param target The text to run and how it was chosen.
     */
    private async execute(document: vscode.TextDocument, target: RunTarget): Promise<void> {
        const key = document.uri.toString();

        if (this.pendingRuns.has(key) || this.getRunner(document.uri).isRunning) {
            await vscode.window.showInformationMessage("A query from this editor is already running. Cancel it first.");

            return;
        }

        this.pendingRuns.add(key);

        try {
            await this.executeReserved(document, target);
        }
        finally {
            this.pendingRuns.delete(key);
        }
    }

    /**
     * Runs some SQL from a document that has already been reserved by
     * {@link execute}.
     *
     * Nothing here checks whether the editor is busy, because the reservation
     * that got us here is what guarantees it is not. That is the point of the
     * split: everything below this line yields at least twice before the run is
     * submitted, and the panel and the status bar must not be touched until the
     * run is a certainty.
     *
     * @param document The document the text came from.
     * @param target The text to run and how it was chosen.
     */
    private async executeReserved(document: vscode.TextDocument, target: RunTarget): Promise<void> {
        const serverUrl = await this.bindings.resolveServer(document);

        if (serverUrl === undefined) {
            return;
        }

        const runner = this.getRunner(document.uri);
        const environment = this.bindings.getEnvironment(serverUrl);

        if (runNeedsConfirmation(target.text, environment, this.bindings.getAlwaysAllowServers(), serverUrl)) {
            if (!await this.confirmDestructive(serverUrl)) {
                return;
            }
        }

        this.panels.startRun(document.uri, serverUrl, summarizeStatement(target.text));
        this.bindings.setRunning(document.uri, true);

        const startedAt = new Date().toISOString();

        const outcome = await runner.run(serverUrl, target.text, {
            onMessages: messages => this.panels.appendMessages(document.uri, messages)
        });

        this.bindings.setRunning(document.uri, false);

        if (outcome.kind === "completed") {
            const durationMs = typeof outcome.progress.duration === "number" && outcome.progress.duration > 0
                ? outcome.progress.duration
                : outcome.durationMs;
            const summary = summarizeResultSets(outcome.progress.resultSets);

            await this.record(serverUrl, target.text, startedAt, durationMs, "success", summary);

            // The grid is filled before the run is completed: the tabs and the
            // row counts come from the result sets, and the duration each footer
            // shows comes from the completion.
            this.panels.showResultSets(document.uri, outcome.progress.resultSets ?? [], target.text);
            this.panels.completeRun(document.uri, "succeeded", durationMs, summary, null);

            return;
        }

        if (outcome.kind === "cancelled") {
            await this.record(serverUrl, target.text, startedAt, outcome.durationMs, "cancelled", null);

            this.panels.completeRun(document.uri, "cancelled", outcome.durationMs, null, null);

            return;
        }

        await this.record(serverUrl, target.text, startedAt, outcome.durationMs, "error", null, outcome.error.message);

        this.panels.completeRun(document.uri, "failed", outcome.durationMs, null, outcome.error.message);

        await vscode.window.showErrorMessage(outcome.error.message);
    }

    /**
     * Records a finished run in the query history.
     *
     * Every outcome is recorded, including a cancellation: what someone tried to
     * run is as useful to get back to as what succeeded, and an error entry is
     * often the one you want most. Only the statement text is kept, never the
     * results.
     *
     * @param serverUrl The URL of the server the statement ran against.
     * @param statementText The statement that ran.
     * @param startedAt The ISO 8601 time the run started.
     * @param durationMs How long the run took.
     * @param outcome How the run ended.
     * @param summary What the run produced, if anything.
     * @param errorMessage The server's error, when the run failed.
     */
    private async record(serverUrl: string, statementText: string, startedAt: string, durationMs: number, outcome: HistoryOutcome, summary: { setCount: number; rowCount: number } | null, errorMessage?: string): Promise<void> {
        const resultSummary: HistoryResultSummary | null = summary === null
            ? null
            : {
                resultSetCount: summary.setCount,
                totalRows: summary.rowCount
            };

        await this.history.record({
            serverUrl,
            statementText,
            startedAt,
            durationMs,
            outcome,
            resultSummary,
            errorSummary: errorMessage
        });
    }

    /**
     * Asks what to do with a history entry and does it.
     *
     * A truncated entry cannot be re-run: the stored text stops mid statement,
     * and running half a statement is either an error or, far worse, a different
     * statement. The action is still listed so that the reason is visible where
     * it is looked for.
     *
     * @param entry The entry that was chosen.
     */
    private async actOnHistoryEntry(entry: HistoryEntry): Promise<void> {
        const actions: HistoryActionItem[] = [
            {
                action: "rerun",
                label: rerunActionLabel,
                description: entry.truncated ? truncatedRerunNote : undefined,
                detail: `Open a query editor bound to ${entry.serverUrl} and run it`
            },
            {
                action: "open",
                label: openActionLabel,
                detail: `Open a query editor bound to ${entry.serverUrl} without running it`
            },
            {
                action: "copy",
                label: copyActionLabel,
                detail: "Copy the statement to the clipboard"
            }
        ];

        const picked = await vscode.window.showQuickPick(actions, {
            title: entry.label,
            placeHolder: "What would you like to do with this statement?"
        });

        if (!picked) {
            return;
        }

        if (picked.action === "copy") {
            await vscode.env.clipboard.writeText(entry.statementText);

            return;
        }

        if (picked.action === "rerun" && entry.truncated) {
            await vscode.window.showInformationMessage(`Only the first part of this statement was kept, so it cannot be re-run. ${openActionLabel} instead and finish it by hand.`);

            return;
        }

        const document = await this.openBoundQueryEditor(entry.serverUrl, entry.statementText);

        if (picked.action === "open") {
            return;
        }

        await this.execute(document, {
            text: document.getText(),
            source: "document"
        });
    }

    /**
     * Cancels the run of one query editor, if it has one.
     *
     * @param documentUri The URI of the query editor.
     */
    private async cancelForDocument(documentUri: vscode.Uri): Promise<void> {
        const runner = this.runners.get(documentUri.toString());

        if (!runner || !runner.isRunning) {
            return;
        }

        await runner.cancel();
    }

    /**
     * Works out which table a Select Top 1000 was asked for.
     *
     * Two callers reach this command: the tree, which passes the table's own
     * node, and the Go to Table quick pick, which has only a server and a name.
     * Both are accepted so that neither has to build a node the other's shape.
     *
     * @param value The argument the command was invoked with, if any.
     *
     * @returns The server and table to query, or undefined when the argument named neither.
     */
    private resolveSelectTopTarget(value: unknown): { serverUrl: string; tableName: string } | undefined {
        const node = value as ITreeNode | undefined;

        if (isSqlTreeNode(node) && node.sql.nodeType === ObjectExplorerNodeType.Table) {
            return {
                serverUrl: node.serverUrl,
                tableName: node.itemDescriptor.displayName
            };
        }

        if (typeof value === "object" && value !== null) {
            const bag = value as Record<string, unknown>;

            if (typeof bag["serverUrl"] === "string" && typeof bag["tableName"] === "string" && bag["tableName"] !== "") {
                return {
                    serverUrl: bag["serverUrl"],
                    tableName: bag["tableName"]
                };
            }
        }

        return undefined;
    }

    /**
     * Narrows the argument a CodeLens passes to a run statement command.
     *
     * @param value The argument the command was invoked with, if any.
     *
     * @returns The argument, or undefined when the command came from a keybinding or the palette.
     */
    private asRunStatementArgument(value: unknown): RunStatementArgument | undefined {
        if (typeof value !== "object" || value === null) {
            return undefined;
        }

        const bag = value as Record<string, unknown>;

        if (typeof bag["documentUri"] !== "string" || typeof bag["offset"] !== "number") {
            return undefined;
        }

        return {
            documentUri: bag["documentUri"],
            offset: bag["offset"]
        };
    }

    // #endregion

    // #region Command Functions

    /**
     * Called when the person wants a new query editor on a particular server.
     *
     * @param node The tree node the command was invoked on, if any.
     */
    private async newQuery(node?: ITreeNode): Promise<void> {
        const serverUrl = node?.serverUrl ?? await this.bindings.pickServer("New Query");

        if (serverUrl === undefined) {
            return;
        }

        await this.openBoundQueryEditor(serverUrl);
    }

    /**
     * Called when the person wants the first thousand rows of a table.
     *
     * The generated statement is opened in a query editor of its own rather than
     * run invisibly, because it is as much a starting point for editing as it is
     * a result: the column list is right there to trim, and the statement is
     * already bound to the right server.
     *
     * @param target The table node the command was invoked on, or the table the Go to Table quick pick chose.
     */
    private async selectTop1000(target?: unknown): Promise<void> {
        const table = this.resolveSelectTopTarget(target);

        if (!table) {
            return;
        }

        const tableName = table.tableName;
        let columns: string[];

        try {
            columns = await vscode.window.withProgress({
                cancellable: false,
                location: vscode.ProgressLocation.Window,
                title: `Reading the columns of ${tableName}`
            }, () => this.objectExplorer.getColumnNames(table.serverUrl, tableName));
        }
        catch (error) {
            await vscode.window.showErrorMessage(error instanceof Error ? error.message : `The columns of ${tableName} could not be read.`);

            return;
        }

        const document = await this.openBoundQueryEditor(table.serverUrl, buildSelectTopStatement(tableName, columns));

        await this.execute(document, {
            text: document.getText(),
            source: "document"
        });
    }

    /**
     * Called when the person wants a scratch query editor without choosing a
     * server first.
     */
    private async scratchQuery(): Promise<void> {
        const serverUrl = this.bindings.getScratchServer() ?? await this.bindings.pickServer("Scratch Query");

        if (serverUrl === undefined) {
            return;
        }

        await this.openBoundQueryEditor(serverUrl);
    }

    /**
     * Called when the person wants to run the selection, or the whole document
     * when nothing is selected.
     */
    private async runQuery(): Promise<void> {
        const editor = this.getActiveSqlEditor();

        if (!editor) {
            return;
        }

        const selectedText = editor.selections
            .map(selection => editor.document.getText(selection))
            .join("\n");

        const target = resolveRunTarget(editor.document.getText(), selectedText);

        if (!target) {
            await vscode.window.showInformationMessage("There is nothing to run in this editor.");

            return;
        }

        await this.execute(editor.document, target);
    }

    /**
     * Called when the person wants to run the statement the cursor is in, or the
     * statement a CodeLens sits above.
     *
     * @param argument The argument a CodeLens passed, if the command came from one.
     */
    private async runStatement(argument?: unknown): Promise<void> {
        const lens = this.asRunStatementArgument(argument);

        if (lens) {
            const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === lens.documentUri);

            if (!document) {
                return;
            }

            const target = resolveStatementTarget(document.getText(), lens.offset);

            if (target) {
                await this.execute(document, target);
            }

            return;
        }

        const editor = this.getActiveSqlEditor();

        if (!editor) {
            return;
        }

        const target = resolveStatementTarget(editor.document.getText(), editor.document.offsetAt(editor.selection.active));

        if (!target) {
            await vscode.window.showInformationMessage("There is nothing to run in this editor.");

            return;
        }

        await this.execute(editor.document, target);
    }

    /**
     * Called when the person wants to stop the query running in the active
     * editor.
     */
    private async cancelQuery(): Promise<void> {
        const editor = this.getActiveSqlEditor();

        if (editor) {
            await this.cancelForDocument(editor.document.uri);

            return;
        }

        // The status bar hides itself for anything but a SQL editor, so getting
        // here means the palette was used with a panel focused. Cancel whatever
        // single query is in flight, and do nothing when there are several.
        const running = [...this.runners.entries()].filter(entry => entry[1].isRunning);

        if (running.length === 1) {
            await running[0][1].cancel();
        }
    }

    /**
     * Called when the person wants the active SQL editor to run against a
     * different server.
     */
    private async rebindDocument(): Promise<void> {
        const editor = this.getActiveSqlEditor();

        if (!editor) {
            return;
        }

        const serverUrl = await this.bindings.pickServer("Run SQL on");

        if (serverUrl === undefined) {
            return;
        }

        await this.bindings.bind(editor.document.uri, serverUrl);
    }

    /**
     * Called when the person wants to find a statement they have run before.
     *
     * Invoked from a server node the list is that server's runs only, and from
     * the palette it is everything: the tree makes the scope obvious, and the
     * palette has no scope to speak of.
     *
     * Searching is left to the quick pick itself, over the label, the server and
     * the outcome of each row, which is what makes typing a table name or a
     * server host find the run.
     *
     * @param node The tree node the command was invoked on, if any.
     */
    private async showHistory(node?: ITreeNode): Promise<void> {
        const all = this.history.getEntries();
        // Filtering by the normalized URL, because that is the spelling the
        // entries were stored with: a trailing slash on the tree node's URL
        // would otherwise match nothing.
        const entries = node?.serverUrl === undefined
            ? all
            : filterEntries(all, normalizeServerUrl(node.serverUrl));

        if (entries.length === 0) {
            await vscode.window.showInformationMessage(node?.serverUrl === undefined
                ? "You haven't run any SQL yet."
                : `You haven't run any SQL on ${node.serverUrl} yet.`);

            return;
        }

        const items = buildHistoryPickItems(entries, Date.now());

        const picked = await vscode.window.showQuickPick(items, {
            title: "Query History",
            placeHolder: "Search your recent statements",
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (!picked) {
            return;
        }

        const entry = this.history.getEntry(picked.entryId);

        if (!entry) {
            return;
        }

        await this.actOnHistoryEntry(entry);
    }

    /**
     * Called when the person wants to throw the query history away.
     */
    private async clearHistory(): Promise<void> {
        const count = this.history.getEntries().length;

        if (count === 0) {
            await vscode.window.showInformationMessage("There is no query history to clear.");

            return;
        }

        const choice = await vscode.window.showWarningMessage("Clear the query history?", {
            modal: true,
            detail: `${count.toLocaleString("en-US")} recorded statement${count === 1 ? "" : "s"} will be forgotten. This cannot be undone.`
        }, clearHistoryButton);

        if (choice !== clearHistoryButton) {
            return;
        }

        await this.history.clear();
    }

    /**
     * Called when the person wants to say whether a server is production,
     * staging or development.
     *
     * Production is the default rather than a choice with consequences, so
     * choosing it stores nothing: untagged and production are the same state.
     * Staging and development are the opt out, and they are what gets stored.
     *
     * @param node The tree node the command was invoked on, if any.
     */
    private async setServerEnvironment(node?: ITreeNode): Promise<void> {
        const serverUrl = node?.serverUrl ?? await this.bindings.pickServer("Set SQL Environment");

        if (serverUrl === undefined) {
            return;
        }

        const current = effectiveEnvironment(this.bindings.getEnvironment(serverUrl));

        const picked = await vscode.window.showQuickPick([...environmentPickItems], {
            title: serverUrl,
            placeHolder: `Currently treated as ${current}`
        });

        if (!picked) {
            return;
        }

        const environment: ServerEnvironment = picked.environment;

        await this.bindings.setEnvironment(serverUrl, environment);

        await vscode.window.showInformationMessage(environment === undefined
            ? `${serverUrl} is treated as production, which is the default for every server.`
            : `Tagged ${serverUrl} as ${environment}, which turns off the production warnings.`);
    }

    // #endregion
}
