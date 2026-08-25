import * as vscode from "vscode";
import { sqlLanguageId } from "./bindingManager";
import { findPersonAliasMisjoins } from "./rockCatalog";

/** The setting that turns the Rock aware warnings on and off. */
const diagnosticsSettingKey = "magnus.sql.diagnostics";

/** The source shown beside each warning in the Problems panel. */
const diagnosticSource = "magnus-sql";

/** How long typing has to pause before a document is scanned again. */
const debounceMs = 400;

/**
 * Warns about the Rock mistakes that a query cannot tell you about itself.
 *
 * There is exactly one rule so far, the `Person.Id` against `PersonAliasId`
 * misjoin, and it is a warning rather than an error because the query is valid
 * T-SQL that runs and returns rows. The scan is debounced because it walks the
 * whole document, and it runs against the document text alone: no server, no
 * schema, nothing to fetch, so an unbound editor is warned about the same as a
 * bound one.
 *
 * The rule is opt in and off by default, because a legitimate query against
 * `PersonAlias` is common enough that the warning read as noise. The setting is
 * read on every scan and watched for changes, so turning it on scans every open
 * SQL document and turning it off clears what is published.
 */
export class SqlDiagnostics implements vscode.Disposable {
    // #region Private Properties

    /** The warnings we have published, per document. */
    private collection: vscode.DiagnosticCollection;

    /** The handle of the pending scan of each document, keyed by document URI. */
    private debounceHandles: Map<string, ReturnType<typeof setTimeout>> = new Map<string, ReturnType<typeof setTimeout>>();

    /** The things we have to let go of when the extension shuts down. */
    private disposables: vscode.Disposable[] = [];

    // #endregion

    // #region Constructors

    /**
     * Creates a new instance of the diagnostics and starts watching SQL
     * documents. Everything it hooks up is disposed with the instance, which
     * `extension.ts` puts in the extension's subscriptions.
     */
    public constructor() {
        this.collection = vscode.languages.createDiagnosticCollection(diagnosticSource);

        this.disposables.push(this.collection);

        this.disposables.push(vscode.workspace.onDidOpenTextDocument(document => this.schedule(document)));
        this.disposables.push(vscode.workspace.onDidChangeTextDocument(event => this.schedule(event.document)));
        this.disposables.push(vscode.workspace.onDidCloseTextDocument(document => this.forget(document)));

        this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(diagnosticsSettingKey)) {
                this.refreshAll();
            }
        }));

        this.refreshAll();

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
    }

    // #endregion

    // #region Private Functions

    /**
     * Determines if the warnings are switched on.
     *
     * The fallback matches the `false` default declared in `package.json`: the
     * warnings are opt in, so the absence of a value means off.
     *
     * @returns True if documents should be scanned.
     */
    private isEnabled(): boolean {
        return vscode.workspace.getConfiguration().get<boolean>(diagnosticsSettingKey, false);
    }

    /**
     * Scans every open SQL document, or clears everything when the warnings have
     * been switched off.
     */
    private refreshAll(): void {
        if (!this.isEnabled()) {
            this.collection.clear();

            return;
        }

        for (const document of vscode.workspace.textDocuments) {
            this.scan(document);
        }
    }

    /**
     * Asks for a document to be scanned once typing has paused.
     *
     * The setting is read here as well as in {@link scan}, because the warnings
     * are off by default: without this every keystroke in every SQL editor set a
     * timer whose only job was to find out there was nothing to do.
     *
     * @param document The document that changed or was opened.
     */
    private schedule(document: vscode.TextDocument): void {
        if (document.languageId !== sqlLanguageId) {
            return;
        }

        if (!this.isEnabled()) {
            return;
        }

        const key = document.uri.toString();
        const pending = this.debounceHandles.get(key);

        if (pending !== undefined) {
            clearTimeout(pending);
        }

        this.debounceHandles.set(key, setTimeout(() => {
            this.debounceHandles.delete(key);
            this.scan(document);
        }, debounceMs));
    }

    /**
     * Drops the warnings of a document that was closed.
     *
     * @param document The document that was closed.
     */
    private forget(document: vscode.TextDocument): void {
        const key = document.uri.toString();
        const pending = this.debounceHandles.get(key);

        if (pending !== undefined) {
            clearTimeout(pending);
            this.debounceHandles.delete(key);
        }

        this.collection.delete(document.uri);
    }

    /**
     * Scans one document and publishes what it found.
     *
     * @param document The document to scan.
     */
    private scan(document: vscode.TextDocument): void {
        if (document.languageId !== sqlLanguageId) {
            return;
        }

        if (!this.isEnabled()) {
            this.collection.delete(document.uri);

            return;
        }

        const findings = findPersonAliasMisjoins(document.getText());

        if (findings.length === 0) {
            this.collection.delete(document.uri);

            return;
        }

        this.collection.set(document.uri, findings.map(finding => {
            const range = new vscode.Range(document.positionAt(finding.startOffset), document.positionAt(finding.endOffset));
            const diagnostic = new vscode.Diagnostic(range, finding.message, vscode.DiagnosticSeverity.Warning);

            diagnostic.source = diagnosticSource;

            return diagnostic;
        }));
    }

    // #endregion
}
