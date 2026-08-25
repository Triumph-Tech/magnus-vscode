import { describe, expect, it } from "vitest";
import {
    bareIdentifier,
    isWordPart,
    isWordStart,
    skipBlockComment,
    skipLineComment,
    sqlIdentifierPattern,
    sqlQualifiedIdentifierPattern,
    unbracketIdentifier,
    unquoteIdentifier
} from "../sqlLexemes";

/**
 * The lexical primitives the SQL scanners share: word characters, comment
 * skipping, the identifier pattern and identifier unquoting.
 */

describe("isWordStart", () => {
    it("accepts a letter, an underscore, a variable and a temp table", () => {
        expect(isWordStart("a")).toBe(true);
        expect(isWordStart("Z")).toBe(true);
        expect(isWordStart("_")).toBe(true);
        expect(isWordStart("@")).toBe(true);
        expect(isWordStart("#")).toBe(true);
    });

    it("rejects a digit, a dollar sign and punctuation", () => {
        expect(isWordStart("1")).toBe(false);
        expect(isWordStart("$")).toBe(false);
        expect(isWordStart(".")).toBe(false);
        expect(isWordStart(" ")).toBe(false);
    });
});

describe("isWordPart", () => {
    it("accepts everything a word can continue with", () => {
        expect(isWordPart("a")).toBe(true);
        expect(isWordPart("1")).toBe(true);
        expect(isWordPart("_")).toBe(true);
        expect(isWordPart("@")).toBe(true);
        expect(isWordPart("#")).toBe(true);
        expect(isWordPart("$")).toBe(true);
    });

    it("rejects what ends a word", () => {
        expect(isWordPart(".")).toBe(false);
        expect(isWordPart(" ")).toBe(false);
        expect(isWordPart("[")).toBe(false);
    });
});

describe("skipLineComment", () => {
    it("stops at the line break, which stays in the text", () => {
        const text = "-- note\nSELECT 1";

        expect(skipLineComment(text, 0)).toBe(7);
        expect(text[7]).toBe("\n");
    });

    it("runs to the end of an unterminated comment", () => {
        expect(skipLineComment("-- note", 0)).toBe(7);
    });
});

describe("skipBlockComment", () => {
    it("skips a plain comment", () => {
        expect(skipBlockComment("/* note */x", 0)).toBe(10);
    });

    it("counts nesting rather than stopping at the first close", () => {
        const text = "/* a /* b */ */x";

        expect(skipBlockComment(text, 0)).toBe(15);
    });

    it("runs to the end of an unterminated comment", () => {
        expect(skipBlockComment("/* a /* b */", 0)).toBe(12);
    });
});

describe("sqlIdentifierPattern", () => {
    it("matches a bare identifier and a bracketed one", () => {
        const pattern = new RegExp(`^${sqlIdentifierPattern}$`);

        expect(pattern.test("Person")).toBe(true);
        expect(pattern.test("[Group]")).toBe(true);
        expect(pattern.test("@rows")).toBe(true);
        expect(pattern.test("#tmp")).toBe(true);
        expect(pattern.test("a_1$")).toBe(true);
    });

    it("does not swallow a dot, so an owner and its column stay apart", () => {
        const pattern = new RegExp(`^${sqlIdentifierPattern}$`);

        expect(pattern.test("dbo.Person")).toBe(false);
    });

    it("matches inside a larger pattern", () => {
        const match = new RegExp(`\\bfrom\\s+(${sqlIdentifierPattern})`, "i").exec("SELECT * FROM [Group] g");

        expect(match?.[1]).toBe("[Group]");
    });
});

describe("sqlQualifiedIdentifierPattern", () => {
    it("matches a name that carries its schema", () => {
        const pattern = new RegExp(`^${sqlQualifiedIdentifierPattern}$`);

        expect(pattern.test("dbo.Person")).toBe(true);
        expect(pattern.test("Person")).toBe(true);
        expect(pattern.test("[Group]")).toBe(true);
    });
});

describe("unbracketIdentifier", () => {
    it("removes the brackets", () => {
        expect(unbracketIdentifier("[Person]")).toBe("Person");
    });

    it("collapses a doubled closing bracket back to one", () => {
        expect(unbracketIdentifier("[My]]Table]")).toBe("My]Table");
    });

    it("leaves a bare name alone", () => {
        expect(unbracketIdentifier("Person")).toBe("Person");
        expect(unbracketIdentifier("")).toBe("");
    });

    it("leaves a double quoted name alone", () => {
        expect(unbracketIdentifier("\"Person\"")).toBe("\"Person\"");
    });
});

describe("unquoteIdentifier", () => {
    it("removes brackets or double quotes", () => {
        expect(unquoteIdentifier("[Person]")).toBe("Person");
        expect(unquoteIdentifier("\"Person\"")).toBe("Person");
    });

    it("shares the bracket rules, doubled closing bracket included", () => {
        expect(unquoteIdentifier("[My]]Table]")).toBe("My]Table");
    });

    it("leaves a bare name alone", () => {
        expect(unquoteIdentifier("Person")).toBe("Person");
    });
});

describe("bareIdentifier", () => {
    it("takes the last part of a qualified name", () => {
        expect(bareIdentifier("dbo.Person")).toBe("Person");
        expect(bareIdentifier("[dbo].[Person]")).toBe("Person");
    });

    it("trims the part before unquoting it", () => {
        expect(bareIdentifier("dbo . [Person] ")).toBe("Person");
    });

    it("returns a bare name unchanged", () => {
        expect(bareIdentifier("Person")).toBe("Person");
        expect(bareIdentifier("")).toBe("");
    });
});
