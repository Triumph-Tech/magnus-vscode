import { describe, expect, it } from "vitest";
import { describeResultSets, isErrorMessage, parseExtensionMessage, parsePanelMessage, summarizeResultSets } from "../panelProtocol";

describe("parsePanelMessage", () => {
    it("accepts a ready message", () => {
        expect(parsePanelMessage({ type: "ready" })).toEqual({ type: "ready" });
    });

    it("accepts a cancel message", () => {
        expect(parsePanelMessage({ type: "cancelRun" })).toEqual({ type: "cancelRun" });
    });

    it("accepts a reveal line message", () => {
        expect(parsePanelMessage({ type: "revealLine", lineNumber: 12 })).toEqual({ type: "revealLine", lineNumber: 12 });
    });

    it("floors a fractional line number", () => {
        expect(parsePanelMessage({ type: "revealLine", lineNumber: 12.7 })).toEqual({ type: "revealLine", lineNumber: 12 });
    });

    it("rejects a line number below one", () => {
        expect(parsePanelMessage({ type: "revealLine", lineNumber: 0 })).toBeNull();
    });

    it("rejects a line number that is not a number", () => {
        expect(parsePanelMessage({ type: "revealLine", lineNumber: "12" })).toBeNull();
    });

    it("rejects a reveal line message with no line number", () => {
        expect(parsePanelMessage({ type: "revealLine" })).toBeNull();
    });

    it("rejects an unknown message type", () => {
        expect(parsePanelMessage({ type: "runEverything" })).toBeNull();
    });

    it("rejects values that are not messages", () => {
        expect(parsePanelMessage(null)).toBeNull();
        expect(parsePanelMessage(undefined)).toBeNull();
        expect(parsePanelMessage("ready")).toBeNull();
        expect(parsePanelMessage(42)).toBeNull();
        expect(parsePanelMessage([{ type: "ready" }])).toBeNull();
        expect(parsePanelMessage({})).toBeNull();
        expect(parsePanelMessage({ type: "" })).toBeNull();
    });
});

describe("parseExtensionMessage", () => {
    it("accepts a run started message", () => {
        expect(parseExtensionMessage({ type: "runStarted", serverLabel: "rock.example.org", statementPreview: "SELECT 1" }))
            .toEqual({ type: "runStarted", serverLabel: "rock.example.org", statementPreview: "SELECT 1" });
    });

    it("rejects a run started message with no preview", () => {
        expect(parseExtensionMessage({ type: "runStarted", serverLabel: "rock.example.org" })).toBeNull();
    });

    it("accepts messages and normalizes their optional fields", () => {
        const parsed = parseExtensionMessage({
            type: "messages",
            messages: [
                { message: "(1 row affected)" },
                { message: "Invalid column name", code: 207, level: 16, state: 1, lineNumber: 3 }
            ]
        });

        expect(parsed).toEqual({
            type: "messages",
            messages: [
                { message: "(1 row affected)", code: null, level: null, state: null, lineNumber: null },
                { message: "Invalid column name", code: 207, level: 16, state: 1, lineNumber: 3 }
            ]
        });
    });

    it("accepts an empty message array", () => {
        expect(parseExtensionMessage({ type: "messages", messages: [] })).toEqual({ type: "messages", messages: [] });
    });

    it("rejects a messages payload that is not an array", () => {
        expect(parseExtensionMessage({ type: "messages", messages: "nope" })).toBeNull();
    });

    it("rejects a message entry with no text", () => {
        expect(parseExtensionMessage({ type: "messages", messages: [{ code: 207 }] })).toBeNull();
    });

    it("accepts a completed run with result sets", () => {
        expect(parseExtensionMessage({
            type: "runCompleted",
            status: "succeeded",
            durationMs: 1234,
            resultSets: { setCount: 2, rowCount: 40 },
            errorMessage: null
        })).toEqual({
            type: "runCompleted",
            status: "succeeded",
            durationMs: 1234,
            resultSets: { setCount: 2, rowCount: 40 },
            errorMessage: null
        });
    });

    it("accepts a failed run with an error message", () => {
        expect(parseExtensionMessage({
            type: "runCompleted",
            status: "failed",
            durationMs: 0,
            resultSets: null,
            errorMessage: "Boom"
        })).toEqual({
            type: "runCompleted",
            status: "failed",
            durationMs: 0,
            resultSets: null,
            errorMessage: "Boom"
        });
    });

    it("treats an absent result set summary and error as null", () => {
        expect(parseExtensionMessage({ type: "runCompleted", status: "cancelled", durationMs: 10 })).toEqual({
            type: "runCompleted",
            status: "cancelled",
            durationMs: 10,
            resultSets: null,
            errorMessage: null
        });
    });

    it("rejects an unknown run status", () => {
        expect(parseExtensionMessage({ type: "runCompleted", status: "exploded", durationMs: 10 })).toBeNull();
    });

    it("rejects a negative duration", () => {
        expect(parseExtensionMessage({ type: "runCompleted", status: "succeeded", durationMs: -1 })).toBeNull();
    });

    it("rejects a malformed result set summary", () => {
        expect(parseExtensionMessage({ type: "runCompleted", status: "succeeded", durationMs: 1, resultSets: { setCount: 1 } })).toBeNull();
        expect(parseExtensionMessage({ type: "runCompleted", status: "succeeded", durationMs: 1, resultSets: [] })).toBeNull();
    });

    it("rejects an unknown message type", () => {
        expect(parseExtensionMessage({ type: "grid" })).toBeNull();
    });
});

describe("summarizeResultSets", () => {
    it("returns null when there are no result sets", () => {
        expect(summarizeResultSets(null)).toBeNull();
        expect(summarizeResultSets(undefined)).toBeNull();
        expect(summarizeResultSets([])).toBeNull();
    });

    it("adds up the rows of every result set", () => {
        expect(summarizeResultSets([{ rows: [[1], [2]] }, { rows: [[3]] }])).toEqual({ setCount: 2, rowCount: 3 });
    });

    it("counts a result set with no rows", () => {
        expect(summarizeResultSets([{ rows: [] }])).toEqual({ setCount: 1, rowCount: 0 });
    });
});

describe("describeResultSets", () => {
    it("uses the singular for one set of one row", () => {
        expect(describeResultSets({ setCount: 1, rowCount: 1 })).toBe("1 result set (1 row)");
    });

    it("uses the plural and thousands separators", () => {
        expect(describeResultSets({ setCount: 2, rowCount: 12345 })).toBe("2 result sets (12,345 rows)");
    });
});

describe("isErrorMessage", () => {
    it("treats a message with a SQL error number as an error", () => {
        expect(isErrorMessage({ message: "Invalid column name", code: 207 })).toBe(true);
    });

    it("treats a high severity level as an error", () => {
        expect(isErrorMessage({ message: "Something", level: 16 })).toBe(true);
    });

    it("does not treat PRINT output as an error", () => {
        expect(isErrorMessage({ message: "hello" })).toBe(false);
        expect(isErrorMessage({ message: "hello", code: 0, level: 0 })).toBe(false);
    });

    it("does not treat an informational level as an error", () => {
        expect(isErrorMessage({ message: "(1 row affected)", level: 10 })).toBe(false);
    });
});
