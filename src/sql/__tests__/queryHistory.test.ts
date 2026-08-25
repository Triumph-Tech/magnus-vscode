import { describe, expect, it } from "vitest";
import { serverHostLabel } from "../bindingDecisions";
import { addEntry, buildHistoryPickItems, createHistoryEntry, filterEntries, formatDuration, formatRelativeTime, HistoryEntry, HistoryEntryInput, maxLabelLength, maxLabelTables, maxStoredStatementLength, parseStoredHistory, serverHost } from "../queryHistory";

const serverUrl = "https://rock.example.org";
const startedAt = "2026-08-25T12:00:00.000Z";
const now = new Date("2026-08-25T12:00:30.000Z").getTime();

/**
 * Builds a history entry, letting each test override only what it cares about.
 *
 * @param overrides The fields to change.
 *
 * @returns The entry.
 */
function makeEntry(overrides: Partial<HistoryEntryInput> = {}): HistoryEntry {
    const input: HistoryEntryInput = {
        id: "entry-1",
        serverUrl: serverUrl,
        statementText: "SELECT TOP (10) * FROM Person",
        startedAt: startedAt,
        durationMs: 120,
        resultSummary: { resultSetCount: 1, totalRows: 10 },
        outcome: "success",
        ...overrides
    };

    return createHistoryEntry(input);
}

describe("createHistoryEntry", () => {
    it("normalizes the server URL so the same server always matches itself", () => {
        expect(makeEntry({ serverUrl: "HTTPS://Rock.Example.Org/" }).serverUrl).toBe(serverUrl);
    });

    it("keeps a normal statement whole and unmarked", () => {
        const entry = makeEntry({ statementText: "SELECT 1" });

        expect(entry.statementText).toBe("SELECT 1");
        expect(entry.truncated).toBe(false);
    });

    it("cuts an oversized statement at the storage cap and marks it truncated", () => {
        const entry = makeEntry({ statementText: "x".repeat(maxStoredStatementLength + 500) });

        expect(entry.statementText.length).toBe(maxStoredStatementLength);
        expect(entry.truncated).toBe(true);
    });

    it("labels the entry with the comment it opens with", () => {
        const entry = makeEntry({ statementText: "-- from the support ticket\nSELECT COUNT(*) FROM Attendance" });

        expect(entry.label).toBe("from the support ticket");
    });

    it("finds a leading comment past the blank lines and the indentation", () => {
        const entry = makeEntry({ statementText: "\n\n    -- from the support ticket\n\nSELECT COUNT(*) FROM Attendance" });

        expect(entry.label).toBe("from the support ticket");
    });

    it("takes the first line of a multi line block comment", () => {
        const entry = makeEntry({ statementText: "/*\n * Unduplicated attendance\n * by campus, for Q3\n */\nSELECT * FROM Attendance" });

        expect(entry.label).toBe("Unduplicated attendance");
    });

    it("takes a single line block comment", () => {
        expect(makeEntry({ statementText: "/* weekly giving */ SELECT * FROM FinancialTransaction" }).label).toBe("weekly giving");
    });

    it("ignores an empty comment and summarizes instead", () => {
        expect(makeEntry({ statementText: "--\nSELECT * FROM Person" }).label).toBe("SELECT · Person");
    });

    it("ignores a comment that does not open the statement", () => {
        expect(makeEntry({ statementText: "SELECT * FROM Person -- everybody" }).label).toBe("SELECT · Person");
    });

    it("collapses whitespace inside the label", () => {
        const entry = makeEntry({ statementText: "--   from     the\tticket\nSELECT 1" });

        expect(entry.label).toBe("from the ticket");
    });

    it("summarizes one table", () => {
        expect(makeEntry({ statementText: "SELECT Id,\n  NickName\nFROM Person p\nWHERE p.IsDeceased = 0" }).label).toBe("SELECT · Person");
    });

    it("summarizes three tables in the order they appear", () => {
        const sql = "SELECT * FROM Attendance a INNER JOIN AttendanceOccurrence o ON o.Id = a.OccurrenceId INNER JOIN PersonAlias pa ON pa.Id = a.PersonAliasId";

        expect(makeEntry({ statementText: sql }).label).toBe("SELECT · Attendance, AttendanceOccurrence, PersonAlias");
    });

    it("counts the tables past the cap", () => {
        const sql = "SELECT * FROM Attendance a JOIN AttendanceOccurrence o ON 1 = 1 JOIN PersonAlias pa ON 1 = 1 JOIN Person p ON 1 = 1 JOIN [Group] g ON 1 = 1";
        const entry = makeEntry({ statementText: sql });

        expect(entry.label).toBe(`SELECT · Attendance, AttendanceOccurrence, PersonAlias +${5 - maxLabelTables}`);
    });

    it("strips the brackets off a reserved table name", () => {
        expect(makeEntry({ statementText: "SELECT * FROM [Group] g" }).label).toBe("SELECT · Group");
    });

    it("names a table once however many times it is joined", () => {
        expect(makeEntry({ statementText: "SELECT * FROM Person p JOIN Person q ON q.Id = p.Id" }).label).toBe("SELECT · Person");
    });

    it("reads the verb of a statement that is not a SELECT", () => {
        expect(makeEntry({ statementText: "UPDATE p SET p.Email = NULL FROM Person p" }).label).toBe("UPDATE · Person");
        expect(makeEntry({ statementText: "DELETE FROM Person WHERE Id = 1" }).label).toBe("DELETE · Person");
    });

    it("falls back to the first line for a statement that names no table", () => {
        expect(makeEntry({ statementText: "DECLARE @personId INT = 42" }).label).toBe("DECLARE @personId INT = 42");
        expect(makeEntry({ statementText: "EXEC dbo.spRefreshCache @Force = 1" }).label).toBe("EXEC dbo.spRefreshCache @Force = 1");
    });

    it("does not count a table that only appears in a derived table", () => {
        expect(makeEntry({ statementText: "SELECT * FROM (SELECT Id FROM Person) x" }).label).toBe("SELECT * FROM (SELECT Id FROM Person) x");
    });

    it("cuts a long label with an ellipsis", () => {
        const entry = makeEntry({ statementText: `SELECT ${"a".repeat(200)}` });

        expect(entry.label.length).toBe(maxLabelLength);
        expect(entry.label.endsWith("…")).toBe(true);
    });

    it("cuts a long leading comment with an ellipsis", () => {
        const entry = makeEntry({ statementText: `-- ${"why ".repeat(60)}\nSELECT * FROM Person` });

        expect(entry.label.length).toBe(maxLabelLength);
        expect(entry.label.endsWith("…")).toBe(true);
    });

    it("falls back to the comment when the statement is nothing but comments", () => {
        expect(makeEntry({ statementText: "-- nothing to run" }).label).toBe("nothing to run");
    });

    it("tells apart two runs that differ only in whether they carry a comment", () => {
        const commented = makeEntry({ statementText: "-- just the names\nSELECT NickName, LastName FROM Person" });
        const bare = makeEntry({ statementText: "SELECT Id FROM Person" });

        expect(commented.label).toBe("just the names");
        expect(bare.label).toBe("SELECT · Person");
        expect(commented.label).not.toBe(bare.label);
    });

    it("reduces a multi line error to its first line", () => {
        const entry = makeEntry({ outcome: "error", errorSummary: "\nInvalid column name 'Foo'.\nat line 3" });

        expect(entry.errorSummary).toBe("Invalid column name 'Foo'.");
    });

    it("stores a missing result summary as null rather than undefined", () => {
        expect(makeEntry({ resultSummary: undefined }).resultSummary).toBeNull();
    });

    it("omits the database when there is not one", () => {
        expect(makeEntry().database).toBeUndefined();
        expect(makeEntry({ database: "RockRMS" }).database).toBe("RockRMS");
    });

    it("never stores anything beyond the recorded fields", () => {
        expect(Object.keys(makeEntry({ database: "RockRMS", errorSummary: "boom" })).sort()).toEqual([
            "database",
            "durationMs",
            "errorSummary",
            "id",
            "label",
            "outcome",
            "resultSummary",
            "serverUrl",
            "startedAt",
            "statementText",
            "truncated"
        ]);
    });

    it("rounds and floors a strange duration", () => {
        expect(makeEntry({ durationMs: -5 }).durationMs).toBe(0);
        expect(makeEntry({ durationMs: 12.6 }).durationMs).toBe(13);
    });
});

describe("addEntry", () => {
    it("puts the newest entry first", () => {
        const first = makeEntry({ id: "a", statementText: "SELECT 1" });
        const second = makeEntry({ id: "b", statementText: "SELECT 2" });

        expect(addEntry(addEntry([], first, 10), second, 10).map(entry => entry.id)).toEqual(["b", "a"]);
    });

    it("does not modify the list it was given", () => {
        const entries = [makeEntry({ id: "a", statementText: "SELECT 1" })];

        addEntry(entries, makeEntry({ id: "b", statementText: "SELECT 2" }), 10);

        expect(entries).toHaveLength(1);
    });

    it("evicts the oldest entries beyond the cap", () => {
        let entries: HistoryEntry[] = [];

        for (let index = 0; index < 5; index++) {
            entries = addEntry(entries, makeEntry({ id: `entry-${index}`, statementText: `SELECT ${index}` }), 3);
        }

        expect(entries.map(entry => entry.id)).toEqual(["entry-4", "entry-3", "entry-2"]);
    });

    it("stores nothing and clears what was there when history is disabled", () => {
        const entries = [makeEntry({ id: "a" })];

        expect(addEntry(entries, makeEntry({ id: "b", statementText: "SELECT 2" }), 0)).toEqual([]);
        expect(addEntry(entries, makeEntry({ id: "b", statementText: "SELECT 2" }), -1)).toEqual([]);
    });

    it("updates the newest entry instead of stacking when the same statement is re-run", () => {
        const first = makeEntry({ id: "a", statementText: "SELECT 1", durationMs: 100 });
        const rerun = makeEntry({ id: "b", statementText: "SELECT 1", durationMs: 250, startedAt: "2026-08-25T12:05:00.000Z", outcome: "error", errorSummary: "boom" });
        const entries = addEntry([first], rerun, 10);

        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe("a");
        expect(entries[0].startedAt).toBe("2026-08-25T12:05:00.000Z");
        expect(entries[0].outcome).toBe("error");
        expect(entries[0].durationMs).toBe(250);
        expect(entries[0].errorSummary).toBe("boom");
    });

    it("does not collapse twenty re-runs into a longer list", () => {
        let entries: HistoryEntry[] = [];

        for (let index = 0; index < 20; index++) {
            entries = addEntry(entries, makeEntry({ id: `run-${index}`, statementText: "SELECT 1" }), 500);
        }

        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe("run-0");
    });

    it("keeps both statements when the same one is re-run after another", () => {
        const one = makeEntry({ id: "a", statementText: "SELECT 1" });
        const two = makeEntry({ id: "b", statementText: "SELECT 2" });
        const oneAgain = makeEntry({ id: "c", statementText: "SELECT 1" });

        expect(addEntry(addEntry([one], two, 10), oneAgain, 10).map(entry => entry.id)).toEqual(["c", "b", "a"]);
    });

    it("does not treat the same statement on another server as a re-run", () => {
        const first = makeEntry({ id: "a", statementText: "SELECT 1" });
        const other = makeEntry({ id: "b", statementText: "SELECT 1", serverUrl: "https://other.example.org" });

        expect(addEntry([first], other, 10).map(entry => entry.id)).toEqual(["b", "a"]);
    });
});

describe("filterEntries", () => {
    const entries = [
        makeEntry({ id: "a", statementText: "SELECT * FROM Attendance", serverUrl: "https://rock.example.org" }),
        makeEntry({ id: "b", statementText: "SELECT * FROM Person WHERE LastName = 'Decker'", serverUrl: "https://staging.example.org" }),
        makeEntry({ id: "c", statementText: "UPDATE Person SET IsDeceased = 0", serverUrl: "https://rock.example.org", database: "RockDev" })
    ];

    it("returns everything for an empty or whitespace query", () => {
        expect(filterEntries(entries, "")).toHaveLength(3);
        expect(filterEntries(entries, "   ")).toHaveLength(3);
    });

    it("matches statement text case insensitively", () => {
        expect(filterEntries(entries, "decker").map(entry => entry.id)).toEqual(["b"]);
    });

    it("matches the server URL", () => {
        expect(filterEntries(entries, "staging").map(entry => entry.id)).toEqual(["b"]);
    });

    it("matches the database name", () => {
        expect(filterEntries(entries, "rockdev").map(entry => entry.id)).toEqual(["c"]);
    });

    it("requires every token to match", () => {
        expect(filterEntries(entries, "person rock.example").map(entry => entry.id)).toEqual(["c"]);
        expect(filterEntries(entries, "person nonsense")).toEqual([]);
    });

    it("does not match a token that is only a subsequence", () => {
        expect(filterEntries(entries, "atndnc")).toEqual([]);
    });

    it("keeps the original order", () => {
        expect(filterEntries(entries, "select").map(entry => entry.id)).toEqual(["a", "b"]);
    });

    it("searches the statement text and never the label", () => {
        const commented = makeEntry({ id: "d", statementText: "-- the quarterly rollup\nSELECT * FROM Attendance" });

        expect(commented.label).toBe("the quarterly rollup");
        expect(filterEntries([commented], "attendance").map(entry => entry.id)).toEqual(["d"]);
        expect(filterEntries(entries, "·")).toEqual([]);
    });
});

describe("buildHistoryPickItems", () => {
    it("labels a row with the short label and carries the entry identifier", () => {
        const items = buildHistoryPickItems([makeEntry({ id: "a" })], now);

        expect(items[0].entryId).toBe("a");
        expect(items[0].label).toBe("SELECT · Person");
    });

    it("describes a row with the host and the relative time", () => {
        expect(buildHistoryPickItems([makeEntry()], now)[0].description).toBe("rock.example.org · just now");
    });

    it("includes the database in the description when there is one", () => {
        expect(buildHistoryPickItems([makeEntry({ database: "RockRMS" })], now)[0].description).toBe("rock.example.org · RockRMS · just now");
    });

    it("details a successful run with its result sets, rows and duration", () => {
        const entry = makeEntry({ resultSummary: { resultSetCount: 2, totalRows: 1234 }, durationMs: 450 });

        expect(buildHistoryPickItems([entry], now)[0].detail).toBe("2 result sets · 1,234 rows · 450 ms");
    });

    it("uses the singular for one result set and one row", () => {
        const entry = makeEntry({ resultSummary: { resultSetCount: 1, totalRows: 1 } });

        expect(buildHistoryPickItems([entry], now)[0].detail).toContain("1 result set · 1 row");
    });

    it("details a run that returned no result sets", () => {
        const entry = makeEntry({ resultSummary: null, durationMs: 20 });

        expect(buildHistoryPickItems([entry], now)[0].detail).toBe("no results · 20 ms");
    });

    it("details a failed run with its error", () => {
        const entry = makeEntry({ outcome: "error", errorSummary: "Invalid object name 'Persn'.", resultSummary: null, durationMs: 30 });

        expect(buildHistoryPickItems([entry], now)[0].detail).toBe("error: Invalid object name 'Persn'. · 30 ms");
    });

    it("details a failed run that has no message", () => {
        const entry = makeEntry({ outcome: "error", resultSummary: null, durationMs: 30 });

        expect(buildHistoryPickItems([entry], now)[0].detail).toBe("error · 30 ms");
    });

    it("details a cancelled run", () => {
        const entry = makeEntry({ outcome: "cancelled", resultSummary: null, durationMs: 5000 });

        expect(buildHistoryPickItems([entry], now)[0].detail).toBe("cancelled · 5.0 s");
    });

    it("says so when the stored statement was truncated", () => {
        const entry = makeEntry({ statementText: "SELECT 1\n".concat("x".repeat(maxStoredStatementLength)) });

        expect(buildHistoryPickItems([entry], now)[0].detail).toContain("statement truncated");
    });

    it("keeps the entry order", () => {
        const items = buildHistoryPickItems([makeEntry({ id: "a" }), makeEntry({ id: "b", statementText: "SELECT 2" })], now);

        expect(items.map(item => item.entryId)).toEqual(["a", "b"]);
    });
});

describe("formatRelativeTime", () => {
    const base = new Date("2026-08-25T12:00:00.000Z").getTime();

    it("calls anything inside a minute just now", () => {
        expect(formatRelativeTime(new Date(base - 30 * 1000).toISOString(), base)).toBe("just now");
    });

    it("counts minutes, hours and days", () => {
        expect(formatRelativeTime(new Date(base - 12 * 60 * 1000).toISOString(), base)).toBe("12m ago");
        expect(formatRelativeTime(new Date(base - 3 * 60 * 60 * 1000).toISOString(), base)).toBe("3h ago");
        expect(formatRelativeTime(new Date(base - 2 * 24 * 60 * 60 * 1000).toISOString(), base)).toBe("2d ago");
    });

    it("shows the date once a week has passed", () => {
        expect(formatRelativeTime("2026-01-02T09:00:00.000Z", base)).toBe("2026-01-02");
    });

    it("treats a time in the future as just now rather than a negative age", () => {
        expect(formatRelativeTime(new Date(base + 60 * 1000).toISOString(), base)).toBe("just now");
    });

    it("does not throw on a time it cannot read", () => {
        expect(formatRelativeTime("not a date", base)).toBe("unknown time");
    });
});

describe("formatDuration", () => {
    it("uses milliseconds under a second", () => {
        expect(formatDuration(0)).toBe("0 ms");
        expect(formatDuration(999)).toBe("999 ms");
    });

    it("uses seconds from a second up", () => {
        expect(formatDuration(1000)).toBe("1.0 s");
        expect(formatDuration(12345)).toBe("12.3 s");
    });
});

describe("serverHost", () => {
    it("takes the host out of a URL", () => {
        expect(serverHost("https://rock.example.org/some/path")).toBe("rock.example.org");
        expect(serverHost("http://localhost:6229")).toBe("localhost:6229");
    });

    it("returns a value that is not a URL unchanged", () => {
        expect(serverHost("  rock  ")).toBe("rock");
    });

    it("keeps credentials out of the history", () => {
        expect(serverHost("https://user:pass@rock.example.org/api")).toBe("rock.example.org");
        expect(serverHost("https://user@rock.example.org:8443")).toBe("rock.example.org:8443");
    });

    it("agrees with the status bar's own host label", () => {
        for (const url of ["https://user:pass@rock.example.org/api", "http://localhost:6229", "  rock  "]) {
            expect(serverHost(url)).toBe(serverHostLabel(url));
        }
    });

    it("does not show credentials in a history row", () => {
        const items = buildHistoryPickItems([makeEntry({ serverUrl: "https://user:secret@rock.example.org" })], now);

        expect(items[0].description).not.toContain("secret");
        expect(items[0].description).toContain("rock.example.org");
    });
});

describe("parseStoredHistory", () => {
    const valid = makeEntry({ id: "a" });

    it("reads a stored JSON string", () => {
        expect(parseStoredHistory(JSON.stringify([valid]))).toEqual([valid]);
    });

    it("reads an already parsed array", () => {
        expect(parseStoredHistory([valid])).toEqual([valid]);
    });

    it("returns nothing for an empty store", () => {
        expect(parseStoredHistory(undefined)).toEqual([]);
        expect(parseStoredHistory(null)).toEqual([]);
        expect(parseStoredHistory("")).toEqual([]);
    });

    it("returns nothing for text that is not JSON", () => {
        expect(parseStoredHistory("{not json")).toEqual([]);
    });

    it("returns nothing for JSON that is not an array", () => {
        expect(parseStoredHistory("{\"id\":\"a\"}")).toEqual([]);
    });

    it("discards the corrupt entries and keeps the rest", () => {
        const stored = [valid, null, "nonsense", 42, {}, { id: "b" }, { id: "c", serverUrl: serverUrl }, makeEntry({ id: "d", statementText: "SELECT 2" })];

        expect(parseStoredHistory(stored).map(entry => entry.id)).toEqual(["a", "d"]);
    });

    it("rejects an entry with no statement text", () => {
        expect(parseStoredHistory([{ id: "a", serverUrl: serverUrl, statementText: "" }])).toEqual([]);
    });

    it("fills in the fields an older version may not have written", () => {
        const entries = parseStoredHistory([{ id: "a", serverUrl: serverUrl, statementText: "SELECT 1" }]);

        expect(entries[0].label).toBe("SELECT 1");
        expect(entries[0].outcome).toBe("success");
        expect(entries[0].durationMs).toBe(0);
        expect(entries[0].resultSummary).toBeNull();
        expect(entries[0].truncated).toBe(false);
        expect(entries[0].startedAt).toBe("1970-01-01T00:00:00.000Z");
    });

    it("repairs an unrecognized outcome rather than dropping the entry", () => {
        expect(parseStoredHistory([{ id: "a", serverUrl: serverUrl, statementText: "SELECT 1", outcome: "exploded" }])[0].outcome).toBe("success");
    });

    it("repairs an unreadable date and duration", () => {
        const entries = parseStoredHistory([{ id: "a", serverUrl: serverUrl, statementText: "SELECT 1", startedAt: "whenever", durationMs: "fast" }]);

        expect(entries[0].startedAt).toBe("1970-01-01T00:00:00.000Z");
        expect(entries[0].durationMs).toBe(0);
    });

    it("discards a malformed result summary", () => {
        const stored = [{ id: "a", serverUrl: serverUrl, statementText: "SELECT 1", resultSummary: { resultSetCount: "one" } }];

        expect(parseStoredHistory(stored)[0].resultSummary).toBeNull();
    });

    it("keeps a well formed result summary", () => {
        const stored = [{ id: "a", serverUrl: serverUrl, statementText: "SELECT 1", resultSummary: { resultSetCount: 1, totalRows: 7 } }];

        expect(parseStoredHistory(stored)[0].resultSummary).toEqual({ resultSetCount: 1, totalRows: 7 });
    });

    it("cuts a statement that was stored oversized", () => {
        const stored = [{ id: "a", serverUrl: serverUrl, statementText: "x".repeat(maxStoredStatementLength + 10) }];
        const entry = parseStoredHistory(stored)[0];

        expect(entry.statementText.length).toBe(maxStoredStatementLength);
        expect(entry.truncated).toBe(true);
    });

    it("normalizes the server URL of a stored entry", () => {
        expect(parseStoredHistory([{ id: "a", serverUrl: "HTTPS://Rock.Example.Org/", statementText: "SELECT 1" }])[0].serverUrl).toBe(serverUrl);
    });

    it("survives a round trip through storage", () => {
        const entries = [makeEntry({ id: "a", database: "RockRMS" }), makeEntry({ id: "b", statementText: "SELECT 2", outcome: "error", errorSummary: "boom", resultSummary: null })];

        expect(parseStoredHistory(JSON.stringify(entries))).toEqual(entries);
    });
});
