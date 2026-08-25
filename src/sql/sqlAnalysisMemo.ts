import { analyzeSql, SqlAnalysis } from "./sqlContext";

/**
 * Holds the analysis of the documents that are being typed in, so that one
 * keystroke costs one scan of the document rather than one per rule that wants
 * to know something about it.
 *
 * The key is the document URI and the version, which is exactly what makes an
 * analysis reusable: a document version is immutable, so an analysis of it can
 * never go stale. A new version simply replaces the entry for its document,
 * because nothing wants the previous version of a document someone is typing in.
 *
 * Nothing here touches vscode. The caller passes the URI and the version as a
 * string and a number, which keeps this unit testable.
 */

/** How many documents the memo holds an analysis for at once. */
const defaultCapacity = 4;

/**
 * A memo of document analyses, keyed by document and version.
 */
export class SqlAnalysisMemo {
    // #region Private Properties

    /** The greatest number of documents to hold an analysis for. */
    private capacity: number;

    /** The analysis held for each document, keyed by the document's key. */
    private entries: Map<string, { version: number; analysis: SqlAnalysis }> = new Map<string, { version: number; analysis: SqlAnalysis }>();

    // #endregion

    // #region Constructors

    /**
     * Creates a new memo.
     *
     * @param capacity The greatest number of documents to hold an analysis for.
     */
    public constructor(capacity: number = defaultCapacity) {
        this.capacity = Math.max(1, capacity);
    }

    // #endregion

    // #region Public Functions

    /**
     * Gets the analysis of a document version, computing it the first time it is
     * asked for.
     *
     * @param key The key of the document, which is its URI as a string.
     * @param version The version of the document.
     * @param text The text of that version of the document.
     *
     * @returns The analysis of that version.
     */
    public get(key: string, version: number, text: string): SqlAnalysis {
        const existing = this.entries.get(key);

        if (existing && existing.version === version) {
            return existing.analysis;
        }

        const analysis = analyzeSql(text);

        this.entries.delete(key);
        this.entries.set(key, { version, analysis });

        while (this.entries.size > this.capacity) {
            const oldest = this.entries.keys().next();

            if (oldest.done) {
                break;
            }

            this.entries.delete(oldest.value);
        }

        return analysis;
    }

    /**
     * Drops whatever is held for a document, which the caller does when the
     * document is closed.
     *
     * @param key The key of the document, which is its URI as a string.
     */
    public forget(key: string): void {
        this.entries.delete(key);
    }

    // #endregion
}
