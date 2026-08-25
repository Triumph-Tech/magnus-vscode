import { describe, expect, it } from "vitest";
import { completionContext, extractAliasMap, findNonCodeRegions, isInNonCode, maskNonCode, soleTableInScope, tableNameAt } from "../sqlContext";

/**
 * Builds the completion context at the position of a `|` marker, which is
 * removed from the text before the call.
 *
 * @param textWithCursor The SQL text with exactly one `|` marking the cursor.
 *
 * @returns The completion context at the marker.
 */
function contextAtMarker(textWithCursor: string): ReturnType<typeof completionContext> {
    const offset = textWithCursor.indexOf("|");
    const text = textWithCursor.replace("|", "");

    return completionContext(text, offset);
}

/**
 * Resolves the table under a `|` marker, which is removed from the text before
 * the call.
 *
 * @param textWithCursor The SQL text with exactly one `|` marking the cursor.
 *
 * @returns The table reference under the marker.
 */
function tableAtMarker(textWithCursor: string): ReturnType<typeof tableNameAt> {
    const offset = textWithCursor.indexOf("|");
    const text = textWithCursor.replace("|", "");

    return tableNameAt(text, offset);
}

/**
 * Turns an alias map into a plain object, so a test can compare it in one go.
 *
 * @param sqlText The SQL to scan.
 *
 * @returns The alias map as an object.
 */
function aliasesOf(sqlText: string): Record<string, string> {
    return Object.fromEntries(extractAliasMap(sqlText));
}

describe("maskNonCode", () => {
    it("leaves plain code alone", () => {
        expect(maskNonCode("SELECT * FROM Person")).toBe("SELECT * FROM Person");
    });

    it("blanks a string literal but keeps its length", () => {
        const masked = maskNonCode("WHERE LastName = 'Decker'");

        expect(masked).toHaveLength("WHERE LastName = 'Decker'".length);
        expect(masked).toBe("WHERE LastName =         ");
    });

    it("blanks a line comment and keeps the line break", () => {
        expect(maskNonCode("-- FROM Person\nSELECT 1")).toBe("              \nSELECT 1");
    });

    it("blanks a block comment and keeps its line breaks", () => {
        expect(maskNonCode("/* JOIN\nPerson */SELECT 1")).toBe("       \n         SELECT 1");
    });

    it("keeps a bracketed identifier visible, because it is code", () => {
        expect(maskNonCode("FROM [Group] g")).toBe("FROM [Group] g");
    });

    it("does not mistake a doubled quote for the end of a string", () => {
        expect(maskNonCode("'it''s' Person")).toBe("        Person");
    });

    it("blanks an unterminated string to the end of the text", () => {
        expect(maskNonCode("WHERE Name = 'oops")).toBe("WHERE Name =      ");
    });
});

describe("findNonCodeRegions and isInNonCode", () => {
    it("finds a string, a line comment and a block comment", () => {
        const regions = findNonCodeRegions("'a' -- b\n/* c */");

        expect(regions.map(region => region.kind)).toEqual(["string", "lineComment", "blockComment"]);
    });

    it("treats the delimiters as code and the inside as not", () => {
        const text = "N = 'abc'";
        const regions = findNonCodeRegions(text);

        expect(isInNonCode(regions, text.indexOf("'"))).toBe(false);
        expect(isInNonCode(regions, text.indexOf("abc"))).toBe(true);
        expect(isInNonCode(regions, text.length)).toBe(false);
    });

    it("treats the end of a line comment as still inside it", () => {
        const text = "-- todo";
        const regions = findNonCodeRegions(text);

        expect(isInNonCode(regions, text.length)).toBe(true);
    });

    it("treats the end of an unterminated string as still inside it", () => {
        const text = "N = 'abc";
        const regions = findNonCodeRegions(text);

        expect(isInNonCode(regions, text.length)).toBe(true);
    });

    it("treats the offset just past a block comment as code", () => {
        const text = "/* x */Y";
        const regions = findNonCodeRegions(text);

        expect(isInNonCode(regions, text.indexOf("Y"))).toBe(false);
    });

    it("ignores a quote inside a bracketed identifier", () => {
        expect(findNonCodeRegions("FROM [it's] x")).toEqual([]);
    });
});

describe("extractAliasMap", () => {
    it("finds a simple alias", () => {
        expect(aliasesOf("SELECT * FROM Person p")).toEqual({ p: "Person" });
    });

    it("finds an alias written with AS", () => {
        expect(aliasesOf("SELECT * FROM Person AS p")).toEqual({ p: "Person" });
    });

    it("maps an unaliased table to itself", () => {
        expect(aliasesOf("SELECT * FROM Person")).toEqual({ person: "Person" });
    });

    it("strips brackets from the table and the alias", () => {
        expect(aliasesOf("SELECT * FROM [Group] [g]")).toEqual({ g: "Group" });
    });

    it("maps an unaliased bracketed table to its bare name", () => {
        expect(aliasesOf("SELECT * FROM [Group]")).toEqual({ group: "Group" });
    });

    it("takes the table from a schema qualified name", () => {
        expect(aliasesOf("SELECT * FROM dbo.Person p")).toEqual({ p: "Person" });
    });

    it("takes the table from a fully qualified name with brackets", () => {
        expect(aliasesOf("SELECT * FROM [Rock].[dbo].[Group] g")).toEqual({ g: "Group" });
    });

    it("finds every table of a multi join query", () => {
        const sql = "SELECT * FROM Attendance a INNER JOIN AttendanceOccurrence ao ON ao.Id = a.OccurrenceId LEFT OUTER JOIN [Group] g ON g.Id = ao.GroupId";

        expect(aliasesOf(sql)).toEqual({ a: "Attendance", ao: "AttendanceOccurrence", g: "Group" });
    });

    it("finds the tables of a comma separated FROM list", () => {
        expect(aliasesOf("SELECT * FROM Attendance a, Person p WHERE 1 = 1")).toEqual({ a: "Attendance", p: "Person" });
    });

    it("does not take a following keyword for an alias", () => {
        expect(aliasesOf("SELECT * FROM Person WHERE Id = 1")).toEqual({ person: "Person" });
        expect(aliasesOf("SELECT * FROM Person INNER JOIN PersonAlias ON 1 = 1")).toEqual({ person: "Person", personalias: "PersonAlias" });
    });

    it("ignores what happens inside a subquery", () => {
        const sql = "SELECT * FROM Person p WHERE p.Id IN (SELECT PersonId FROM PersonAlias pa)";

        expect(aliasesOf(sql)).toEqual({ p: "Person" });
    });

    it("ignores a derived table and its internals", () => {
        const sql = "SELECT * FROM (SELECT Id FROM Person p) d INNER JOIN Attendance a ON a.Id = d.Id";

        expect(aliasesOf(sql)).toEqual({ a: "Attendance" });
    });

    it("ignores the body of a common table expression", () => {
        const sql = "WITH gifts AS (SELECT * FROM FinancialTransaction ft) SELECT * FROM gifts g";

        expect(aliasesOf(sql)).toEqual({ g: "gifts" });
    });

    it("ignores a FROM inside a string or a comment", () => {
        expect(aliasesOf("SELECT 'FROM Person p' AS x")).toEqual({});
        expect(aliasesOf("-- FROM Person p\nSELECT 1")).toEqual({});
        expect(aliasesOf("/* FROM Person p */ SELECT 1")).toEqual({});
    });

    it("is case insensitive about the keywords and keys", () => {
        expect(aliasesOf("select * from Person P")).toEqual({ p: "Person" });
    });

    it("returns nothing for text with no table reference", () => {
        expect(aliasesOf("SELECT 1")).toEqual({});
        expect(aliasesOf("")).toEqual({});
    });

    it("does not crash on a truncated clause", () => {
        expect(aliasesOf("SELECT * FROM ")).toEqual({});
        expect(aliasesOf("SELECT * FROM Person p INNER JOIN")).toEqual({ p: "Person" });
    });
});

describe("soleTableInScope", () => {
    it("resolves a single unaliased table", () => {
        expect(soleTableInScope(extractAliasMap("SELECT * FROM Person"))).toBe("Person");
    });

    it("resolves a single aliased table", () => {
        expect(soleTableInScope(extractAliasMap("SELECT * FROM Person AS p WHERE p.Id = 1"))).toBe("Person");
    });

    it("strips the qualifier and the brackets", () => {
        expect(soleTableInScope(extractAliasMap("SELECT * FROM Rock.dbo.[Group] g"))).toBe("Group");
    });

    it("resolves nothing when two tables are joined", () => {
        expect(soleTableInScope(extractAliasMap("SELECT * FROM Person p INNER JOIN PersonAlias pa ON pa.PersonId = p.Id"))).toBeNull();
    });

    it("resolves nothing for a self join, even though both entries name one table", () => {
        expect(soleTableInScope(extractAliasMap("SELECT * FROM Person p INNER JOIN Person q ON q.Id = p.Id"))).toBeNull();
    });

    it("resolves nothing for a comma separated table list", () => {
        expect(soleTableInScope(extractAliasMap("SELECT * FROM Person p, PersonAlias pa"))).toBeNull();
    });

    it("resolves nothing when no table is named at all", () => {
        expect(soleTableInScope(extractAliasMap("SELECT 1"))).toBeNull();
        expect(soleTableInScope(extractAliasMap("DECLARE @id INT = 5"))).toBeNull();
    });

    it("does not count a table that only appears inside a subquery", () => {
        expect(soleTableInScope(extractAliasMap("SELECT * FROM Person p WHERE p.Id IN (SELECT PersonId FROM PersonAlias)"))).toBe("Person");
    });

    it("does not count a table that only appears inside a derived table", () => {
        expect(soleTableInScope(extractAliasMap("SELECT * FROM (SELECT Id FROM PersonAlias) x"))).toBeNull();
    });

    it("ignores a join that is commented out", () => {
        expect(soleTableInScope(extractAliasMap("SELECT * FROM Person p -- INNER JOIN PersonAlias pa"))).toBe("Person");
    });
});

describe("completionContext", () => {
    it("offers nothing inside a string literal", () => {
        expect(contextAtMarker("WHERE LastName = 'De|cker'")).toEqual({ kind: "none" });
    });

    it("offers nothing inside a line comment", () => {
        expect(contextAtMarker("-- pick up from | here\nSELECT 1")).toEqual({ kind: "none" });
    });

    it("offers nothing inside a block comment", () => {
        expect(contextAtMarker("/* FROM Per|son */ SELECT 1")).toEqual({ kind: "none" });
    });

    it("offers nothing inside an unterminated string", () => {
        expect(contextAtMarker("WHERE Name = 'De|")).toEqual({ kind: "none" });
    });

    it("recognizes a member reference after an alias", () => {
        expect(contextAtMarker("SELECT p.| FROM Person p")).toEqual({ kind: "afterDot", aliasOrTable: "p" });
    });

    it("recognizes a member reference while the column is being typed", () => {
        expect(contextAtMarker("SELECT p.Last| FROM Person p")).toEqual({ kind: "afterDot", aliasOrTable: "p" });
    });

    it("recognizes a member reference after a bracketed owner", () => {
        expect(contextAtMarker("SELECT [Group].| FROM [Group]")).toEqual({ kind: "afterDot", aliasOrTable: "Group" });
    });

    it("recognizes a member reference after a bare table name", () => {
        expect(contextAtMarker("SELECT Person.| FROM Person")).toEqual({ kind: "afterDot", aliasOrTable: "Person" });
    });

    it("recognizes a table position after FROM", () => {
        expect(contextAtMarker("SELECT * FROM |")).toEqual({ kind: "tableName" });
    });

    it("recognizes a table position while the table name is being typed", () => {
        expect(contextAtMarker("SELECT * FROM Per|")).toEqual({ kind: "tableName" });
    });

    it("recognizes a join target after every spelling of a JOIN", () => {
        expect(contextAtMarker("SELECT * FROM Person p JOIN |")).toEqual({ kind: "joinTarget" });
        expect(contextAtMarker("SELECT * FROM Person p INNER JOIN |")).toEqual({ kind: "joinTarget" });
        expect(contextAtMarker("SELECT * FROM Person p LEFT JOIN |")).toEqual({ kind: "joinTarget" });
        expect(contextAtMarker("SELECT * FROM Person p LEFT OUTER JOIN |")).toEqual({ kind: "joinTarget" });
        expect(contextAtMarker("SELECT * FROM Person p RIGHT OUTER JOIN |")).toEqual({ kind: "joinTarget" });
        expect(contextAtMarker("SELECT * FROM Person p FULL OUTER JOIN |")).toEqual({ kind: "joinTarget" });
    });

    it("recognizes a join target while the table name is being typed", () => {
        expect(contextAtMarker("SELECT * FROM Person p LEFT OUTER JOIN Att|")).toEqual({ kind: "joinTarget" });
    });

    it("recognizes a join target on the line after the JOIN keyword", () => {
        expect(contextAtMarker("SELECT * FROM Person p\nINNER JOIN\n    |")).toEqual({ kind: "joinTarget" });
    });

    it("keeps a plain FROM a table position", () => {
        expect(contextAtMarker("SELECT * FROM |")).toEqual({ kind: "tableName" });
        expect(contextAtMarker("SELECT * FROM Per|")).toEqual({ kind: "tableName" });
    });

    it("keeps CROSS JOIN a table position, since it takes no ON clause", () => {
        expect(contextAtMarker("SELECT * FROM Person p CROSS JOIN |")).toEqual({ kind: "tableName" });
    });

    it("keeps a comma separated list after a JOIN a table position", () => {
        expect(contextAtMarker("SELECT * FROM Person p INNER JOIN Campus c, |")).toEqual({ kind: "tableName" });
    });

    it("does not see a join target inside a string or a comment", () => {
        expect(contextAtMarker("SELECT 'INNER JOIN |")).toEqual({ kind: "none" });
        expect(contextAtMarker("-- INNER JOIN |")).toEqual({ kind: "none" });
        expect(contextAtMarker("/* INNER JOIN | */")).toEqual({ kind: "none" });
    });

    it("does not treat a JOIN inside a comment as a join target", () => {
        expect(contextAtMarker("-- INNER JOIN Person\nSELECT |")).toEqual({ kind: "general" });
    });

    it("stops treating the position as a join target once the ON clause starts", () => {
        expect(contextAtMarker("SELECT * FROM Person p INNER JOIN PersonAlias pa ON |")).toEqual({ kind: "general" });
    });

    it("recognizes a table position after a comma in a FROM list", () => {
        expect(contextAtMarker("SELECT * FROM Person p, |")).toEqual({ kind: "tableName" });
    });

    it("stops treating the position as a table once the clause has moved on", () => {
        expect(contextAtMarker("SELECT * FROM Person p WHERE |")).toEqual({ kind: "general" });
        expect(contextAtMarker("SELECT * FROM Person p ON |")).toEqual({ kind: "general" });
        expect(contextAtMarker("SELECT * FROM Person p ORDER BY |")).toEqual({ kind: "general" });
    });

    it("does not treat a FROM inside a comment as a table position", () => {
        expect(contextAtMarker("-- FROM Person\nSELECT |")).toEqual({ kind: "general" });
    });

    it("falls back to general everywhere else", () => {
        expect(contextAtMarker("|")).toEqual({ kind: "general" });
        expect(contextAtMarker("SELECT |")).toEqual({ kind: "general" });
        expect(contextAtMarker("SELECT Id, | FROM Person")).toEqual({ kind: "general" });
    });

    it("clamps an offset outside the text instead of throwing", () => {
        expect(completionContext("SELECT 1", -5)).toEqual({ kind: "general" });
        expect(completionContext("SELECT 1", 500)).toEqual({ kind: "general" });
    });
});

describe("tableNameAt", () => {
    it("resolves an alias to its table", () => {
        expect(tableAtMarker("SELECT * FROM Person p WHERE p|.Id = 1")).toEqual({ tableName: "Person" });
    });

    it("resolves a bare table name to itself", () => {
        expect(tableAtMarker("SELECT * FROM Per|son")).toEqual({ tableName: "Person" });
    });

    it("resolves a bracketed table name", () => {
        expect(tableAtMarker("SELECT * FROM [Gro|up] g")).toEqual({ tableName: "Group" });
    });

    it("resolves the table half of a schema qualified name", () => {
        expect(tableAtMarker("SELECT * FROM dbo.Per|son p")).toEqual({ tableName: "Person" });
    });

    it("resolves an alias used in a join condition", () => {
        expect(tableAtMarker("SELECT * FROM Attendance a INNER JOIN AttendanceOccurrence ao ON a|o.Id = a.OccurrenceId")).toEqual({ tableName: "AttendanceOccurrence" });
    });

    it("returns nothing for a column of a known alias", () => {
        expect(tableAtMarker("SELECT p.La|stName FROM Person p")).toBeNull();
    });

    it("returns nothing inside a string or a comment", () => {
        expect(tableAtMarker("SELECT 'Per|son'")).toBeNull();
        expect(tableAtMarker("-- Per|son\nSELECT 1")).toBeNull();
    });

    it("returns nothing when the cursor is not on an identifier", () => {
        expect(tableAtMarker("SELECT * FROM Person p WHERE 1 =| 1")).toBeNull();
        expect(tableAtMarker("|")).toBeNull();
    });

    it("returns an unknown identifier as written, so hover can try it", () => {
        expect(tableAtMarker("SELECT * FROM Att|endanceOccurrence")).toEqual({ tableName: "AttendanceOccurrence" });
    });

    it("clamps an offset outside the text instead of throwing", () => {
        expect(tableNameAt("SELECT 1", 500)).toBeNull();
    });
});
