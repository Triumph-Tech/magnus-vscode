import { describe, expect, it } from "vitest";
import { buildQueryDocumentName, buildUntitledQueryUri, nextQueryDocumentName, queryDocumentLabel } from "../queryDocumentNames";

describe("buildQueryDocumentName", () => {
    it("names the first editor Query-1.sql", () => {
        expect(buildQueryDocumentName(1)).toBe("Query-1.sql");
    });

    it("counts up", () => {
        expect(buildQueryDocumentName(12)).toBe("Query-12.sql");
    });

    it("never goes below one, whatever it is handed", () => {
        expect(buildQueryDocumentName(0)).toBe("Query-1.sql");
        expect(buildQueryDocumentName(-4)).toBe("Query-1.sql");
        expect(buildQueryDocumentName(2.7)).toBe("Query-2.sql");
    });
});

describe("nextQueryDocumentName", () => {
    it("uses the counter when nothing is open", () => {
        expect(nextQueryDocumentName(1, [])).toEqual({ name: "Query-1.sql", nextCounter: 2 });
    });

    it("moves the counter forward on each call", () => {
        const first = nextQueryDocumentName(1, []);
        const second = nextQueryDocumentName(first.nextCounter, [first.name]);

        expect(second.name).toBe("Query-2.sql");
        expect(second.nextCounter).toBe(3);
    });

    it("skips a name that is already open", () => {
        expect(nextQueryDocumentName(1, ["Query-1.sql", "Query-2.sql"]).name).toBe("Query-3.sql");
    });

    it("skips a name that is open under a different casing", () => {
        expect(nextQueryDocumentName(1, ["query-1.SQL"]).name).toBe("Query-2.sql");
    });

    it("ignores untitled documents that are not query editors", () => {
        expect(nextQueryDocumentName(1, ["Untitled-1", "notes.txt"]).name).toBe("Query-1.sql");
    });

    it("does not reuse a number the counter has passed, even after that editor closed", () => {
        expect(nextQueryDocumentName(4, []).name).toBe("Query-4.sql");
    });
});

describe("buildUntitledQueryUri", () => {
    it("builds an untitled URI that carries the name", () => {
        expect(buildUntitledQueryUri("Query-1.sql")).toBe("untitled:Query-1.sql");
    });
});

describe("queryDocumentLabel", () => {
    it("hands back the name of an untitled query document", () => {
        expect(queryDocumentLabel("Query-3.sql")).toBe("Query-3.sql");
    });

    it("takes the file name out of a path", () => {
        expect(queryDocumentLabel("/Users/someone/work/queries/attendance.sql")).toBe("attendance.sql");
    });

    it("takes the file name out of a leading slash only path", () => {
        expect(queryDocumentLabel("/attendance.sql")).toBe("attendance.sql");
    });

    it("hands back the path itself when there is no name in it", () => {
        expect(queryDocumentLabel("/")).toBe("/");
    });
});
