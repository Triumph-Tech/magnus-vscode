import { describe, expect, it } from "vitest";
import {
    buildMoreRows,
    buildResultSetStream,
    buildResultSetStreamChunk,
    ExtensionToPanelMessage,
    formatRowPayload,
    maxRequestedRows,
    parseExtensionMessage,
    parsePanelMessage,
    resultSetChunkRows,
    resultSetStreamLength
} from "../panelProtocol";
import { QueryColumn, QueryColumnType, QueryResultSet } from "../types";

/**
 * The phase 3 half of the panel protocol: the result set stream, the on-demand
 * row requests, and the copy and export requests. The phase 2B messages are
 * covered by panelProtocol.test.ts and must keep passing unchanged.
 */

const columns: QueryColumn[] = [
    { name: "Id", type: QueryColumnType.Number },
    { name: "Name", type: QueryColumnType.String }
];

/**
 * Builds a result set of sequentially numbered rows.
 *
 * @param rowCount The number of rows to build.
 *
 * @returns The result set.
 */
function makeResultSet(rowCount: number): QueryResultSet {
    const rows: unknown[][] = [];

    for (let index = 0; index < rowCount; index++) {
        rows.push([index, `name ${index}`]);
    }

    return { columns, rows };
}

describe("formatRowPayload", () => {
    it("formats each cell and flags NULL", () => {
        expect(formatRowPayload(columns, [1, null])).toEqual([
            { display: "1", isNull: false },
            { display: "NULL", isNull: true }
        ]);
    });

    it("pads a row that is shorter than the column list", () => {
        expect(formatRowPayload(columns, [1])).toEqual([
            { display: "1", isNull: false },
            { display: "NULL", isNull: true }
        ]);
    });

    it("drops values past the column list", () => {
        expect(formatRowPayload(columns, [1, "a", "extra"])).toHaveLength(2);
    });
});

describe("buildResultSetStream", () => {
    it("opens with a start, chunks the rows and closes with an end", () => {
        const messages = buildResultSetStream(0, makeResultSet(5), 5, null, 2);

        expect(messages.map(m => m.type)).toEqual(["resultSetStart", "resultSetRows", "resultSetRows", "resultSetRows", "resultSetEnd"]);
        expect(messages[0]).toEqual({
            type: "resultSetStart",
            index: 0,
            columns,
            totalRows: 5,
            renderedRows: 5,
            truncatedNotice: null
        });
    });

    it("states the starting row of every chunk", () => {
        const messages = buildResultSetStream(1, makeResultSet(5), 5, null, 2);
        const chunks = messages.filter((m): m is Extract<ExtensionToPanelMessage, { type: "resultSetRows" }> => m.type === "resultSetRows");

        expect(chunks.map(c => c.startRow)).toEqual([0, 2, 4]);
        expect(chunks.map(c => c.rows.length)).toEqual([2, 2, 1]);
        expect(chunks[0].rows[0][0]).toEqual({ display: "0", isNull: false });
        expect(chunks.every(c => c.index === 1)).toBe(true);
    });

    it("sends only the rows the render plan allows but reports the true total", () => {
        const messages = buildResultSetStream(0, makeResultSet(10), 4, "Showing the first 4 rows.", 3);
        const start = messages[0] as Extract<ExtensionToPanelMessage, { type: "resultSetStart" }>;
        const sent = messages
            .filter((m): m is Extract<ExtensionToPanelMessage, { type: "resultSetRows" }> => m.type === "resultSetRows")
            .reduce((total, chunk) => total + chunk.rows.length, 0);

        expect(start.totalRows).toBe(10);
        expect(start.renderedRows).toBe(4);
        expect(start.truncatedNotice).toBe("Showing the first 4 rows.");
        expect(sent).toBe(4);
    });

    it("sends no chunks for a result set with no rows", () => {
        const messages = buildResultSetStream(0, makeResultSet(0), 0, null);

        expect(messages.map(m => m.type)).toEqual(["resultSetStart", "resultSetEnd"]);
    });

    it("never sends more rows than the set holds", () => {
        const messages = buildResultSetStream(0, makeResultSet(2), 99, null);
        const start = messages[0] as Extract<ExtensionToPanelMessage, { type: "resultSetStart" }>;

        expect(start.renderedRows).toBe(2);
    });

    it("uses the default chunk size when none is given", () => {
        const messages = buildResultSetStream(0, makeResultSet(resultSetChunkRows + 1), resultSetChunkRows + 1, null);

        expect(messages.filter(m => m.type === "resultSetRows")).toHaveLength(2);
    });

    it("produces messages that its own validator accepts", () => {
        for (const message of buildResultSetStream(0, makeResultSet(3), 3, "notice", 2)) {
            expect(parseExtensionMessage(message)).toEqual(message);
        }
    });
});

describe("resultSetStreamLength and buildResultSetStreamChunk", () => {
    const cases: [number, number, number][] = [
        [0, 0, 2],
        [5, 5, 2],
        [3, 3, 2],
        [10, 4, 2],
        [2, 99, 2],
        [1001, 1001, 500]
    ];

    for (const [totalRows, initialRows, chunkRows] of cases) {
        it(`agrees with buildResultSetStream for ${totalRows} rows capped at ${initialRows} in chunks of ${chunkRows}`, () => {
            const resultSet = makeResultSet(totalRows);
            const whole = buildResultSetStream(0, resultSet, initialRows, "notice", chunkRows);
            const length = resultSetStreamLength(totalRows, initialRows, chunkRows);

            expect(length).toBe(whole.length);

            for (let position = 0; position < length; position++) {
                expect(buildResultSetStreamChunk(0, resultSet, initialRows, "notice", position, chunkRows)).toEqual(whole[position]);
            }
        });
    }

    it("always holds at least a start and an end", () => {
        expect(resultSetStreamLength(0, 0)).toBe(2);
    });

    it("clamps a position outside the stream to its ends", () => {
        const resultSet = makeResultSet(4);

        expect(buildResultSetStreamChunk(0, resultSet, 4, null, -3, 2).type).toBe("resultSetStart");
        expect(buildResultSetStreamChunk(0, resultSet, 4, null, 99, 2).type).toBe("resultSetEnd");
    });

    it("treats a nonsense chunk size as one row per message", () => {
        expect(resultSetStreamLength(3, 3, 0)).toBe(5);
    });
});

describe("buildMoreRows", () => {
    it("answers with the requested window and says more remain", () => {
        const message = buildMoreRows(0, makeResultSet(10), 4, 3) as Extract<ExtensionToPanelMessage, { type: "moreRows" }>;

        expect(message.startRow).toBe(4);
        expect(message.rows).toHaveLength(3);
        expect(message.rows[0][0]).toEqual({ display: "4", isNull: false });
        expect(message.hasMore).toBe(true);
    });

    it("says nothing remains once the last row is included", () => {
        const message = buildMoreRows(0, makeResultSet(10), 7, 5) as Extract<ExtensionToPanelMessage, { type: "moreRows" }>;

        expect(message.rows).toHaveLength(3);
        expect(message.hasMore).toBe(false);
    });

    it("answers a request past the end with no rows", () => {
        const message = buildMoreRows(0, makeResultSet(3), 50, 10) as Extract<ExtensionToPanelMessage, { type: "moreRows" }>;

        expect(message.rows).toEqual([]);
        expect(message.hasMore).toBe(false);
    });

    it("produces a message its own validator accepts", () => {
        const message = buildMoreRows(2, makeResultSet(4), 0, 2);

        expect(parseExtensionMessage(message)).toEqual(message);
    });
});

describe("parseExtensionMessage with grid messages", () => {
    it("accepts a start message", () => {
        const message = {
            type: "resultSetStart",
            index: 0,
            columns: [{ name: "Id", type: QueryColumnType.Number }],
            totalRows: 3,
            renderedRows: 2,
            truncatedNotice: "held back"
        };

        expect(parseExtensionMessage(message)).toEqual(message);
    });

    it("normalizes a missing truncation notice to null", () => {
        const parsed = parseExtensionMessage({ type: "resultSetStart", index: 0, columns: [], totalRows: 0, renderedRows: 0 });

        expect(parsed).toEqual({ type: "resultSetStart", index: 0, columns: [], totalRows: 0, renderedRows: 0, truncatedNotice: null });
    });

    it("rejects a start message that renders more rows than it has", () => {
        expect(parseExtensionMessage({ type: "resultSetStart", index: 0, columns: [], totalRows: 1, renderedRows: 2 })).toBeNull();
    });

    it("rejects a start message with a bad index or counts", () => {
        expect(parseExtensionMessage({ type: "resultSetStart", index: -1, columns: [], totalRows: 0, renderedRows: 0 })).toBeNull();
        expect(parseExtensionMessage({ type: "resultSetStart", index: 0, columns: [], totalRows: "3", renderedRows: 0 })).toBeNull();
        expect(parseExtensionMessage({ type: "resultSetStart", index: 0, columns: [], totalRows: 3 })).toBeNull();
    });

    it("rejects a start message with malformed columns", () => {
        expect(parseExtensionMessage({ type: "resultSetStart", index: 0, columns: "Id", totalRows: 0, renderedRows: 0 })).toBeNull();
        expect(parseExtensionMessage({ type: "resultSetStart", index: 0, columns: [{ name: "Id" }], totalRows: 0, renderedRows: 0 })).toBeNull();
        expect(parseExtensionMessage({ type: "resultSetStart", index: 0, columns: [{ name: 1, type: 1 }], totalRows: 0, renderedRows: 0 })).toBeNull();
        expect(parseExtensionMessage({ type: "resultSetStart", index: 0, columns: [{ name: "Id", type: 99 }], totalRows: 0, renderedRows: 0 })).toBeNull();
        expect(parseExtensionMessage({ type: "resultSetStart", index: 0, columns: [null], totalRows: 0, renderedRows: 0 })).toBeNull();
    });

    it("accepts every known column type", () => {
        const all = [
            QueryColumnType.Unknown,
            QueryColumnType.String,
            QueryColumnType.Number,
            QueryColumnType.Boolean,
            QueryColumnType.DateTime,
            QueryColumnType.ByteArray
        ].map(type => ({ name: "c", type }));

        const parsed = parseExtensionMessage({ type: "resultSetStart", index: 0, columns: all, totalRows: 0, renderedRows: 0 });

        expect(parsed).not.toBeNull();
    });

    it("accepts a rows message", () => {
        const message = {
            type: "resultSetRows",
            index: 1,
            startRow: 500,
            rows: [[{ display: "1", isNull: false }, { display: "NULL", isNull: true }]]
        };

        expect(parseExtensionMessage(message)).toEqual(message);
    });

    it("accepts a rows message with no rows", () => {
        expect(parseExtensionMessage({ type: "resultSetRows", index: 0, startRow: 0, rows: [] }))
            .toEqual({ type: "resultSetRows", index: 0, startRow: 0, rows: [] });
    });

    it("rejects a rows message with malformed cells", () => {
        expect(parseExtensionMessage({ type: "resultSetRows", index: 0, startRow: 0, rows: [["1"]] })).toBeNull();
        expect(parseExtensionMessage({ type: "resultSetRows", index: 0, startRow: 0, rows: [[{ display: "1" }]] })).toBeNull();
        expect(parseExtensionMessage({ type: "resultSetRows", index: 0, startRow: 0, rows: [[{ isNull: false }]] })).toBeNull();
        expect(parseExtensionMessage({ type: "resultSetRows", index: 0, startRow: 0, rows: [[{ display: 1, isNull: false }]] })).toBeNull();
        expect(parseExtensionMessage({ type: "resultSetRows", index: 0, startRow: 0, rows: [{ display: "1", isNull: false }] })).toBeNull();
        expect(parseExtensionMessage({ type: "resultSetRows", index: 0, startRow: 0, rows: "rows" })).toBeNull();
    });

    it("rejects a rows message with a negative start row", () => {
        expect(parseExtensionMessage({ type: "resultSetRows", index: 0, startRow: -1, rows: [] })).toBeNull();
    });

    it("accepts a more rows message and requires its hasMore flag", () => {
        const message = { type: "moreRows", index: 0, startRow: 10, rows: [], hasMore: true };

        expect(parseExtensionMessage(message)).toEqual(message);
        expect(parseExtensionMessage({ type: "moreRows", index: 0, startRow: 10, rows: [] })).toBeNull();
        expect(parseExtensionMessage({ type: "moreRows", index: 0, startRow: 10, rows: [], hasMore: "yes" })).toBeNull();
    });

    it("accepts an end message", () => {
        expect(parseExtensionMessage({ type: "resultSetEnd", index: 2 })).toEqual({ type: "resultSetEnd", index: 2 });
        expect(parseExtensionMessage({ type: "resultSetEnd" })).toBeNull();
        expect(parseExtensionMessage({ type: "resultSetEnd", index: -1 })).toBeNull();
    });

    it("still accepts the phase 2B messages", () => {
        expect(parseExtensionMessage({ type: "runStarted", serverLabel: "rock", statementPreview: "SELECT 1" }))
            .toEqual({ type: "runStarted", serverLabel: "rock", statementPreview: "SELECT 1" });
    });
});

describe("parsePanelMessage with grid messages", () => {
    it("accepts a row request", () => {
        expect(parsePanelMessage({ type: "requestRows", resultSet: 0, startRow: 10000, count: 200 }))
            .toEqual({ type: "requestRows", resultSet: 0, startRow: 10000, count: 200 });
    });

    it("caps an unreasonable row request rather than refusing it", () => {
        const parsed = parsePanelMessage({ type: "requestRows", resultSet: 0, startRow: 0, count: 10_000_000 });

        expect(parsed).toEqual({ type: "requestRows", resultSet: 0, startRow: 0, count: maxRequestedRows });
    });

    it("floors a fractional row request", () => {
        expect(parsePanelMessage({ type: "requestRows", resultSet: 0.4, startRow: 10.9, count: 5.6 }))
            .toEqual({ type: "requestRows", resultSet: 0, startRow: 10, count: 5 });
    });

    it("rejects a malformed row request", () => {
        expect(parsePanelMessage({ type: "requestRows", resultSet: -1, startRow: 0, count: 1 })).toBeNull();
        expect(parsePanelMessage({ type: "requestRows", resultSet: 0, startRow: -5, count: 1 })).toBeNull();
        expect(parsePanelMessage({ type: "requestRows", resultSet: 0, startRow: 0, count: 0 })).toBeNull();
        expect(parsePanelMessage({ type: "requestRows", resultSet: 0, startRow: 0 })).toBeNull();
        expect(parsePanelMessage({ type: "requestRows", resultSet: "0", startRow: 0, count: 1 })).toBeNull();
    });

    it("accepts a copy request", () => {
        const message = { type: "copySelection", resultSet: 1, startRow: 0, startColumn: 0, endRow: 5, endColumn: 2, format: "markdown" };

        expect(parsePanelMessage(message)).toEqual(message);
    });

    it("accepts a copy request covering one cell", () => {
        const message = { type: "copySelection", resultSet: 0, startRow: 3, startColumn: 3, endRow: 3, endColumn: 3, format: "csv" };

        expect(parsePanelMessage(message)).toEqual(message);
    });

    it("rejects a copy request whose rectangle is inverted", () => {
        expect(parsePanelMessage({ type: "copySelection", resultSet: 0, startRow: 5, startColumn: 0, endRow: 1, endColumn: 2, format: "csv" })).toBeNull();
        expect(parsePanelMessage({ type: "copySelection", resultSet: 0, startRow: 0, startColumn: 5, endRow: 1, endColumn: 2, format: "csv" })).toBeNull();
    });

    it("rejects a copy request with an unknown or missing format", () => {
        expect(parsePanelMessage({ type: "copySelection", resultSet: 0, startRow: 0, startColumn: 0, endRow: 0, endColumn: 0, format: "excel" })).toBeNull();
        expect(parsePanelMessage({ type: "copySelection", resultSet: 0, startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 })).toBeNull();
    });

    it("rejects a copy request with a missing bound", () => {
        expect(parsePanelMessage({ type: "copySelection", resultSet: 0, startRow: 0, startColumn: 0, endRow: 0, format: "csv" })).toBeNull();
    });

    it("accepts every copy format", () => {
        for (const format of ["tabDelimited", "tabDelimitedWithHeaders", "markdown", "csv", "json", "insert"]) {
            const message = { type: "copySelection", resultSet: 0, startRow: 0, startColumn: 0, endRow: 0, endColumn: 0, format };

            expect(parsePanelMessage(message)).toEqual(message);
        }
    });

    it("accepts an export request for one result set and for all of them", () => {
        expect(parsePanelMessage({ type: "exportResultSet", resultSet: 2, format: "excel" }))
            .toEqual({ type: "exportResultSet", resultSet: 2, format: "excel" });
        expect(parsePanelMessage({ type: "exportResultSet", resultSet: "all", format: "csv" }))
            .toEqual({ type: "exportResultSet", resultSet: "all", format: "csv" });
    });

    it("rejects an export request with an unknown format or target", () => {
        expect(parsePanelMessage({ type: "exportResultSet", resultSet: 0, format: "markdown" })).toBeNull();
        expect(parsePanelMessage({ type: "exportResultSet", resultSet: 0 })).toBeNull();
        expect(parsePanelMessage({ type: "exportResultSet", resultSet: "every", format: "csv" })).toBeNull();
        expect(parsePanelMessage({ type: "exportResultSet", format: "csv" })).toBeNull();
    });

    it("still accepts the phase 2B messages", () => {
        expect(parsePanelMessage({ type: "ready" })).toEqual({ type: "ready" });
        expect(parsePanelMessage({ type: "cancelRun" })).toEqual({ type: "cancelRun" });
        expect(parsePanelMessage({ type: "revealLine", lineNumber: 4 })).toEqual({ type: "revealLine", lineNumber: 4 });
    });

    it("still rejects an unknown message type", () => {
        expect(parsePanelMessage({ type: "openInspector", resultSet: 0 })).toBeNull();
    });
});
