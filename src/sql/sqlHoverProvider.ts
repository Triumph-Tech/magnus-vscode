import * as vscode from "vscode";
import { BindingManager, sqlLanguageId } from "./bindingManager";
import { buildTableHover } from "./hoverContent";
import { findRockTable } from "./rockCatalog";
import { SqlAnalysisMemo } from "./sqlAnalysisMemo";
import { SqlAnalysis, tableNameIn } from "./sqlContext";
import { SqlObjectExplorer } from "./sqlObjectExplorer";

/**
 * Shows what a table is for, and what columns it has, when a table name in a
 * SQL editor is hovered.
 *
 * The hover itself is cache only: a hover fires whenever the mouse rests
 * anywhere, so fetching in front of it would mean a request per idle moment, and
 * what the object explorer or a Select Top 1000 has already loaded is free. What
 * it does do is warm the cache behind itself, so that the second hover of a
 * table lists its columns.
 *
 * That warming is deliberately narrow. It happens only when a hover is actually
 * being shown and only when the name is plausibly a table on this server, which
 * keeps a mouse wandering over keywords, temp tables and column names from
 * turning into a fetch each. Coalescing the fetches and remembering the failures
 * belongs to the object explorer, which is where every caller of it benefits.
 */
export class SqlHoverProvider implements vscode.HoverProvider, vscode.Disposable {
    // #region Private Properties

    /** The bindings of the open documents, which name the server whose columns apply. */
    private bindings: BindingManager;

    /** The object explorer, which owns the cached column names. */
    private objectExplorer: SqlObjectExplorer;

    /** The analysis of the hovered document, held per document version. */
    private analyses: SqlAnalysisMemo = new SqlAnalysisMemo();

    /** The things we have to let go of when the extension shuts down. */
    private disposables: vscode.Disposable[] = [];

    // #endregion

    // #region Constructors

    /**
     * Creates a new instance of the hover provider, registered for SQL
     * documents. The registration is disposed with the instance, which
     * `extension.ts` puts in the extension's subscriptions.
     *
     * @param bindings The bindings of the open documents.
     * @param objectExplorer The object explorer, which owns the cached schema data.
     */
    public constructor(bindings: BindingManager, objectExplorer: SqlObjectExplorer) {
        this.bindings = bindings;
        this.objectExplorer = objectExplorer;

        this.disposables.push(vscode.languages.registerHoverProvider({
            language: sqlLanguageId
        }, this));

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

    // #region HoverProvider

    /** @inheritdoc */
    public provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.Hover | undefined {
        if (document.languageId !== sqlLanguageId) {
            return undefined;
        }

        if (token.isCancellationRequested) {
            return undefined;
        }

        const analysis = this.analyses.get(document.uri.toString(), document.version, document.getText());
        const reference = tableNameIn(analysis, document.offsetAt(position));

        if (!reference) {
            return undefined;
        }

        const serverUrl = this.bindings.getBoundServer(document.uri);
        const columns = serverUrl === undefined
            ? undefined
            : this.objectExplorer.getCachedColumnNames(serverUrl, reference.tableName);
        const markdown = buildTableHover(reference.tableName, columns);

        if (markdown === null) {
            return undefined;
        }

        // Only now, with a hover on screen and no columns in it, is a fetch worth
        // making: the name is one the person is looking at and one we could tell
        // them more about.
        if (columns === undefined && serverUrl !== undefined && this.isPlausibleTable(serverUrl, analysis, reference.tableName)) {
            this.fetchColumnsInBackground(serverUrl, reference.tableName);
        }

        return new vscode.Hover(new vscode.MarkdownString(markdown));
    }

    // #endregion

    // #region Private Functions

    /**
     * Determines whether a hovered name is worth asking the server about.
     *
     * Three things vouch for a name: the Rock catalog, the server's own table
     * list once it has been walked, and the document itself naming it as a table
     * in a `FROM` or `JOIN` clause. Anything else, and there is plenty of it in a
     * script, is left alone.
     *
     * @param serverUrl The URL of the server the document is bound to.
     * @param analysis The analysis of the document, whose alias map names the tables in scope.
     * @param tableName The name under the cursor.
     *
     * @returns True if the name is plausibly a table on this server.
     */
    private isPlausibleTable(serverUrl: string, analysis: SqlAnalysis, tableName: string): boolean {
        const name = tableName.toLowerCase();

        if (findRockTable(tableName)) {
            return true;
        }

        for (const inScope of analysis.aliases.values()) {
            if (inScope.toLowerCase() === name) {
                return true;
            }
        }

        return (this.objectExplorer.getCachedTables(serverUrl) ?? []).some(table => table.tableName.toLowerCase() === name);
    }

    /**
     * Starts a background fetch of a table's columns so the next hover of it can
     * list them.
     *
     * The hover that triggered this still returns immediately with whatever it
     * had, and nothing is shown for a failure. There is no bookkeeping here on
     * purpose: {@link SqlObjectExplorer.getColumnNames} shares one request
     * between concurrent callers and refuses a table that has just failed, so a
     * second hover is not a second request.
     *
     * @param serverUrl The URL of the server the document is bound to.
     * @param tableName The table whose columns were not in the cache.
     */
    private fetchColumnsInBackground(serverUrl: string, tableName: string): void {
        this.objectExplorer.getColumnNames(serverUrl, tableName).catch(() => {
            // A name that is not a table on this server, or a server that is
            // down. Neither is worth interrupting a hover over.
        });
    }

    // #endregion
}
