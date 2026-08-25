import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { serverHostLabel } from "./bindingDecisions";
import {
    buildExportFileName,
    describeExportResult,
    exportDialogFilters,
    extractSingleTableName,
    needsExportProgress
} from "./gridCommandDecisions";
import { extractSelection } from "./gridSelection";
import { buildMoreRows, buildResultSetStreamChunk, ExtensionToPanelMessage, parsePanelMessage, resultSetStreamLength, ResultSetSummary, RunStatus } from "./panelProtocol";
import { defaultMaxRenderRows, renderPlan } from "./queryDecisions";
import { queryDocumentLabel } from "./queryDocumentNames";
import { buildCopyTextChunks, CellSanitizeOptions, copyChunkRows, CopyFormat, planCopy } from "./resultFormatting";
import { ExportFormat, serializeResultSet, serializeResultSets } from "./serializers";
import { QueryMessage, QueryResultSet } from "./types";

/** The view type of the results panel, used when a panel is created. */
const panelViewType = "magnus.sql.results";

/** The folder inside the extension that holds the webview's own assets. */
const webviewAssetFolder = ["src", "sql", "webview"];

/** The setting that caps how many rows the grid renders up front. */
const maxRenderRowsSettingKey = "magnus.sql.maxRenderRows";

/** The setting that neutralizes a cell a spreadsheet would read as a formula. */
const sanitizeSpreadsheetCellsSettingKey = "magnus.sql.sanitizeSpreadsheetCells";

/** How long a clipboard confirmation stays in the status bar, in milliseconds. */
const clipboardStatusMs = 3000;

/** The button offered on a successful export. */
const openExportButton = "Open";

/** The button that confirms a copy large enough to be worth asking about. */
const confirmCopyButton = "Copy";

/**
 * Produces one message to post to a webview, or null when it is no longer worth
 * posting.
 *
 * The message is built at the moment it is posted rather than when it is queued,
 * which is what lets a run's rows be formatted a chunk at a time instead of all
 * in the tick that finished the run. A thunk that finds its run superseded
 * returns null and the pump drops it.
 */
type MessageThunk = () => ExtensionToPanelMessage | null;

/**
 * One results panel and the bookkeeping around it.
 */
type PanelEntry = {
    /** The panel itself. */
    panel: vscode.WebviewPanel;

    /** True once the webview has told us it can render. */
    isReady: boolean;

    /** The messages waiting to be posted, in order. */
    outbox: MessageThunk[];

    /** True while the pump is working through the outbox. */
    isPumping: boolean;

    /**
     * Which generation of this panel's content the outbox belongs to.
     *
     * A new run, or a webview reload that has to be replayed, makes everything
     * queued before it obsolete. Every thunk captures the epoch it was queued in
     * and cancels itself if the epoch has moved on, which is what keeps the rows
     * of an abandoned run from interleaving with the rows of the current one.
     */
    epoch: number;

    /**
     * The result sets of the last run, with their raw values.
     *
     * The webview only ever holds formatted cells, and only the rows it has
     * asked for, so these stay here for the panel's lifetime: they are what a
     * scroll past the render cap, a copy and an export all read from.
     */
    resultSets: QueryResultSet[];

    /** The text that produced those result sets, used to name an INSERT's table. */
    queryText: string;

    /**
     * What the last {@link ResultsPanelManager.startRun} told the webview.
     *
     * The panel does not retain its context when it is hidden, so switching
     * tabs away and back reloads the webview into an empty page. Everything
     * needed to put the last run back on screen is kept here rather than being
     * posted once and forgotten.
     */
    lastRun: { serverLabel: string; statementPreview: string } | null;

    /** Every message the server emitted during the last run, in order. */
    messages: QueryMessage[];

    /** How the last run ended, or null while it is still in flight. */
    lastCompletion: { status: RunStatus; durationMs: number; resultSets: ResultSetSummary | null; errorMessage: string | null } | null;
};

/**
 * Owns the results panels: one per query editor, reused across runs, opened
 * beside the editor it belongs to.
 *
 * The webview renders; this class decides. It holds the raw result sets of the
 * last run of each editor, answers the grid's requests for more rows out of
 * them, and owns the two things a webview cannot do for itself: writing to the
 * clipboard and writing a file.
 */
export class ResultsPanelManager implements vscode.Disposable {
    // #region Private Properties

    /** The context that identifies our extension instance. */
    private context: vscode.ExtensionContext;

    /** The panels we are showing, keyed by the URI of the editor they belong to. */
    private panels: Map<string, PanelEntry> = new Map<string, PanelEntry>();

    /** The emitter used to tell the commands that a panel asked to cancel. */
    private didRequestCancel: vscode.EventEmitter<vscode.Uri> = new vscode.EventEmitter<vscode.Uri>();

    /** The subscription that closes a panel when its query editor is closed. */
    private documentCloseSubscription: vscode.Disposable;

    // #endregion

    // #region Constructors

    /**
     * Creates a new instance of the results panel manager.
     *
     * @param context The context that identifies our extension instance.
     */
    public constructor(context: vscode.ExtensionContext) {
        this.context = context;

        // A panel outliving its query editor keeps every retained row alive with
        // nothing left to scroll them, and an untitled scratch query has no
        // document at all once its tab is gone.
        this.documentCloseSubscription = vscode.workspace.onDidCloseTextDocument(document => this.closePanelFor(document.uri));
    }

    /** @inheritdoc */
    public dispose(): void {
        this.documentCloseSubscription.dispose();

        for (const entry of this.panels.values()) {
            entry.panel.dispose();
        }

        this.panels.clear();
        this.didRequestCancel.dispose();
    }

    // #endregion

    // #region Public Properties

    /** Fired with the URI of a query editor whose panel asked to cancel its run. */
    public readonly onDidRequestCancel: vscode.Event<vscode.Uri> = this.didRequestCancel.event;

    // #endregion

    // #region Private Functions

    /**
     * Gets the webview URI of one of our own asset files.
     *
     * @param webview The webview the asset is for.
     * @param fileName The name of the file inside the webview asset folder.
     *
     * @returns The URI the webview can load the file from.
     */
    private getAssetUri(webview: vscode.Webview, fileName: string): vscode.Uri {
        return webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...webviewAssetFolder, fileName));
    }

    /**
     * Builds the HTML of a results panel.
     *
     * The content security policy allows nothing but our own script and style,
     * both of which are local files, and the script is additionally pinned to a
     * per-load nonce.
     *
     * @param webview The webview the HTML is for.
     *
     * @returns The HTML document to hand the webview.
     */
    private getHtml(webview: vscode.Webview): string {
        const nonce = makeNonce();
        const scriptUri = this.getAssetUri(webview, "results.js");
        const styleUri = this.getAssetUri(webview, "results.css");
        const csp = [
            "default-src 'none'",
            `style-src ${webview.cspSource}`,
            `script-src 'nonce-${nonce}'`,
            `font-src ${webview.cspSource}`
        ].join("; ");

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>Query Results</title>
</head>
<body>
    <header class="panel-header">
        <div class="header-left">
            <span class="server-label" id="server-label"></span>
            <span class="statement-preview" id="statement-preview"></span>
        </div>
        <div class="header-right">
            <span class="status" id="status"></span>
            <button class="cancel-button" id="cancel-button" type="button" hidden>Cancel</button>
        </div>
    </header>
    <nav class="tab-strip" role="tablist" id="tab-strip">
        <button class="tab active" id="tab-messages" role="tab" type="button" aria-selected="true">Messages</button>
    </nav>
    <div class="toolbar" id="toolbar" hidden>
        <div class="menu-host" id="copy-menu-host">
            <button class="toolbar-button" id="copy-menu-button" type="button" aria-haspopup="true" aria-expanded="false">Copy as…</button>
        </div>
        <div class="menu-host" id="export-menu-host">
            <button class="toolbar-button" id="export-menu-button" type="button" aria-haspopup="true" aria-expanded="false">Export…</button>
        </div>
        <button class="toolbar-button" id="transpose-button" type="button" aria-pressed="false">Row inspector</button>
        <span class="toolbar-spacer"></span>
        <span class="selection-summary" id="selection-summary"></span>
    </div>
    <main class="tab-panel" id="messages-view" role="tabpanel" aria-labelledby="tab-messages">
        <ol class="message-list" id="message-list"></ol>
    </main>
    <div class="results-host" id="results-host" hidden></div>
    <section class="inspector" id="inspector" hidden aria-label="Value inspector">
        <div class="inspector-header">
            <span class="inspector-title" id="inspector-title"></span>
            <span class="inspector-kind" id="inspector-kind"></span>
            <span class="toolbar-spacer"></span>
            <button class="inspector-close" id="inspector-close" type="button" aria-label="Close the inspector">×</button>
        </div>
        <div class="inspector-body" id="inspector-body"></div>
    </section>
    <div class="context-menu" id="context-menu" role="menu" hidden></div>
    <span class="measure" id="measure" aria-hidden="true"></span>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    /**
     * Gets the panel of a query editor, creating it the first time.
     *
     * @param documentUri The URI of the query editor the panel belongs to.
     *
     * @returns The panel entry.
     */
    private getOrCreatePanel(documentUri: vscode.Uri): PanelEntry {
        const key = documentUri.toString();
        const existing = this.panels.get(key);

        if (existing) {
            return existing;
        }

        const panel = vscode.window.createWebviewPanel(panelViewType, "Query Results", {
            preserveFocus: true,
            viewColumn: vscode.ViewColumn.Beside
        }, {
            enableScripts: true,
            retainContextWhenHidden: false,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, ...webviewAssetFolder)
            ]
        });

        const entry: PanelEntry = {
            panel,
            isReady: false,
            outbox: [],
            isPumping: false,
            epoch: 0,
            resultSets: [],
            queryText: "",
            lastRun: null,
            messages: [],
            lastCompletion: null
        };

        panel.webview.html = this.getHtml(panel.webview);

        panel.webview.onDidReceiveMessage(raw => this.handlePanelMessage(documentUri, raw));

        panel.onDidDispose(() => {
            // Closing the panel of a query that is still running is how someone
            // says "stop". The cancel has to be fired while the entry is still
            // here, since the command side keys off the document URI.
            if (entry.lastCompletion === null && entry.lastRun !== null) {
                this.didRequestCancel.fire(documentUri);
            }

            this.panels.delete(key);
        });

        this.panels.set(key, entry);

        return entry;
    }

    /**
     * Closes the panel of a query editor and forgets everything it retained.
     *
     * @param documentUri The URI of the query editor.
     */
    private closePanelFor(documentUri: vscode.Uri): void {
        const entry = this.panels.get(documentUri.toString());

        if (!entry) {
            return;
        }

        // The dispose handler is what removes the entry, and it also fires the
        // cancel when a run was still in flight.
        entry.panel.dispose();
    }

    /**
     * Acts on a message that arrived from one of our webviews.
     *
     * @param documentUri The URI of the query editor the panel belongs to.
     * @param raw The value the webview posted, which is not trusted.
     */
    private handlePanelMessage(documentUri: vscode.Uri, raw: unknown): void {
        const message = parsePanelMessage(raw);

        if (!message) {
            return;
        }

        if (message.type === "ready") {
            const entry = this.panels.get(documentUri.toString());

            if (!entry) {
                return;
            }

            if (entry.isReady) {
                // The webview has reloaded, which happens whenever the panel is
                // hidden and shown again, and it came back to an empty page.
                // Everything it was showing is still here, so it is put back
                // rather than leaving the person with a blank panel.
                this.replayLastRun(documentUri, entry);

                return;
            }

            entry.isReady = true;
            this.pump(documentUri, entry);

            return;
        }

        if (message.type === "cancelRun") {
            this.didRequestCancel.fire(documentUri);

            return;
        }

        if (message.type === "revealLine") {
            this.revealLine(documentUri, message.lineNumber);

            return;
        }

        if (message.type === "requestRows") {
            const resultSet = this.getResultSet(documentUri, message.resultSet);

            if (resultSet) {
                this.post(documentUri, buildMoreRows(message.resultSet, resultSet, message.startRow, message.count));
            }

            return;
        }

        if (message.type === "copySelection") {
            void this.copySelection(documentUri, message.resultSet, {
                startRow: message.startRow,
                startColumn: message.startColumn,
                endRow: message.endRow,
                endColumn: message.endColumn
            }, message.format);

            return;
        }

        if (message.type === "exportResultSet") {
            void this.exportResultSets(documentUri, message.resultSet, message.format);
        }
    }

    /**
     * Gets one result set of the last run of a query editor.
     *
     * @param documentUri The URI of the query editor.
     * @param index The position of the result set among the run's result sets.
     *
     * @returns The result set, or undefined when the panel no longer holds one there.
     */
    private getResultSet(documentUri: vscode.Uri, index: number): QueryResultSet | undefined {
        return this.panels.get(documentUri.toString())?.resultSets[index];
    }

    /**
     * Puts a selection of a result set on the clipboard.
     *
     * The rectangle is applied to the raw rows rather than to anything the
     * webview holds, so a selection that reaches past the render cap copies real
     * values instead of the placeholders the grid was showing.
     *
     * The size is judged from the rectangle before any of it is extracted, since
     * a select all on a very large result set is hundreds of megabytes of string
     * and the point of asking is to ask before that is allocated.
     *
     * @param documentUri The URI of the query editor.
     * @param index The position of the result set among the run's result sets.
     * @param rect The selected rectangle, both ends inclusive.
     * @param format The format the person picked from the Copy as… menu.
     */
    private async copySelection(documentUri: vscode.Uri, index: number, rect: { startRow: number; startColumn: number; endRow: number; endColumn: number }, format: CopyFormat): Promise<void> {
        const entry = this.panels.get(documentUri.toString());
        const resultSet = entry?.resultSets[index];

        if (!entry || !resultSet) {
            return;
        }

        const plan = planCopy(rect.endRow - rect.startRow + 1, rect.endColumn - rect.startColumn + 1);

        if (plan.needsConfirmation) {
            const choice = await vscode.window.showWarningMessage(plan.confirmationMessage ?? "", {
                modal: true
            }, confirmCopyButton);

            if (choice !== confirmCopyButton) {
                return;
            }
        }

        const slice = extractSelection(resultSet.columns, resultSet.rows, rect);

        if (!slice) {
            return;
        }

        let tableName: string | undefined;

        if (format === "insert") {
            tableName = await this.resolveInsertTableName(entry.queryText);

            if (tableName === undefined) {
                return;
            }
        }

        const build = async (): Promise<string> => {
            const chunks = buildCopyTextChunks(format, slice.columns, slice.rows, tableName, copyChunkRows, this.getSanitizeOptions());
            const parts: string[] = [];

            for (const chunk of chunks) {
                parts.push(chunk);

                // Concatenating a very large document in one expression is a
                // stall the person sees; yielding between chunks keeps the
                // extension host answering while it is assembled.
                await nextTurn();
            }

            return parts.join("");
        };

        const text = plan.needsConfirmation
            ? await vscode.window.withProgress({
                cancellable: false,
                location: vscode.ProgressLocation.Notification,
                title: `Copying ${plan.cellCount.toLocaleString("en-US")} cells…`
            }, () => build())
            : await build();

        await vscode.env.clipboard.writeText(text);

        const cells = slice.rows.length * slice.columns.length;

        vscode.window.setStatusBarMessage(`Copied ${cells.toLocaleString("en-US")} ${cells === 1 ? "cell" : "cells"} to the clipboard.`, clipboardStatusMs);
    }

    /**
     * Works out which table a copy as INSERT should aim at.
     *
     * A single table select answers this on its own; anything else has to be
     * asked, since guessing would produce statements aimed at the wrong table.
     *
     * @param queryText The text that produced the result set.
     *
     * @returns The table name, or undefined when the person cancelled.
     */
    private async resolveInsertTableName(queryText: string): Promise<string | undefined> {
        const detected = extractSingleTableName(queryText);

        if (detected) {
            return detected;
        }

        return await vscode.window.showInputBox({
            title: "Copy as INSERT",
            prompt: "The table name to insert into",
            placeHolder: "dbo.Person",
            validateInput: value => value.trim() === "" ? "Enter a table name." : undefined
        });
    }

    /**
     * Writes one result set, or every result set, to a file the person picks.
     *
     * @param documentUri The URI of the query editor.
     * @param target The position of the result set to export, or "all" for every set.
     * @param format The format to export to.
     */
    private async exportResultSets(documentUri: vscode.Uri, target: number | "all", format: ExportFormat): Promise<void> {
        const entry = this.panels.get(documentUri.toString());

        if (!entry) {
            return;
        }

        const sets = target === "all"
            ? entry.resultSets
            : entry.resultSets[target] ? [entry.resultSets[target]] : [];

        if (sets.length === 0) {
            return;
        }

        const rowCount = sets.reduce((total, set) => total + set.rows.length, 0);
        const fileName = buildExportFileName(queryDocumentLabel(documentUri.path), target, format, entry.resultSets.length);

        const destination = await vscode.window.showSaveDialog({
            title: "Export Results",
            defaultUri: this.getDefaultExportUri(fileName),
            filters: exportDialogFilters(format),
            saveLabel: "Export"
        });

        if (!destination) {
            return;
        }

        try {
            if (needsExportProgress(rowCount)) {
                await vscode.window.withProgress({
                    cancellable: false,
                    location: vscode.ProgressLocation.Notification,
                    title: `Exporting ${rowCount.toLocaleString("en-US")} rows…`
                }, () => this.writeExport(destination, target, format, sets));
            }
            else {
                await this.writeExport(destination, target, format, sets);
            }
        }
        catch (error) {
            await vscode.window.showErrorMessage(error instanceof Error ? error.message : "The export failed.");

            return;
        }

        const choice = await vscode.window.showInformationMessage(
            describeExportResult(queryDocumentLabel(destination.path), rowCount),
            openExportButton
        );

        if (choice === openExportButton) {
            await this.openExport(destination, format);
        }
    }

    /**
     * Serializes result sets and writes them to a file.
     *
     * @param destination The file to write.
     * @param target The position of the result set being exported, or "all" for every set.
     * @param format The format to export to.
     * @param sets The result sets to write.
     */
    private async writeExport(destination: vscode.Uri, target: number | "all", format: ExportFormat, sets: QueryResultSet[]): Promise<void> {
        const options = this.getSanitizeOptions();
        const document = target === "all"
            ? await serializeResultSets(format, sets, options)
            : await serializeResultSet(format, sets[0], options);

        const bytes = typeof document === "string"
            ? Buffer.from(document, "utf8")
            : document;

        await vscode.workspace.fs.writeFile(destination, new Uint8Array(bytes));
    }

    /**
     * Opens a file an export just wrote.
     *
     * A text document opens in an editor; a workbook is handed to whatever the
     * operating system uses for one, since VS Code cannot show it.
     *
     * @param destination The file that was written.
     * @param format The format it was written in.
     */
    private async openExport(destination: vscode.Uri, format: ExportFormat): Promise<void> {
        try {
            if (format === "excel") {
                await vscode.env.openExternal(destination);

                return;
            }

            const document = await vscode.workspace.openTextDocument(destination);

            await vscode.window.showTextDocument(document, {
                preview: false
            });
        }
        catch (error) {
            await vscode.window.showErrorMessage(error instanceof Error ? error.message : "The exported file could not be opened.");
        }
    }

    /**
     * Gets the file the export save dialog should start on.
     *
     * @param fileName The file name to suggest.
     *
     * @returns The URI to start the dialog at.
     */
    private getDefaultExportUri(fileName: string): vscode.Uri {
        const folder = vscode.workspace.workspaceFolders?.[0];

        return folder ? vscode.Uri.joinPath(folder.uri, fileName) : vscode.Uri.file(fileName);
    }

    /**
     * Moves the cursor of a query editor to the line a message pointed at.
     *
     * @param documentUri The URI of the query editor.
     * @param lineNumber The one based line number reported by SQL Server.
     */
    private async revealLine(documentUri: vscode.Uri, lineNumber: number): Promise<void> {
        try {
            const document = await vscode.workspace.openTextDocument(documentUri);
            const editor = await vscode.window.showTextDocument(document, {
                preserveFocus: false,
                preview: false
            });
            const line = Math.min(Math.max(0, lineNumber - 1), Math.max(0, document.lineCount - 1));
            const position = new vscode.Position(line, 0);

            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
        catch {
            // The editor may have been closed since the message was rendered,
            // which is not worth interrupting anyone over.
        }
    }

    /**
     * Posts a message to a panel, holding it until the webview can render.
     *
     * @param documentUri The URI of the query editor the panel belongs to.
     * @param message The message to post.
     */
    private post(documentUri: vscode.Uri, message: ExtensionToPanelMessage): void {
        const entry = this.panels.get(documentUri.toString());

        if (!entry) {
            return;
        }

        this.enqueue(documentUri, entry, entry.epoch, () => message);
    }

    /**
     * Adds one message to a panel's outbox and makes sure the pump is running.
     *
     * @param documentUri The URI of the query editor the panel belongs to.
     * @param entry The panel entry the message is for.
     * @param epoch The generation of the panel's content the message belongs to.
     * @param build Produces the message when its turn comes.
     */
    private enqueue(documentUri: vscode.Uri, entry: PanelEntry, epoch: number, build: MessageThunk): void {
        entry.outbox.push(() => entry.epoch === epoch ? build() : null);

        this.pump(documentUri, entry);
    }

    /**
     * Works through a panel's outbox, yielding to the event loop between
     * messages.
     *
     * A run that produced tens of thousands of rows used to format and post
     * every chunk of every result set in the tick that finished it, which is a
     * stall the person sees as a frozen window and an empty panel. Handing one
     * message over per macrotask lets the webview paint the first rows while the
     * later ones are still being formatted.
     *
     * @param documentUri The URI of the query editor the panel belongs to.
     * @param entry The panel entry to drain.
     */
    private pump(documentUri: vscode.Uri, entry: PanelEntry): void {
        if (entry.isPumping || !entry.isReady) {
            return;
        }

        entry.isPumping = true;

        void (async (): Promise<void> => {
            try {
                while (entry.outbox.length > 0) {
                    // A panel that was closed while its rows were still being
                    // formatted has nothing left to post to.
                    if (this.panels.get(documentUri.toString()) !== entry) {
                        entry.outbox = [];

                        return;
                    }

                    const message = entry.outbox.shift()?.() ?? null;

                    if (message) {
                        void entry.panel.webview.postMessage(message);
                    }

                    await nextTurn();
                }
            }
            finally {
                entry.isPumping = false;
            }
        })();
    }

    /**
     * Puts the last run of a panel back on screen after its webview reloaded.
     *
     * The result sets themselves never left, so this replays the run from what
     * the entry retained rather than asking the server for anything.
     *
     * @param documentUri The URI of the query editor the panel belongs to.
     * @param entry The panel entry to replay.
     */
    private replayLastRun(documentUri: vscode.Uri, entry: PanelEntry): void {
        if (!entry.lastRun) {
            return;
        }

        // Anything still queued belongs to the page that has just gone away.
        entry.outbox = [];
        entry.epoch += 1;

        const epoch = entry.epoch;

        this.enqueue(documentUri, entry, epoch, () => ({
            type: "runStarted",
            serverLabel: entry.lastRun?.serverLabel ?? "",
            statementPreview: entry.lastRun?.statementPreview ?? ""
        }));

        if (entry.messages.length > 0) {
            this.enqueue(documentUri, entry, epoch, () => ({
                type: "messages",
                messages: entry.messages
            }));
        }

        this.streamResultSets(documentUri, entry, epoch);

        const completion = entry.lastCompletion;

        if (completion) {
            this.enqueue(documentUri, entry, epoch, () => ({
                type: "runCompleted",
                ...completion
            }));
        }
    }

    /**
     * Queues the initial render of every result set a panel retains.
     *
     * Each chunk is formatted when its turn to be posted comes, so a large run
     * costs one chunk of work per macrotask instead of all of it at once.
     *
     * @param documentUri The URI of the query editor the panel belongs to.
     * @param entry The panel entry whose result sets are being streamed.
     * @param epoch The generation of the panel's content the stream belongs to.
     */
    private streamResultSets(documentUri: vscode.Uri, entry: PanelEntry, epoch: number): void {
        const maxRenderRows = vscode.workspace.getConfiguration().get<number>(maxRenderRowsSettingKey, defaultMaxRenderRows);

        for (let index = 0; index < entry.resultSets.length; index++) {
            const resultSet = entry.resultSets[index];
            const plan = renderPlan(resultSet.rows.length, maxRenderRows);
            const chunkCount = resultSetStreamLength(resultSet.rows.length, plan.initialRows);

            for (let chunk = 0; chunk < chunkCount; chunk++) {
                this.enqueue(documentUri, entry, epoch, () => buildResultSetStreamChunk(index, resultSet, plan.initialRows, plan.truncatedNotice, chunk));
            }
        }
    }

    /**
     * Reads whether a cell that a spreadsheet would read as a formula should be
     * neutralized.
     *
     * @returns The option to hand the copy and export builders.
     */
    private getSanitizeOptions(): CellSanitizeOptions {
        return {
            sanitizeSpreadsheetCells: vscode.workspace.getConfiguration().get<boolean>(sanitizeSpreadsheetCellsSettingKey, true)
        };
    }

    // #endregion

    // #region Public Functions

    /**
     * Opens or reveals the panel of a query editor and tells it a run has begun.
     *
     * @param documentUri The URI of the query editor.
     * @param serverUrl The URL of the server the run is on.
     * @param statementPreview A one line summary of what is running.
     */
    public startRun(documentUri: vscode.Uri, serverUrl: string, statementPreview: string): void {
        const entry = this.getOrCreatePanel(documentUri);

        // The panel is titled after the editor it belongs to, not after the
        // server, so that its tab caption is as stable as the editor's own and
        // so that two panels on one server are told apart. The server is named
        // in the panel's own header, which the message below carries.
        entry.panel.title = `Results: ${queryDocumentLabel(documentUri.path)}`;
        entry.panel.reveal(vscode.ViewColumn.Beside, true);

        // The rows of the previous run stop being answerable the moment a new
        // run starts, and the webview clears its grids on the same message. Any
        // chunk of the previous run still waiting in the outbox belongs to a
        // grid that no longer exists, so the epoch moves on and those thunks
        // cancel themselves when the pump reaches them.
        entry.resultSets = [];
        entry.queryText = "";
        entry.outbox = [];
        entry.epoch += 1;
        entry.messages = [];
        entry.lastCompletion = null;
        entry.lastRun = {
            serverLabel: serverHostLabel(serverUrl),
            statementPreview
        };

        this.post(documentUri, {
            type: "runStarted",
            ...entry.lastRun
        });
    }

    /**
     * Streams the messages the server has emitted into the panel.
     *
     * @param documentUri The URI of the query editor.
     * @param messages The messages that are new since the last call.
     */
    public appendMessages(documentUri: vscode.Uri, messages: QueryMessage[]): void {
        if (messages.length === 0) {
            return;
        }

        const entry = this.panels.get(documentUri.toString());

        if (entry) {
            // Kept so that a webview which reloads gets the whole transcript
            // back rather than only whatever arrives after the reload.
            entry.messages = [...entry.messages, ...messages];
        }

        this.post(documentUri, {
            type: "messages",
            messages
        });
    }

    /**
     * Hands the result sets of a finished run to the panel's grid.
     *
     * The rows are kept here as well as streamed, because the render cap means
     * the webview is only ever given the first slice of a large set. Call this
     * before {@link completeRun}: the tabs and the row counts come from here and
     * the duration in each footer comes from there.
     *
     * @param documentUri The URI of the query editor.
     * @param resultSets The result sets the run produced, in order.
     * @param queryText The text that was run, used to name an INSERT's table.
     */
    public showResultSets(documentUri: vscode.Uri, resultSets: QueryResultSet[], queryText: string): void {
        const entry = this.panels.get(documentUri.toString());

        if (!entry) {
            return;
        }

        entry.resultSets = resultSets;
        entry.queryText = queryText;

        this.streamResultSets(documentUri, entry, entry.epoch);
    }

    /**
     * Tells the panel that a run has finished.
     *
     * @param documentUri The URI of the query editor.
     * @param status How the run ended.
     * @param durationMs How long the run took, in milliseconds.
     * @param resultSets A summary of the result sets it produced, or null when there were none.
     * @param errorMessage The error to show, or null when there was none.
     */
    public completeRun(documentUri: vscode.Uri, status: RunStatus, durationMs: number, resultSets: ResultSetSummary | null, errorMessage: string | null): void {
        const entry = this.panels.get(documentUri.toString());
        const completion = {
            status,
            durationMs,
            resultSets,
            errorMessage
        };

        if (entry) {
            entry.lastCompletion = completion;
        }

        this.post(documentUri, {
            type: "runCompleted",
            ...completion
        });
    }

    // #endregion
}

/**
 * Yields to the event loop so that the extension host can do something else
 * before the next chunk of work.
 *
 * `setImmediate` runs after the pending I/O of this turn, which is what lets a
 * message the webview has already been posted actually reach it.
 *
 * @returns A promise that settles on the next turn of the event loop.
 */
function nextTurn(): Promise<void> {
    return new Promise<void>(resolve => setImmediate(resolve));
}

/**
 * Makes a random nonce for the content security policy of one webview load.
 *
 * The bytes come from the platform's cryptographic generator rather than from
 * `Math.random`, since a nonce a page could predict is not a nonce.
 *
 * @returns A 32 character hexadecimal nonce.
 */
function makeNonce(): string {
    return randomBytes(16).toString("hex");
}
