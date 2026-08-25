import * as vscode from "vscode";
import { BindingManager } from "./bindingManager";
import { buildTableActionItems, buildTableQuickPickItems, SqlTableActionKind, SqlTableReference } from "./sqlNodeMapping";
import { isSqlTreeNode, SqlObjectExplorer } from "./sqlObjectExplorer";
import { quoteQualifiedIdentifier } from "./resultFormatting";

/**
 * Registers and responds to the SQL tools commands.
 */
export class SqlCommands implements vscode.Disposable {
    // #region Private Properties

    /** The object explorer that owns the SQL subtree and its cache. */
    private objectExplorer: SqlObjectExplorer;

    /** The bindings, which own the one server picker every SQL command uses. */
    private bindings: BindingManager;

    /** The things we have to let go of when the extension shuts down. */
    private disposables: vscode.Disposable[] = [];

    // #endregion

    // #region Constructors

    /**
     * Creates a new instance of the SQL command handler. The commands it
     * registers are owned by the instance, which `extension.ts` puts in the
     * extension's subscriptions.
     *
     * @param objectExplorer The object explorer that owns the SQL subtree.
     * @param bindings The bindings, which own the shared server picker.
     */
    public constructor(objectExplorer: SqlObjectExplorer, bindings: BindingManager) {
        this.objectExplorer = objectExplorer;
        this.bindings = bindings;

        this.disposables.push(vscode.commands.registerCommand("magnus.sql.goToTable", this.goToTable, this));
        this.disposables.push(vscode.commands.registerCommand("magnus.sql.refreshObjectExplorer", this.refreshObjectExplorer, this));
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
     * Determines which server a command should act on. If the command came from
     * the tree then the node already tells us; otherwise the person is asked.
     *
     * The asking is the bindings' picker rather than a second one of our own,
     * which is what keeps the production warning on a server's entry: a picker
     * of plain URL strings drops the environment tag, and dropping it here meant
     * Go to Table was the one SQL command that could send someone to production
     * without saying so.
     *
     * @param node The tree node the command was invoked on, if any.
     *
     * @returns The URL of the server to use, or undefined if the person cancelled.
     */
    private async getTargetServerUrl(node?: ITreeNode): Promise<string | undefined> {
        if (node?.serverUrl) {
            return node.serverUrl;
        }

        return await this.bindings.pickServer("Go to Table");
    }

    /**
     * Inserts a table name at the cursor of the active editor.
     *
     * The name is quoted a part at a time, so `dbo.Person` arrives as
     * `[dbo].[Person]` rather than as the single unusable `[dbo.Person]` that
     * wrapping the whole string in brackets produced, and a `]` inside a name is
     * doubled rather than closing the bracket early.
     *
     * @param tableName The name of the table to insert.
     */
    private async insertTableName(tableName: string): Promise<void> {
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
            return;
        }

        await editor.edit(builder => {
            for (const selection of editor.selections) {
                builder.replace(selection, quoteQualifiedIdentifier(tableName));
            }
        });
    }

    /**
     * Asks what should be done with the chosen table and does it.
     *
     * @param table The table that was chosen.
     */
    private async performTableAction(table: SqlTableReference): Promise<void> {
        const hasActiveEditor = vscode.window.activeTextEditor !== undefined;
        const actions = buildTableActionItems(table.tableName, hasActiveEditor);

        const action = await vscode.window.showQuickPick(actions, {
            title: table.tableName,
            placeHolder: "Select an action"
        });

        if (!action) {
            return;
        }

        if (action.action === SqlTableActionKind.SelectTop1000) {
            // The run commands own execution, so the table is handed to their
            // command rather than a second copy of the flow living here.
            await vscode.commands.executeCommand("magnus.sql.selectTop1000", {
                serverUrl: table.serverUrl,
                tableName: table.tableName
            });
        }
        else if (action.action === SqlTableActionKind.Reveal) {
            await this.objectExplorer.revealTable(table);
        }
        else if (action.action === SqlTableActionKind.Insert) {
            await this.insertTableName(table.tableName);
        }
        else if (action.action === SqlTableActionKind.Copy) {
            await vscode.env.clipboard.writeText(table.tableName);
        }
    }

    // #endregion

    // #region Command Functions

    /**
     * Called when the person wants to find a table by name on a server.
     *
     * @param node The tree node the command was invoked on, if any.
     */
    private async goToTable(node?: ITreeNode): Promise<void> {
        const serverUrl = await this.getTargetServerUrl(node);

        if (!serverUrl) {
            return;
        }

        let tables: SqlTableReference[];

        try {
            tables = await vscode.window.withProgress({
                cancellable: false,
                location: vscode.ProgressLocation.Window,
                title: "Loading tables"
            }, () => this.objectExplorer.getTables(serverUrl));
        }
        catch (error) {
            if (error instanceof Error) {
                await vscode.window.showErrorMessage(error.message);
            }

            return;
        }

        if (tables.length === 0) {
            await vscode.window.showInformationMessage("No tables were found on this server.");

            return;
        }

        const picked = await vscode.window.showQuickPick(buildTableQuickPickItems(tables), {
            title: "Go to Table",
            placeHolder: "Search for a table",
            matchOnDescription: true
        });

        if (!picked) {
            return;
        }

        await this.performTableAction(picked.table);
    }

    /**
     * Called when the person wants to discard everything cached for a server's
     * SQL subtree and load it again.
     *
     * @param node The tree node the command was invoked on.
     */
    private refreshObjectExplorer(node?: ITreeNode): void {
        if (!isSqlTreeNode(node)) {
            return;
        }

        this.objectExplorer.refresh(node);
    }

    // #endregion
}
