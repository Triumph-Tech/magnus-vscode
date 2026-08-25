import { CopyFormat, FormattedCell, formatCell, isCopyFormat } from "./resultFormatting";
import { ExportFormat, isExportFormat } from "./serializers/formats";
import { QueryColumn, QueryColumnType, QueryMessage, QueryResultSet } from "./types";

/**
 * The message protocol spoken between the extension host and the results panel
 * webview.
 *
 * Both directions are described here, as types plus validators, so that the
 * panel and the webview never guess at each other's shapes. The webview is
 * untrusted input as far as the extension host is concerned, so every message
 * arriving from it is shape validated before it is acted on. The extension side
 * of the protocol is validated too, which is what lets the whole protocol be
 * unit tested without a webview.
 *
 * Phase 2B carried the panel shell and the Messages view. Phase 3 adds the
 * result set payloads the grid needs, on top of the 2B messages rather than in
 * place of them.
 *
 * ## How result sets reach the grid
 *
 * Rows are streamed, not posted as one payload, because a single 10,000 row
 * `postMessage` is a stall the person can see. One result set arrives as:
 *
 * 1. `resultSetStart` — the columns, the total row count, how many rows are
 *    about to be sent, and the truncation notice when the render cap applies.
 *    The webview creates the tab and its header here.
 * 2. `resultSetRows` — one message per chunk of rows, in ascending order, each
 *    stating the row index it starts at so that a dropped or reordered message
 *    cannot silently shift the grid.
 * 3. `resultSetEnd` — no more rows are coming for this set.
 *
 * Cells cross the boundary already formatted (`FormattedCell`), so the webview
 * holds no copy of the formatting rules and a raw value never has to be
 * serialized twice in two different ways. The raw values stay on the extension
 * side, which is what lets a copy or an export cover all rows including those
 * past the render cap.
 *
 * Everything beyond the cap is fetched on demand: the webview sends
 * `requestRows` as it scrolls and the extension answers with `moreRows`, which
 * carries the same formatted cells plus whether anything remains after them.
 */

/** The status a finished run ended in. */
export type RunStatus = "succeeded" | "failed" | "cancelled";

/**
 * A summary of the result sets a run produced. The rows themselves are not part
 * of the phase 2B protocol; the Messages view shows this summary instead of a
 * grid.
 */
export type ResultSetSummary = {
    /** The number of result sets the query produced. */
    setCount: number;

    /** The total number of rows across all of the result sets. */
    rowCount: number;
};

/** The number of rows carried by one `resultSetRows` or `moreRows` message. */
export const resultSetChunkRows = 500;

/** The largest number of rows the webview may ask for in one request. */
export const maxRequestedRows = 5000;

/**
 * One row of a result set, as the webview receives it: every cell already
 * formatted for display, with NULL flagged rather than inferred from the text.
 */
export type ResultRowPayload = FormattedCell[];

/**
 * A message sent from the extension host to the results panel webview.
 */
export type ExtensionToPanelMessage =
    /** A run has started, which clears the panel and starts its timer. */
    | { type: "runStarted"; serverLabel: string; statementPreview: string }
    /** Messages the server emitted since the last update. */
    | { type: "messages"; messages: QueryMessage[] }
    /** A run has finished, one way or another. */
    | { type: "runCompleted"; status: RunStatus; durationMs: number; resultSets: ResultSetSummary | null; errorMessage: string | null }
    /** A result set is about to be streamed, so the webview can build its tab. */
    | { type: "resultSetStart"; index: number; columns: QueryColumn[]; totalRows: number; renderedRows: number; truncatedNotice: string | null }
    /** A chunk of rows of a result set, starting at the stated row. */
    | { type: "resultSetRows"; index: number; startRow: number; rows: ResultRowPayload[] }
    /** Every row of the initial render of a result set has been sent. */
    | { type: "resultSetEnd"; index: number }
    /** The rows the webview asked for while scrolling past the render cap. */
    | { type: "moreRows"; index: number; startRow: number; rows: ResultRowPayload[]; hasMore: boolean };

/**
 * A message sent from the results panel webview to the extension host.
 *
 * Opening the cell or row inspector is deliberately absent: the webview already
 * holds every formatted cell it is showing, so it opens its own inspector
 * without a round trip.
 */
export type PanelToExtensionMessage =
    /** The webview has loaded and is able to render. */
    | { type: "ready" }
    /** The person clicked a message that carries a line number. */
    | { type: "revealLine"; lineNumber: number }
    /** The person clicked the cancel button while a run was in flight. */
    | { type: "cancelRun" }
    /** The grid scrolled to rows it does not hold yet. */
    | { type: "requestRows"; resultSet: number; startRow: number; count: number }
    /** The person picked an entry from the Copy as… menu. */
    | { type: "copySelection"; resultSet: number; startRow: number; startColumn: number; endRow: number; endColumn: number; format: CopyFormat }
    /** The person clicked an export button, for one result set or for all of them. */
    | { type: "exportResultSet"; resultSet: number | "all"; format: ExportFormat };

/**
 * Validates a value that arrived from the webview.
 *
 * Anything that is not exactly one of the known shapes yields null, and the
 * caller ignores it. A webview cannot be trusted to send well formed messages,
 * and a malformed one must never reach a command.
 *
 * @param value The value received from the webview.
 *
 * @returns The validated message, or null if it is not one.
 */
export function parsePanelMessage(value: unknown): PanelToExtensionMessage | null {
    const bag = asMessageBag(value);

    if (!bag) {
        return null;
    }

    if (bag.type === "ready") {
        return {
            type: "ready"
        };
    }

    if (bag.type === "cancelRun") {
        return {
            type: "cancelRun"
        };
    }

    if (bag.type === "revealLine") {
        const lineNumber = bag["lineNumber"];

        if (typeof lineNumber !== "number" || !Number.isFinite(lineNumber) || lineNumber < 1) {
            return null;
        }

        return {
            type: "revealLine",
            lineNumber: Math.floor(lineNumber)
        };
    }

    if (bag.type === "requestRows") {
        const resultSet = wholeNumber(bag["resultSet"]);
        const startRow = wholeNumber(bag["startRow"]);
        const count = wholeNumber(bag["count"]);

        if (resultSet === null || startRow === null || count === null || count < 1) {
            return null;
        }

        return {
            type: "requestRows",
            resultSet,
            startRow,
            // A webview asking for a million rows at once would undo the point
            // of chunking, so the request is capped rather than refused.
            count: Math.min(count, maxRequestedRows)
        };
    }

    if (bag.type === "copySelection") {
        const resultSet = wholeNumber(bag["resultSet"]);
        const startRow = wholeNumber(bag["startRow"]);
        const startColumn = wholeNumber(bag["startColumn"]);
        const endRow = wholeNumber(bag["endRow"]);
        const endColumn = wholeNumber(bag["endColumn"]);
        const format = bag["format"];

        if (resultSet === null || startRow === null || startColumn === null || endRow === null || endColumn === null) {
            return null;
        }

        if (!isCopyFormat(format)) {
            return null;
        }

        if (endRow < startRow || endColumn < startColumn) {
            return null;
        }

        return {
            type: "copySelection",
            resultSet,
            startRow,
            startColumn,
            endRow,
            endColumn,
            format
        };
    }

    if (bag.type === "exportResultSet") {
        const format = bag["format"];

        if (!isExportFormat(format)) {
            return null;
        }

        if (bag["resultSet"] === "all") {
            return {
                type: "exportResultSet",
                resultSet: "all",
                format
            };
        }

        const resultSet = wholeNumber(bag["resultSet"]);

        if (resultSet === null) {
            return null;
        }

        return {
            type: "exportResultSet",
            resultSet,
            format
        };
    }

    return null;
}

/**
 * Validates a value that the extension host is about to post, or that the
 * webview received.
 *
 * The webview is plain JavaScript and cannot import this module, so it repeats a
 * minimal version of these checks. Having the authoritative version here keeps
 * the protocol unit testable and gives phase 3 one place to extend.
 *
 * @param value The value posted to the webview.
 *
 * @returns The validated message, or null if it is not one.
 */
export function parseExtensionMessage(value: unknown): ExtensionToPanelMessage | null {
    const bag = asMessageBag(value);

    if (!bag) {
        return null;
    }

    if (bag.type === "runStarted") {
        if (typeof bag["serverLabel"] !== "string" || typeof bag["statementPreview"] !== "string") {
            return null;
        }

        return {
            type: "runStarted",
            serverLabel: bag["serverLabel"],
            statementPreview: bag["statementPreview"]
        };
    }

    if (bag.type === "messages") {
        const messages = parseMessages(bag["messages"]);

        if (!messages) {
            return null;
        }

        return {
            type: "messages",
            messages
        };
    }

    if (bag.type === "runCompleted") {
        const status = bag["status"];
        const durationMs = bag["durationMs"];

        if (status !== "succeeded" && status !== "failed" && status !== "cancelled") {
            return null;
        }

        if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
            return null;
        }

        const resultSets = parseResultSetSummary(bag["resultSets"]);

        if (resultSets === undefined) {
            return null;
        }

        const errorMessage = bag["errorMessage"];

        if (errorMessage !== null && errorMessage !== undefined && typeof errorMessage !== "string") {
            return null;
        }

        return {
            type: "runCompleted",
            status,
            durationMs,
            resultSets,
            errorMessage: typeof errorMessage === "string" ? errorMessage : null
        };
    }

    if (bag.type === "resultSetStart") {
        const index = wholeNumber(bag["index"]);
        const totalRows = wholeNumber(bag["totalRows"]);
        const renderedRows = wholeNumber(bag["renderedRows"]);
        const columns = parseColumns(bag["columns"]);
        const truncatedNotice = bag["truncatedNotice"];

        if (index === null || totalRows === null || renderedRows === null || !columns) {
            return null;
        }

        if (renderedRows > totalRows) {
            return null;
        }

        if (truncatedNotice !== null && truncatedNotice !== undefined && typeof truncatedNotice !== "string") {
            return null;
        }

        return {
            type: "resultSetStart",
            index,
            columns,
            totalRows,
            renderedRows,
            truncatedNotice: typeof truncatedNotice === "string" ? truncatedNotice : null
        };
    }

    if (bag.type === "resultSetRows" || bag.type === "moreRows") {
        const index = wholeNumber(bag["index"]);
        const startRow = wholeNumber(bag["startRow"]);
        const rows = parseRowPayloads(bag["rows"]);

        if (index === null || startRow === null || !rows) {
            return null;
        }

        if (bag.type === "resultSetRows") {
            return {
                type: "resultSetRows",
                index,
                startRow,
                rows
            };
        }

        if (typeof bag["hasMore"] !== "boolean") {
            return null;
        }

        return {
            type: "moreRows",
            index,
            startRow,
            rows,
            hasMore: bag["hasMore"]
        };
    }

    if (bag.type === "resultSetEnd") {
        const index = wholeNumber(bag["index"]);

        if (index === null) {
            return null;
        }

        return {
            type: "resultSetEnd",
            index
        };
    }

    return null;
}

/**
 * Formats one row of a result set for the webview.
 *
 * A row shorter than the column list is padded with NULL rather than with
 * undefined cells the grid would have to defend against.
 *
 * @param columns The columns of the result set.
 * @param row The raw values of the row.
 *
 * @returns The formatted cells, one per column.
 */
export function formatRowPayload(columns: QueryColumn[], row: unknown[]): ResultRowPayload {
    return columns.map((column, index) => formatCell(column.type, row[index]));
}

/**
 * Builds every message needed to stream the initial render of one result set.
 *
 * The render cap decides how many rows are sent up front; the rest wait for a
 * `requestRows`. A capped set still reports its true total, since the footer
 * has to state the full count.
 *
 * @param index The position of the result set among the run's result sets.
 * @param resultSet The result set to stream.
 * @param initialRows The number of rows to send up front, from the render plan.
 * @param truncatedNotice The notice from the render plan, or null when nothing was held back.
 * @param chunkRows The number of rows per message.
 *
 * @returns The messages to post, in order.
 */
export function buildResultSetStream(
    index: number,
    resultSet: QueryResultSet,
    initialRows: number,
    truncatedNotice: string | null,
    chunkRows: number = resultSetChunkRows
): ExtensionToPanelMessage[] {
    const messages: ExtensionToPanelMessage[] = [];
    const length = resultSetStreamLength(resultSet.rows.length, initialRows, chunkRows);

    for (let position = 0; position < length; position++) {
        messages.push(buildResultSetStreamChunk(index, resultSet, initialRows, truncatedNotice, position, chunkRows));
    }

    return messages;
}

/**
 * Counts the messages the initial render of one result set takes.
 *
 * A caller that posts the stream across several turns of the event loop needs to
 * know how many messages there are without building any of them, which is what
 * this is for.
 *
 * @param totalRows The number of rows the result set holds.
 * @param initialRows The number of rows to send up front, from the render plan.
 * @param chunkRows The number of rows per message.
 *
 * @returns The number of messages the stream holds, which is never fewer than two.
 */
export function resultSetStreamLength(totalRows: number, initialRows: number, chunkRows: number = resultSetChunkRows): number {
    const rendered = renderedRowCount(totalRows, initialRows);
    const chunk = Math.max(1, Math.floor(chunkRows));

    return 2 + Math.ceil(rendered / chunk);
}

/**
 * Builds one message of the initial render of a result set.
 *
 * The first message is the `resultSetStart`, the last is the `resultSetEnd`, and
 * everything between is a chunk of rows. Building them one at a time is what
 * lets the panel format a large result set across several turns of the event
 * loop instead of in the tick that finished the run.
 *
 * @param index The position of the result set among the run's result sets.
 * @param resultSet The result set to stream.
 * @param initialRows The number of rows to send up front, from the render plan.
 * @param truncatedNotice The notice from the render plan, or null when nothing was held back.
 * @param position The position of the wanted message in the stream.
 * @param chunkRows The number of rows per message.
 *
 * @returns The message to post.
 */
export function buildResultSetStreamChunk(
    index: number,
    resultSet: QueryResultSet,
    initialRows: number,
    truncatedNotice: string | null,
    position: number,
    chunkRows: number = resultSetChunkRows
): ExtensionToPanelMessage {
    const totalRows = resultSet.rows.length;
    const rendered = renderedRowCount(totalRows, initialRows);
    const chunk = Math.max(1, Math.floor(chunkRows));
    const length = resultSetStreamLength(totalRows, initialRows, chunkRows);

    if (position <= 0) {
        return {
            type: "resultSetStart",
            index,
            columns: resultSet.columns,
            totalRows,
            renderedRows: rendered,
            truncatedNotice
        };
    }

    if (position >= length - 1) {
        return {
            type: "resultSetEnd",
            index
        };
    }

    const startRow = (position - 1) * chunk;

    return {
        type: "resultSetRows",
        index,
        startRow,
        rows: resultSet.rows
            .slice(startRow, Math.min(startRow + chunk, rendered))
            .map(row => formatRowPayload(resultSet.columns, row))
    };
}

/**
 * Clamps the render plan's row count to what the result set actually holds.
 *
 * @param totalRows The number of rows the result set holds.
 * @param initialRows The number of rows the render plan asked for.
 *
 * @returns The number of rows the initial render covers.
 */
function renderedRowCount(totalRows: number, initialRows: number): number {
    return Math.max(0, Math.min(Math.floor(initialRows), totalRows));
}

/**
 * Builds the answer to a `requestRows` message.
 *
 * A request that starts past the end of the result set is answered with no rows
 * rather than with an error, since a grid can legitimately ask for rows that a
 * newer, shorter result set no longer has.
 *
 * @param index The position of the result set among the run's result sets.
 * @param resultSet The result set the rows come from.
 * @param startRow The first row requested.
 * @param count The number of rows requested.
 *
 * @returns The message to post.
 */
export function buildMoreRows(index: number, resultSet: QueryResultSet, startRow: number, count: number): ExtensionToPanelMessage {
    const start = Math.max(0, Math.floor(startRow));
    const end = Math.min(resultSet.rows.length, start + Math.max(0, Math.floor(count)));
    const rows = resultSet.rows.slice(start, end).map(row => formatRowPayload(resultSet.columns, row));

    return {
        type: "moreRows",
        index,
        startRow: start,
        rows,
        hasMore: end < resultSet.rows.length
    };
}

/**
 * Describes a set of result sets in a single line for the Messages view.
 *
 * The grid shows the rows themselves, so this is no longer the only place the
 * count appears. It stays because the Messages view is the transcript of a run,
 * and "how many rows came back" belongs in it next to the PRINT output and the
 * row counts the server reported.
 *
 * @param summary The summary of the result sets a run produced.
 *
 * @returns The line to add to the Messages view.
 */
export function describeResultSets(summary: ResultSetSummary): string {
    const sets = `${summary.setCount} result ${summary.setCount === 1 ? "set" : "sets"}`;
    const rows = `${summary.rowCount.toLocaleString("en-US")} ${summary.rowCount === 1 ? "row" : "rows"}`;

    return `${sets} (${rows})`;
}

/**
 * Summarizes the result sets a completed run produced.
 *
 * @param resultSets The result sets the server returned, which may be absent.
 *
 * @returns The summary, or null when the run produced no result sets at all.
 */
export function summarizeResultSets(resultSets: { rows: unknown[][] }[] | null | undefined): ResultSetSummary | null {
    if (!resultSets || resultSets.length === 0) {
        return null;
    }

    let rowCount = 0;

    for (const set of resultSets) {
        rowCount += Array.isArray(set?.rows) ? set.rows.length : 0;
    }

    return {
        setCount: resultSets.length,
        rowCount
    };
}

/**
 * Determines whether a message should be shown as an error.
 *
 * SQL Server reports anything above severity 10 as an error; PRINT output and
 * row counts arrive with no level at all.
 *
 * @param message The message the server emitted.
 *
 * @returns True if the message is an error.
 */
export function isErrorMessage(message: QueryMessage): boolean {
    if (typeof message.code === "number" && message.code > 0) {
        return true;
    }

    return typeof message.level === "number" && message.level > 10;
}

/**
 * Narrows a value to an object with a string `type` property.
 *
 * @param value The value to narrow.
 *
 * @returns The value as a bag of properties, or null if it does not qualify.
 */
function asMessageBag(value: unknown): (Record<string, unknown> & { type: string }) | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }

    const bag = value as Record<string, unknown>;

    if (typeof bag["type"] !== "string" || bag["type"] === "") {
        return null;
    }

    return bag as Record<string, unknown> & { type: string };
}

/**
 * Validates an array of server messages.
 *
 * @param value The value that should be an array of messages.
 *
 * @returns The validated messages, or null if the value is not a valid array of them.
 */
function parseMessages(value: unknown): QueryMessage[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const messages: QueryMessage[] = [];

    for (const entry of value) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            return null;
        }

        const bag = entry as Record<string, unknown>;

        if (typeof bag["message"] !== "string") {
            return null;
        }

        messages.push({
            message: bag["message"],
            code: optionalNumber(bag["code"]),
            level: optionalNumber(bag["level"]),
            state: optionalNumber(bag["state"]),
            lineNumber: optionalNumber(bag["lineNumber"])
        });
    }

    return messages;
}

/**
 * Validates the result set summary of a completed run.
 *
 * @param value The value that should be a summary or null.
 *
 * @returns The summary, null when there is none, or undefined when the value is invalid.
 */
function parseResultSetSummary(value: unknown): ResultSetSummary | null | undefined {
    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    const bag = value as Record<string, unknown>;
    const setCount = bag["setCount"];
    const rowCount = bag["rowCount"];

    if (typeof setCount !== "number" || !Number.isFinite(setCount) || setCount < 0) {
        return undefined;
    }

    if (typeof rowCount !== "number" || !Number.isFinite(rowCount) || rowCount < 0) {
        return undefined;
    }

    return {
        setCount: Math.floor(setCount),
        rowCount: Math.floor(rowCount)
    };
}

/**
 * Reads an optional numeric property of a message.
 *
 * @param value The value of the property.
 *
 * @returns The number, or null when the property was absent or not a number.
 */
function optionalNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Validates a value that must be a non-negative whole number.
 *
 * @param value The value of the property.
 *
 * @returns The floored number, or null when the value does not qualify.
 */
function wholeNumber(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return null;
    }

    return Math.floor(value);
}

/**
 * Validates the column list of a result set.
 *
 * @param value The value that should be an array of columns.
 *
 * @returns The validated columns, or null when the value is not one.
 */
function parseColumns(value: unknown): QueryColumn[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const columns: QueryColumn[] = [];

    for (const entry of value) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            return null;
        }

        const bag = entry as Record<string, unknown>;
        const type = bag["type"];

        if (typeof bag["name"] !== "string") {
            return null;
        }

        if (typeof type !== "number" || !isColumnType(type)) {
            return null;
        }

        columns.push({
            name: bag["name"],
            type
        });
    }

    return columns;
}

/**
 * Determines whether a number is one of the known column types.
 *
 * @param value The value of the property.
 *
 * @returns True when the value names a column type.
 */
function isColumnType(value: number): value is QueryColumnType {
    return value === QueryColumnType.Unknown
        || value === QueryColumnType.String
        || value === QueryColumnType.Number
        || value === QueryColumnType.Boolean
        || value === QueryColumnType.DateTime
        || value === QueryColumnType.ByteArray;
}

/**
 * Validates a chunk of formatted rows.
 *
 * @param value The value that should be an array of rows of formatted cells.
 *
 * @returns The validated rows, or null when the value is not one.
 */
function parseRowPayloads(value: unknown): ResultRowPayload[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const rows: ResultRowPayload[] = [];

    for (const row of value) {
        if (!Array.isArray(row)) {
            return null;
        }

        const cells: FormattedCell[] = [];

        for (const cell of row) {
            if (typeof cell !== "object" || cell === null || Array.isArray(cell)) {
                return null;
            }

            const bag = cell as Record<string, unknown>;

            if (typeof bag["display"] !== "string" || typeof bag["isNull"] !== "boolean") {
                return null;
            }

            cells.push({
                display: bag["display"],
                isNull: bag["isNull"]
            });
        }

        rows.push(cells);
    }

    return rows;
}
