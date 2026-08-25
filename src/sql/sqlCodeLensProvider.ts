import * as vscode from "vscode";
import { sqlLanguageId } from "./bindingManager";
import { buildRunLenses } from "./runDecisions";

/** The setting that turns the per statement lenses on and off. */
const codeLensSettingKey = "magnus.sql.codeLens";

/** How long typing has to pause before the statements are parsed again. */
const debounceMs = 300;

/**
 * Puts a "Run" lens above each statement of a SQL document.
 *
 * The statement boundaries come from the same pure splitter the run commands
 * use, so a lens always runs exactly what `Ctrl+Enter` on that line would.
 * Re-parsing is debounced because the splitter walks the whole document and
 * someone typing a long script would otherwise pay for it on every keystroke.
 */
export class SqlCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    // #region Private Properties

    /** The emitter used to tell Visual Studio Code that the lenses changed. */
    private didChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();

    /**
     * The handle of the pending debounced refresh of each document, keyed by
     * document URI.
     *
     * One handle for the whole window meant that typing in one editor cancelled
     * the pending refresh of another, so a document someone had stopped typing
     * in could sit with stale lenses for as long as they kept typing elsewhere.
     */
    private debounceHandles: Map<string, ReturnType<typeof setTimeout>> = new Map<string, ReturnType<typeof setTimeout>>();

    /** The things we have to let go of when the extension shuts down. */
    private disposables: vscode.Disposable[] = [];

    // #endregion

    // #region Constructors

    /**
     * Creates a new instance of the CodeLens provider, registered for SQL
     * documents. The registration is disposed with the instance, which
     * `extension.ts` puts in the extension's subscriptions.
     */
    public constructor() {
        this.disposables.push(vscode.languages.registerCodeLensProvider({
            language: sqlLanguageId
        }, this));

        this.disposables.push(vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.languageId === sqlLanguageId) {
                this.scheduleRefresh(event.document.uri.toString());
            }
        }));

        this.disposables.push(vscode.workspace.onDidCloseTextDocument(document => this.forget(document.uri.toString())));

        this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(codeLensSettingKey)) {
                this.didChangeCodeLenses.fire();
            }
        }));

    }

    /** @inheritdoc */
    public dispose(): void {
        for (const handle of this.debounceHandles.values()) {
            clearTimeout(handle);
        }

        this.debounceHandles.clear();

        for (const disposable of this.disposables) {
            disposable.dispose();
        }

        this.disposables = [];
        this.didChangeCodeLenses.dispose();
    }

    // #endregion

    // #region Public Properties

    /** @inheritdoc */
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this.didChangeCodeLenses.event;

    // #endregion

    // #region Private Functions

    /**
     * Asks for the lenses to be rebuilt once typing in a document has paused.
     *
     * @param key The URI of the document that changed, as a string.
     */
    private scheduleRefresh(key: string): void {
        const pending = this.debounceHandles.get(key);

        if (pending !== undefined) {
            clearTimeout(pending);
        }

        this.debounceHandles.set(key, setTimeout(() => {
            this.debounceHandles.delete(key);

            this.didChangeCodeLenses.fire();
        }, debounceMs));
    }

    /**
     * Drops the pending refresh of a document that was closed.
     *
     * @param key The URI of the document that was closed, as a string.
     */
    private forget(key: string): void {
        const pending = this.debounceHandles.get(key);

        if (pending !== undefined) {
            clearTimeout(pending);
            this.debounceHandles.delete(key);
        }
    }

    // #endregion

    // #region CodeLensProvider

    /** @inheritdoc */
    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] {
        if (document.languageId !== sqlLanguageId) {
            return [];
        }

        // Both of these are checked before the document is read, because reading
        // it and splitting it is the whole cost of this method.
        if (!vscode.workspace.getConfiguration().get<boolean>(codeLensSettingKey, true)) {
            return [];
        }

        if (token.isCancellationRequested) {
            return [];
        }

        return buildRunLenses(document.getText(), true).map(lens => {
            const position = document.positionAt(lens.startOffset);

            return new vscode.CodeLens(new vscode.Range(position, position), {
                title: "$(play) Run",
                tooltip: "Run this statement",
                command: "magnus.sql.runStatement",
                arguments: [
                    {
                        documentUri: document.uri.toString(),
                        offset: lens.startOffset
                    }
                ]
            });
        });
    }

    // #endregion
}
