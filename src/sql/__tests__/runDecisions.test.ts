import { describe, expect, it } from "vitest";
import { ServerEnvironment } from "../documentBindings";
import { buildRunLenses, classifyRunText, containsDestructiveKeyword, resolveRunTarget, resolveStatementTarget, runNeedsConfirmation, summarizeStatement } from "../runDecisions";

const serverUrl = "https://rock.example.org";

describe("resolveRunTarget", () => {
    it("runs the selection when there is one", () => {
        expect(resolveRunTarget("SELECT 1;\nSELECT 2;", "SELECT 2;")).toEqual({ text: "SELECT 2;", source: "selection" });
    });

    it("runs the whole document when nothing is selected", () => {
        expect(resolveRunTarget("SELECT 1;", "")).toEqual({ text: "SELECT 1;", source: "document" });
    });

    it("ignores a selection of nothing but whitespace", () => {
        expect(resolveRunTarget("SELECT 1;", "   \n ")).toEqual({ text: "SELECT 1;", source: "document" });
    });

    it("has nothing to run in an empty document", () => {
        expect(resolveRunTarget("   \n\n", "")).toBeNull();
    });
});

describe("resolveStatementTarget", () => {
    const text = "SELECT 1;\nSELECT 2;\nSELECT 3;";

    it("runs the statement the cursor is in", () => {
        expect(resolveStatementTarget(text, 12)).toEqual({ text: "SELECT 2;", source: "statement" });
    });

    it("runs the first statement when the cursor is at the very start", () => {
        expect(resolveStatementTarget(text, 0)).toEqual({ text: "SELECT 1;", source: "statement" });
    });

    it("falls back to the whole document when the splitter finds nothing", () => {
        // Nothing but a comment: no statements, but the person still asked to run.
        expect(resolveStatementTarget("-- just a note", 3)).toEqual({ text: "-- just a note", source: "document" });
    });

    it("has nothing to run in an empty document", () => {
        expect(resolveStatementTarget("\n\n", 1)).toBeNull();
    });
});

describe("classifyRunText", () => {
    it("classifies every statement of a batch", () => {
        expect(classifyRunText("SELECT 1;\nUPDATE Person SET Email = NULL;")).toEqual(["read", "destructive"]);
    });

    it("classifies text the splitter finds no statements in as a whole", () => {
        expect(classifyRunText("-- nothing here")).toEqual(["unknown"]);
    });

    it("classifies nothing at all as nothing", () => {
        expect(classifyRunText("   ")).toEqual([]);
    });

    it("catches a destructive keyword in a batch written without semicolons", () => {
        expect(classifyRunText("DECLARE @x INT\nDELETE FROM Person")).toEqual(["read", "destructive"]);
    });

    it("catches a SELECT that writes a table with INTO", () => {
        expect(classifyRunText("SELECT * INTO PersonCopy FROM Person")).toEqual(["read", "destructive"]);
    });

    it("leaves a read alone when the keyword is inside a string literal", () => {
        expect(classifyRunText("SELECT * FROM Person WHERE LastName = 'delete me'")).toEqual(["read"]);
    });

    it("leaves a read alone when the keyword is inside a comment", () => {
        expect(classifyRunText("SELECT 1 -- delete this later")).toEqual(["read"]);
        expect(classifyRunText("/* TODO: drop the table */\nSELECT 1")).toEqual(["read"]);
    });

    it("leaves a read alone when the keyword is only part of a name", () => {
        expect(classifyRunText("SELECT DeletedDateTime, Updates FROM Person")).toEqual(["read"]);
    });

    it("does not add a verdict to a batch that already has one", () => {
        expect(classifyRunText("SELECT 1;\nDELETE FROM Person;")).toEqual(["read", "destructive"]);
    });
});

describe("containsDestructiveKeyword", () => {
    it("finds a keyword anywhere in the run", () => {
        expect(containsDestructiveKeyword("DECLARE @x INT\nTRUNCATE TABLE Person")).toBe(true);
    });

    it("ignores keywords in strings and comments", () => {
        expect(containsDestructiveKeyword("SELECT 'drop' -- alter")).toBe(false);
    });

    it("ignores a keyword that is only part of a word", () => {
        expect(containsDestructiveKeyword("SELECT Inserted, Dropped FROM x")).toBe(false);
    });

    it("finds nothing in an empty run", () => {
        expect(containsDestructiveKeyword("")).toBe(false);
    });
});

describe("runNeedsConfirmation", () => {
    /**
     * Runs the confirmation decision with the defaults the matrix below shares.
     *
     * @param text The text about to run.
     * @param environment The tag on the server.
     * @param alwaysAllow The servers that stopped asking.
     *
     * @returns True if the person must confirm.
     */
    function decide(text: string, environment: ServerEnvironment, alwaysAllow: string[] = []): boolean {
        return runNeedsConfirmation(text, environment, alwaysAllow, serverUrl);
    }

    it("confirms on an untagged server, which is treated as production", () => {
        expect(decide("DROP TABLE Person;", undefined)).toBe(true);
    });

    it("does not confirm a read on an untagged server", () => {
        expect(decide("SELECT TOP (10) * FROM Person;", undefined)).toBe(false);
    });

    it("confirms a batch on an untagged server that goes on to change data", () => {
        expect(decide("SELECT 1;\nDELETE FROM Person WHERE Id = 1;", undefined)).toBe(true);
    });

    it("does not confirm on an untagged server that was always allowed", () => {
        expect(decide("DROP TABLE Person;", undefined, [serverUrl])).toBe(false);
    });

    it("never confirms on a development server", () => {
        expect(decide("DROP TABLE Person;", "development")).toBe(false);
    });

    it("never confirms on a staging server", () => {
        expect(decide("DROP TABLE Person;", "staging")).toBe(false);
    });

    it("does not confirm a read on production", () => {
        expect(decide("SELECT TOP (10) * FROM Person;", "production")).toBe(false);
    });

    it("confirms a destructive statement on production", () => {
        expect(decide("UPDATE Person SET Email = NULL;", "production")).toBe(true);
    });

    it("confirms an unrecognized statement on production, failing safe", () => {
        expect(decide("-- who knows", "production")).toBe(true);
    });

    it("confirms a batch whose first statement is a read but which goes on to change data", () => {
        expect(decide("SELECT 1;\nDELETE FROM Person WHERE Id = 1;", "production")).toBe(true);
    });

    it("does not confirm a batch of nothing but reads on production", () => {
        expect(decide("SELECT 1;\nSELECT 2;\nGO\nSELECT 3;", "production")).toBe(false);
    });

    it("does not confirm on a production server that was always allowed", () => {
        expect(decide("DROP TABLE Person;", "production", [serverUrl])).toBe(false);
    });

    it("matches the always allow list regardless of trailing slashes and case", () => {
        expect(decide("DROP TABLE Person;", "production", ["HTTPS://Rock.Example.org/"])).toBe(false);
    });

    it("still confirms when a different server was always allowed", () => {
        expect(decide("DROP TABLE Person;", "production", ["https://other.example.org"])).toBe(true);
    });

    it("does not confirm empty text", () => {
        expect(decide("   ", "production")).toBe(false);
    });
});

describe("buildRunLenses", () => {
    it("maps one lens onto each statement", () => {
        const lenses = buildRunLenses("SELECT 1;\nSELECT 2;", true);

        expect(lenses).toHaveLength(2);
        expect(lenses[0]).toEqual({ startOffset: 0, endOffset: 9, startLine: 0, text: "SELECT 1;" });
        expect(lenses[1].startLine).toBe(1);
        expect(lenses[1].text).toBe("SELECT 2;");
    });

    it("puts a lens on each batch of a GO separated script", () => {
        const lenses = buildRunLenses("SELECT 1\nGO\nSELECT 2\n", true);

        expect(lenses.map(lens => lens.text)).toEqual(["SELECT 1", "SELECT 2"]);
    });

    it("returns nothing when the setting is off", () => {
        expect(buildRunLenses("SELECT 1;", false)).toEqual([]);
    });

    it("returns nothing for a document with no statements", () => {
        expect(buildRunLenses("-- a note\n", true)).toEqual([]);
    });

    it("does not put a lens inside a string literal that looks like a statement", () => {
        const lenses = buildRunLenses("SELECT 'a; b' AS Value;", true);

        expect(lenses).toHaveLength(1);
    });
});

describe("summarizeStatement", () => {
    it("collapses whitespace onto one line", () => {
        expect(summarizeStatement("SELECT\n    *\nFROM Person")).toBe("SELECT * FROM Person");
    });

    it("truncates a long statement with an ellipsis", () => {
        const summary = summarizeStatement("SELECT " + "x".repeat(200), 20);

        expect(summary).toHaveLength(20);
        expect(summary.endsWith("…")).toBe(true);
    });

    it("leaves a statement that fits alone", () => {
        expect(summarizeStatement("SELECT 1", 20)).toBe("SELECT 1");
    });
});
