import { describe, expect, it } from "vitest";
import { buildColumnCompletions, buildCompletions, buildSingleTableColumnCompletions, buildTableCompletions, sortTiers } from "../completionItems";
import { rockTables } from "../rockCatalog";
import { completionContext, extractAliasMap, soleTableInScope } from "../sqlContext";

describe("buildColumnCompletions", () => {
    it("offers every column", () => {
        const items = buildColumnCompletions(["Id", "NickName", "LastName"]);

        expect(items.map(item => item.label)).toEqual(["Id", "NickName", "LastName"]);
        expect(items.every(item => item.kind === "column")).toBe(true);
    });

    it("inserts a column as plain text", () => {
        const items = buildColumnCompletions(["NickName"]);

        expect(items[0].insertText).toBe("NickName");
        expect(items[0].isSnippet).toBe(false);
    });

    it("puts every column in the column tier", () => {
        const items = buildColumnCompletions(["Id", "PersonAliasId"]);

        expect(items.every(item => item.sortText.startsWith(sortTiers.column))).toBe(true);
    });

    it("offers no join for a foreign key column, which belongs after a JOIN now", () => {
        const items = buildColumnCompletions(["PersonAliasId", "GroupId", "Note"]);

        expect(items.filter(item => item.kind === "snippet")).toHaveLength(0);
        expect(items.some(item => item.insertText.includes("INNER JOIN"))).toBe(false);
    });
});

describe("buildTableCompletions", () => {
    it("offers the whole static catalog with its descriptions", () => {
        const items = buildTableCompletions([]);

        expect(items).toHaveLength(rockTables.length);
        expect(items.find(item => item.label === "Person")?.detail).toContain("One row per person");
    });

    it("brackets a reserved table name on insert but not in the label", () => {
        const items = buildTableCompletions([]);
        const group = items.find(item => item.label === "Group");

        expect(group?.insertText).toBe("[Group]");
    });

    it("adds the live tables the catalog does not name", () => {
        const items = buildTableCompletions(["Person", "_org_CustomThing"]);
        const custom = items.find(item => item.label === "_org_CustomThing");

        expect(custom).toBeDefined();
        expect(custom?.detail).toBe("On this server");
    });

    it("never lists a table twice", () => {
        const items = buildTableCompletions(["Person", "person", "[Person]"]);

        expect(items.filter(item => item.label.toLowerCase() === "person")).toHaveLength(1);
    });

    it("sorts the catalog above the live tables", () => {
        const items = buildTableCompletions(["_org_CustomThing"]);
        const catalog = items.find(item => item.label === "Person");
        const live = items.find(item => item.label === "_org_CustomThing");

        expect(catalog!.sortText < live!.sortText).toBe(true);
    });

    it("ignores an empty live name", () => {
        const items = buildTableCompletions(["", "   "]);

        expect(items).toHaveLength(rockTables.length);
    });
});

describe("buildSingleTableColumnCompletions", () => {
    it("offers every column as a plain column", () => {
        const items = buildSingleTableColumnCompletions(["Id", "NickName"]);

        expect(items.map(item => item.label)).toEqual(["Id", "NickName"]);
        expect(items.every(item => item.kind === "column")).toBe(true);
        expect(items.every(item => item.isSnippet === false)).toBe(true);
    });

    it("offers no joins", () => {
        const items = buildSingleTableColumnCompletions(["PersonAliasId", "GroupId"]);

        expect(items.filter(item => item.kind === "snippet")).toHaveLength(0);
    });

    it("puts the columns in the column tier", () => {
        const items = buildSingleTableColumnCompletions(["Id"]);

        expect(items[0].sortText.startsWith(sortTiers.column)).toBe(true);
    });

    it("offers nothing for a table with no columns", () => {
        expect(buildSingleTableColumnCompletions([])).toHaveLength(0);
    });
});

describe("buildCompletions", () => {
    it("offers nothing inside a string or a comment", () => {
        expect(buildCompletions({ kind: "none" }, { columns: ["Id"], liveTableNames: ["Person"] })).toHaveLength(0);
    });

    it("offers the columns after a dot", () => {
        const items = buildCompletions({ kind: "afterDot", aliasOrTable: "p" }, { columns: ["Id", "LastName"] });

        expect(items.map(item => item.label)).toContain("LastName");
    });

    it("offers nothing after a dot when no columns are known", () => {
        expect(buildCompletions({ kind: "afterDot", aliasOrTable: "p" }, {})).toHaveLength(0);
        expect(buildCompletions({ kind: "afterDot", aliasOrTable: "p" }, { columns: [] })).toHaveLength(0);
    });

    it("does not fall back to table names after a dot", () => {
        const items = buildCompletions({ kind: "afterDot", aliasOrTable: "p" }, { liveTableNames: ["Person"] });

        expect(items).toHaveLength(0);
    });

    it("offers the tables where a table name belongs", () => {
        const items = buildCompletions({ kind: "tableName" }, { liveTableNames: ["_org_CustomThing"] });

        expect(items.some(item => item.label === "Person")).toBe(true);
        expect(items.some(item => item.label === "_org_CustomThing")).toBe(true);
    });

    it("offers no table names anywhere but a table position", () => {
        const items = buildCompletions({ kind: "general" }, { liveTableNames: ["Person", "_org_CustomThing"] });

        expect(items).toHaveLength(0);
    });

    it("offers nothing at all in a general context with no table in scope", () => {
        expect(buildCompletions({ kind: "general" }, {})).toHaveLength(0);
        expect(buildCompletions({ kind: "general" }, { columns: [] })).toHaveLength(0);
    });

    it("offers the single table's columns in a general context", () => {
        const items = buildCompletions({ kind: "general" }, { columns: ["Id", "NickName"] });

        expect(items.map(item => item.label)).toEqual(["Id", "NickName"]);
        expect(items.every(item => item.kind === "column")).toBe(true);
    });

    it("offers no join in a general context or after a dot", () => {
        const general = buildCompletions({ kind: "general" }, { columns: ["PersonAliasId"] });
        const afterDot = buildCompletions({ kind: "afterDot", aliasOrTable: "a" }, { columns: ["PersonAliasId"] });

        expect(general.filter(item => item.kind === "snippet")).toHaveLength(0);
        expect(afterDot.filter(item => item.kind === "snippet")).toHaveLength(0);
    });

    it("offers join clauses and then tables where a join target belongs", () => {
        const items = buildCompletions({ kind: "joinTarget" }, {
            aliases: new Map([["a", "Attendance"]]),
            columnsByTable: { attendance: ["Id", "PersonAliasId"] },
            liveTableNames: ["_org_CustomThing"]
        });
        const firstTable = items.findIndex(item => item.kind === "table");
        const lastClause = items.map(item => item.kind).lastIndexOf("snippet");

        expect(lastClause).toBeGreaterThanOrEqual(0);
        expect(lastClause).toBeLessThan(firstTable);
        expect(items.some(item => item.label === "Person")).toBe(true);
        expect(items.some(item => item.label === "_org_CustomThing")).toBe(true);
    });

    it("still offers the tables where a join target has nothing to suggest", () => {
        const items = buildCompletions({ kind: "joinTarget" }, {});

        expect(items.every(item => item.kind === "table")).toBe(true);
        expect(items.length).toBeGreaterThan(0);
    });

    it("builds a join clause from a real cursor context", () => {
        const sql = "SELECT * FROM Attendance a INNER JOIN ";
        const context = completionContext(sql, sql.length);
        const items = buildCompletions(context, {
            aliases: extractAliasMap(sql),
            columnsByTable: { attendance: ["Id", "PersonAliasId"] }
        });

        expect(context.kind).toBe("joinTarget");
        expect(items.some(item => item.insertText === "PersonAlias pa ON pa.Id = a.PersonAliasId")).toBe(true);
    });

    it("offers the single table's columns from a real cursor context", () => {
        const sql = "SELECT  FROM Person p WHERE p.Id = 1";
        const offset = "SELECT ".length;
        const context = completionContext(sql, offset);
        const table = soleTableInScope(extractAliasMap(sql));

        expect(context.kind).toBe("general");
        expect(table).toBe("Person");
        expect(buildCompletions(context, { columns: ["NickName"] }).map(item => item.label)).toEqual(["NickName"]);
    });

    it("works from a real cursor context", () => {
        const sql = "SELECT * FROM Attendance a WHERE a.";
        const context = completionContext(sql, sql.length);
        const items = buildCompletions(context, { columns: ["Id", "PersonAliasId"] });

        expect(context.kind).toBe("afterDot");
        expect(items.map(item => item.label)).toEqual(["Id", "PersonAliasId"]);
    });
});
