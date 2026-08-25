import { ExportFormat, exportFileExtensions } from "./serializers/formats";
import { maskNonCode } from "./sqlContext";
import { sqlIdentifierPattern } from "./sqlLexemes";

/**
 * The decisions the results grid's commands need, kept away from the vscode API
 * so that each one is a unit test rather than a click.
 *
 * Three questions live here: which tab a finished run should land on, what a
 * copy as INSERT should call the table, and what an export's save dialog should
 * offer.
 */

/** The number of rows past which an export shows a progress notification. */
export const exportProgressRowThreshold = 5000;

/** The label of the "any file" entry of an export save dialog. */
export const allFilesFilterLabel = "All Files";

/** The label each export format's save dialog filter uses. */
export const exportFilterLabels: Readonly<Record<ExportFormat, string>> = {
    csv: "CSV",
    json: "JSON",
    excel: "Excel Workbook"
};

/**
 * Which tab of the results panel is showing.
 */
export type PanelTab =
    /** The Messages tab. */
    | { kind: "messages" }
    /** One of the result set tabs, by its position. */
    | { kind: "results"; index: number };

/**
 * Decides which tab a finished run should land on.
 *
 * Rows are what someone ran a SELECT for, so the first result set wins whenever
 * there is one. A run that returned no rows at all has nothing to show but its
 * messages, and those are usually the point (a PRINT, a row count, an error).
 *
 * The webview repeats this rule, because it cannot import TypeScript. Having the
 * authoritative version here is what makes it testable.
 *
 * @param setCount The number of result sets the run produced.
 *
 * @returns The tab to show.
 */
export function defaultPanelTab(setCount: number): PanelTab {
    if (!Number.isFinite(setCount) || setCount < 1) {
        return {
            kind: "messages"
        };
    }

    return {
        kind: "results",
        index: 0
    };
}

/**
 * Finds the table a query selected from, when it selected from exactly one.
 *
 * Copy as INSERT needs a table name, and asking for one every time would be
 * tedious for the common case of `SELECT … FROM [Person]`. This is a cheap
 * textual test, not a parser: anything with a join, a union, a second table in
 * the FROM clause, a derived table or more than one statement yields null and
 * the caller asks instead. Being wrong in the cautious direction only costs a
 * prompt.
 *
 * The test runs against the masked text, so a `JOIN` inside a comment or a
 * string literal is invisible to it. Masking is `sqlContext`'s, not a fourth
 * hand rolled comment scanner: this one used to close a block comment on the
 * first `*` `/` it found, which left the tail of a nested comment behind.
 * Masking preserves every offset, so the name this matches is still spelled the
 * way the query spelled it.
 *
 * @param queryText The text that was executed.
 *
 * @returns The table name as it was written, or null when the query was not a single table select.
 */
export function extractSingleTableName(queryText: string): string | null {
    const text = maskNonCode(queryText).trim().replace(/;\s*$/, "");

    if (text === "" || !/^select\b/i.test(text)) {
        return null;
    }

    // Anything that combines tables, or that is more than one statement, is out
    // of scope by design.
    if (/\b(join|apply|union|except|intersect|pivot|unpivot|into)\b/i.test(text)) {
        return null;
    }

    if (/;/.test(text) || /(^|\s)go(\s|$)/i.test(text)) {
        return null;
    }

    const fromMatches = text.match(/\bfrom\b/gi);

    if (!fromMatches || fromMatches.length !== 1) {
        return null;
    }

    const match = new RegExp(`\\bfrom\\s+(${sqlIdentifierPattern}(?:\\s*\\.\\s*${sqlIdentifierPattern}){0,2})([\\s\\S]*)$`, "i").exec(text);

    if (!match) {
        return null;
    }

    const name = match[1].replace(/\s*\.\s*/g, ".");
    const rest = match[2].trimStart();

    // A comma after the table means a second table follows, which the FROM test
    // above cannot see.
    if (rest.startsWith(",")) {
        return null;
    }

    // A table variable or temp table is a real single table, but it is not
    // something an INSERT should be aimed at by default.
    if (name.startsWith("@") || name.startsWith("#")) {
        return null;
    }

    return name;
}

/**
 * Builds the file name an export's save dialog starts with.
 *
 * The name is taken from the query editor so that exporting from two editors
 * does not offer the same file name twice. A result set index only appears when
 * the run produced more than one set, since `Query-1-results-1.csv` reads like
 * there should be a second file.
 *
 * @param documentLabel The label of the query editor, such as `Query-1.sql`.
 * @param resultSet The result set being exported, or "all" for every set at once.
 * @param format The format being exported to.
 * @param setCount The number of result sets the run produced.
 *
 * @returns The file name, including its extension.
 */
export function buildExportFileName(documentLabel: string, resultSet: number | "all", format: ExportFormat, setCount: number): string {
    const base = sanitizeFileNamePart(documentLabel.replace(/\.sql$/i, ""));
    const stem = base === "" ? "Query" : base;
    const numbered = resultSet !== "all" && setCount > 1
        ? `-${Math.max(0, Math.floor(resultSet)) + 1}`
        : "";

    return `${stem}-results${numbered}.${exportFileExtensions[format]}`;
}

/**
 * Builds the filters of an export's save dialog.
 *
 * @param format The format being exported to.
 *
 * @returns The filters, keyed by the label the dialog shows.
 */
export function exportDialogFilters(format: ExportFormat): Record<string, string[]> {
    return {
        [exportFilterLabels[format]]: [exportFileExtensions[format]],
        [allFilesFilterLabel]: ["*"]
    };
}

/**
 * Decides whether an export is big enough to be worth a progress notification.
 *
 * @param rowCount The number of rows being exported.
 *
 * @returns True when the export should report progress.
 */
export function needsExportProgress(rowCount: number): boolean {
    return Number.isFinite(rowCount) && rowCount >= exportProgressRowThreshold;
}

/**
 * Describes a finished export for its notification.
 *
 * @param fileName The name of the file that was written.
 * @param rowCount The number of rows that were written.
 *
 * @returns The text of the notification.
 */
export function describeExportResult(fileName: string, rowCount: number): string {
    const rows = Math.max(0, Math.floor(rowCount));

    return `Exported ${rows.toLocaleString("en-US")} ${rows === 1 ? "row" : "rows"} to ${fileName}.`;
}

/**
 * Removes the characters no file system wants in a file name.
 *
 * @param text The text to clean up.
 *
 * @returns The text with its path and wildcard characters replaced by hyphens.
 */
function sanitizeFileNamePart(text: string): string {
    return text
        .replace(/[\\/:*?"<>|]/g, "-")
        .replace(/\s+/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^-+|-+$/g, "");
}
