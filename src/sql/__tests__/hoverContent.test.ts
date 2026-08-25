import { describe, expect, it } from "vitest";
import { buildTableHover } from "../hoverContent";

/**
 * Builds a list of column names.
 *
 * @param count How many names to build.
 *
 * @returns The names, `Column1` upwards.
 */
function columns(count: number): string[] {
    const names: string[] = [];

    for (let index = 1; index <= count; index++) {
        names.push(`Column${index}`);
    }

    return names;
}

describe("buildTableHover", () => {
    it("shows what a catalog table is for", () => {
        const markdown = buildTableHover("Person");

        expect(markdown).toContain("**Person**");
        expect(markdown).toContain("One row per person record");
    });

    it("finds the table however it was written", () => {
        expect(buildTableHover("[dbo].[person]")).toContain("**Person**");
    });

    it("shows nothing for a table it knows nothing about", () => {
        expect(buildTableHover("_org_CustomThing")).toBeNull();
        expect(buildTableHover("_org_CustomThing", [])).toBeNull();
    });

    it("shows the columns of a table that is not in the catalog", () => {
        const markdown = buildTableHover("_org_CustomThing", ["Id", "Name"]);

        expect(markdown).toContain("**_org_CustomThing**");
        expect(markdown).toContain("`Id`");
        expect(markdown).toContain("2 columns");
    });

    it("shows both the description and the columns when it has both", () => {
        const markdown = buildTableHover("Attendance", ["Id", "OccurrenceId"]);

        expect(markdown).toContain("check-in");
        expect(markdown).toContain("`OccurrenceId`");
    });

    it("pluralizes a single column", () => {
        expect(buildTableHover("Person", ["Id"])).toContain("1 column");
    });

    it("lists every column of a wide table", () => {
        const markdown = buildTableHover("Person", columns(100)) ?? "";
        const entries = markdown.split("\n").filter(line => line.startsWith("- `"));

        expect(entries).toHaveLength(100);
        expect(markdown).toContain("`Column1`");
        expect(markdown).toContain("`Column100`");
        expect(markdown).toContain("100 columns");
    });

    it("never summarizes the rest of the columns away", () => {
        const markdown = buildTableHover("Person", columns(100)) ?? "";

        expect(markdown).not.toContain("more");
        expect(markdown).not.toContain("…");
    });

    it("cannot be escaped by a backtick in a column name", () => {
        const markdown = buildTableHover("Person", ["Id`](https://evil.example.org)`"]) ?? "";

        expect(markdown).toContain("- `Id'](https://evil.example.org)'`");
        expect(markdown.split("\n").filter(line => line.startsWith("- `"))).toHaveLength(1);
    });

    it("keeps a column name readable after escaping", () => {
        expect(buildTableHover("Person", ["a`b"])).toContain("- `a'b`");
    });
});
