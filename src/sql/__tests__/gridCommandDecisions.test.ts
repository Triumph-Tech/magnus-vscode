import { describe, expect, it } from "vitest";
import {
    allFilesFilterLabel,
    buildExportFileName,
    defaultPanelTab,
    describeExportResult,
    exportDialogFilters,
    exportProgressRowThreshold,
    extractSingleTableName,
    needsExportProgress
} from "../gridCommandDecisions";

/**
 * The decisions the results grid's commands make: which tab to land on, what a
 * copy as INSERT should call the table, and what an export's save dialog offers.
 */

describe("defaultPanelTab", () => {
    it("lands on the first result set when there is one", () => {
        expect(defaultPanelTab(1)).toEqual({ kind: "results", index: 0 });
        expect(defaultPanelTab(4)).toEqual({ kind: "results", index: 0 });
    });

    it("lands on Messages when the run returned no result sets", () => {
        expect(defaultPanelTab(0)).toEqual({ kind: "messages" });
    });

    it("lands on Messages for a nonsense count", () => {
        expect(defaultPanelTab(-1)).toEqual({ kind: "messages" });
        expect(defaultPanelTab(Number.NaN)).toEqual({ kind: "messages" });
    });
});

describe("extractSingleTableName", () => {
    it("finds a bracketed table", () => {
        expect(extractSingleTableName("SELECT TOP (1000) [Id], [Name] FROM [Person]")).toBe("[Person]");
    });

    it("finds a bare table", () => {
        expect(extractSingleTableName("select Id from Person")).toBe("Person");
    });

    it("finds a schema qualified table", () => {
        expect(extractSingleTableName("SELECT * FROM [dbo].[Person]")).toBe("[dbo].[Person]");
        expect(extractSingleTableName("SELECT * FROM dbo . Person")).toBe("dbo.Person");
    });

    it("keeps the table when the query has an alias, a where and an order by", () => {
        expect(extractSingleTableName("SELECT p.Id FROM [Person] AS p WHERE p.Id > 5 ORDER BY p.Id")).toBe("[Person]");
    });

    it("keeps the table when the select list has a function call", () => {
        expect(extractSingleTableName("SELECT COUNT(*) FROM [Person]")).toBe("[Person]");
    });

    it("looks past comments", () => {
        expect(extractSingleTableName("-- pick everyone\nSELECT * FROM [Person] /* everyone */")).toBe("[Person]");
    });

    it("is not fooled by a join hidden in a comment", () => {
        expect(extractSingleTableName("SELECT * FROM [Person] -- join [Group]")).toBe("[Person]");
    });

    it("counts the nesting of a block comment", () => {
        expect(extractSingleTableName("SELECT * /* a /* b */ */ FROM [Person]")).toBe("[Person]");
    });

    it("is not fooled by a join hidden past the inner end of a nested comment", () => {
        expect(extractSingleTableName("SELECT * FROM [Person] /* a /* b */ join [Group] */")).toBe("[Person]");
    });

    it("is not fooled by a from inside a string literal", () => {
        expect(extractSingleTableName("SELECT * FROM [Person] WHERE LastName = 'from [Group]'")).toBe("[Person]");
    });

    it("refuses a join", () => {
        expect(extractSingleTableName("SELECT * FROM [Person] p JOIN [PersonAlias] a ON a.PersonId = p.Id")).toBeNull();
    });

    it("refuses a second table in the from clause", () => {
        expect(extractSingleTableName("SELECT * FROM [Person], [Group]")).toBeNull();
    });

    it("refuses a union", () => {
        expect(extractSingleTableName("SELECT Id FROM [Person] UNION SELECT Id FROM [Group]")).toBeNull();
    });

    it("refuses a subquery", () => {
        expect(extractSingleTableName("SELECT * FROM (SELECT Id FROM [Person]) x")).toBeNull();
    });

    it("refuses more than one statement", () => {
        expect(extractSingleTableName("SELECT * FROM [Person]; SELECT * FROM [Group]")).toBeNull();
    });

    it("allows a single trailing semicolon", () => {
        expect(extractSingleTableName("SELECT * FROM [Person];")).toBe("[Person]");
    });

    it("refuses a statement that is not a select", () => {
        expect(extractSingleTableName("UPDATE [Person] SET Id = 1")).toBeNull();
        expect(extractSingleTableName("EXEC sp_who")).toBeNull();
    });

    it("refuses a select with no from clause", () => {
        expect(extractSingleTableName("SELECT 1")).toBeNull();
    });

    it("refuses a temp table or a table variable", () => {
        expect(extractSingleTableName("SELECT * FROM #tmp")).toBeNull();
        expect(extractSingleTableName("SELECT * FROM @rows")).toBeNull();
    });

    it("refuses an empty query", () => {
        expect(extractSingleTableName("")).toBeNull();
        expect(extractSingleTableName("   \n  ")).toBeNull();
    });
});

describe("buildExportFileName", () => {
    it("names the file after the query editor", () => {
        expect(buildExportFileName("Query-1.sql", 0, "csv", 1)).toBe("Query-1-results.csv");
    });

    it("uses the extension of the format", () => {
        expect(buildExportFileName("Query-1.sql", 0, "json", 1)).toBe("Query-1-results.json");
        expect(buildExportFileName("Query-1.sql", 0, "excel", 1)).toBe("Query-1-results.xlsx");
    });

    it("numbers the set only when there is more than one", () => {
        expect(buildExportFileName("Query-2.sql", 1, "csv", 3)).toBe("Query-2-results-2.csv");
        expect(buildExportFileName("Query-2.sql", 0, "csv", 3)).toBe("Query-2-results-1.csv");
        expect(buildExportFileName("Query-2.sql", 0, "csv", 1)).toBe("Query-2-results.csv");
    });

    it("never numbers an export of every set", () => {
        expect(buildExportFileName("Query-2.sql", "all", "excel", 3)).toBe("Query-2-results.xlsx");
    });

    it("cleans up a label that is a path or has spaces", () => {
        expect(buildExportFileName("reports/daily counts.sql", 0, "csv", 1)).toBe("reports-daily-counts-results.csv");
    });

    it("falls back to Query when the label has nothing usable", () => {
        expect(buildExportFileName(".sql", 0, "csv", 1)).toBe("Query-results.csv");
        expect(buildExportFileName("", 0, "csv", 1)).toBe("Query-results.csv");
    });
});

describe("exportDialogFilters", () => {
    it("offers the format and then any file", () => {
        expect(exportDialogFilters("csv")).toEqual({
            CSV: ["csv"],
            [allFilesFilterLabel]: ["*"]
        });
    });

    it("offers the workbook extension for Excel", () => {
        expect(exportDialogFilters("excel")["Excel Workbook"]).toEqual(["xlsx"]);
    });
});

describe("needsExportProgress", () => {
    it("stays quiet for a small export", () => {
        expect(needsExportProgress(0)).toBe(false);
        expect(needsExportProgress(exportProgressRowThreshold - 1)).toBe(false);
    });

    it("reports progress from the threshold up", () => {
        expect(needsExportProgress(exportProgressRowThreshold)).toBe(true);
        expect(needsExportProgress(250000)).toBe(true);
    });
});

describe("describeExportResult", () => {
    it("counts the rows and names the file", () => {
        expect(describeExportResult("Query-1-results.csv", 12345)).toBe("Exported 12,345 rows to Query-1-results.csv.");
    });

    it("uses the singular for one row", () => {
        expect(describeExportResult("a.csv", 1)).toBe("Exported 1 row to a.csv.");
    });
});
