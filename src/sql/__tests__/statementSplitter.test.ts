import { describe, expect, it } from "vitest";
import { classifyStatement, splitStatements, statementAt } from "../statementSplitter";

/**
 * Splits the text and returns just the statement texts, which is what most of
 * these cases care about.
 *
 * @param text The document text to split.
 *
 * @returns The text of each statement found.
 */
function texts(text: string): string[] {
    return splitStatements(text).map(s => s.text);
}

describe("splitStatements", () => {
    it("returns nothing for empty input", () => {
        expect(splitStatements("")).toEqual([]);
    });

    it("returns nothing for whitespace only input", () => {
        expect(splitStatements("   \n\t\r\n  ")).toEqual([]);
    });

    it("returns nothing for comment only input", () => {
        expect(splitStatements("-- just a note\n/* and another */\n")).toEqual([]);
    });

    it("returns a single statement with no terminator", () => {
        const statements = splitStatements("SELECT 1");

        expect(statements).toHaveLength(1);
        expect(statements[0]).toEqual({
            text: "SELECT 1",
            startOffset: 0,
            endOffset: 8,
            startLine: 0
        });
    });

    it("keeps the semicolon with the statement it terminates", () => {
        expect(texts("SELECT 1;")).toEqual(["SELECT 1;"]);
    });

    it("splits on top level semicolons", () => {
        expect(texts("SELECT 1; SELECT 2;")).toEqual(["SELECT 1;", "SELECT 2;"]);
    });

    it("drops the segment after a trailing semicolon", () => {
        expect(texts("SELECT 1;\n\n")).toEqual(["SELECT 1;"]);
    });

    it("drops empty segments made of stray semicolons", () => {
        expect(texts("SELECT 1;;;SELECT 2")).toEqual(["SELECT 1;", "SELECT 2"]);
    });

    it("gives offsets that address the statement text exactly", () => {
        const text = "  SELECT 1;\n\n  SELECT 2  ";
        const statements = splitStatements(text);

        for (const statement of statements) {
            expect(text.substring(statement.startOffset, statement.endOffset)).toBe(statement.text);
        }
    });

    it("reports the line each statement starts on", () => {
        const statements = splitStatements("SELECT 1;\n\nSELECT 2;\nGO\nSELECT 3;");

        expect(statements.map(s => s.startLine)).toEqual([0, 2, 4]);
    });

    it("ignores a semicolon inside a string literal", () => {
        expect(texts("SELECT 'a;b';SELECT 2")).toEqual(["SELECT 'a;b';", "SELECT 2"]);
    });

    it("handles a doubled quote escape inside a string literal", () => {
        expect(texts("SELECT 'it''s; fine';SELECT 2")).toEqual(["SELECT 'it''s; fine';", "SELECT 2"]);
    });

    it("ignores a semicolon inside a bracketed identifier", () => {
        expect(texts("SELECT [odd;name] FROM T;SELECT 2")).toEqual(["SELECT [odd;name] FROM T;", "SELECT 2"]);
    });

    it("handles a doubled bracket escape inside a bracketed identifier", () => {
        expect(texts("SELECT [weird]];name] FROM T;SELECT 2")).toEqual(["SELECT [weird]];name] FROM T;", "SELECT 2"]);
    });

    it("ignores a semicolon inside a double quoted identifier", () => {
        expect(texts("SELECT \"odd;name\" FROM T;SELECT 2")).toEqual(["SELECT \"odd;name\" FROM T;", "SELECT 2"]);
    });

    it("ignores a semicolon inside a line comment", () => {
        expect(texts("SELECT 1 -- ; not a boundary\nFROM T;SELECT 2")).toEqual(["SELECT 1 -- ; not a boundary\nFROM T;", "SELECT 2"]);
    });

    it("ignores a semicolon inside a block comment", () => {
        expect(texts("SELECT /* ; */ 1;SELECT 2")).toEqual(["SELECT /* ; */ 1;", "SELECT 2"]);
    });

    it("honors nested block comments", () => {
        expect(texts("SELECT /* outer /* inner ; */ still ; comment */ 1;SELECT 2")).toEqual(["SELECT /* outer /* inner ; */ still ; comment */ 1;", "SELECT 2"]);
    });

    it("does not run off the end of an unterminated string", () => {
        expect(texts("SELECT 'unterminated")).toEqual(["SELECT 'unterminated"]);
    });

    it("does not run off the end of an unterminated block comment", () => {
        expect(texts("SELECT 1 /* unterminated")).toEqual(["SELECT 1 /* unterminated"]);
    });

    it("splits on a GO batch separator", () => {
        expect(texts("SELECT 1\nGO\nSELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
    });

    it("never includes the GO in a statement", () => {
        for (const statement of texts("SELECT 1\nGO\nSELECT 2")) {
            expect(statement.toLowerCase()).not.toContain("go");
        }
    });

    it("splits on a GO in any letter case", () => {
        expect(texts("SELECT 1\ngo\nSELECT 2\nGo\nSELECT 3")).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
    });

    it("splits on an indented GO", () => {
        expect(texts("SELECT 1\n\tGO  \nSELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
    });

    it("splits on a GO with a repeat count", () => {
        expect(texts("INSERT INTO T VALUES (1)\nGO 10\nSELECT 2")).toEqual(["INSERT INTO T VALUES (1)", "SELECT 2"]);
    });

    it("splits on a GO followed by a line comment", () => {
        expect(texts("SELECT 1\nGO -- new batch\nSELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
    });

    it("splits on a GO at the very end of the document", () => {
        expect(texts("SELECT 1\nGO")).toEqual(["SELECT 1"]);
    });

    it("splits on a GO at the very start of the document", () => {
        expect(texts("GO\nSELECT 1")).toEqual(["SELECT 1"]);
    });

    it("does not treat a GO with trailing code as a separator", () => {
        expect(texts("SELECT 1\nGO SELECT 2")).toEqual(["SELECT 1\nGO SELECT 2"]);
    });

    it("does not treat a GO with leading code as a separator", () => {
        expect(texts("SELECT 1 GO\nSELECT 2")).toEqual(["SELECT 1 GO\nSELECT 2"]);
    });

    it("does not treat a word that merely starts with GO as a separator", () => {
        expect(texts("SELECT 1\nGOTO done")).toEqual(["SELECT 1\nGOTO done"]);
    });

    it("does not treat a GO inside a string as a separator", () => {
        expect(texts("SELECT '\nGO\n' AS x")).toEqual(["SELECT '\nGO\n' AS x"]);
    });

    it("does not treat a GO inside a block comment as a separator", () => {
        expect(texts("SELECT 1 /*\nGO\n*/ + 2")).toEqual(["SELECT 1 /*\nGO\n*/ + 2"]);
    });

    it("does not treat a commented out GO as a separator", () => {
        expect(texts("SELECT 1\n--GO\n+ 2")).toEqual(["SELECT 1\n--GO\n+ 2"]);
    });

    it("splits a document that uses CRLF line endings", () => {
        expect(texts("SELECT 1\r\nGO\r\nSELECT 2\r\n")).toEqual(["SELECT 1", "SELECT 2"]);
    });

    it("counts lines the same way for CRLF and LF", () => {
        const lf = splitStatements("SELECT 1\nGO\nSELECT 2");
        const crlf = splitStatements("SELECT 1\r\nGO\r\nSELECT 2");

        expect(crlf.map(s => s.startLine)).toEqual(lf.map(s => s.startLine));
    });

    it("splits on both semicolons and GO in the same document", () => {
        expect(texts("SELECT 1;\nSELECT 2;\nGO\nSELECT 3")).toEqual(["SELECT 1;", "SELECT 2;", "SELECT 3"]);
    });

    it("drops a batch that holds only a comment", () => {
        expect(texts("SELECT 1\nGO\n-- nothing here\nGO\nSELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
    });

    it("keeps a leading comment with the statement it documents", () => {
        expect(texts("-- why\nSELECT 1")).toEqual(["-- why\nSELECT 1"]);
    });
});

describe("statementAt", () => {
    const text = "SELECT 1;\n\nSELECT 2;\nGO\nSELECT 3";
    const statements = splitStatements(text);

    it("returns undefined when there are no statements", () => {
        expect(statementAt([], 0)).toBeUndefined();
    });

    it("finds the statement a cursor sits inside", () => {
        expect(statementAt(statements, 3)?.text).toBe("SELECT 1;");
        expect(statementAt(statements, 14)?.text).toBe("SELECT 2;");
        expect(statementAt(statements, 28)?.text).toBe("SELECT 3");
    });

    it("resolves a cursor on the first character to that statement", () => {
        expect(statementAt(statements, statements[1].startOffset)?.text).toBe("SELECT 2;");
    });

    it("resolves a cursor just past the last character to that statement", () => {
        expect(statementAt(statements, statements[0].endOffset)?.text).toBe("SELECT 1;");
    });

    it("resolves a cursor in the blank line between statements to the preceding one", () => {
        expect(statementAt(statements, 10)?.text).toBe("SELECT 1;");
    });

    it("resolves a cursor on the GO line to the preceding statement", () => {
        expect(statementAt(statements, text.indexOf("GO") + 1)?.text).toBe("SELECT 2;");
    });

    it("resolves a cursor past the end of the document to the last statement", () => {
        expect(statementAt(statements, text.length + 50)?.text).toBe("SELECT 3");
    });

    it("resolves a cursor before the first statement to the first statement", () => {
        expect(statementAt(splitStatements("\n\n   SELECT 1"), 0)?.text).toBe("SELECT 1");
    });
});

describe("classifyStatement", () => {
    it("classifies an empty statement as unknown", () => {
        expect(classifyStatement("")).toBe("unknown");
        expect(classifyStatement("   \n  ")).toBe("unknown");
        expect(classifyStatement("-- nothing")).toBe("unknown");
    });

    it("classifies reads", () => {
        expect(classifyStatement("SELECT * FROM Person")).toBe("read");
        expect(classifyStatement("declare @x int")).toBe("read");
        expect(classifyStatement("SET NOCOUNT ON")).toBe("read");
        expect(classifyStatement("PRINT 'hi'")).toBe("read");
        expect(classifyStatement("USE RockDb")).toBe("read");
    });

    it("classifies destructive statements", () => {
        const destructive = [
            "UPDATE Person SET FirstName = 'x'",
            "DELETE FROM Person",
            "INSERT INTO Person (Id) VALUES (1)",
            "MERGE Person AS t USING S ON 1 = 1",
            "TRUNCATE TABLE Person",
            "DROP TABLE Person",
            "ALTER TABLE Person ADD X int",
            "CREATE TABLE Person (Id int)",
            "GRANT SELECT ON Person TO rock",
            "DENY SELECT ON Person TO rock",
            "REVOKE SELECT ON Person TO rock"
        ];

        for (const statement of destructive) {
            expect(classifyStatement(statement)).toBe("destructive");
        }
    });

    it("classifies both spellings of EXEC as destructive", () => {
        expect(classifyStatement("EXEC spSomething")).toBe("destructive");
        expect(classifyStatement("execute spSomething")).toBe("destructive");
    });

    it("ignores letter case and leading whitespace", () => {
        expect(classifyStatement("\n\t  uPdAtE Person SET X = 1")).toBe("destructive");
    });

    it("skips leading comments to find the keyword", () => {
        expect(classifyStatement("-- a note\n/* another */\nSELECT 1")).toBe("read");
        expect(classifyStatement("/* nested /* note */ */ DELETE FROM T")).toBe("destructive");
    });

    it("is not fooled by a keyword inside a leading comment", () => {
        expect(classifyStatement("-- DELETE FROM Person\nSELECT 1")).toBe("read");
    });

    it("is not fooled by a keyword inside a string", () => {
        expect(classifyStatement("SELECT 'DELETE FROM Person'")).toBe("read");
    });

    it("classifies BEGIN as unknown because a block and a transaction look alike", () => {
        expect(classifyStatement("BEGIN TRANSACTION")).toBe("unknown");
        expect(classifyStatement("BEGIN\n SELECT 1\nEND")).toBe("unknown");
    });

    it("classifies an unrecognized shape as unknown", () => {
        expect(classifyStatement("GOTO done")).toBe("unknown");
        expect(classifyStatement("@x = 1")).toBe("unknown");
        expect(classifyStatement("(SELECT 1)")).toBe("unknown");
    });

    it("follows a common table expression through to a SELECT", () => {
        expect(classifyStatement("WITH c AS (SELECT Id FROM Person) SELECT * FROM c")).toBe("read");
    });

    it("follows a common table expression through to a DELETE", () => {
        expect(classifyStatement("WITH c AS (SELECT Id FROM Person) DELETE FROM c")).toBe("destructive");
    });

    it("follows a common table expression through to an UPDATE", () => {
        expect(classifyStatement("WITH c AS (SELECT Id FROM Person) UPDATE c SET Id = 1")).toBe("destructive");
    });

    it("follows a common table expression through to an INSERT", () => {
        expect(classifyStatement("WITH c AS (SELECT 1 AS Id) INSERT INTO T SELECT Id FROM c")).toBe("destructive");
    });

    it("follows a common table expression through to a MERGE", () => {
        expect(classifyStatement("WITH c AS (SELECT 1 AS Id) MERGE T AS t USING c ON 1 = 1")).toBe("destructive");
    });

    it("follows several chained common table expressions", () => {
        expect(classifyStatement("WITH a AS (SELECT 1 AS Id), b AS (SELECT Id FROM a) DELETE FROM b")).toBe("destructive");
    });

    it("is not fooled by a nested SELECT inside the expression body", () => {
        expect(classifyStatement("WITH c AS (SELECT (SELECT 1) AS Id) UPDATE c SET Id = 2")).toBe("destructive");
    });

    it("classifies a common table expression with no recognizable body as unknown", () => {
        expect(classifyStatement("WITH c AS (SELECT 1)")).toBe("unknown");
    });

    it("classifies a multi line common table expression", () => {
        const statement = [
            "WITH Recent AS (",
            "    SELECT Id",
            "    FROM Person",
            ")",
            "SELECT * FROM Recent"
        ].join("\n");

        expect(classifyStatement(statement)).toBe("read");
    });
});
