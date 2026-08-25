import { Workbook } from "exceljs";
import { describe, expect, it } from "vitest";
import {
    exportFileExtensions,
    isExportFormat,
    serializeResultSet,
    serializeResultSets,
    serializeResultSetsToCsv,
    serializeResultSetsToExcel,
    serializeResultSetsToJson,
    serializeResultSetToCsv,
    serializeResultSetToExcel,
    serializeResultSetToJson
} from "../serializers";
import { maxColumnWidth, minColumnWidth } from "../serializers/excel";
import { QueryColumnType, QueryResultSet } from "../types";

const people: QueryResultSet = {
    columns: [
        { name: "Id", type: QueryColumnType.Number },
        { name: "Name", type: QueryColumnType.String },
        { name: "IsActive", type: QueryColumnType.Boolean },
        { name: "ModifiedDateTime", type: QueryColumnType.DateTime }
    ],
    rows: [
        [1, "Ted Decker", true, "2026-08-25T13:45:12"],
        [2, "Decker, Cindy", false, null],
        [3, null, 1, "2026-08-25"]
    ]
};

const groups: QueryResultSet = {
    columns: [
        { name: "GroupId", type: QueryColumnType.Number },
        { name: "GroupName", type: QueryColumnType.String }
    ],
    rows: [
        [10, "Serving"]
    ]
};

/**
 * Reads a workbook back out of the bytes a serializer produced.
 *
 * @param bytes The bytes of the workbook.
 *
 * @returns The parsed workbook.
 */
async function readWorkbook(bytes: Buffer): Promise<Workbook> {
    const workbook = new Workbook();

    await workbook.xlsx.load(bytes);

    return workbook;
}

describe("serializeResultSetToCsv", () => {
    it("writes a header row and one row per result row", () => {
        const csv = serializeResultSetToCsv(people);

        expect(csv.split("\r\n").filter(l => l !== "")).toHaveLength(4);
        expect(csv.startsWith("Id,Name,IsActive,ModifiedDateTime\r\n")).toBe(true);
    });

    it("quotes a value holding the delimiter and leaves NULL empty", () => {
        const lines = serializeResultSetToCsv(people).split("\r\n");

        expect(lines[2]).toBe("2,\"Decker, Cindy\",0,");
    });

    it("formats each value by its column type", () => {
        const lines = serializeResultSetToCsv(people).split("\r\n");

        expect(lines[1]).toBe("1,Ted Decker,1,2026-08-25T13:45:12.000");
        expect(lines[3]).toBe("3,,1,2026-08-25T00:00:00.000");
    });

    it("honors the options it is given", () => {
        expect(serializeResultSetToCsv(groups, { includeHeaders: false, lineSeparator: "\n" })).toBe("10,Serving\n");
    });
});

describe("serializeResultSetsToCsv", () => {
    it("stacks the sets, each with its own header", () => {
        const csv = serializeResultSetsToCsv([groups, groups]);

        expect(csv).toBe("GroupId,GroupName\r\n10,Serving\r\n\r\nGroupId,GroupName\r\n10,Serving\r\n");
    });

    it("writes nothing for no sets", () => {
        expect(serializeResultSetsToCsv([])).toBe("");
    });
});

describe("serializeResultSetToJson", () => {
    it("writes an array of typed objects", () => {
        expect(JSON.parse(serializeResultSetToJson(people))).toEqual([
            { Id: 1, Name: "Ted Decker", IsActive: true, ModifiedDateTime: "2026-08-25T13:45:12.000" },
            { Id: 2, Name: "Decker, Cindy", IsActive: false, ModifiedDateTime: null },
            { Id: 3, Name: null, IsActive: true, ModifiedDateTime: "2026-08-25T00:00:00.000" }
        ]);
    });

    it("writes an empty array for a set with no rows", () => {
        expect(serializeResultSetToJson({ columns: groups.columns, rows: [] })).toBe("[]");
    });
});

describe("serializeResultSetsToJson", () => {
    it("writes a single set as a plain array", () => {
        expect(JSON.parse(serializeResultSetsToJson([groups]))).toEqual([{ GroupId: 10, GroupName: "Serving" }]);
    });

    it("nests several sets", () => {
        expect(JSON.parse(serializeResultSetsToJson([groups, groups]))).toEqual([
            [{ GroupId: 10, GroupName: "Serving" }],
            [{ GroupId: 10, GroupName: "Serving" }]
        ]);
    });

    it("writes an empty array for no sets", () => {
        expect(serializeResultSetsToJson([])).toBe("[]");
    });
});

describe("serializeResultSetToExcel", () => {
    it("produces a workbook that parses back with one sheet of rows", async () => {
        const workbook = await readWorkbook(await serializeResultSetToExcel(people));

        expect(workbook.worksheets).toHaveLength(1);

        const sheet = workbook.worksheets[0];

        expect(sheet.name).toBe("Results 1");
        // One header row plus one row per result row.
        expect(sheet.rowCount).toBe(4);
        expect(sheet.getRow(1).values).toEqual([undefined, "Id", "Name", "IsActive", "ModifiedDateTime"]);
    });

    it("keeps values typed", async () => {
        const workbook = await readWorkbook(await serializeResultSetToExcel(people));
        const sheet = workbook.worksheets[0];

        expect(sheet.getCell("A2").value).toBe(1);
        expect(sheet.getCell("B2").value).toBe("Ted Decker");
        expect(sheet.getCell("C2").value).toBe(true);
        expect(sheet.getCell("D2").value).toBeInstanceOf(Date);
        expect(sheet.getCell("C3").value).toBe(false);
    });

    it("writes a NULL as an empty cell", async () => {
        const workbook = await readWorkbook(await serializeResultSetToExcel(people));
        const sheet = workbook.worksheets[0];

        expect(sheet.getCell("D3").value).toBeNull();
        expect(sheet.getCell("B4").value).toBeNull();
    });

    it("makes the header bold and freezes it", async () => {
        const workbook = await readWorkbook(await serializeResultSetToExcel(people));
        const sheet = workbook.worksheets[0];

        expect(sheet.getRow(1).font?.bold).toBe(true);
        expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    });

    it("keeps column widths within bounds", async () => {
        const wide: QueryResultSet = {
            columns: [{ name: "Note", type: QueryColumnType.String }, { name: "N", type: QueryColumnType.Number }],
            rows: [["x".repeat(500), 1]]
        };
        const workbook = await readWorkbook(await serializeResultSetToExcel(wide));
        const sheet = workbook.worksheets[0];

        expect(sheet.getColumn(1).width).toBe(maxColumnWidth);
        expect(sheet.getColumn(2).width).toBe(minColumnWidth);
    });

    it("uses and sanitizes a requested sheet name", async () => {
        const named = await readWorkbook(await serializeResultSetToExcel(groups, "Serving [teams]"));

        expect(named.worksheets[0].name).toBe("Serving  teams");
    });

    it("handles a result set with no rows", async () => {
        const workbook = await readWorkbook(await serializeResultSetToExcel({ columns: groups.columns, rows: [] }));

        expect(workbook.worksheets[0].rowCount).toBe(1);
    });
});

describe("serializeResultSetsToExcel", () => {
    it("gives each result set its own worksheet", async () => {
        const workbook = await readWorkbook(await serializeResultSetsToExcel([people, groups]));

        expect(workbook.worksheets.map(s => s.name)).toEqual(["Results 1", "Results 2"]);
        expect(workbook.worksheets[1].getCell("B2").value).toBe("Serving");
    });

    it("still produces a valid workbook when there is nothing to export", async () => {
        const workbook = await readWorkbook(await serializeResultSetsToExcel([]));

        expect(workbook.worksheets).toHaveLength(1);
    });

    it("keeps duplicate column names apart", async () => {
        const duplicated: QueryResultSet = {
            columns: [{ name: "Id", type: QueryColumnType.Number }, { name: "Id", type: QueryColumnType.Number }],
            rows: [[1, 2]]
        };
        const workbook = await readWorkbook(await serializeResultSetsToExcel([duplicated]));
        const sheet = workbook.worksheets[0];

        expect(sheet.getRow(1).values).toEqual([undefined, "Id", "Id"]);
        expect(sheet.getRow(2).values).toEqual([undefined, 1, 2]);
    });
});

describe("isExportFormat", () => {
    it("accepts the known formats and rejects the rest", () => {
        expect(isExportFormat("csv")).toBe(true);
        expect(isExportFormat("json")).toBe(true);
        expect(isExportFormat("excel")).toBe(true);
        expect(isExportFormat("xlsx")).toBe(false);
        expect(isExportFormat("markdown")).toBe(false);
        expect(isExportFormat(null)).toBe(false);
    });
});

describe("exportFileExtensions", () => {
    it("names the file extension of each format", () => {
        expect(exportFileExtensions).toEqual({ csv: "csv", json: "json", excel: "xlsx" });
    });
});

describe("serializeResultSets", () => {
    it("dispatches to the text formats", async () => {
        expect(await serializeResultSets("csv", [groups])).toBe("GroupId,GroupName\r\n10,Serving\r\n");
        expect(JSON.parse(await serializeResultSets("json", [groups]) as string)).toEqual([{ GroupId: 10, GroupName: "Serving" }]);
    });

    it("dispatches to Excel and returns bytes", async () => {
        const bytes = await serializeResultSets("excel", [groups]);

        expect(Buffer.isBuffer(bytes)).toBe(true);
        expect((await readWorkbook(bytes as Buffer)).worksheets).toHaveLength(1);
    });
});

describe("serializeResultSet", () => {
    it("dispatches one result set to each format", async () => {
        expect(await serializeResultSet("csv", groups)).toBe("GroupId,GroupName\r\n10,Serving\r\n");
        expect(await serializeResultSet("json", groups)).toBe(serializeResultSetToJson(groups));
        expect(Buffer.isBuffer(await serializeResultSet("excel", groups))).toBe(true);
    });
});
