import { describe, expect, it } from "vitest";
import { buildTableActionItems, buildTableQuickPickItems, getNodeContextValue, getNodeIcon, getNodeIsExpandable, getNodePresentation, SqlTableActionKind, SqlTableReference } from "../sqlNodeMapping";
import { ObjectExplorerNodeType } from "../types";

/**
 * Builds a table reference for use in the quick pick tests.
 *
 * @param tableName The name of the table.
 * @param databaseName The name of the database that holds it.
 *
 * @returns A table reference.
 */
function makeTable(tableName: string, databaseName: string = "RockDb"): SqlTableReference {
    return {
        serverUrl: "https://rock.example.org",
        nodeId: `node-${tableName}`,
        tableName,
        databaseName
    };
}

describe("getNodeIcon", () => {
    it("uses the database icon for a database", () => {
        expect(getNodeIcon(ObjectExplorerNodeType.Database)).toBe("$(database)");
    });

    it("uses the table icon for a table", () => {
        expect(getNodeIcon(ObjectExplorerNodeType.Table)).toBe("$(table)");
    });

    it("uses the field icon for a column", () => {
        expect(getNodeIcon(ObjectExplorerNodeType.Column)).toBe("$(symbol-field)");
    });

    it("uses the folder icon for every folder", () => {
        expect(getNodeIcon(ObjectExplorerNodeType.DatabasesFolder)).toBe("$(folder)");
        expect(getNodeIcon(ObjectExplorerNodeType.TablesFolder)).toBe("$(folder)");
        expect(getNodeIcon(ObjectExplorerNodeType.ColumnsFolder)).toBe("$(folder)");
    });
});

describe("getNodeIsExpandable", () => {
    it("makes a column a leaf", () => {
        expect(getNodeIsExpandable(ObjectExplorerNodeType.Column)).toBe(false);
    });

    it("makes everything above a column expandable", () => {
        expect(getNodeIsExpandable(ObjectExplorerNodeType.DatabasesFolder)).toBe(true);
        expect(getNodeIsExpandable(ObjectExplorerNodeType.Database)).toBe(true);
        expect(getNodeIsExpandable(ObjectExplorerNodeType.TablesFolder)).toBe(true);
        expect(getNodeIsExpandable(ObjectExplorerNodeType.Table)).toBe(true);
        expect(getNodeIsExpandable(ObjectExplorerNodeType.ColumnsFolder)).toBe(true);
    });
});

describe("getNodeContextValue", () => {
    it("distinguishes the kinds of node", () => {
        expect(getNodeContextValue(ObjectExplorerNodeType.Database)).toBe("sqlDatabase_");
        expect(getNodeContextValue(ObjectExplorerNodeType.Table)).toBe("sqlTable_canSelectTop1000_");
        expect(getNodeContextValue(ObjectExplorerNodeType.Column)).toBe("sqlColumn_");
        expect(getNodeContextValue(ObjectExplorerNodeType.TablesFolder)).toBe("sqlFolder_");
    });

    it("does not match the menus that belong to the descriptor tree", () => {
        const contextValues = [
            getNodeContextValue(ObjectExplorerNodeType.Database),
            getNodeContextValue(ObjectExplorerNodeType.Table),
            getNodeContextValue(ObjectExplorerNodeType.Column),
            getNodeContextValue(ObjectExplorerNodeType.TablesFolder)
        ];

        for (const contextValue of contextValues) {
            expect(/^server_/.test(contextValue)).toBe(false);
            expect(/^folder_/.test(contextValue)).toBe(false);
            expect(/_canDelete_/.test(contextValue)).toBe(false);
        }
    });
});

describe("getNodePresentation", () => {
    it("maps a server node onto its tree presentation", () => {
        const presentation = getNodePresentation({
            id: "node-1",
            name: "Person",
            type: ObjectExplorerNodeType.Table
        });

        expect(presentation).toEqual({
            label: "Person",
            icon: "$(table)",
            isExpandable: true,
            contextValue: "sqlTable_canSelectTop1000_"
        });
    });

    it("maps a column onto a leaf presentation", () => {
        const presentation = getNodePresentation({
            id: "node-2",
            name: "FirstName",
            type: ObjectExplorerNodeType.Column
        });

        expect(presentation.isExpandable).toBe(false);
        expect(presentation.icon).toBe("$(symbol-field)");
    });
});

describe("buildTableQuickPickItems", () => {
    it("labels each entry with the table name and describes it with the database", () => {
        const items = buildTableQuickPickItems([makeTable("Person")]);

        expect(items).toHaveLength(1);
        expect(items[0].label).toBe("Person");
        expect(items[0].description).toBe("RockDb");
        expect(items[0].table.nodeId).toBe("node-Person");
    });

    it("sorts the entries by table name", () => {
        const items = buildTableQuickPickItems([
            makeTable("Person"),
            makeTable("Attendance"),
            makeTable("Group")
        ]);

        expect(items.map(i => i.label)).toEqual(["Attendance", "Group", "Person"]);
    });

    it("returns nothing when there are no tables", () => {
        expect(buildTableQuickPickItems([])).toEqual([]);
    });
});

describe("buildTableActionItems", () => {
    it("offers reveal, select top 1000 and copy when there is no active editor", () => {
        const items = buildTableActionItems("Person", false);

        expect(items.map(i => i.action)).toEqual([SqlTableActionKind.Reveal, SqlTableActionKind.SelectTop1000, SqlTableActionKind.Copy]);
    });

    it("offers insert as well when there is an active editor", () => {
        const items = buildTableActionItems("Person", true);

        expect(items.map(i => i.action)).toEqual([SqlTableActionKind.Reveal, SqlTableActionKind.SelectTop1000, SqlTableActionKind.Insert, SqlTableActionKind.Copy]);
    });

    it("names the table in every entry", () => {
        for (const item of buildTableActionItems("Person", true)) {
            expect(item.description).toContain("Person");
        }
    });

    it("offers select top 1000 now that query execution ships", () => {
        const labels = buildTableActionItems("Person", true).map(i => i.label.toLowerCase());

        expect(labels.some(l => l.includes("1000"))).toBe(true);
    });
});
