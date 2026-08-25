/**
 * The naming of the untitled query editors that New Query and Scratch Query
 * open, and the label those editors lend to their results panel.
 *
 * A plain untitled document takes its tab caption from the first line of its
 * own content, so the tab renames itself and changes width on every keystroke.
 * Naming the document up front, by opening `untitled:Query-1.sql` rather than an
 * anonymous buffer, gives the tab a caption that never moves. The `.sql`
 * extension is what earns the editor its language mode, so the name carries the
 * binding, the syntax highlighting and the CodeLens with it.
 *
 * Everything here is pure: the counter is passed in and handed back, so the
 * numbering can be tested without opening an editor.
 */

/** The scheme of an untitled document, which is what makes the name stick. */
export const untitledScheme = "untitled";

/** What every generated query name starts with. */
export const queryNamePrefix = "Query-";

/** The extension every generated query name ends with, which selects the language. */
export const queryNameExtension = ".sql";

/**
 * A generated name and the counter to generate the next one from.
 */
export type QueryDocumentName = {
    /** The file name of the new document, such as `Query-3.sql`. */
    name: string;

    /** The counter the next name should be generated from. */
    nextCounter: number;
};

/**
 * Builds the name of the nth query editor.
 *
 * @param counter The number to name the editor after, counting from one.
 *
 * @returns The file name, such as `Query-3.sql`.
 */
export function buildQueryDocumentName(counter: number): string {
    return `${queryNamePrefix}${Math.max(1, Math.trunc(counter))}${queryNameExtension}`;
}

/**
 * Picks the next unused query name.
 *
 * The counter only ever moves forward within a window, so reopening after a
 * close does not reuse a caption someone was looking at a moment ago. Names that
 * are already open are skipped as well, which covers a document restored by a
 * window reload, whose name the counter knows nothing about.
 *
 * @param counter The number to start looking from, counting from one.
 * @param takenNames The names of the untitled documents that are already open.
 *
 * @returns The name to use and the counter to continue from.
 */
export function nextQueryDocumentName(counter: number, takenNames: readonly string[]): QueryDocumentName {
    const taken = new Set(takenNames.map(name => name.toLowerCase()));
    let candidate = Math.max(1, Math.trunc(counter));

    while (taken.has(buildQueryDocumentName(candidate).toLowerCase())) {
        candidate = candidate + 1;
    }

    return {
        name: buildQueryDocumentName(candidate),
        nextCounter: candidate + 1
    };
}

/**
 * Builds the URI that opens a named untitled document.
 *
 * @param name The file name of the document.
 *
 * @returns The URI, as a string, for `vscode.Uri.parse`.
 */
export function buildUntitledQueryUri(name: string): string {
    return `${untitledScheme}:${name}`;
}

/**
 * Gets the label of a query document, which is what its tab shows and what its
 * results panel is titled after.
 *
 * @param uriPath The path component of the document's URI.
 *
 * @returns The last segment of the path, or the path itself when it has only one.
 */
export function queryDocumentLabel(uriPath: string): string {
    const trimmed = uriPath.replace(/\/+$/, "");
    const lastSlash = trimmed.lastIndexOf("/");
    const label = lastSlash < 0 ? trimmed : trimmed.substring(lastSlash + 1);

    return label === "" ? uriPath : label;
}
