import { describe, expect, it } from "vitest";
import { SqlAnalysisMemo } from "../sqlAnalysisMemo";

const sql = "SELECT * FROM Person p WHERE p.LastName = 'Decker'";

describe("SqlAnalysisMemo", () => {
    it("analyzes the text it is given", () => {
        const analysis = new SqlAnalysisMemo().get("file:///a.sql", 1, sql);

        expect(analysis.masked).toBe("SELECT * FROM Person p WHERE p.LastName =         ");
        expect(Object.fromEntries(analysis.aliases)).toEqual({ p: "Person" });
    });

    it("returns the same analysis for the same document version", () => {
        const memo = new SqlAnalysisMemo();
        const first = memo.get("file:///a.sql", 1, sql);

        expect(memo.get("file:///a.sql", 1, sql)).toBe(first);
    });

    it("re-analyzes when the version moves on", () => {
        const memo = new SqlAnalysisMemo();
        const first = memo.get("file:///a.sql", 1, sql);
        const second = memo.get("file:///a.sql", 2, "SELECT * FROM PersonAlias");

        expect(second).not.toBe(first);
        expect(second.text).toBe("SELECT * FROM PersonAlias");
    });

    it("keeps documents apart", () => {
        const memo = new SqlAnalysisMemo();

        memo.get("file:///a.sql", 1, sql);

        expect(memo.get("file:///b.sql", 1, "SELECT 1").text).toBe("SELECT 1");
        expect(memo.get("file:///a.sql", 1, sql)).toBe(memo.get("file:///a.sql", 1, sql));
    });

    it("forgets the least recently used document once it is full", () => {
        const memo = new SqlAnalysisMemo(2);
        const first = memo.get("file:///a.sql", 1, sql);

        memo.get("file:///b.sql", 1, "SELECT 1");
        memo.get("file:///c.sql", 1, "SELECT 2");

        expect(memo.get("file:///a.sql", 1, sql)).not.toBe(first);
    });

    it("forgets a document on request", () => {
        const memo = new SqlAnalysisMemo();
        const first = memo.get("file:///a.sql", 1, sql);

        memo.forget("file:///a.sql");

        expect(memo.get("file:///a.sql", 1, sql)).not.toBe(first);
    });
});
