import * as vscode from "vscode";
import { BindingManager, sqlLanguageId } from "./bindingManager";
import { buildCompletions, SqlCompletionItem, SqlCompletionKind } from "./completionItems";
import { CachedColumnsByTable } from "./joinCompletion";
import { SqlObjectExplorer } from "./sqlObjectExplorer";
import { SqlAnalysisMemo } from "./sqlAnalysisMemo";
import { completionContextIn, CompletionContext, distinctTablesInOrder, soleTableInScope, SqlAnalysis } from "./sqlContext";

/** The characters that ask for completions without anything having been typed. */
const triggerCharacters = [".", " "];

/**
 * Offers Rock aware completions in SQL editors.
 *
 * Two rules shape everything here, and both come from the fact that this runs
 * while someone is typing. It never reports a problem: an unbound document, a
 * server that cannot be reached or a table that does not exist all produce a
 * shorter list and nothing else, because an error toast per keystroke would be
 * intolerable. And it only ever asks the server for a column list, never more
 * than one per request, and only for a table it can name without guessing: the
 * table before a dot, the single table a statement has in scope, or the first
 * table in scope with no columns cached when the cursor is after a `JOIN`. The
 * table list is read from the object explorer cache and never fetched.
 *
 * Every decision about what the list holds lives in {@link completionItems}.
 */
export class SqlCompletionProvider implements vscode.CompletionItemProvider, vscode.Disposable {
    // #region Private Properties

    /** The bindings of the open documents, which name the server to ask. */
    private bindings: BindingManager;

    /** The object explorer, which owns the cached tables and column names. */
    private objectExplorer: SqlObjectExplorer;

    /**
     * The analysis of the document being typed in, held per document version.
     *
     * Space is a trigger character, so this runs often enough that scanning the
     * document once per keystroke rather than three or four times is worth a
     * cache with one entry per editor in it.
     */
    private analyses: SqlAnalysisMemo = new SqlAnalysisMemo();

    /** The things we have to let go of when the extension shuts down. */
    private disposables: vscode.Disposable[] = [];

    // #endregion

    // #region Constructors

    /**
     * Creates a new instance of the completion provider, registered for SQL
     * documents. The registration is disposed with the instance, which
     * `extension.ts` puts in the extension's subscriptions.
     *
     * @param bindings The bindings of the open documents.
     * @param objectExplorer The object explorer, which owns the cached schema data.
     */
    public constructor(bindings: BindingManager, objectExplorer: SqlObjectExplorer) {
        this.bindings = bindings;
        this.objectExplorer = objectExplorer;

        this.disposables.push(vscode.languages.registerCompletionItemProvider({
            language: sqlLanguageId
        }, this, ...triggerCharacters));

        this.disposables.push(vscode.workspace.onDidCloseTextDocument(document => this.analyses.forget(document.uri.toString())));

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
     * Reads the columns of the table an alias stands for, giving up quietly.
     *
     * @param document The document the completion was asked for.
     * @param analysis The analysis of that document.
     * @param aliasOrTable The alias or table name the cursor followed.
     *
     * @returns The column names, or undefined when the document is unbound, the alias resolves to nothing, or the request failed.
     */
    private async readColumns(document: vscode.TextDocument, analysis: SqlAnalysis, aliasOrTable: string): Promise<string[] | undefined> {
        const tableName = analysis.aliases.get(aliasOrTable.toLowerCase()) ?? aliasOrTable;

        return await this.readColumnsOfTable(document, tableName);
    }

    /**
     * Reads the columns of the single table a statement has in scope, giving up
     * quietly.
     *
     * @param document The document the completion was asked for.
     * @param analysis The analysis of that document.
     *
     * @returns The column names, or undefined when the statement does not resolve to exactly one table, the document is unbound, or the request failed.
     */
    private async readSoleTableColumns(document: vscode.TextDocument, analysis: SqlAnalysis): Promise<string[] | undefined> {
        const tableName = soleTableInScope(analysis.aliases);

        if (tableName === null) {
            return undefined;
        }

        return await this.readColumnsOfTable(document, tableName);
    }

    /**
     * Reads the columns of one table of a document's bound server, cache first
     * and giving up quietly.
     *
     * @param document The document the completion was asked for.
     * @param tableName The table to read the columns of.
     *
     * @returns The column names, or undefined when the document is unbound or the request failed.
     */
    private async readColumnsOfTable(document: vscode.TextDocument, tableName: string): Promise<string[] | undefined> {
        const serverUrl = this.bindings.getBoundServer(document.uri);

        if (serverUrl === undefined) {
            return undefined;
        }

        const cached = this.objectExplorer.getCachedColumnNames(serverUrl, tableName);

        if (cached) {
            return cached;
        }

        try {
            return await this.objectExplorer.getColumnNames(serverUrl, tableName);
        }
        catch {
            // A table that is not on this server, a server that is down, an
            // expired session: none of them are worth interrupting typing over.
            return undefined;
        }
    }

    /**
     * Reads whichever column list a cursor context calls for, if any.
     *
     * @param document The document the completion was asked for.
     * @param analysis The analysis of that document.
     * @param context The context the cursor is in.
     *
     * @returns The column names, or undefined when the context wants none or none could be read.
     */
    private async readColumnsFor(document: vscode.TextDocument, analysis: SqlAnalysis, context: CompletionContext): Promise<string[] | undefined> {
        if (context.kind === "afterDot") {
            return await this.readColumns(document, analysis, context.aliasOrTable);
        }

        if (context.kind === "general") {
            return await this.readSoleTableColumns(document, analysis);
        }

        return undefined;
    }

    /**
     * Gathers the column lists for the tables a statement already has in scope,
     * for the join clause suggestions.
     *
     * The cache answers for as many of them as it can. At most one table then gets
     * a real request, and only if it is the first one the cache had nothing for.
     *
     * That cap is the whole policy, and it is a deliberate trade. A statement can
     * easily have five or six tables in scope; firing a request per table per
     * keystroke would turn a completion into a fan-out against someone's
     * production Rock server, and the cache would not save us, because the first
     * keystroke is exactly when it is cold. One request matches what the
     * `afterDot` path already allows itself, so the worst case of a completion is
     * unchanged. The tables that missed out are not silent: the catalog's curated
     * foreign keys stand in for them, and the request made here warms the cache,
     * so the next keystroke is better than this one.
     *
     * @param document The document the completion was asked for.
     * @param aliases The alias map of the statement, which names the tables in scope.
     *
     * @returns The column lists that could be gathered, keyed by lower cased table name.
     */
    private async readInScopeColumns(document: vscode.TextDocument, aliases: Map<string, string>): Promise<CachedColumnsByTable> {
        const serverUrl = this.bindings.getBoundServer(document.uri);
        const columnsByTable: CachedColumnsByTable = {};

        if (serverUrl === undefined) {
            return columnsByTable;
        }

        const tables = distinctTablesInOrder(aliases);
        let missing: string | undefined = undefined;

        for (const tableName of tables) {
            const cached = this.objectExplorer.getCachedColumnNames(serverUrl, tableName);

            if (cached) {
                columnsByTable[tableName.toLowerCase()] = cached;
            }
            else if (missing === undefined) {
                missing = tableName;
            }
        }

        if (missing !== undefined) {
            const fetched = await this.readColumnsOfTable(document, missing);

            if (fetched) {
                columnsByTable[missing.toLowerCase()] = fetched;
            }
        }

        return columnsByTable;
    }

    /**
     * Reads the table names already cached for a document's server.
     *
     * @param document The document the completion was asked for.
     *
     * @returns The table names, which is empty until the object explorer has been used.
     */
    private readCachedTableNames(document: vscode.TextDocument): string[] {
        const serverUrl = this.bindings.getBoundServer(document.uri);

        if (serverUrl === undefined) {
            return [];
        }

        return (this.objectExplorer.getCachedTables(serverUrl) ?? []).map(table => table.tableName);
    }

    /**
     * Turns one decided completion into the vscode item that renders it.
     *
     * @param item The completion to render.
     *
     * @returns The vscode item.
     */
    private toVsCodeItem(item: SqlCompletionItem): vscode.CompletionItem {
        const completion = new vscode.CompletionItem(item.label, this.toVsCodeKind(item.kind));

        completion.insertText = item.isSnippet ? new vscode.SnippetString(item.insertText) : item.insertText;
        completion.sortText = item.sortText;

        if (item.detail !== undefined) {
            completion.detail = item.detail;
        }

        if (item.filterText !== undefined) {
            completion.filterText = item.filterText;
        }

        if (item.documentation !== undefined) {
            completion.documentation = new vscode.MarkdownString(item.documentation);
        }

        return completion;
    }

    /**
     * Maps a completion kind to the vscode kind that gives it its icon.
     *
     * @param kind The kind of completion.
     *
     * @returns The vscode kind.
     */
    private toVsCodeKind(kind: SqlCompletionKind): vscode.CompletionItemKind {
        if (kind === "column") {
            return vscode.CompletionItemKind.Field;
        }

        if (kind === "table") {
            return vscode.CompletionItemKind.Class;
        }

        return vscode.CompletionItemKind.Snippet;
    }

    // #endregion

    // #region CompletionItemProvider

    /** @inheritdoc */
    public async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.CompletionItem[]> {
        if (document.languageId !== sqlLanguageId) {
            return [];
        }

        // Checked before the document is read, because the whole point is to not
        // scan a document nobody is waiting on any more.
        if (token.isCancellationRequested) {
            return [];
        }

        const analysis = this.analyses.get(document.uri.toString(), document.version, document.getText());
        const context = completionContextIn(analysis, document.offsetAt(position));

        if (context.kind === "none") {
            return [];
        }

        if (context.kind === "joinTarget") {
            const aliases = analysis.aliases;
            const columnsByTable = await this.readInScopeColumns(document, aliases);

            if (token.isCancellationRequested) {
                return [];
            }

            const inJoin = buildCompletions(context, {
                aliases: aliases,
                columnsByTable: columnsByTable,
                liveTableNames: this.readCachedTableNames(document)
            });

            return inJoin.map(item => this.toVsCodeItem(item));
        }

        const columns = await this.readColumnsFor(document, analysis, context);

        if (token.isCancellationRequested) {
            return [];
        }

        const liveTableNames = context.kind === "tableName"
            ? this.readCachedTableNames(document)
            : undefined;

        return buildCompletions(context, { columns, liveTableNames }).map(item => this.toVsCodeItem(item));
    }

    // #endregion
}
