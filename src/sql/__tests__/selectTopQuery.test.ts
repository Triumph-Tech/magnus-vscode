import { describe, expect, it } from "vitest";
import { buildSelectTopStatement, selectTopRowCount } from "../selectTopQuery";

/**
 * The statement Select Top 1000 generates.
 */

describe("buildSelectTopStatement", () => {
    it("writes one column per line and brackets every name", () => {
        expect(buildSelectTopStatement("Person", ["Id", "FirstName"])).toBe(
            "SELECT TOP (1000)\n    [Id],\n    [FirstName]\nFROM [Person]\n"
        );
    });

    it("defaults to a thousand rows", () => {
        expect(selectTopRowCount).toBe(1000);
        expect(buildSelectTopStatement("Person", ["Id"])).toContain("SELECT TOP (1000)");
    });

    it("honors a different row count", () => {
        expect(buildSelectTopStatement("Person", ["Id"], 10)).toContain("SELECT TOP (10)");
    });

    it("never asks for fewer than one row", () => {
        expect(buildSelectTopStatement("Person", ["Id"], 0)).toContain("SELECT TOP (1)");
        expect(buildSelectTopStatement("Person", ["Id"], -5)).toContain("SELECT TOP (1)");
    });

    it("falls back to a star when the columns are unknown", () => {
        expect(buildSelectTopStatement("Person", [])).toBe("SELECT TOP (1000) *\nFROM [Person]\n");
        expect(buildSelectTopStatement("Person", ["", "  "])).toBe("SELECT TOP (1000) *\nFROM [Person]\n");
    });

    it("keeps a schema qualified table qualified", () => {
        expect(buildSelectTopStatement("dbo.Person", ["Id"])).toContain("FROM [dbo].[Person]");
    });

    it("does not bracket an already bracketed table twice", () => {
        expect(buildSelectTopStatement("[dbo].[Person]", ["Id"])).toContain("FROM [dbo].[Person]");
    });

    it("escapes a bracket inside a column name", () => {
        expect(buildSelectTopStatement("Person", ["Odd]Name"])).toContain("[Odd]]Name]");
    });

    it("cannot be broken out of by a bracketed table name", () => {
        const statement = buildSelectTopStatement("[Person] DROP TABLE [X] --]", ["Id"]);

        expect(statement).toContain("FROM [Person]] DROP TABLE [X]] --]");
        expect(statement).not.toContain("DROP TABLE [X] ");
    });
});
