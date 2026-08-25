import { describe, expect, it } from "vitest";
import { buildJoinClauseCompletions, freshAlias, inScopeTables, joinClauseSortTier } from "../joinCompletion";
import { buildCompletions, SqlCompletionItem } from "../completionItems";
import { completionContext, extractAliasMap } from "../sqlContext";

/**
 * Builds the completions for a statement, which is how every test below reads
 * more like the thing being described.
 *
 * @param sql The statement, whose alias map stands in for "the statement so far".
 * @param columnsByTable The column lists to pretend are cached, keyed by lower cased table name.
 *
 * @returns The join clause completions.
 */
function clausesFor(sql: string, columnsByTable: Record<string, string[] | undefined> = {}): SqlCompletionItem[] {
    return buildJoinClauseCompletions(extractAliasMap(sql), columnsByTable);
}

describe("inScopeTables", () => {
    it("takes the alias from the map key and keeps document order", () => {
        const tables = inScopeTables(extractAliasMap("SELECT * FROM Attendance a INNER JOIN [Group] g ON g.Id = 1"));

        expect(tables).toEqual([
            { alias: "a", tableName: "Attendance" },
            { alias: "g", tableName: "Group" }
        ]);
    });

    it("treats an unaliased table as its own alias", () => {
        expect(inScopeTables(extractAliasMap("SELECT * FROM Person"))).toEqual([{ alias: "person", tableName: "Person" }]);
    });
});

describe("freshAlias", () => {
    it("keeps the conventional alias when nothing is using it", () => {
        expect(freshAlias("pa", new Set(["a", "p"]))).toBe("pa");
    });

    it("numbers from two on a collision", () => {
        expect(freshAlias("pa", new Set(["a", "pa"]))).toBe("pa2");
    });

    it("keeps counting until it finds a free one", () => {
        expect(freshAlias("pa", new Set(["pa", "pa2", "pa3"]))).toBe("pa4");
    });

    it("compares without regard to case", () => {
        expect(freshAlias("pa", new Set(["PA"]))).toBe("pa2");
    });

    it("falls back to a name when it is given none", () => {
        expect(freshAlias("", new Set())).toBe("t");
    });
});

describe("buildJoinClauseCompletions", () => {
    it("inserts a whole clause without repeating the JOIN keyword", () => {
        const items = clausesFor("SELECT * FROM Attendance a INNER JOIN ", { attendance: ["Id", "PersonAliasId"] });
        const single = items.find(item => item.label === "PersonAlias ON …PersonAliasId");

        expect(single).toBeDefined();
        expect(single!.insertText).toBe("PersonAlias pa ON pa.Id = a.PersonAliasId");
        expect(single!.isSnippet).toBe(false);
    });

    it("offers the two hop chain as its own item, with a JOIN keyword on the added hop", () => {
        const items = clausesFor("SELECT * FROM Attendance a INNER JOIN ", { attendance: ["PersonAliasId"] });
        const chain = items.find(item => item.label === "PersonAlias → Person (via a.PersonAliasId)");

        expect(chain).toBeDefined();
        expect(chain!.insertText).toBe("PersonAlias pa ON pa.Id = a.PersonAliasId\nINNER JOIN Person p ON p.Id = pa.PersonId");
    });

    it("spells the added hop INNER JOIN whatever kind of join it follows", () => {
        const items = clausesFor("SELECT * FROM Attendance a LEFT OUTER JOIN ", { attendance: ["PersonAliasId"] });
        const chain = items.find(item => item.insertText.includes("\n"));

        expect(chain!.insertText).toContain("\nINNER JOIN Person p");
        expect(chain!.documentation).toContain("always spelled INNER JOIN");
    });

    it("offers only one item for a single hop path", () => {
        const items = clausesFor("SELECT * FROM Person p INNER JOIN ", { person: ["PrimaryFamilyId"] });

        expect(items).toHaveLength(1);
        expect(items[0].insertText).toBe("[Group] pf ON pf.Id = p.PrimaryFamilyId");
    });

    it("puts the fuller path above the first hop alone", () => {
        const items = clausesFor("SELECT * FROM Attendance a INNER JOIN ", { attendance: ["PersonAliasId"] });

        expect(items[0].label).toContain("→");
        expect(items[1].label).not.toContain("→");
        expect(items[0].sortText < items[1].sortText).toBe(true);
    });

    it("puts every clause in the join clause tier", () => {
        const items = clausesFor("SELECT * FROM Attendance a INNER JOIN ", { attendance: ["PersonAliasId", "CampusId"] });

        expect(items.length).toBeGreaterThan(0);
        expect(items.every(item => item.sortText.startsWith(joinClauseSortTier))).toBe(true);
        expect(items.every(item => item.kind === "snippet")).toBe(true);
    });

    it("filters on the target table name, so typing Per finds the PersonAlias clause", () => {
        const items = clausesFor("SELECT * FROM Attendance a INNER JOIN ", { attendance: ["PersonAliasId"] });

        expect(items.every(item => item.filterText !== undefined)).toBe(true);
        expect(items.every(item => item.filterText!.includes("PersonAlias"))).toBe(true);
        expect(items[0].filterText).toBe("PersonAlias Person PersonAliasId");
        expect(items[1].filterText).toBe("PersonAlias PersonAliasId");
    });

    it("names the source column in the detail", () => {
        const items = clausesFor("SELECT * FROM Attendance a INNER JOIN ", { attendance: ["CampusId"] });

        expect(items[0].detail).toBe("a.CampusId → Campus.Id");
    });

    it("renumbers an alias the statement is already using", () => {
        const sql = "SELECT * FROM Attendance a INNER JOIN PersonAlias pa ON pa.Id = a.PersonAliasId INNER JOIN ";
        const items = clausesFor(sql, { attendance: ["PersonAliasId"] });
        const chain = items.find(item => item.insertText.includes("\n"));

        expect(chain!.insertText).toBe("PersonAlias pa2 ON pa2.Id = a.PersonAliasId\nINNER JOIN Person p ON p.Id = pa2.PersonId");
    });

    it("renumbers every colliding hop of a chain independently", () => {
        const sql = "SELECT * FROM Attendance a INNER JOIN PersonAlias pa ON pa.Id = a.PersonAliasId INNER JOIN Person p ON p.Id = pa.PersonId INNER JOIN ";
        const items = clausesFor(sql, { attendance: ["PersonAliasId"] });
        const chain = items.find(item => item.insertText.includes("\n"));

        expect(chain!.insertText).toBe("PersonAlias pa2 ON pa2.Id = a.PersonAliasId\nINNER JOIN Person p2 ON p2.Id = pa2.PersonId");
    });

    it("resolves collisions against the statement only, not against the other suggestions", () => {
        const items = clausesFor("SELECT * FROM Attendance a INNER JOIN ", { attendance: ["PersonAliasId", "CampusId"] });

        expect(items.filter(item => item.insertText.startsWith("PersonAlias pa "))).toHaveLength(2);
    });

    it("brackets a reserved target table the way the catalog does", () => {
        const items = clausesFor("SELECT * FROM GroupMember gm INNER JOIN ", { groupmember: ["GroupId"] });

        expect(items[0].insertText).toBe("[Group] g ON g.Id = gm.GroupId");
        expect(items[0].label).toBe("Group ON …GroupId");
    });

    it("lets every table in scope contribute, in the order they appeared", () => {
        const sql = "SELECT * FROM Attendance a INNER JOIN AttendanceOccurrence ao ON ao.Id = a.OccurrenceId INNER JOIN ";
        const items = clausesFor(sql, { attendance: ["CampusId"], attendanceoccurrence: ["ScheduleId"] });

        expect(items.map(item => item.insertText)).toEqual([
            "Campus c ON c.Id = a.CampusId",
            "[Schedule] s ON s.Id = ao.ScheduleId"
        ]);
    });

    it("skips a column with no canonical path and a column that is not an id", () => {
        const items = clausesFor("SELECT * FROM Person p INNER JOIN ", { person: ["LastName", "ForeignId", "PrimaryFamilyId"] });

        expect(items).toHaveLength(1);
        expect(items[0].detail).toContain("PrimaryFamilyId");
    });

    it("falls back to the catalog's foreign keys for a known table with no cached columns", () => {
        const items = clausesFor("SELECT * FROM Attendance a INNER JOIN ");

        expect(items.some(item => item.insertText.includes("ao.Id = a.OccurrenceId"))).toBe(true);
        expect(items.some(item => item.insertText.includes("pa.Id = a.PersonAliasId"))).toBe(true);
    });

    it("treats an empty cached column list as no list at all", () => {
        const items = clausesFor("SELECT * FROM Attendance a INNER JOIN ", { attendance: [] });

        expect(items.some(item => item.insertText.includes("ao.Id = a.OccurrenceId"))).toBe(true);
    });

    it("prefers the cached columns over the catalog's guess", () => {
        const items = clausesFor("SELECT * FROM Attendance a INNER JOIN ", { attendance: ["CampusId"] });

        expect(items).toHaveLength(1);
        expect(items[0].insertText).toBe("Campus c ON c.Id = a.CampusId");
    });

    it("offers nothing for an unknown table with no cached columns", () => {
        expect(clausesFor("SELECT * FROM _org_CustomThing x INNER JOIN ")).toHaveLength(0);
    });

    it("offers nothing when the statement has no table in scope yet", () => {
        expect(buildJoinClauseCompletions(new Map(), {})).toHaveLength(0);
    });

    it("still works for a table nobody has cached, once its columns arrive", () => {
        const items = clausesFor("SELECT * FROM _org_CustomThing x INNER JOIN ", { _org_customthing: ["PersonAliasId"] });

        expect(items.some(item => item.insertText === "PersonAlias pa ON pa.Id = x.PersonAliasId")).toBe(true);
    });

    it("leaves no alias placeholder behind", () => {
        const items = clausesFor("SELECT * FROM AttributeValue av INNER JOIN ", { attributevalue: ["AttributeId", "EntityId"] });

        expect(items.length).toBeGreaterThan(0);
        expect(items.every(item => !item.insertText.includes("{alias}"))).toBe(true);
    });

    it("sorts the clauses above the table names in the finished list", () => {
        const sql = "SELECT * FROM Attendance a INNER JOIN ";
        const context = completionContext(sql, sql.length);
        const items = buildCompletions(context, {
            aliases: extractAliasMap(sql),
            columnsByTable: { attendance: ["PersonAliasId"] },
            liveTableNames: ["_org_CustomThing"]
        });
        const clause = items.find(item => item.kind === "snippet");
        const catalogTable = items.find(item => item.label === "Person");
        const liveTable = items.find(item => item.label === "_org_CustomThing");

        expect(clause!.sortText < catalogTable!.sortText).toBe(true);
        expect(catalogTable!.sortText < liveTable!.sortText).toBe(true);
    });
});
