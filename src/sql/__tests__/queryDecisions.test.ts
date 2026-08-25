import { describe, expect, it } from "vitest";
import { classifyCompletion, defaultMaxRenderRows, initialPollDelayMs, maxPollDelayMs, maxRenderRowsCeiling, mergeMessages, nextPollDelay, renderPlan, resolveMaxRenderRows, retryBudgetMs, retryDelayMs, shouldRetryPoll } from "../queryDecisions";
import { ExecuteQueryProgress, QueryMessage } from "../types";

/**
 * Builds a message for the merge cases.
 *
 * @param message The text of the message.
 * @param lineNumber The line the message relates to, if any.
 *
 * @returns The message.
 */
function makeMessage(message: string, lineNumber?: number): QueryMessage {
    return {
        message,
        lineNumber: lineNumber ?? null
    };
}

/**
 * Builds a progress bag for the completion cases.
 *
 * @param isComplete Whether the server has finished the query.
 *
 * @returns The progress bag.
 */
function makeProgress(isComplete: boolean): ExecuteQueryProgress {
    return {
        identifier: "abc",
        isComplete,
        duration: 12,
        messages: []
    };
}

describe("nextPollDelay", () => {
    it("polls quickly for the first second", () => {
        expect(nextPollDelay(0)).toBe(initialPollDelayMs);
        expect(nextPollDelay(999)).toBe(initialPollDelayMs);
    });

    it("steps up at one second", () => {
        expect(nextPollDelay(1000)).toBe(500);
        expect(nextPollDelay(2999)).toBe(500);
    });

    it("reaches the cap at three seconds and stays there", () => {
        expect(nextPollDelay(3000)).toBe(maxPollDelayMs);
        expect(nextPollDelay(60000)).toBe(maxPollDelayMs);
    });

    it("never exceeds the cap", () => {
        for (const elapsed of [0, 500, 1000, 2500, 3000, 100000]) {
            expect(nextPollDelay(elapsed)).toBeLessThanOrEqual(maxPollDelayMs);
        }
    });

    it("treats a nonsensical elapsed time as the start of the query", () => {
        expect(nextPollDelay(-100)).toBe(initialPollDelayMs);
        expect(nextPollDelay(Number.NaN)).toBe(initialPollDelayMs);
    });
});

describe("mergeMessages", () => {
    it("takes everything when nothing is known yet", () => {
        const incoming = [makeMessage("a"), makeMessage("b")];
        const result = mergeMessages([], incoming);

        expect(result.messages).toEqual(incoming);
        expect(result.newMessages).toEqual(incoming);
    });

    it("takes only the appended messages of a cumulative response", () => {
        const existing = [makeMessage("a")];
        const result = mergeMessages(existing, [makeMessage("a"), makeMessage("b")]);

        expect(result.messages).toEqual([makeMessage("a"), makeMessage("b")]);
        expect(result.newMessages).toEqual([makeMessage("b")]);
    });

    it("reports nothing new when the lists are equal", () => {
        const existing = [makeMessage("a"), makeMessage("b")];
        const result = mergeMessages(existing, [makeMessage("a"), makeMessage("b")]);

        expect(result.messages).toEqual(existing);
        expect(result.newMessages).toEqual([]);
    });

    it("reports nothing new for an empty response", () => {
        const existing = [makeMessage("a")];
        const result = mergeMessages(existing, []);

        expect(result.messages).toEqual(existing);
        expect(result.newMessages).toEqual([]);
    });

    it("does not shrink the list when the response is shorter but still a prefix", () => {
        const existing = [makeMessage("a"), makeMessage("b")];
        const result = mergeMessages(existing, [makeMessage("a")]);

        expect(result.messages).toEqual(existing);
        expect(result.newMessages).toEqual([]);
    });

    it("appends a response that is not an extension of what is known", () => {
        const existing = [makeMessage("a")];
        const result = mergeMessages(existing, [makeMessage("b")]);

        expect(result.messages).toEqual([makeMessage("a"), makeMessage("b")]);
        expect(result.newMessages).toEqual([makeMessage("b")]);
    });

    it("keeps repeated identical messages that arrive as an extension", () => {
        const existing = [makeMessage("(1 row affected)")];
        const result = mergeMessages(existing, [makeMessage("(1 row affected)"), makeMessage("(1 row affected)")]);

        expect(result.messages).toHaveLength(2);
        expect(result.newMessages).toEqual([makeMessage("(1 row affected)")]);
    });

    it("tells two messages apart by more than their text", () => {
        const existing = [makeMessage("Invalid column name", 3)];
        const result = mergeMessages(existing, [makeMessage("Invalid column name", 7)]);

        expect(result.newMessages).toEqual([makeMessage("Invalid column name", 7)]);
    });

    it("treats an absent and a null field as the same", () => {
        const result = mergeMessages([{ message: "a" }], [{ message: "a", code: null, lineNumber: null }]);

        expect(result.newMessages).toEqual([]);
    });

    it("does not mutate the list it was given", () => {
        const existing = [makeMessage("a")];

        mergeMessages(existing, [makeMessage("a"), makeMessage("b")]);

        expect(existing).toHaveLength(1);
    });
});

describe("shouldRetryPoll", () => {
    it("does not retry when nothing has failed", () => {
        expect(shouldRetryPoll(0, 0)).toBe(false);
    });

    it("retries the first failure", () => {
        expect(shouldRetryPoll(1, 0)).toBe(true);
    });

    it("keeps retrying inside the budget", () => {
        expect(shouldRetryPoll(5, retryBudgetMs - 1)).toBe(true);
    });

    it("stops retrying once the budget is spent", () => {
        expect(shouldRetryPoll(5, retryBudgetMs)).toBe(false);
        expect(shouldRetryPoll(5, retryBudgetMs + 5000)).toBe(false);
    });

    it("spends a budget of thirty seconds", () => {
        expect(retryBudgetMs).toBe(30000);
    });
});

describe("retryDelayMs", () => {
    it("starts at half a second", () => {
        expect(retryDelayMs(1)).toBe(500);
    });

    it("doubles with each failure", () => {
        expect(retryDelayMs(2)).toBe(1000);
        expect(retryDelayMs(3)).toBe(2000);
        expect(retryDelayMs(4)).toBe(4000);
    });

    it("caps the delay", () => {
        expect(retryDelayMs(5)).toBe(5000);
        expect(retryDelayMs(50)).toBe(5000);
    });

    it("never returns a nonsensical delay", () => {
        expect(retryDelayMs(0)).toBe(500);
        expect(retryDelayMs(-3)).toBe(500);
    });
});

describe("classifyCompletion", () => {
    it("reports a running query", () => {
        expect(classifyCompletion(makeProgress(false))).toBe("running");
    });

    it("reports a complete query", () => {
        expect(classifyCompletion(makeProgress(true))).toBe("complete");
    });
});

describe("renderPlan", () => {
    it("falls back to the default cap when the setting is zero", () => {
        const plan = renderPlan(250000, 0);

        expect(plan.initialRows).toBe(defaultMaxRenderRows);
        expect(plan.truncatedNotice).not.toBeNull();
    });

    it("falls back to the default cap when the setting is negative", () => {
        expect(renderPlan(250000, -1).initialRows).toBe(defaultMaxRenderRows);
    });

    it("falls back to the default cap when the setting is not a number", () => {
        expect(renderPlan(250000, Number.NaN).initialRows).toBe(defaultMaxRenderRows);
    });

    it("clamps an absurd cap to the hard ceiling", () => {
        const plan = renderPlan(5000000, 10000000);

        expect(plan.initialRows).toBe(maxRenderRowsCeiling);
        expect(plan.truncatedNotice).not.toBeNull();
    });

    it("renders everything when the ceiling itself covers the rows", () => {
        const plan = renderPlan(1000, 10000000);

        expect(plan.initialRows).toBe(1000);
        expect(plan.truncatedNotice).toBeNull();
    });

    it("renders everything below the cap", () => {
        const plan = renderPlan(9999, 10000);

        expect(plan.initialRows).toBe(9999);
        expect(plan.truncatedNotice).toBeNull();
    });

    it("renders everything exactly at the cap", () => {
        const plan = renderPlan(10000, 10000);

        expect(plan.initialRows).toBe(10000);
        expect(plan.truncatedNotice).toBeNull();
    });

    it("holds back the rows past the cap", () => {
        const plan = renderPlan(10001, 10000);

        expect(plan.initialRows).toBe(10000);
        expect(plan.truncatedNotice).not.toBeNull();
    });

    it("states the full row count explicitly", () => {
        const plan = renderPlan(250000, 10000);

        expect(plan.truncatedNotice).toContain("250,000");
        expect(plan.truncatedNotice).toContain("10,000");
    });

    it("says the held back rows are still exported", () => {
        expect(renderPlan(250000, 10000).truncatedNotice).toContain("exports");
    });

    it("handles an empty result set", () => {
        const plan = renderPlan(0, 10000);

        expect(plan.initialRows).toBe(0);
        expect(plan.truncatedNotice).toBeNull();
    });

    it("never reports a negative row count", () => {
        expect(renderPlan(-5, 10000).initialRows).toBe(0);
    });
});

describe("resolveMaxRenderRows", () => {
    it("keeps a sensible setting", () => {
        expect(resolveMaxRenderRows(2500)).toBe(2500);
    });

    it("floors a fractional setting", () => {
        expect(resolveMaxRenderRows(2500.9)).toBe(2500);
    });

    it("treats zero and below as the default", () => {
        expect(resolveMaxRenderRows(0)).toBe(defaultMaxRenderRows);
        expect(resolveMaxRenderRows(-1)).toBe(defaultMaxRenderRows);
    });

    it("treats a non-finite setting as the default", () => {
        expect(resolveMaxRenderRows(Number.NaN)).toBe(defaultMaxRenderRows);
        expect(resolveMaxRenderRows(Number.POSITIVE_INFINITY)).toBe(defaultMaxRenderRows);
    });

    it("clamps to the hard ceiling", () => {
        expect(resolveMaxRenderRows(maxRenderRowsCeiling + 1)).toBe(maxRenderRowsCeiling);
    });

    it("never resolves to fewer than one row", () => {
        expect(resolveMaxRenderRows(0.5)).toBe(1);
    });
});
