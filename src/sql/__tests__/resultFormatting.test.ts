import { describe, expect, it } from "vitest";
import {
    buildCopyText,
    buildCopyTextChunks,
    buildCsv,
    buildInsertStatements,
    buildJson,
    buildMarkdownTable,
    buildTabDelimited,
    byteArrayPreviewBytes,
    copyFormats,
    detectCellContent,
    largeCopyCellThreshold,
    needsSpreadsheetSanitization,
    planCopy,
    sanitizeSpreadsheetCell,
    spreadsheetFormulaLeaders,
    formatByteArray,
    formatCell,
    formatDateTime,
    formatNumber,
    getCellDisplayValue,
    isCopyFormat,
    isNullValue,
    prettyPrintJson,
    quoteIdentifier,
    quoteQualifiedIdentifier,
    uniqueColumnKeys
} from "../resultFormatting";
import { QueryColumn, QueryColumnType } from "../types";

/**
 * Builds a column list from name and type pairs.
 *
 * @param pairs The name and type of each column.
 *
 * @returns The columns.
 */
function columns(...pairs: [string, QueryColumnType][]): QueryColumn[] {
    return pairs.map(([name, type]) => ({ name, type }));
}

describe("isNullValue", () => {
    it("treats null and undefined as NULL", () => {
        expect(isNullValue(null)).toBe(true);
        expect(isNullValue(undefined)).toBe(true);
    });

    it("does not treat empty or zero values as NULL", () => {
        expect(isNullValue("")).toBe(false);
        expect(isNullValue(0)).toBe(false);
        expect(isNullValue(false)).toBe(false);
        expect(isNullValue("NULL")).toBe(false);
    });
});

describe("formatCell", () => {
    it("flags a NULL and gives it the NULL text", () => {
        expect(formatCell(QueryColumnType.String, null)).toEqual({ display: "NULL", isNull: true });
        expect(formatCell(QueryColumnType.Number, undefined)).toEqual({ display: "NULL", isNull: true });
    });

    it("does not flag a string that happens to read NULL", () => {
        expect(formatCell(QueryColumnType.String, "NULL")).toEqual({ display: "NULL", isNull: false });
    });

    it("formats a value that is present", () => {
        expect(formatCell(QueryColumnType.Boolean, true)).toEqual({ display: "1", isNull: false });
    });
});

describe("getCellDisplayValue", () => {
    it("returns an empty string for a NULL, leaving the NULL text to formatCell", () => {
        expect(getCellDisplayValue(QueryColumnType.String, null)).toBe("");
        expect(getCellDisplayValue(QueryColumnType.DateTime, undefined)).toBe("");
    });

    it("passes a string through untouched", () => {
        expect(getCellDisplayValue(QueryColumnType.String, "Ted Decker")).toBe("Ted Decker");
        expect(getCellDisplayValue(QueryColumnType.String, "")).toBe("");
        expect(getCellDisplayValue(QueryColumnType.String, " padded ")).toBe(" padded ");
    });

    it("renders a boolean as one or zero", () => {
        expect(getCellDisplayValue(QueryColumnType.Boolean, true)).toBe("1");
        expect(getCellDisplayValue(QueryColumnType.Boolean, false)).toBe("0");
        expect(getCellDisplayValue(QueryColumnType.Boolean, 1)).toBe("1");
        expect(getCellDisplayValue(QueryColumnType.Boolean, 0)).toBe("0");
        expect(getCellDisplayValue(QueryColumnType.Boolean, "True")).toBe("1");
        expect(getCellDisplayValue(QueryColumnType.Boolean, "false")).toBe("0");
    });

    it("stringifies an unknown column with no interpretation", () => {
        expect(getCellDisplayValue(QueryColumnType.Unknown, 42)).toBe("42");
        expect(getCellDisplayValue(QueryColumnType.Unknown, true)).toBe("true");
    });

    it("serializes an object value rather than showing object Object", () => {
        expect(getCellDisplayValue(QueryColumnType.String, { a: 1 })).toBe("{\"a\":1}");
    });
});

describe("formatNumber", () => {
    it("formats whole and fractional numbers with a dot", () => {
        expect(formatNumber(42)).toBe("42");
        expect(formatNumber(-17)).toBe("-17");
        expect(formatNumber(1.5)).toBe("1.5");
    });

    it("does not group thousands, which no locale would agree on", () => {
        expect(formatNumber(1234567)).toBe("1234567");
    });

    it("keeps a decimal that arrived as a string exactly as it was sent", () => {
        expect(formatNumber("123.4500")).toBe("123.4500");
        expect(formatNumber("0.10000000000000000001")).toBe("0.10000000000000000001");
    });

    it("handles the numeric edges", () => {
        expect(formatNumber(0)).toBe("0");
        expect(formatNumber(-0)).toBe("0");
        expect(formatNumber(Number.NaN)).toBe("NaN");
        expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("Infinity");
        expect(formatNumber(Number.NEGATIVE_INFINITY)).toBe("-Infinity");
        expect(formatNumber(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    });

    it("formats a bigint", () => {
        expect(formatNumber(9007199254740993n)).toBe("9007199254740993");
    });
});

describe("formatDateTime", () => {
    it("keeps the wall clock of a value that carries no offset", () => {
        expect(formatDateTime("2026-08-25T13:45:12")).toBe("2026-08-25T13:45:12.000");
        expect(formatDateTime("2026-08-25 13:45:12")).toBe("2026-08-25T13:45:12.000");
        expect(formatDateTime("2026-08-25T13:45:12.123")).toBe("2026-08-25T13:45:12.123");
    });

    it("truncates a fraction longer than milliseconds", () => {
        expect(formatDateTime("2026-08-25T13:45:12.1234567")).toBe("2026-08-25T13:45:12.123");
    });

    it("pads a short fraction", () => {
        expect(formatDateTime("2026-08-25T13:45:12.5")).toBe("2026-08-25T13:45:12.500");
    });

    it("fills in midnight for a date with no time", () => {
        expect(formatDateTime("2026-08-25")).toBe("2026-08-25T00:00:00.000");
    });

    it("fills in seconds when they are absent", () => {
        expect(formatDateTime("2026-08-25T13:45")).toBe("2026-08-25T13:45:00.000");
    });

    it("converts a value that names its own instant", () => {
        expect(formatDateTime("2026-08-25T13:45:12Z")).toBe("2026-08-25T13:45:12.000Z");
        expect(formatDateTime(new Date(Date.UTC(2026, 7, 25, 13, 45, 12)))).toBe("2026-08-25T13:45:12.000Z");
    });

    it("returns text that is not a date unchanged", () => {
        expect(formatDateTime("not a date")).toBe("not a date");
    });

    it("returns an empty string for an invalid date object", () => {
        expect(formatDateTime(new Date(Number.NaN))).toBe("");
    });
});

describe("formatByteArray", () => {
    it("renders bytes as an uppercase hex preview", () => {
        expect(formatByteArray([0, 1, 15, 16, 255])).toBe("0x00010F10FF");
    });

    it("renders a typed array the same way", () => {
        expect(formatByteArray(new Uint8Array([171, 205]))).toBe("0xABCD");
    });

    it("renders an empty array as the prefix alone", () => {
        expect(formatByteArray([])).toBe("0x");
    });

    it("caps the preview and marks the remainder", () => {
        const bytes = new Array(byteArrayPreviewBytes + 10).fill(0xab);
        const preview = formatByteArray(bytes);

        expect(preview).toBe(`0x${"AB".repeat(byteArrayPreviewBytes)}…`);
        expect(preview.endsWith("…")).toBe(true);
    });

    it("does not mark a value that fits exactly", () => {
        const bytes = new Array(byteArrayPreviewBytes).fill(1);

        expect(formatByteArray(bytes).endsWith("…")).toBe(false);
    });

    it("truncates text the server already encoded", () => {
        const long = `0x${"AB".repeat(100)}`;

        expect(formatByteArray(long)).toBe(`${long.slice(0, byteArrayPreviewBytes * 2 + 2)}…`);
    });

    it("passes short encoded text through", () => {
        expect(formatByteArray("0xDEAD")).toBe("0xDEAD");
    });
});

describe("buildTabDelimited", () => {
    const cols = columns(["Id", QueryColumnType.Number], ["Name", QueryColumnType.String]);

    it("writes rows with no header when headers are not asked for", () => {
        expect(buildTabDelimited(cols, [[1, "Ted"], [2, "Cindy"]], false)).toBe("1\tTed\n2\tCindy");
    });

    it("writes a header row when asked", () => {
        expect(buildTabDelimited(cols, [[1, "Ted"]], true)).toBe("Id\tName\n1\tTed");
    });

    it("writes NULL for a null value", () => {
        expect(buildTabDelimited(cols, [[null, null]], false)).toBe("NULL\tNULL");
    });

    it("collapses tabs and line breaks inside a value", () => {
        expect(buildTabDelimited(cols, [[1, "a\tb\nc\r\nd"]], false)).toBe("1\ta b c d");
    });

    it("writes only the header for an empty selection", () => {
        expect(buildTabDelimited(cols, [], true)).toBe("Id\tName");
        expect(buildTabDelimited(cols, [], false)).toBe("");
    });
});

describe("buildMarkdownTable", () => {
    const cols = columns(["Id", QueryColumnType.Number], ["Name", QueryColumnType.String]);

    it("writes a header and divider", () => {
        expect(buildMarkdownTable(cols, [[1, "Ted"]])).toBe("| Id | Name |\n| --- | --- |\n| 1 | Ted |");
    });

    it("escapes a pipe so it cannot split a cell", () => {
        expect(buildMarkdownTable(cols, [[1, "a|b"]])).toContain("| 1 | a\\|b |");
    });

    it("escapes a backslash before escaping a pipe", () => {
        expect(buildMarkdownTable(cols, [[1, "a\\b"]])).toContain("| 1 | a\\\\b |");
    });

    it("turns line breaks into line break tags", () => {
        expect(buildMarkdownTable(cols, [[1, "a\nb\r\nc"]])).toContain("| 1 | a<br>b<br>c |");
    });

    it("writes NULL for a null value", () => {
        expect(buildMarkdownTable(cols, [[null, null]])).toContain("| NULL | NULL |");
    });

    it("still writes the header for an empty selection", () => {
        expect(buildMarkdownTable(cols, [])).toBe("| Id | Name |\n| --- | --- |");
    });
});

describe("buildCsv", () => {
    const cols = columns(["Id", QueryColumnType.Number], ["Name", QueryColumnType.String]);

    it("writes a header and CRLF terminated rows", () => {
        expect(buildCsv(cols, [[1, "Ted"]])).toBe("Id,Name\r\n1,Ted\r\n");
    });

    it("omits the header when asked", () => {
        expect(buildCsv(cols, [[1, "Ted"]], { includeHeaders: false })).toBe("1,Ted\r\n");
    });

    it("quotes a value holding the delimiter", () => {
        expect(buildCsv(cols, [[1, "Decker, Ted"]], { includeHeaders: false })).toBe("1,\"Decker, Ted\"\r\n");
    });

    it("doubles an embedded quote", () => {
        expect(buildCsv(cols, [[1, "say \"hi\""]], { includeHeaders: false })).toBe("1,\"say \"\"hi\"\"\"\r\n");
    });

    it("quotes a value holding a line break", () => {
        expect(buildCsv(cols, [[1, "a\r\nb"]], { includeHeaders: false })).toBe("1,\"a\r\nb\"\r\n");
    });

    it("quotes a value with leading or trailing whitespace", () => {
        expect(buildCsv(cols, [[1, " padded "]], { includeHeaders: false })).toBe("1,\" padded \"\r\n");
        expect(buildCsv(cols, [[1, "tab\t"]], { includeHeaders: false })).toBe("1,\"tab\t\"\r\n");
    });

    it("keeps an empty string distinguishable from a NULL", () => {
        expect(buildCsv(cols, [[1, ""], [2, null]], { includeHeaders: false })).toBe("1,\"\"\r\n2,\r\n");
    });

    it("writes a chosen NULL text, encoded like any other field", () => {
        expect(buildCsv(cols, [[null, null]], { includeHeaders: false, nullText: "NULL" })).toBe("NULL,NULL\r\n");
        expect(buildCsv(cols, [[null, null]], { includeHeaders: false, nullText: "n/a," })).toBe("\"n/a,\",\"n/a,\"\r\n");
    });

    it("honors a different delimiter, quoting on it instead of on commas", () => {
        const csv = buildCsv(cols, [[1, "a,b"], [2, "c;d"]], { includeHeaders: false, delimiter: ";" });

        expect(csv).toBe("1;a,b\r\n2;\"c;d\"\r\n");
    });

    it("honors a different line separator", () => {
        expect(buildCsv(cols, [[1, "Ted"]], { includeHeaders: false, lineSeparator: "\n" })).toBe("1,Ted\n");
    });

    it("quotes a header that needs it", () => {
        expect(buildCsv(columns(["Full, Name", QueryColumnType.String]), [])).toBe("\"Full, Name\"\r\n");
    });

    it("produces an empty document when there is nothing at all to write", () => {
        expect(buildCsv([], [], { includeHeaders: false })).toBe("");
    });

    it("formats each value by its column type", () => {
        const typed = columns(["On", QueryColumnType.Boolean], ["When", QueryColumnType.DateTime]);

        expect(buildCsv(typed, [[true, "2026-08-25T13:45:12"]], { includeHeaders: false })).toBe("1,2026-08-25T13:45:12.000\r\n");
    });
});

describe("buildJson", () => {
    it("writes an array of objects keyed by column name", () => {
        const cols = columns(["Id", QueryColumnType.Number], ["Name", QueryColumnType.String]);

        expect(JSON.parse(buildJson(cols, [[1, "Ted"], [2, "Cindy"]]))).toEqual([
            { Id: 1, Name: "Ted" },
            { Id: 2, Name: "Cindy" }
        ]);
    });

    it("keeps types rather than display strings", () => {
        const cols = columns(
            ["Id", QueryColumnType.Number],
            ["IsActive", QueryColumnType.Boolean],
            ["When", QueryColumnType.DateTime],
            ["Blob", QueryColumnType.ByteArray],
            ["Note", QueryColumnType.String]
        );
        const parsed = JSON.parse(buildJson(cols, [[7, 1, "2026-08-25T13:45:12", [1, 2], null]]));

        expect(parsed).toEqual([{
            Id: 7,
            IsActive: true,
            When: "2026-08-25T13:45:12.000",
            Blob: "0x0102",
            Note: null
        }]);
    });

    it("keeps a high precision decimal as a string rather than rounding it", () => {
        const cols = columns(["Amount", QueryColumnType.Number]);
        const parsed = JSON.parse(buildJson(cols, [["123.4500"], ["1.5"]]));

        expect(parsed).toEqual([{ Amount: "123.4500" }, { Amount: 1.5 }]);
    });

    it("indents with two spaces", () => {
        expect(buildJson(columns(["Id", QueryColumnType.Number]), [[1]])).toBe("[\n  {\n    \"Id\": 1\n  }\n]");
    });

    it("writes an empty array for no rows", () => {
        expect(buildJson(columns(["Id", QueryColumnType.Number]), [])).toBe("[]");
    });

    it("suffixes duplicate column names", () => {
        const cols = columns(["Id", QueryColumnType.Number], ["Id", QueryColumnType.Number], ["Id", QueryColumnType.Number]);

        expect(JSON.parse(buildJson(cols, [[1, 2, 3]]))).toEqual([{ Id: 1, Id_2: 2, Id_3: 3 }]);
    });
});

describe("uniqueColumnKeys", () => {
    it("leaves distinct names alone", () => {
        expect(uniqueColumnKeys(columns(["A", QueryColumnType.String], ["B", QueryColumnType.String]))).toEqual(["A", "B"]);
    });

    it("names an unnamed column by its position", () => {
        expect(uniqueColumnKeys(columns(["", QueryColumnType.String], ["B", QueryColumnType.String], ["", QueryColumnType.String])))
            .toEqual(["column1", "B", "column3"]);
    });

    it("steps past a suffix that a real column already claimed", () => {
        const cols = columns(["Id", QueryColumnType.Number], ["Id_2", QueryColumnType.Number], ["Id", QueryColumnType.Number]);

        expect(uniqueColumnKeys(cols)).toEqual(["Id", "Id_2", "Id_3"]);
    });

    it("produces as many keys as there are columns, all unique", () => {
        const cols = columns(["X", QueryColumnType.String], ["X", QueryColumnType.String], ["X", QueryColumnType.String], ["X_2", QueryColumnType.String]);
        const keys = uniqueColumnKeys(cols);

        expect(keys).toHaveLength(4);
        expect(new Set(keys).size).toBe(4);
    });
});

describe("quoteIdentifier", () => {
    it("brackets a name", () => {
        expect(quoteIdentifier("Person")).toBe("[Person]");
    });

    it("doubles a closing bracket inside a name", () => {
        expect(quoteIdentifier("Odd]Name")).toBe("[Odd]]Name]");
    });

    it("brackets a name holding a dot", () => {
        expect(quoteIdentifier("My.Column")).toBe("[My.Column]");
    });
});

describe("quoteQualifiedIdentifier", () => {
    it("brackets each part of a qualified name", () => {
        expect(quoteQualifiedIdentifier("dbo.Person")).toBe("[dbo].[Person]");
    });

    it("leaves an already bracketed part alone", () => {
        expect(quoteQualifiedIdentifier("[dbo].[Person]")).toBe("[dbo].[Person]");
    });

    it("does not split on a dot inside brackets", () => {
        expect(quoteQualifiedIdentifier("[my.schema].Person")).toBe("[my.schema].[Person]");
    });

    it("brackets an unqualified name", () => {
        expect(quoteQualifiedIdentifier("Person")).toBe("[Person]");
    });

    it("doubles a closing bracket smuggled into a bracketed part", () => {
        const quoted = quoteQualifiedIdentifier("[Person] DROP TABLE [X] --]");

        expect(quoted).toBe("[Person]] DROP TABLE [X]] --]");
        expect(quoteQualifiedIdentifier(quoted)).toBe(quoted);
    });

    it("re-quotes a bracketed part idempotently", () => {
        const once = quoteQualifiedIdentifier("[dbo].[My]]Table]");

        expect(once).toBe("[dbo].[My]]Table]");
        expect(quoteQualifiedIdentifier(once)).toBe(once);
    });

    it("brackets an empty pair of brackets", () => {
        expect(quoteQualifiedIdentifier("[]")).toBe("[]");
    });
});

describe("buildInsertStatements", () => {
    it("writes one statement per row", () => {
        const cols = columns(["Id", QueryColumnType.Number], ["Name", QueryColumnType.String]);
        const statements = buildInsertStatements("Person", cols, [[1, "Ted"], [2, "Cindy"]]);

        expect(statements).toBe(
            "INSERT INTO [Person] ([Id], [Name]) VALUES (1, N'Ted');\n"
            + "INSERT INTO [Person] ([Id], [Name]) VALUES (2, N'Cindy');"
        );
    });

    it("mixes every type in one statement", () => {
        const cols = columns(
            ["Id", QueryColumnType.Number],
            ["Name", QueryColumnType.String],
            ["IsActive", QueryColumnType.Boolean],
            ["When", QueryColumnType.DateTime],
            ["Blob", QueryColumnType.ByteArray],
            ["Note", QueryColumnType.String]
        );
        const statements = buildInsertStatements("dbo.Person", cols, [[7, "Ted", false, "2026-08-25T13:45:12", [222, 173], null]]);

        expect(statements).toBe(
            "INSERT INTO [dbo].[Person] ([Id], [Name], [IsActive], [When], [Blob], [Note]) "
            + "VALUES (7, N'Ted', 0, '2026-08-25T13:45:12.000', 0xDEAD, NULL);"
        );
    });

    it("doubles a quote inside a string", () => {
        const cols = columns(["Name", QueryColumnType.String]);

        expect(buildInsertStatements("Person", cols, [["O'Brien"]])).toContain("VALUES (N'O''Brien');");
    });

    it("quotes a numeric column whose value is not a number", () => {
        const cols = columns(["Amount", QueryColumnType.Number]);

        expect(buildInsertStatements("T", cols, [["1e5"]])).toContain("VALUES (1e5);");
        expect(buildInsertStatements("T", cols, [["oops"]])).toContain("VALUES (N'oops');");
    });

    it("brackets a table name holding a bracket", () => {
        const cols = columns(["Id", QueryColumnType.Number]);

        expect(buildInsertStatements("Odd]Table", cols, [[1]])).toContain("INSERT INTO [Odd]]Table] ([Id])");
    });

    it("writes the full bytes of a blob rather than the preview", () => {
        const cols = columns(["Blob", QueryColumnType.ByteArray]);
        const bytes = new Array(byteArrayPreviewBytes + 4).fill(0xff);

        expect(buildInsertStatements("T", cols, [[bytes]])).toContain(`VALUES (0x${"FF".repeat(byteArrayPreviewBytes + 4)});`);
    });

    it("writes nothing for no rows", () => {
        expect(buildInsertStatements("Person", columns(["Id", QueryColumnType.Number]), [])).toBe("");
    });

    it("keeps a newline inside a string literal", () => {
        const cols = columns(["Note", QueryColumnType.String]);

        expect(buildInsertStatements("T", cols, [["a\nb"]])).toBe("INSERT INTO [T] ([Note]) VALUES (N'a\nb');");
    });
});

describe("buildCopyText", () => {
    const cols = columns(["Id", QueryColumnType.Number], ["Name", QueryColumnType.String]);
    const rows = [[1, "Ted"]];

    it("dispatches to each format", () => {
        expect(buildCopyText("tabDelimited", cols, rows)).toBe("1\tTed");
        expect(buildCopyText("tabDelimitedWithHeaders", cols, rows)).toBe("Id\tName\n1\tTed");
        expect(buildCopyText("markdown", cols, rows)).toContain("| --- | --- |");
        expect(buildCopyText("csv", cols, rows)).toBe("Id,Name\r\n1,Ted\r\n");
        expect(JSON.parse(buildCopyText("json", cols, rows))).toEqual([{ Id: 1, Name: "Ted" }]);
        expect(buildCopyText("insert", cols, rows, "Person")).toContain("INSERT INTO [Person]");
    });

    it("falls back to a placeholder table name for INSERT statements", () => {
        expect(buildCopyText("insert", cols, rows)).toContain("INSERT INTO [Table]");
        expect(buildCopyText("insert", cols, rows, "")).toContain("INSERT INTO [Table]");
    });
});

describe("needsSpreadsheetSanitization", () => {
    it("catches every formula leader", () => {
        for (const leader of spreadsheetFormulaLeaders) {
            expect(needsSpreadsheetSanitization(`${leader}cmd|calc`)).toBe(true);
        }
    });

    it("leaves ordinary text alone", () => {
        expect(needsSpreadsheetSanitization("Ted")).toBe(false);
        expect(needsSpreadsheetSanitization("")).toBe(false);
        expect(needsSpreadsheetSanitization("a=b")).toBe(false);
    });

    it("exempts a plain numeric literal", () => {
        expect(needsSpreadsheetSanitization("-5")).toBe(false);
        expect(needsSpreadsheetSanitization("-5.25")).toBe(false);
        expect(needsSpreadsheetSanitization("+7")).toBe(false);
        expect(needsSpreadsheetSanitization("-1.5e-3")).toBe(false);
    });

    it("catches an expression that only starts like a number", () => {
        expect(needsSpreadsheetSanitization("-5+3")).toBe(true);
        expect(needsSpreadsheetSanitization("-1-1")).toBe(true);
    });
});

describe("sanitizeSpreadsheetCell", () => {
    it("prefixes a value a spreadsheet would evaluate", () => {
        expect(sanitizeSpreadsheetCell("=1+1")).toBe("'=1+1");
        expect(sanitizeSpreadsheetCell("@SUM(A1)")).toBe("'@SUM(A1)");
        expect(sanitizeSpreadsheetCell("\tHIDDEN")).toBe("'\tHIDDEN");
    });

    it("leaves a number and ordinary text alone", () => {
        expect(sanitizeSpreadsheetCell("-5")).toBe("-5");
        expect(sanitizeSpreadsheetCell("Ted")).toBe("Ted");
    });
});

describe("spreadsheet sanitization in the copy and export formats", () => {
    const cols = columns(["Name", QueryColumnType.String]);
    const hostile = [["=cmd|' /C calc'!A1"], ["+1+1"], ["-1-1"], ["@SUM(1)"], ["\tsmuggled"], ["\rreturned"]];

    it("neutralizes every leader in CSV", () => {
        const csv = buildCsv(cols, hostile);

        expect(csv).toContain("\"'=cmd|' /C calc'!A1\"");
        expect(csv).toContain("\"'+1+1\"");
        expect(csv).toContain("\"'-1-1\"");
        expect(csv).toContain("\"'@SUM(1)\"");
        expect(csv).toContain("\"'\tsmuggled\"");
        expect(csv).toContain("\"'\rreturned\"");
    });

    it("always quotes a neutralized CSV field", () => {
        expect(buildCsv(cols, [["=1+1"]], { includeHeaders: false })).toBe("\"'=1+1\"\r\n");
    });

    it("neutralizes a hostile column name in the CSV header", () => {
        expect(buildCsv(columns(["=1+1", QueryColumnType.String]), [])).toBe("\"'=1+1\"\r\n");
    });

    it("neutralizes every leader in a tab delimited block", () => {
        const text = buildTabDelimited(cols, hostile, false);

        expect(text.split("\n")).toEqual([
            "'=cmd|' /C calc'!A1",
            "'+1+1",
            "'-1-1",
            "'@SUM(1)",
            // The tab and the carriage return are still flattened to a space
            // after the prefix is added, since a tab would break the columns.
            "' smuggled",
            "' returned"
        ]);
    });

    it("neutralizes a hostile column name in a tab delimited header", () => {
        expect(buildTabDelimited(columns(["=1+1", QueryColumnType.String]), [], true)).toBe("'=1+1");
    });

    it("leaves a negative number in a numeric column as a number", () => {
        const numeric = columns(["Balance", QueryColumnType.Number]);

        expect(buildCsv(numeric, [[-5]], { includeHeaders: false })).toBe("-5\r\n");
        expect(buildTabDelimited(numeric, [[-5]], false)).toBe("-5");
    });

    it("leaves a NULL alone", () => {
        expect(buildCsv(cols, [[null]], { includeHeaders: false })).toBe("\r\n");
        expect(buildTabDelimited(cols, [[null]], false)).toBe("NULL");
    });

    it("restores the old output when the flag is off", () => {
        const off = { sanitizeSpreadsheetCells: false };

        expect(buildCsv(cols, hostile, { includeHeaders: false, ...off })).toBe(
            "=cmd|' /C calc'!A1\r\n+1+1\r\n-1-1\r\n@SUM(1)\r\n\"\tsmuggled\"\r\n\"\rreturned\"\r\n"
        );
        expect(buildTabDelimited(cols, hostile, false, off).split("\n")).toEqual([
            "=cmd|' /C calc'!A1",
            "+1+1",
            "-1-1",
            "@SUM(1)",
            " smuggled",
            " returned"
        ]);
    });

    it("leaves markdown, JSON and INSERT untouched", () => {
        expect(buildMarkdownTable(cols, [["=1+1"]])).toContain("| =1+1 |");
        expect(buildJson(cols, [["=1+1"]])).toContain("\"=1+1\"");
        expect(buildInsertStatements("T", cols, [["=1+1"]])).toContain("N'=1+1'");
    });

    it("reaches the copy formats that a spreadsheet reads", () => {
        expect(buildCopyText("tabDelimited", cols, [["=1+1"]])).toBe("'=1+1");
        expect(buildCopyText("tabDelimitedWithHeaders", cols, [["=1+1"]])).toBe("Name\n'=1+1");
        expect(buildCopyText("csv", cols, [["=1+1"]])).toBe("Name\r\n\"'=1+1\"\r\n");
        expect(buildCopyText("markdown", cols, [["=1+1"]])).toContain("| =1+1 |");
    });
});

describe("planCopy", () => {
    it("says nothing about an ordinary selection", () => {
        const plan = planCopy(100, 10);

        expect(plan.needsConfirmation).toBe(false);
        expect(plan.cellCount).toBe(1000);
        expect(plan.confirmationMessage).toBeNull();
    });

    it("does not ask exactly at the threshold", () => {
        expect(planCopy(largeCopyCellThreshold, 1).needsConfirmation).toBe(false);
    });

    it("asks one cell past the threshold and states the count", () => {
        const plan = planCopy(largeCopyCellThreshold + 1, 1);

        expect(plan.needsConfirmation).toBe(true);
        expect(plan.cellCount).toBe(largeCopyCellThreshold + 1);
        expect(plan.confirmationMessage).toContain("100,001 cells");
    });

    it("counts the rectangle rather than trusting it", () => {
        expect(planCopy(-4, 10).cellCount).toBe(0);
        expect(planCopy(2.9, 3).cellCount).toBe(6);
    });
});

describe("buildCopyTextChunks", () => {
    const cols = columns(["Id", QueryColumnType.Number], ["Name", QueryColumnType.String], ["When", QueryColumnType.DateTime]);
    const rows: unknown[][] = [
        [1, "Ted", "2026-01-02T03:04:05"],
        [2, null, null],
        [3, "=1+1", "2026-01-02"],
        [4, "a\tb", "2026-01-02T03:04:05.678"],
        [5, "quote\"and,comma", null]
    ];

    for (const format of copyFormats) {
        it(`concatenates to exactly buildCopyText for ${format}`, () => {
            const whole = buildCopyText(format, cols, rows, "dbo.Person");

            for (const chunkRows of [1, 2, 3, 5, 500]) {
                expect(buildCopyTextChunks(format, cols, rows, "dbo.Person", chunkRows).join("")).toBe(whole);
            }
        });

        it(`concatenates to exactly buildCopyText for ${format} with no rows`, () => {
            expect(buildCopyTextChunks(format, cols, [], "dbo.Person", 2).join("")).toBe(buildCopyText(format, cols, [], "dbo.Person"));
        });

        it(`concatenates to exactly buildCopyText for ${format} with sanitization off`, () => {
            const off = { sanitizeSpreadsheetCells: false };

            expect(buildCopyTextChunks(format, cols, rows, "dbo.Person", 2, off).join("")).toBe(buildCopyText(format, cols, rows, "dbo.Person", off));
        });
    }

    it("splits into more than one piece", () => {
        expect(buildCopyTextChunks("csv", cols, rows, undefined, 2).length).toBeGreaterThan(1);
    });

    it("treats a nonsense chunk size as one row", () => {
        expect(buildCopyTextChunks("csv", cols, rows, undefined, 0).join("")).toBe(buildCopyText("csv", cols, rows));
    });

    it("matches buildJson for a JSON document", () => {
        expect(buildCopyTextChunks("json", cols, rows, undefined, 2).join("")).toBe(buildJson(cols, rows));
        expect(buildCopyTextChunks("json", cols, [], undefined, 2).join("")).toBe(buildJson(cols, []));
        expect(buildCopyTextChunks("json", [], rows, undefined, 2).join("")).toBe(buildJson([], rows));
    });
});

describe("isCopyFormat", () => {
    it("accepts every known format", () => {
        expect(isCopyFormat("tabDelimited")).toBe(true);
        expect(isCopyFormat("tabDelimitedWithHeaders")).toBe(true);
        expect(isCopyFormat("markdown")).toBe(true);
        expect(isCopyFormat("csv")).toBe(true);
        expect(isCopyFormat("json")).toBe(true);
        expect(isCopyFormat("insert")).toBe(true);
    });

    it("rejects anything else", () => {
        expect(isCopyFormat("excel")).toBe(false);
        expect(isCopyFormat("")).toBe(false);
        expect(isCopyFormat(7)).toBe(false);
        expect(isCopyFormat(null)).toBe(false);
    });
});

describe("detectCellContent", () => {
    it("detects a JSON object and array", () => {
        expect(detectCellContent("{\"a\":1}")).toBe("json");
        expect(detectCellContent("  [1, 2, 3]  ")).toBe("json");
        expect(detectCellContent("{}")).toBe("json");
    });

    it("does not call a bare JSON scalar JSON", () => {
        expect(detectCellContent("42")).toBe("text");
        expect(detectCellContent("\"quoted\"")).toBe("text");
        expect(detectCellContent("true")).toBe("text");
        expect(detectCellContent("null")).toBe("text");
    });

    it("does not call broken JSON JSON", () => {
        expect(detectCellContent("{not json")).toBe("text");
        expect(detectCellContent("[1, 2,")).toBe("text");
    });

    it("detects XML markup", () => {
        expect(detectCellContent("<root><a>1</a></root>")).toBe("xml");
        expect(detectCellContent("<?xml version=\"1.0\"?><a/>")).toBe("xml");
        expect(detectCellContent("<!DOCTYPE html><html></html>")).toBe("xml");
        expect(detectCellContent("</closing>")).toBe("xml");
    });

    it("does not call a comparison XML", () => {
        expect(detectCellContent("< 5 and > 3")).toBe("text");
        expect(detectCellContent("<3")).toBe("text");
        expect(detectCellContent("<a")).toBe("text");
    });

    it("calls everything else text", () => {
        expect(detectCellContent("Ted Decker")).toBe("text");
        expect(detectCellContent("")).toBe("text");
        expect(detectCellContent("   ")).toBe("text");
        expect(detectCellContent("NULL")).toBe("text");
    });
});

describe("prettyPrintJson", () => {
    it("reformats with a two space indent", () => {
        expect(prettyPrintJson("{\"a\":{\"b\":1}}")).toBe("{\n  \"a\": {\n    \"b\": 1\n  }\n}");
    });

    it("is stable when run twice", () => {
        const once = prettyPrintJson("{\"a\":[1,2]}");

        expect(prettyPrintJson(once)).toBe(once);
    });

    it("returns text that is not JSON unchanged", () => {
        expect(prettyPrintJson("not json")).toBe("not json");
    });
});
