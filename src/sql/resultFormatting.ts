import { QueryColumn, QueryColumnType } from "./types";
import { unbracketIdentifier } from "./sqlLexemes";

/**
 * Turning raw result set values into text: how one cell is displayed in the
 * grid, and how a rectangular selection of cells becomes a tab delimited
 * block, a Markdown table, CSV, JSON, or a set of INSERT statements.
 *
 * Everything here is pure. The grid, the Copy as… menu and the file export
 * serializers all share these functions, which is what keeps a copied cell and
 * an exported cell identical.
 *
 * Cell display semantics are ported from the retired Azure Data Studio
 * extension (magnus-ads `src/utils.ts`) with two deliberate changes: dates are
 * ISO formatted rather than space separated, and NULL is reported as a flag on
 * the formatted cell instead of being flattened into the literal text "null"
 * that a real string value could also produce.
 */

/** The number of leading bytes shown when a byte array is previewed. */
export const byteArrayPreviewBytes = 32;

/** The text used for a value that is NULL. */
export const nullDisplayText = "NULL";

/**
 * One cell, formatted for display.
 *
 * `isNull` is carried separately so that the grid can dim a NULL without
 * having to guess whether the text "NULL" came from the database or from this
 * module, and so that every export can pick its own representation of NULL.
 */
export type FormattedCell = {
    /** The text to show for the cell. */
    display: string;

    /** True when the underlying value was NULL. */
    isNull: boolean;
};

/** The formats a selection can be copied as. */
export type CopyFormat =
    /** Tab delimited, no header row. */
    | "tabDelimited"
    /** Tab delimited with a header row. */
    | "tabDelimitedWithHeaders"
    /** A GitHub flavored Markdown table. */
    | "markdown"
    /** RFC 4180 CSV with a header row. */
    | "csv"
    /** An array of objects, one per row. */
    | "json"
    /** One INSERT statement per row. */
    | "insert";

/** Every copy format, in the order the Copy as… menu lists them. */
export const copyFormats: readonly CopyFormat[] = [
    "tabDelimited",
    "tabDelimitedWithHeaders",
    "markdown",
    "csv",
    "json",
    "insert"
];

/** The kinds of content the cell inspector knows how to present. */
export type CellContentKind = "json" | "xml" | "text";

/**
 * The characters that make Excel, Numbers or Sheets read a pasted or imported
 * cell as a formula rather than as text.
 *
 * The tab and the carriage return are in the list because a leading one of
 * either shifts the value into the neighboring cell, which is how a formula gets
 * smuggled past a reader who is looking at the first column.
 */
export const spreadsheetFormulaLeaders: readonly string[] = ["=", "+", "-", "@", "\t", "\r"];

/**
 * The number of cells a copy may cover before it is worth confirming.
 *
 * A selection this size is minutes of typing to make by accident (a select all
 * on a large result set) and hundreds of megabytes of string to build, so it is
 * asked about rather than simply attempted.
 */
export const largeCopyCellThreshold = 100000;

/** The number of rows one chunk of a chunked copy build covers. */
export const copyChunkRows = 500;

/**
 * The options shared by every format that a spreadsheet might read.
 */
export type CellSanitizeOptions = {
    /**
     * Whether to neutralize a value that a spreadsheet would read as a formula.
     * Defaults to true, so that a caller which forgets the option is safe.
     */
    sanitizeSpreadsheetCells?: boolean;
};

/**
 * The options that shape a CSV document.
 */
export type CsvOptions = CellSanitizeOptions & {
    /** Whether to write a header row. Defaults to true. */
    includeHeaders?: boolean;

    /** The field delimiter. Defaults to a comma. */
    delimiter?: string;

    /** The line separator. Defaults to CRLF, which is what RFC 4180 specifies. */
    lineSeparator?: string;

    /**
     * The text written for a NULL value. Defaults to an empty unquoted field,
     * which RFC 4180 readers accept and which stays distinguishable from an
     * empty string, since an empty string is always written as a quoted pair.
     */
    nullText?: string;
};

/**
 * What a copy of a given size should do before it starts.
 */
export type CopyPlan = {
    /** True when the person should be asked before the text is built. */
    needsConfirmation: boolean;

    /** The number of cells the copy covers. */
    cellCount: number;

    /** The question to put to the person, or null when there is nothing to ask. */
    confirmationMessage: string | null;
};

/**
 * Decides whether a copy is large enough to confirm before it runs.
 *
 * The count comes from the selected rectangle rather than from the extracted
 * rows, so that a select all on a very large result set is caught before any of
 * it is materialized.
 *
 * @param rowCount The number of rows the selection covers.
 * @param columnCount The number of columns the selection covers.
 * @param threshold The number of cells above which a copy is confirmed.
 *
 * @returns Whether to ask, and what to ask.
 */
export function planCopy(rowCount: number, columnCount: number, threshold: number = largeCopyCellThreshold): CopyPlan {
    const rows = Math.max(0, Math.floor(rowCount));
    const columns = Math.max(0, Math.floor(columnCount));
    const cellCount = rows * columns;

    if (cellCount <= threshold) {
        return {
            needsConfirmation: false,
            cellCount,
            confirmationMessage: null
        };
    }

    return {
        needsConfirmation: true,
        cellCount,
        confirmationMessage: `This copies ${cellCount.toLocaleString("en-US")} cells, which may take a while and use a lot of memory. Copy anyway?`
    };
}

/**
 * Determines whether a value would be read as a formula by a spreadsheet.
 *
 * A value whose whole text is a plain numeric literal is exempt: no spreadsheet
 * treats `-5` as anything but the number minus five, and quoting it would turn a
 * real number column into a column of text that no longer sorts or sums. A value
 * such as `-5+3`, which does evaluate, is not a plain literal and is caught.
 *
 * @param text The rendered text of the cell.
 *
 * @returns True when the value needs neutralizing.
 */
export function needsSpreadsheetSanitization(text: string): boolean {
    if (text === "" || !spreadsheetFormulaLeaders.includes(text.charAt(0))) {
        return false;
    }

    return !/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text);
}

/**
 * Neutralizes a value that a spreadsheet would read as a formula.
 *
 * The single quote prefix is the convention every spreadsheet understands: it is
 * consumed on import and the rest of the value is stored as text.
 *
 * @param text The rendered text of the cell.
 *
 * @returns The text, prefixed when it needed neutralizing.
 */
export function sanitizeSpreadsheetCell(text: string): string {
    return needsSpreadsheetSanitization(text) ? `'${text}` : text;
}

/**
 * Determines whether a raw value from a result set is NULL.
 *
 * The server sends JSON, so a database NULL arrives as `null`; `undefined`
 * shows up when a row is shorter than its column list.
 *
 * @param value The raw value from the result set.
 *
 * @returns True when the value should be treated as NULL.
 */
export function isNullValue(value: unknown): boolean {
    return value === null || value === undefined;
}

/**
 * Formats one cell for display.
 *
 * This is the entry point callers should reach for. It handles NULL itself and
 * reports it as a flag, leaving `getCellDisplayValue` to deal only with values
 * that actually exist.
 *
 * @param type The type of the column the value came from.
 * @param value The raw value from the result set.
 *
 * @returns The display text plus whether the value was NULL.
 */
export function formatCell(type: QueryColumnType, value: unknown): FormattedCell {
    if (isNullValue(value)) {
        return {
            display: nullDisplayText,
            isNull: true
        };
    }

    return {
        display: getCellDisplayValue(type, value),
        isNull: false
    };
}

/**
 * Gets the text that represents a value of the given column type.
 *
 * NULL is not this function's concern: a NULL yields an empty string, and
 * callers that care use `formatCell` or `isNullValue` instead. Nothing here
 * consults the current locale, so the same value formats the same way on every
 * machine.
 *
 * @param type The type of the column the value came from.
 * @param value The raw value from the result set.
 *
 * @returns The text that represents the value.
 */
export function getCellDisplayValue(type: QueryColumnType, value: unknown): string {
    if (isNullValue(value)) {
        return "";
    }

    switch (type) {
        case QueryColumnType.Boolean:
            return coerceBoolean(value) ? "1" : "0";

        case QueryColumnType.DateTime:
            return formatDateTime(value);

        case QueryColumnType.Number:
            return formatNumber(value);

        case QueryColumnType.ByteArray:
            return formatByteArray(value);

        default:
            return stringifyScalar(value);
    }
}

/**
 * Formats a date or time value as ISO 8601.
 *
 * SQL Server datetime columns have no time zone, and the server serializes
 * them as a local wall clock reading. Shifting one of those into UTC would
 * silently move it by the extension host's offset, so a string that already
 * carries no offset is normalized textually and keeps its wall clock. Only a
 * value that names its own instant, such as a `Date` or a string with a `Z` or
 * a numeric offset, is converted through `Date`.
 *
 * @param value The raw value from the result set.
 *
 * @returns The ISO 8601 text for the value, or the value as-is when it cannot be parsed.
 */
export function formatDateTime(value: unknown): string {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? "" : value.toISOString();
    }

    if (typeof value === "string") {
        const local = matchOffsetlessDateTime(value.trim());

        if (local) {
            return local;
        }
    }

    const parsed = Date.parse(stringifyScalar(value));

    if (Number.isNaN(parsed)) {
        return stringifyScalar(value);
    }

    return new Date(parsed).toISOString();
}

/**
 * Formats a numeric value using invariant rules.
 *
 * Decimals and money columns often arrive as strings so that no precision is
 * lost crossing the wire, and those are passed through untouched rather than
 * being rounded through a JavaScript number.
 *
 * @param value The raw value from the result set.
 *
 * @returns The text that represents the number.
 */
export function formatNumber(value: unknown): string {
    if (typeof value === "number") {
        if (Number.isNaN(value)) {
            return "NaN";
        }

        if (!Number.isFinite(value)) {
            return value > 0 ? "Infinity" : "-Infinity";
        }

        return Object.is(value, -0) ? "0" : String(value);
    }

    if (typeof value === "bigint") {
        return value.toString();
    }

    if (typeof value === "boolean") {
        return value ? "1" : "0";
    }

    return stringifyScalar(value);
}

/**
 * Formats a byte array as a truncated hexadecimal preview.
 *
 * A `varbinary(max)` column can hold megabytes, which no grid cell should ever
 * try to show, so only the first `byteArrayPreviewBytes` bytes are rendered and
 * an ellipsis marks the rest. Byte arrays reach the client either as an array
 * of byte values or as text the server already encoded; text is passed through
 * and truncated the same way.
 *
 * @param value The raw value from the result set.
 *
 * @returns A `0x…` preview of the bytes.
 */
export function formatByteArray(value: unknown): string {
    const bytes = toByteValues(value);

    if (bytes) {
        const shown = bytes.slice(0, byteArrayPreviewBytes);
        const hex = shown.map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();

        return `0x${hex}${bytes.length > shown.length ? "…" : ""}`;
    }

    const text = stringifyScalar(value);
    const limit = byteArrayPreviewBytes * 2 + 2;

    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Builds the tab delimited text for a selection.
 *
 * Tabs and line breaks inside a value would break the row and column alignment
 * that the format depends on, so they are collapsed to single spaces. Anything
 * that needs to survive round-tripping should be copied as CSV or JSON.
 *
 * A tab delimited block is what a paste into a spreadsheet lands in, so a value
 * a spreadsheet would read as a formula is neutralized unless the caller turns
 * that off.
 *
 * @param columns The columns of the selection, in order.
 * @param rows The rows of the selection, each with one value per column.
 * @param includeHeaders Whether to start with a row of column names.
 * @param options Whether to neutralize a value a spreadsheet would read as a formula.
 *
 * @returns The text to put on the clipboard.
 */
export function buildTabDelimited(columns: QueryColumn[], rows: unknown[][], includeHeaders: boolean, options?: CellSanitizeOptions): string {
    return assemble(tabDelimitedPlan(columns, includeHeaders, options), rows);
}

/**
 * Builds a Markdown table for a selection.
 *
 * Pipes are escaped and line breaks become `<br>` so that a value can never
 * split a cell, and every table carries its header row because Markdown has no
 * way to express a table without one.
 *
 * @param columns The columns of the selection, in order.
 * @param rows The rows of the selection, each with one value per column.
 *
 * @returns The Markdown text to put on the clipboard.
 */
export function buildMarkdownTable(columns: QueryColumn[], rows: unknown[][]): string {
    return assemble(markdownPlan(columns), rows);
}

/**
 * Builds an RFC 4180 CSV document for a selection or a whole result set.
 *
 * The same function serves the Copy as CSV command and the CSV file export, so
 * that a copied block and an exported file never disagree.
 *
 * A CSV is opened in a spreadsheet more often than it is read by anything else,
 * so a value a spreadsheet would read as a formula is neutralized unless the
 * caller turns that off.
 *
 * @param columns The columns to write, in order.
 * @param rows The rows to write, each with one value per column.
 * @param options The delimiter, line separator, header, NULL and sanitization choices.
 *
 * @returns The CSV document.
 */
export function buildCsv(columns: QueryColumn[], rows: unknown[][], options?: CsvOptions): string {
    return assemble(csvPlan(columns, options), rows);
}

/**
 * Builds a JSON document for a selection or a whole result set.
 *
 * Values keep their type wherever that is meaningful: numbers stay numbers,
 * booleans stay booleans, NULL is `null`, and dates become ISO strings. Byte
 * arrays become their hexadecimal preview, since a JSON document is not the
 * place to inline a blob.
 *
 * @param columns The columns to write, in order.
 * @param rows The rows to write, each with one value per column.
 *
 * @returns The JSON document, indented with two spaces.
 */
export function buildJson(columns: QueryColumn[], rows: unknown[][]): string {
    const keys = uniqueColumnKeys(columns);
    const objects = rows.map(row => {
        const object: Record<string, unknown> = {};

        for (let index = 0; index < columns.length; index++) {
            object[keys[index]] = jsonValueFor(columns[index], row[index]);
        }

        return object;
    });

    return JSON.stringify(objects, undefined, 2);
}

/**
 * Builds one INSERT statement per row of a selection.
 *
 * Identifiers are bracket quoted and string literals are `N` prefixed, so that
 * a Unicode value survives a paste into a `nvarchar` column. Every literal is
 * escaped; the statements are meant to be pasted into an editor and reviewed,
 * not executed blind.
 *
 * @param tableName The table to insert into, optionally schema qualified.
 * @param columns The columns to write, in order.
 * @param rows The rows to write, each with one value per column.
 *
 * @returns The statements, one per line.
 */
export function buildInsertStatements(tableName: string, columns: QueryColumn[], rows: unknown[][]): string {
    return assemble(insertPlan(tableName, columns), rows);
}

/**
 * Builds the clipboard text for a selection in the requested format.
 *
 * @param format The format the person picked from the Copy as… menu.
 * @param columns The columns of the selection, in order.
 * @param rows The rows of the selection, each with one value per column.
 * @param tableName The table name to use for INSERT statements.
 * @param options Whether to neutralize a value a spreadsheet would read as a formula.
 *
 * @returns The text to put on the clipboard.
 */
export function buildCopyText(format: CopyFormat, columns: QueryColumn[], rows: unknown[][], tableName?: string, options?: CellSanitizeOptions): string {
    return buildCopyTextChunks(format, columns, rows, tableName, rows.length + 1, options).join("");
}

/**
 * Builds the clipboard text for a selection in pieces, a chunk of rows at a
 * time.
 *
 * Concatenating the pieces gives exactly what {@link buildCopyText} returns, so
 * a caller that wants to yield to the event loop between chunks does not have to
 * accept a different document to get one. A very large selection is minutes of
 * frozen extension host if it is built in a single expression, which is the
 * whole reason this exists.
 *
 * @param format The format the person picked from the Copy as… menu.
 * @param columns The columns of the selection, in order.
 * @param rows The rows of the selection, each with one value per column.
 * @param tableName The table name to use for INSERT statements.
 * @param chunkRows The number of rows one piece covers.
 * @param options Whether to neutralize a value a spreadsheet would read as a formula.
 *
 * @returns The pieces of the document, in order.
 */
export function buildCopyTextChunks(
    format: CopyFormat,
    columns: QueryColumn[],
    rows: unknown[][],
    tableName?: string,
    chunkRows: number = copyChunkRows,
    options?: CellSanitizeOptions
): string[] {
    const chunk = Math.max(1, Math.floor(chunkRows));

    if (format === "json") {
        return buildJsonChunks(columns, rows, chunk);
    }

    return assembleChunks(copyPlanFor(format, columns, tableName, options), rows, chunk);
}

/**
 * Determines whether a value is one of the copy formats.
 *
 * @param value The value to check, which may have come from the webview.
 *
 * @returns True when the value names a copy format.
 */
export function isCopyFormat(value: unknown): value is CopyFormat {
    return typeof value === "string" && (copyFormats as readonly string[]).includes(value);
}

/**
 * Guesses what kind of content a cell holds so that the inspector can present
 * it well.
 *
 * The test is deliberately cheap: JSON is whatever `JSON.parse` accepts as an
 * object or an array, which rules out a bare number or a quoted string that
 * happens to be valid JSON, and XML is text that opens with a tag-looking
 * `<name`, `</name`, `<?xml` or `<!DOCTYPE` and closes that bracket somewhere.
 * Nothing here validates the markup; being wrong only means the inspector shows
 * plain text.
 *
 * @param display The display text of the cell.
 *
 * @returns The kind of content detected.
 */
export function detectCellContent(display: string): CellContentKind {
    const text = display.trim();

    if (text === "") {
        return "text";
    }

    if (text.startsWith("{") || text.startsWith("[")) {
        try {
            const parsed: unknown = JSON.parse(text);

            if (typeof parsed === "object" && parsed !== null) {
                return "json";
            }
        }
        catch {
            // Not JSON, fall through to the other tests.
        }
    }

    if (/^<[?!/]?[A-Za-z_]/.test(text) && text.includes(">")) {
        return "xml";
    }

    return "text";
}

/**
 * Pretty prints a JSON document with a stable two space indent.
 *
 * @param text The text to pretty print.
 *
 * @returns The formatted document, or the text unchanged when it is not JSON.
 */
export function prettyPrintJson(text: string): string {
    try {
        return JSON.stringify(JSON.parse(text), undefined, 2);
    }
    catch {
        return text;
    }
}

/**
 * Produces the key each column contributes to a JSON object, keeping the keys
 * unique.
 *
 * A query such as `SELECT p.Id, g.Id FROM …` yields two columns called `Id`,
 * and an unaliased expression yields a column with no name at all. The first
 * use of a name keeps it, later uses get a `_2`, `_3` suffix, and an unnamed
 * column becomes `column1` by its position.
 *
 * @param columns The columns of the result set, in order.
 *
 * @returns One key per column, in the same order.
 */
export function uniqueColumnKeys(columns: QueryColumn[]): string[] {
    const used = new Map<string, number>();
    const keys: string[] = [];

    for (let index = 0; index < columns.length; index++) {
        const base = columns[index].name !== "" ? columns[index].name : `column${index + 1}`;
        const seen = used.get(base) ?? 0;

        used.set(base, seen + 1);

        if (seen === 0) {
            keys.push(base);
            continue;
        }

        // Keep going until the suffixed name is not itself already taken.
        let attempt = seen + 1;
        let candidate = `${base}_${attempt}`;

        while (used.has(candidate)) {
            attempt += 1;
            candidate = `${base}_${attempt}`;
        }

        used.set(candidate, 1);
        used.set(base, attempt);
        keys.push(candidate);
    }

    return keys;
}

/**
 * Quotes one identifier for SQL Server.
 *
 * @param name The identifier to quote.
 *
 * @returns The bracket quoted identifier.
 */
export function quoteIdentifier(name: string): string {
    return `[${name.replace(/]/g, "]]")}]`;
}

/**
 * Quotes a possibly qualified identifier such as `dbo.Person`.
 *
 * A dot inside brackets is not treated as a separator. A part that arrives
 * already bracketed is unwrapped and re-quoted rather than passed through, so
 * that a stray `]` inside it is always doubled: passing it through verbatim let
 * a name such as `[Person] DROP TABLE [X] --]` survive intact into generated
 * SQL. Re-quoting is idempotent for every well formed name.
 *
 * @param name The identifier to quote.
 *
 * @returns The bracket quoted identifier, one pair per part.
 */
export function quoteQualifiedIdentifier(name: string): string {
    return splitQualifiedName(name)
        .map(part => quoteIdentifier(unbracketIdentifier(part)))
        .join(".");
}

/**
 * Splits a qualified name into its parts, respecting brackets.
 *
 * @param name The name to split.
 *
 * @returns The parts of the name, which is the whole name when it has none.
 */
function splitQualifiedName(name: string): string[] {
    const parts: string[] = [];
    let current = "";
    let bracketed = false;

    for (const character of name) {
        if (character === "[") {
            bracketed = true;
        }
        else if (character === "]") {
            bracketed = false;
        }

        if (character === "." && !bracketed) {
            parts.push(current);
            current = "";
            continue;
        }

        current += character;
    }

    parts.push(current);

    return parts.filter(p => p !== "");
}

/**
 * Produces the SQL literal for one value.
 *
 * @param column The column the value came from.
 * @param value The raw value from the result set.
 *
 * @returns The literal to place in a VALUES list.
 */
function sqlLiteralFor(column: QueryColumn, value: unknown): string {
    if (isNullValue(value)) {
        return "NULL";
    }

    if (column.type === QueryColumnType.Boolean) {
        return coerceBoolean(value) ? "1" : "0";
    }

    if (column.type === QueryColumnType.Number) {
        const text = formatNumber(value);

        // Anything that is not a plain number is quoted rather than pasted
        // bare, so that a surprising value cannot become syntax.
        return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text) ? text : quoteStringLiteral(text);
    }

    if (column.type === QueryColumnType.ByteArray) {
        const bytes = toByteValues(value);

        if (bytes) {
            return `0x${bytes.map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
        }

        const text = stringifyScalar(value);

        return /^0[xX][0-9a-fA-F]*$/.test(text) ? text : quoteStringLiteral(text);
    }

    if (column.type === QueryColumnType.DateTime) {
        // A datetime literal is a plain string in SQL Server and needs no N
        // prefix, since it holds no characters outside of ASCII.
        return `'${formatDateTime(value).replace(/'/g, "''")}'`;
    }

    return quoteStringLiteral(stringifyScalar(value));
}

/**
 * Quotes a string literal for SQL Server, doubling any embedded quote.
 *
 * @param text The text to quote.
 *
 * @returns The `N` prefixed literal.
 */
function quoteStringLiteral(text: string): string {
    return `N'${text.replace(/'/g, "''")}'`;
}

/**
 * Produces the JSON value for one cell.
 *
 * @param column The column the value came from.
 * @param value The raw value from the result set.
 *
 * @returns The value to place in the JSON object.
 */
function jsonValueFor(column: QueryColumn, value: unknown): unknown {
    if (isNullValue(value)) {
        return null;
    }

    if (column.type === QueryColumnType.Boolean) {
        return coerceBoolean(value);
    }

    if (column.type === QueryColumnType.Number) {
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }

        const text = formatNumber(value);
        const parsed = Number(text);

        // A decimal that arrived as a string only becomes a JSON number when it
        // round-trips exactly, so no precision is invented or lost.
        return text !== "" && Number.isFinite(parsed) && String(parsed) === text ? parsed : text;
    }

    if (column.type === QueryColumnType.DateTime) {
        return formatDateTime(value);
    }

    if (column.type === QueryColumnType.ByteArray) {
        return formatByteArray(value);
    }

    if (column.type === QueryColumnType.Unknown && (typeof value === "number" || typeof value === "boolean")) {
        return value;
    }

    return stringifyScalar(value);
}

/**
 * How one line based format lays a document out.
 *
 * Every format except JSON is a run of lines with an optional heading and an
 * optional trailing separator, which is what lets one assembler serve all of
 * them and lets the chunked build stay byte identical to the whole one.
 */
type LinePlan = {
    /** The lines that come before the rows, such as a header row. */
    prefix: string[];

    /** Builds the line one row becomes. */
    lineFor: (row: unknown[]) => string;

    /** The text placed between two lines. */
    separator: string;

    /** The text placed after the last line, or an empty string for none. */
    suffix: string;
};

/**
 * Assembles a whole document from a line plan.
 *
 * @param plan The layout of the format.
 * @param rows The rows to write, each with one value per column.
 *
 * @returns The document.
 */
function assemble(plan: LinePlan, rows: unknown[][]): string {
    const lines = [...plan.prefix, ...rows.map(row => plan.lineFor(row))];

    return lines.length === 0 ? "" : `${lines.join(plan.separator)}${plan.suffix}`;
}

/**
 * Assembles a document from a line plan in pieces, a chunk of rows at a time.
 *
 * Each piece after the first carries the separator that joins it to the one
 * before, so that concatenating the pieces gives what {@link assemble} returns.
 *
 * @param plan The layout of the format.
 * @param rows The rows to write, each with one value per column.
 * @param chunkRows The number of lines one piece covers.
 *
 * @returns The pieces of the document, in order.
 */
function assembleChunks(plan: LinePlan, rows: unknown[][], chunkRows: number): string[] {
    const chunks: string[] = [];
    let buffer: string[] = [...plan.prefix];
    let isFirst = true;

    const flush = (): void => {
        if (buffer.length === 0) {
            return;
        }

        chunks.push(isFirst ? buffer.join(plan.separator) : `${plan.separator}${buffer.join(plan.separator)}`);
        isFirst = false;
        buffer = [];
    };

    for (const row of rows) {
        buffer.push(plan.lineFor(row));

        if (buffer.length >= chunkRows) {
            flush();
        }
    }

    flush();

    if (chunks.length > 0 && plan.suffix !== "") {
        chunks.push(plan.suffix);
    }

    return chunks;
}

/**
 * Picks the line plan of one copy format.
 *
 * @param format The format the person picked from the Copy as… menu.
 * @param columns The columns of the selection, in order.
 * @param tableName The table name to use for INSERT statements.
 * @param options Whether to neutralize a value a spreadsheet would read as a formula.
 *
 * @returns The layout of the format.
 */
function copyPlanFor(format: Exclude<CopyFormat, "json">, columns: QueryColumn[], tableName: string | undefined, options: CellSanitizeOptions | undefined): LinePlan {
    switch (format) {
        case "tabDelimited":
            return tabDelimitedPlan(columns, false, options);

        case "tabDelimitedWithHeaders":
            return tabDelimitedPlan(columns, true, options);

        case "markdown":
            return markdownPlan(columns);

        case "csv":
            return csvPlan(columns, options);

        case "insert":
            return insertPlan(tableName && tableName !== "" ? tableName : "Table", columns);
    }
}

/**
 * Builds the line plan of a tab delimited block.
 *
 * @param columns The columns of the selection, in order.
 * @param includeHeaders Whether to start with a row of column names.
 * @param options Whether to neutralize a value a spreadsheet would read as a formula.
 *
 * @returns The layout of the format.
 */
function tabDelimitedPlan(columns: QueryColumn[], includeHeaders: boolean, options: CellSanitizeOptions | undefined): LinePlan {
    const sanitize = options?.sanitizeSpreadsheetCells ?? true;
    // The value is neutralized before it is flattened, so that a leading tab is
    // still recognizable as one rather than having already become a space.
    const cell = (text: string): string => flatten(sanitize ? sanitizeSpreadsheetCell(text) : text);

    return {
        prefix: includeHeaders ? [columns.map(c => cell(c.name)).join("\t")] : [],
        lineFor: row => columns.map((column, index) => cell(displayFor(column, row[index]))).join("\t"),
        separator: "\n",
        suffix: ""
    };
}

/**
 * Builds the line plan of a Markdown table.
 *
 * @param columns The columns of the selection, in order.
 *
 * @returns The layout of the format.
 */
function markdownPlan(columns: QueryColumn[]): LinePlan {
    return {
        prefix: [
            `| ${columns.map(c => escapeMarkdown(c.name)).join(" | ")} |`,
            `| ${columns.map(() => "---").join(" | ")} |`
        ],
        lineFor: row => `| ${columns.map((column, index) => escapeMarkdown(displayFor(column, row[index]))).join(" | ")} |`,
        separator: "\n",
        suffix: ""
    };
}

/**
 * Builds the line plan of a CSV document.
 *
 * @param columns The columns to write, in order.
 * @param options The delimiter, line separator, header, NULL and sanitization choices.
 *
 * @returns The layout of the format.
 */
function csvPlan(columns: QueryColumn[], options: CsvOptions | undefined): LinePlan {
    const includeHeaders = options?.includeHeaders ?? true;
    const delimiter = options?.delimiter ?? ",";
    const lineSeparator = options?.lineSeparator ?? "\r\n";
    const nullText = options?.nullText ?? "";
    const sanitize = options?.sanitizeSpreadsheetCells ?? true;

    return {
        prefix: includeHeaders ? [columns.map(c => encodeCsvField(c.name, delimiter, sanitize)).join(delimiter)] : [],
        lineFor: row => columns
            .map((column, index) => {
                const value = row[index];

                if (isNullValue(value)) {
                    return nullText === "" ? "" : encodeCsvField(nullText, delimiter, sanitize);
                }

                return encodeCsvField(getCellDisplayValue(column.type, value), delimiter, sanitize);
            })
            .join(delimiter),
        separator: lineSeparator,
        suffix: lineSeparator
    };
}

/**
 * Builds the line plan of a run of INSERT statements.
 *
 * @param tableName The table to insert into, optionally schema qualified.
 * @param columns The columns to write, in order.
 *
 * @returns The layout of the format.
 */
function insertPlan(tableName: string, columns: QueryColumn[]): LinePlan {
    const target = quoteQualifiedIdentifier(tableName);
    const columnList = columns.map(c => quoteIdentifier(c.name)).join(", ");

    return {
        prefix: [],
        lineFor: row => `INSERT INTO ${target} (${columnList}) VALUES (${columns.map((column, index) => sqlLiteralFor(column, row[index])).join(", ")});`,
        separator: "\n",
        suffix: ""
    };
}

/**
 * Builds a JSON document in pieces, a chunk of rows at a time.
 *
 * The pieces reproduce what `JSON.stringify(objects, undefined, 2)` produces,
 * which is what lets the chunked build and {@link buildJson} stay identical
 * without either one holding the whole array of objects at once.
 *
 * @param columns The columns to write, in order.
 * @param rows The rows to write, each with one value per column.
 * @param chunkRows The number of rows one piece covers.
 *
 * @returns The pieces of the document, in order.
 */
function buildJsonChunks(columns: QueryColumn[], rows: unknown[][], chunkRows: number): string[] {
    if (rows.length === 0) {
        return ["[]"];
    }

    const keys = uniqueColumnKeys(columns);
    const chunks: string[] = ["[\n"];
    let buffer: string[] = [];

    const flush = (): void => {
        if (buffer.length === 0) {
            return;
        }

        chunks.push(`${chunks.length === 1 ? "" : ",\n"}${buffer.join(",\n")}`);
        buffer = [];
    };

    for (const row of rows) {
        const object: Record<string, unknown> = {};

        for (let index = 0; index < columns.length; index++) {
            object[keys[index]] = jsonValueFor(columns[index], row[index]);
        }

        buffer.push(indentJson(JSON.stringify(object, undefined, 2)));

        if (buffer.length >= chunkRows) {
            flush();
        }
    }

    flush();
    chunks.push("\n]");

    return chunks;
}

/**
 * Indents every line of one serialized object by the two spaces that an entry of
 * a pretty printed array carries.
 *
 * @param text The serialized object.
 *
 * @returns The indented text.
 */
function indentJson(text: string): string {
    return text.split("\n").map(line => `  ${line}`).join("\n");
}

/**
 * Displays one value of a column, using the NULL text for a NULL.
 *
 * @param column The column the value came from.
 * @param value The raw value from the result set.
 *
 * @returns The display text.
 */
function displayFor(column: QueryColumn, value: unknown): string {
    return formatCell(column.type, value).display;
}

/**
 * Collapses tabs and line breaks so that a value cannot break a tab delimited
 * block.
 *
 * @param text The text to flatten.
 *
 * @returns The text with its tabs and line breaks turned into spaces.
 */
function flatten(text: string): string {
    return text.replace(/\r\n|\r|\n|\t/g, " ");
}

/**
 * Escapes a value for a Markdown table cell.
 *
 * @param text The text to escape.
 *
 * @returns The escaped text.
 */
function escapeMarkdown(text: string): string {
    return text
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|")
        .replace(/\r\n|\r|\n/g, "<br>");
}

/**
 * Encodes one CSV field, quoting it when RFC 4180 requires it.
 *
 * An empty string is always quoted, which is what keeps it distinct from a NULL
 * written as an empty field.
 *
 * A neutralized field is always quoted as well, so that the single quote prefix
 * reaches the spreadsheet as part of the value instead of being trimmed or
 * reinterpreted by a lenient reader.
 *
 * @param text The text of the field.
 * @param delimiter The delimiter in use.
 * @param sanitize Whether to neutralize a value a spreadsheet would read as a formula.
 *
 * @returns The encoded field.
 */
function encodeCsvField(text: string, delimiter: string, sanitize: boolean): string {
    if (sanitize && needsSpreadsheetSanitization(text)) {
        return `"'${text.replace(/"/g, "\"\"")}"`;
    }

    const needsQuotes = text === ""
        || text.includes(delimiter)
        || text.includes("\"")
        || text.includes("\r")
        || text.includes("\n")
        || text !== text.trim();

    if (!needsQuotes) {
        return text;
    }

    return `"${text.replace(/"/g, "\"\"")}"`;
}

/**
 * Interprets a value as a boolean.
 *
 * A `bit` column can arrive as a boolean, as 1 and 0, or as text, depending on
 * how the value made it through JSON serialization.
 *
 * @param value The raw value from the result set.
 *
 * @returns The boolean the value represents.
 */
function coerceBoolean(value: unknown): boolean {
    if (typeof value === "boolean") {
        return value;
    }

    if (typeof value === "number") {
        return value !== 0;
    }

    if (typeof value === "string") {
        const text = value.trim().toLowerCase();

        return text === "true" || text === "1" || text === "yes";
    }

    return Boolean(value);
}

/**
 * Reads a value as an array of byte values.
 *
 * @param value The raw value from the result set.
 *
 * @returns The bytes, or null when the value is not a byte sequence.
 */
function toByteValues(value: unknown): number[] | null {
    if (value instanceof Uint8Array) {
        return Array.from(value);
    }

    if (Array.isArray(value) && value.every(entry => typeof entry === "number" && Number.isFinite(entry))) {
        return value.map(entry => Math.max(0, Math.min(255, Math.floor(entry as number))));
    }

    return null;
}

/**
 * Converts a scalar to text without going through the current locale.
 *
 * @param value The raw value from the result set.
 *
 * @returns The text for the value.
 */
function stringifyScalar(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    if (typeof value === "number") {
        return formatNumber(value);
    }

    if (typeof value === "object") {
        try {
            return JSON.stringify(value) ?? "";
        }
        catch {
            return String(value);
        }
    }

    return String(value);
}

/**
 * Normalizes a datetime string that carries no time zone offset.
 *
 * @param text The trimmed text of the value.
 *
 * @returns The ISO text with the same wall clock, or null when the text is not one of these.
 */
function matchOffsetlessDateTime(text: string): string | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,7}))?)?$/.exec(text);

    if (!match) {
        return null;
    }

    const [, year, month, day, hour, minute, second, fraction] = match;
    const milliseconds = (fraction ?? "").padEnd(3, "0").slice(0, 3);

    return `${year}-${month}-${day}T${hour ?? "00"}:${minute ?? "00"}:${second ?? "00"}.${milliseconds}`;
}
