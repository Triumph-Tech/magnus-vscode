import { describe, expect, it } from "vitest";
import { curatedForeignKeyColumns, findPersonAliasMisjoins, findRockTable, joinAliasPlaceholder, rockForeignKeyColumns, rockJoinPaths, rockTables, suggestJoin, writeTableName } from "../rockCatalog";
import { buildTableCompletions } from "../completionItems";

describe("writeTableName", () => {
    it("brackets the names T-SQL has claimed", () => {
        expect(writeTableName("Group")).toBe("[Group]");
        expect(writeTableName("Location")).toBe("[Location]");
    });

    it("leaves everything else alone", () => {
        expect(writeTableName("Person")).toBe("Person");
        expect(writeTableName("AttendanceOccurrence")).toBe("AttendanceOccurrence");
    });

    it("ignores casing when deciding", () => {
        expect(writeTableName("group")).toBe("[group]");
    });

    it("brackets the names the completion list used to bracket on its own", () => {
        // System, Public, Current and Session were bracketed when completed and
        // bare when a join was generated, because the two lists differed.
        expect(writeTableName("System")).toBe("[System]");
        expect(writeTableName("Public")).toBe("[Public]");
        expect(writeTableName("Current")).toBe("[Current]");
        expect(writeTableName("Session")).toBe("[Session]");
    });

    it("spells a name the same way for a completion and for a generated join", () => {
        const completion = buildTableCompletions([]).find(item => item.label === "Group");
        const join = suggestJoin("GroupId", "gm");

        expect(completion?.insertText).toBe("[Group]");
        expect(join?.snippet).toContain("INNER JOIN [Group] ");
    });

    it("spells a live table the same way a join would", () => {
        const completion = buildTableCompletions(["[dbo].[System]"]).find(item => item.label === "System");

        expect(completion?.insertText).toBe(writeTableName("System"));
    });
});


describe("rockTables", () => {
    it("covers the high traffic core tables", () => {
        expect(rockTables.length).toBeGreaterThanOrEqual(40);
    });

    it("includes the tables every Rock query reaches for", () => {
        const expected = [
            "Person",
            "PersonAlias",
            "Group",
            "GroupMember",
            "GroupType",
            "Attendance",
            "AttendanceOccurrence",
            "FinancialTransaction",
            "FinancialTransactionDetail",
            "FinancialAccount",
            "FinancialScheduledTransaction",
            "Campus",
            "DefinedValue",
            "DefinedType",
            "AttributeValue",
            "Attribute",
            "EntityType",
            "PhoneNumber",
            "ConnectionRequest",
            "ConnectionOpportunity",
            "PrayerRequest",
            "ContentChannel",
            "ContentChannelItem",
            "Schedule",
            "Location",
            "Device",
            "Metric",
            "MetricValue",
            "BinaryFile",
            "Communication",
            "CommunicationRecipient",
            "InteractionChannel",
            "InteractionComponent",
            "Interaction",
            "RegistrationInstance",
            "Registration",
            "RegistrationRegistrant",
            "PersonalDevice",
            "Workflow",
            "WorkflowActivity"
        ];

        for (const name of expected) {
            expect(rockTables.map(table => table.name)).toContain(name);
        }
    });

    it("gives every table a non empty description", () => {
        for (const table of rockTables) {
            expect(table.description.trim().length).toBeGreaterThan(0);
        }
    });

    it("names every table without brackets or a schema", () => {
        for (const table of rockTables) {
            expect(table.name).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
        }
    });

    it("lists no table twice", () => {
        const names = rockTables.map(table => table.name.toLowerCase());

        expect(new Set(names).size).toBe(names.length);
    });
});

describe("findRockTable", () => {
    it("finds a table by its exact name", () => {
        expect(findRockTable("PersonAlias")?.name).toBe("PersonAlias");
    });

    it("ignores casing, brackets and schema qualifiers", () => {
        expect(findRockTable("[dbo].[person]")?.name).toBe("Person");
        expect(findRockTable("dbo.GROUPMEMBER")?.name).toBe("GroupMember");
        expect(findRockTable("[Group]")?.name).toBe("Group");
    });

    it("returns nothing for a table that is not in the catalog", () => {
        expect(findRockTable("_org_Custom")).toBeUndefined();
        expect(findRockTable("")).toBeUndefined();
    });
});

describe("rockJoinPaths", () => {
    it("references its own column in every snippet", () => {
        for (const path of rockJoinPaths) {
            expect(path.snippetTemplate).toContain(`${joinAliasPlaceholder}.${path.columnName}`);
        }
    });

    it("uses the alias placeholder in every snippet", () => {
        for (const path of rockJoinPaths) {
            expect(path.snippetTemplate).toContain(joinAliasPlaceholder);
        }
    });

    it("explains every path", () => {
        for (const path of rockJoinPaths) {
            expect(path.explanation.trim().length).toBeGreaterThan(0);
        }
    });

    it("joins only tables that are in the catalog, and brackets the reserved ones", () => {
        for (const path of rockJoinPaths) {
            const matches = path.snippetTemplate.match(/JOIN (\[[A-Za-z]+\]|[A-Za-z]+)/g) ?? [];

            expect(matches.length).toBeGreaterThan(0);

            for (const match of matches) {
                const written = match.substring("JOIN ".length);

                expect(findRockTable(written)).toBeDefined();
            }
        }
    });

    it("lists no column twice", () => {
        const columns = rockJoinPaths.map(path => path.columnName.toLowerCase());

        expect(new Set(columns).size).toBe(columns.length);
    });

    it("covers the paths the spec calls out", () => {
        const columns = rockJoinPaths.map(path => path.columnName);

        expect(columns).toContain("PersonAliasId");
        expect(columns).toContain("OccurrenceId");
        expect(columns).toContain("TransactionId");
        expect(columns).toContain("AccountId");
        expect(columns).toContain("AttributeId");
        expect(columns).toContain("EntityId");
        expect(columns).toContain("GroupId");
    });
});

describe("suggestJoin", () => {
    it("routes a person reference through PersonAlias", () => {
        const suggestion = suggestJoin("PersonAliasId", "a");

        expect(suggestion?.snippet).toBe("INNER JOIN PersonAlias pa ON pa.Id = a.PersonAliasId\nINNER JOIN Person p ON p.Id = pa.PersonId");
        expect(suggestion?.explanation).toContain("PersonAlias");
    });

    it("routes a prefixed person reference through PersonAlias too", () => {
        const suggestion = suggestJoin("CreatedByPersonAliasId", "ft");

        expect(suggestion?.snippet).toBe("INNER JOIN PersonAlias pa ON pa.Id = ft.CreatedByPersonAliasId\nINNER JOIN Person p ON p.Id = pa.PersonId");
    });

    it("prefers the curated path over the suffix rule", () => {
        expect(suggestJoin("AuthorizedPersonAliasId", "ft")?.explanation).toContain("giver");
    });

    it("joins Person directly for a real PersonId column", () => {
        expect(suggestJoin("PersonId", "pa")?.snippet).toBe("INNER JOIN Person p ON p.Id = pa.PersonId");
    });

    it("reaches AttendanceOccurrence from Attendance", () => {
        expect(suggestJoin("OccurrenceId", "a")?.snippet).toBe("INNER JOIN AttendanceOccurrence ao ON ao.Id = a.OccurrenceId");
    });

    it("reaches the transaction and the account from a transaction detail", () => {
        expect(suggestJoin("TransactionId", "ftd")?.snippet).toContain("FinancialTransaction ft ON ft.Id = ftd.TransactionId");
        expect(suggestJoin("AccountId", "ftd")?.snippet).toContain("FinancialAccount fa ON fa.Id = ftd.AccountId");
    });

    it("reaches Group and Person from a group member", () => {
        expect(suggestJoin("GroupId", "gm")?.snippet).toBe("INNER JOIN [Group] g ON g.Id = gm.GroupId");
        expect(suggestJoin("PersonAliasId", "gm")?.snippet).toContain("INNER JOIN Person p ON p.Id = pa.PersonId");
    });

    it("reaches Attribute from an attribute value, and notes what EntityId means", () => {
        expect(suggestJoin("AttributeId", "av")?.snippet).toBe("INNER JOIN Attribute a ON a.Id = av.AttributeId");
        expect(suggestJoin("EntityId", "av")?.explanation).toContain("polymorphic");
    });

    it("sends any ValueId column to DefinedValue", () => {
        expect(suggestJoin("RecordStatusValueId", "p")?.snippet).toBe("INNER JOIN DefinedValue dv ON dv.Id = p.RecordStatusValueId");
        expect(suggestJoin("ConnectionStatusValueId", "p")?.snippet).toContain("DefinedValue dv");
        expect(suggestJoin("DefinedValueId", "x")?.snippet).toContain("DefinedValue dv");
    });

    it("follows the plain convention for a column named after its table", () => {
        expect(suggestJoin("CampusId", "p")?.snippet).toBe("INNER JOIN Campus c ON c.Id = p.CampusId");
        expect(suggestJoin("GroupTypeId", "g")?.snippet).toBe("INNER JOIN GroupType gt ON gt.Id = g.GroupTypeId");
        expect(suggestJoin("ContentChannelId", "cci")?.snippet).toBe("INNER JOIN ContentChannel cc ON cc.Id = cci.ContentChannelId");
    });

    it("brackets a reserved table name reached by convention", () => {
        expect(suggestJoin("ScheduleId", "ao")?.snippet).toBe("INNER JOIN [Schedule] s ON s.Id = ao.ScheduleId");
    });

    it("ignores brackets and casing on the column and the alias", () => {
        expect(suggestJoin("[CampusId]", "[p]")?.snippet).toBe("INNER JOIN Campus c ON c.Id = p.CampusId");
        expect(suggestJoin("campusid", "p")?.snippet).toBe("INNER JOIN Campus c ON c.Id = p.CampusId");
    });

    it("falls back to a generic alias when it is given none", () => {
        expect(suggestJoin("CampusId", "  ")?.snippet).toBe("INNER JOIN Campus c ON c.Id = t.CampusId");
    });

    it("stays quiet about a column it cannot place", () => {
        expect(suggestJoin("LastName", "p")).toBeNull();
        expect(suggestJoin("Id", "p")).toBeNull();
        expect(suggestJoin("SomeCustomThingId", "x")).toBeNull();
        expect(suggestJoin("", "p")).toBeNull();
    });
});

describe("findPersonAliasMisjoins", () => {
    it("flags an aliased Person joined to a PersonAliasId column", () => {
        const sql = "SELECT * FROM Attendance a INNER JOIN Person p ON p.Id = a.PersonAliasId";
        const diagnostics = findPersonAliasMisjoins(sql);

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].severity).toBe("warning");
        expect(sql.substring(diagnostics[0].startOffset, diagnostics[0].endOffset)).toBe("p.Id = a.PersonAliasId");
        expect(diagnostics[0].message).toContain("PersonAlias");
    });

    it("flags the comparison written the other way around", () => {
        const sql = "SELECT * FROM Attendance a INNER JOIN Person p ON a.PersonAliasId = p.Id";

        expect(findPersonAliasMisjoins(sql)).toHaveLength(1);
    });

    it("flags an unaliased Person", () => {
        const sql = "SELECT * FROM Attendance a INNER JOIN Person ON Person.Id = a.PersonAliasId";

        expect(findPersonAliasMisjoins(sql)).toHaveLength(1);
    });

    it("flags a bracketed spelling", () => {
        const sql = "SELECT * FROM Attendance a INNER JOIN Person p ON [p].[Id] = [a].[PersonAliasId]";

        expect(findPersonAliasMisjoins(sql)).toHaveLength(1);
    });

    it("flags a prefixed person alias column", () => {
        const sql = "SELECT * FROM FinancialTransaction ft INNER JOIN Person p ON p.Id = ft.AuthorizedPersonAliasId";

        expect(findPersonAliasMisjoins(sql)).toHaveLength(1);
    });

    it("flags the mistake in a WHERE clause, not just in a JOIN", () => {
        const sql = "SELECT * FROM Attendance a, Person p WHERE p.Id = a.PersonAliasId";

        expect(findPersonAliasMisjoins(sql)).toHaveLength(1);
    });

    it("flags each occurrence and reports them in document order", () => {
        const sql = [
            "SELECT * FROM Attendance a",
            "INNER JOIN Person p ON p.Id = a.PersonAliasId",
            "INNER JOIN Person p2 ON p2.Id = a.CreatedByPersonAliasId"
        ].join("\n");
        const diagnostics = findPersonAliasMisjoins(sql);

        expect(diagnostics).toHaveLength(2);
        expect(diagnostics[0].startOffset).toBeLessThan(diagnostics[1].startOffset);
    });

    it("says nothing about a correct join through PersonAlias", () => {
        const sql = [
            "SELECT p.LastName",
            "FROM Attendance a",
            "INNER JOIN PersonAlias pa ON pa.Id = a.PersonAliasId",
            "INNER JOIN Person p ON p.Id = pa.PersonId"
        ].join("\n");

        expect(findPersonAliasMisjoins(sql)).toEqual([]);
    });

    it("says nothing about a correct join with the comparisons reversed", () => {
        const sql = [
            "SELECT p.LastName",
            "FROM Attendance a",
            "INNER JOIN PersonAlias pa ON a.PersonAliasId = pa.Id",
            "INNER JOIN Person p ON pa.PersonId = p.Id"
        ].join("\n");

        expect(findPersonAliasMisjoins(sql)).toEqual([]);
    });

    it("says nothing when PersonAlias is unaliased", () => {
        const sql = "SELECT * FROM Attendance a INNER JOIN PersonAlias ON PersonAlias.Id = a.PersonAliasId";

        expect(findPersonAliasMisjoins(sql)).toEqual([]);
    });

    it("says nothing about an unrelated Id join", () => {
        const sql = "SELECT * FROM GroupMember gm INNER JOIN [Group] g ON g.Id = gm.GroupId";

        expect(findPersonAliasMisjoins(sql)).toEqual([]);
    });

    it("says nothing about Person joined on a real PersonId column", () => {
        const sql = "SELECT * FROM PersonAlias pa INNER JOIN Person p ON p.Id = pa.PersonId";

        expect(findPersonAliasMisjoins(sql)).toEqual([]);
    });

    it("says nothing when the alias cannot be resolved to a table", () => {
        expect(findPersonAliasMisjoins("SELECT * WHERE x.Id = y.PersonAliasId")).toEqual([]);
    });

    it("says nothing when the Id side is some other table", () => {
        const sql = "SELECT * FROM Attendance a INNER JOIN [Group] g ON g.Id = a.PersonAliasId";

        expect(findPersonAliasMisjoins(sql)).toEqual([]);
    });

    it("does not see the mistake inside a string literal", () => {
        const sql = "SELECT * FROM Person p WHERE p.LastName = 'p.Id = a.PersonAliasId'";

        expect(findPersonAliasMisjoins(sql)).toEqual([]);
    });

    it("does not see the mistake inside a line comment", () => {
        const sql = "SELECT * FROM Attendance a INNER JOIN Person p ON 1 = 1\n-- p.Id = a.PersonAliasId";

        expect(findPersonAliasMisjoins(sql)).toEqual([]);
    });

    it("does not see the mistake inside a block comment", () => {
        const sql = "SELECT * FROM Attendance a INNER JOIN Person p ON 1 = 1 /* p.Id = a.PersonAliasId */";

        expect(findPersonAliasMisjoins(sql)).toEqual([]);
    });

    it("says nothing about text with no comparison in it", () => {
        expect(findPersonAliasMisjoins("")).toEqual([]);
        expect(findPersonAliasMisjoins("SELECT 1")).toEqual([]);
    });

    it("stays quiet on a subquery whose aliases it deliberately did not read", () => {
        const sql = "SELECT * FROM Attendance a WHERE a.PersonAliasId IN (SELECT p.Id FROM Person p WHERE p.Id = a.PersonAliasId)";

        expect(findPersonAliasMisjoins(sql)).toEqual([]);
    });
});

describe("curatedForeignKeyColumns", () => {
    it("names the columns a query joins the core tables on", () => {
        expect(curatedForeignKeyColumns("Attendance")).toContain("OccurrenceId");
        expect(curatedForeignKeyColumns("Attendance")).toContain("PersonAliasId");
    });

    it("ignores casing, brackets and schema qualifiers", () => {
        expect(curatedForeignKeyColumns("[dbo].[groupmember]")).toContain("GroupId");
    });

    it("says nothing about a table it does not know", () => {
        expect(curatedForeignKeyColumns("_org_CustomThing")).toEqual([]);
    });

    it("only lists columns that resolve to a canonical join", () => {
        for (const [table, columns] of Object.entries(rockForeignKeyColumns)) {
            for (const column of columns) {
                expect(suggestJoin(column, "x"), `${table}.${column}`).not.toBeNull();
            }
        }
    });

    it("hands back a copy, so a caller cannot edit the catalog", () => {
        const columns = curatedForeignKeyColumns("PersonAlias");

        columns.push("Nonsense");

        expect(curatedForeignKeyColumns("PersonAlias")).toEqual(["PersonId"]);
    });
});
