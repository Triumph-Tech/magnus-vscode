import { readFileSync } from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { findPersonAliasMisjoins } from "../rockCatalog";
import { classifyStatement } from "../statementSplitter";

/** The shape of one entry of a vscode snippet file. */
type SnippetDefinition = {
    /** The text typed to insert the snippet. */
    prefix: string;

    /** The lines of the snippet. */
    body: string[];

    /** What the snippet is for. */
    description: string;
};

/** The snippet library, read from the file that ships in the package. */
const snippets: Record<string, SnippetDefinition> = JSON.parse(readFileSync(path.join(process.cwd(), "snippets", "rock-sql.json"), "utf8"));

/** The snippets as name and body pairs, which is what most of these tests want. */
const entries = Object.keys(snippets).map(name => ({
    name,
    definition: snippets[name],
    sql: snippets[name].body.join("\n")
}));

describe("the Rock snippet library", () => {
    it("ships enough snippets to be worth having", () => {
        expect(entries.length).toBeGreaterThanOrEqual(8);
    });

    it("prefixes every snippet with rock-", () => {
        for (const entry of entries) {
            expect(entry.definition.prefix.startsWith("rock-")).toBe(true);
        }
    });

    it("gives every snippet a unique prefix", () => {
        const prefixes = entries.map(entry => entry.definition.prefix);

        expect(new Set(prefixes).size).toBe(prefixes.length);
    });

    it("describes every snippet", () => {
        for (const entry of entries) {
            expect(entry.definition.description.length).toBeGreaterThan(20);
        }
    });

    it("covers the queries people actually ask for", () => {
        const prefixes = entries.map(entry => entry.definition.prefix);

        for (const expected of [
            "rock-person-name",
            "rock-person-email",
            "rock-attendance-range",
            "rock-giving-range",
            "rock-group-members",
            "rock-defined-values",
            "rock-attribute-values",
            "rock-registrations",
            "rock-communication-recipients",
            "rock-connection-requests"
        ]) {
            expect(prefixes).toContain(expected);
        }
    });

    it("models every person join correctly", () => {
        for (const entry of entries) {
            expect(findPersonAliasMisjoins(entry.sql), `${entry.name} joins a person the wrong way`).toEqual([]);
        }
    });

    it("holds nothing but read statements", () => {
        for (const entry of entries) {
            expect(classifyStatement(entry.sql), `${entry.name} is not a read`).toBe("read");
        }
    });

    it("reaches Person through PersonAlias wherever it uses an alias id", () => {
        for (const entry of entries.filter(candidate => /PersonAliasId/.test(candidate.sql))) {
            expect(entry.sql, `${entry.name} uses an alias id without joining PersonAlias`).toContain("INNER JOIN PersonAlias");
            expect(entry.sql).toContain("pa.PersonId");
        }
    });

    it("brackets the reserved table names", () => {
        for (const entry of entries) {
            expect(/(?:FROM|JOIN)\s+Group\b/i.test(entry.sql), `${entry.name} uses Group without brackets`).toBe(false);
            expect(/(?:FROM|JOIN)\s+Location\b/i.test(entry.sql), `${entry.name} uses Location without brackets`).toBe(false);
        }
    });
});
