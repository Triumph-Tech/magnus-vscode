import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notFoundMessage, SqlToolsUnsupportedError } from "../sqlErrors";
import { IQueryExecutionClient, QueryRunner } from "../queryRunner";
import { ExecuteQueryProgress, QueryMessage } from "../types";

const serverUrl = "https://rock.example.org";
const identifier = "abc-123";

/**
 * A client whose responses each test scripts, and which records what it was
 * asked to do.
 */
class FakeClient implements IQueryExecutionClient {
    /** The progress returned by the submit, or the error it throws. */
    public submitResult: ExecuteQueryProgress | Error = progress(false);

    /** The responses returned by successive polls, in order. */
    public statusResults: (ExecuteQueryProgress | Error)[] = [];

    /** The number of times the status endpoint was polled. */
    public pollCount: number = 0;

    /** The number of times the cancel endpoint was called. */
    public cancelCount: number = 0;

    /** Called just before each poll resolves, so a test can cancel mid flight. */
    public onPoll?: (pollCount: number) => void;

    /** @inheritdoc */
    public async executeQuery(): Promise<ExecuteQueryProgress> {
        if (this.submitResult instanceof Error) {
            throw this.submitResult;
        }

        return this.submitResult;
    }

    /** @inheritdoc */
    public async getQueryStatus(): Promise<ExecuteQueryProgress> {
        this.pollCount += 1;

        this.onPoll?.(this.pollCount);

        const next = this.statusResults.length > 0
            ? this.statusResults.shift()!
            : progress(true);

        if (next instanceof Error) {
            throw next;
        }

        return next;
    }

    /** @inheritdoc */
    public async cancelQuery(): Promise<void> {
        this.cancelCount += 1;
    }
}

/**
 * Builds a progress response.
 *
 * @param isComplete True when the server is done with the query.
 * @param messages The messages the server has emitted so far.
 * @param resultSets The result sets the query produced.
 *
 * @returns The progress response.
 */
function progress(isComplete: boolean, messages: QueryMessage[] = [], resultSets: ExecuteQueryProgress["resultSets"] = null): ExecuteQueryProgress {
    return {
        identifier,
        isComplete,
        duration: 0,
        messages,
        resultSets
    };
}

describe("QueryRunner", () => {
    let client: FakeClient;
    let runner: QueryRunner;

    beforeEach(() => {
        vi.useFakeTimers();

        client = new FakeClient();
        runner = new QueryRunner(client);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("returns the completed progress when the submit already finished", async () => {
        client.submitResult = progress(true, [{ message: "done" }]);

        const outcome = await runner.run(serverUrl, "SELECT 1");

        expect(outcome.kind).toBe("completed");
        expect(client.pollCount).toBe(0);
        expect(runner.isRunning).toBe(false);
    });

    it("polls until the server reports completion", async () => {
        client.statusResults = [progress(false), progress(false), progress(true)];

        const pending = runner.run(serverUrl, "SELECT 1");

        await vi.advanceTimersByTimeAsync(5000);

        const outcome = await pending;

        expect(outcome.kind).toBe("completed");
        expect(client.pollCount).toBe(3);
    });

    it("reports only the messages that are new on each poll", async () => {
        const first: QueryMessage = { message: "starting" };
        const second: QueryMessage = { message: "halfway" };
        const third: QueryMessage = { message: "(1 row affected)" };

        client.submitResult = progress(false, [first]);
        client.statusResults = [
            progress(false, [first, second]),
            progress(true, [first, second, third])
        ];

        const batches: QueryMessage[][] = [];
        const pending = runner.run(serverUrl, "SELECT 1", {
            onMessages: messages => batches.push(messages)
        });

        await vi.advanceTimersByTimeAsync(5000);
        await pending;

        expect(batches).toEqual([[first], [second], [third]]);
    });

    it("follows the polling backoff of the decision module", async () => {
        client.statusResults = [progress(false), progress(false), progress(false), progress(true)];

        const pending = runner.run(serverUrl, "SELECT 1");

        // 250 ms staircase for the first second.
        await vi.advanceTimersByTimeAsync(249);
        expect(client.pollCount).toBe(0);

        await vi.advanceTimersByTimeAsync(1);
        expect(client.pollCount).toBe(1);

        await vi.advanceTimersByTimeAsync(250);
        expect(client.pollCount).toBe(2);

        await vi.advanceTimersByTimeAsync(10000);
        await pending;

        expect(client.pollCount).toBe(4);
    });

    it("retries a failed poll and carries on when the network comes back", async () => {
        client.statusResults = [new Error("socket hang up"), progress(true)];

        const pending = runner.run(serverUrl, "SELECT 1");

        await vi.advanceTimersByTimeAsync(10000);

        const outcome = await pending;

        expect(outcome.kind).toBe("completed");
        expect(client.pollCount).toBe(2);
    });

    it("gives up once the retry budget is spent", async () => {
        client.statusResults = Array.from({ length: 200 }, () => new Error("socket hang up"));

        const pending = runner.run(serverUrl, "SELECT 1");

        await vi.advanceTimersByTimeAsync(120000);

        const outcome = await pending;

        expect(outcome.kind).toBe("failed");

        if (outcome.kind === "failed") {
            expect(outcome.error.message).toBe("socket hang up");
        }

        // Retries stopped rather than ran forever.
        expect(client.pollCount).toBeLessThan(20);
        expect(runner.isRunning).toBe(false);
    });

    it("reports a failed submit without polling", async () => {
        client.submitResult = new Error("Server unavailable");

        const outcome = await runner.run(serverUrl, "SELECT 1");

        expect(outcome.kind).toBe("failed");
        expect(client.pollCount).toBe(0);
    });

    it("translates a 404 on the submit into the unsupported plugin error", async () => {
        client.submitResult = new Error(notFoundMessage);

        const outcome = await runner.run(serverUrl, "SELECT 1");

        expect(outcome.kind).toBe("failed");

        if (outcome.kind === "failed") {
            expect(outcome.error).toBeInstanceOf(SqlToolsUnsupportedError);
        }
    });

    it("cancels a run that is mid poll and tells the server", async () => {
        client.statusResults = [progress(false), progress(false), progress(false), progress(false), progress(true)];
        client.onPoll = pollCount => {
            if (pollCount === 2) {
                void runner.cancel();
            }
        };

        const pending = runner.run(serverUrl, "SELECT 1");

        await vi.advanceTimersByTimeAsync(10000);

        const outcome = await pending;

        expect(outcome.kind).toBe("cancelled");
        expect(client.cancelCount).toBe(1);
        expect(client.pollCount).toBe(2);
    });

    it("cancels only once even when asked twice", async () => {
        client.statusResults = [progress(false), progress(false), progress(true)];
        client.onPoll = pollCount => {
            if (pollCount === 1) {
                void runner.cancel();
                void runner.cancel();
            }
        };

        const pending = runner.run(serverUrl, "SELECT 1");

        await vi.advanceTimersByTimeAsync(10000);
        await pending;

        expect(client.cancelCount).toBe(1);
    });

    it("does nothing when cancel is called with no run in flight", async () => {
        await runner.cancel();

        expect(client.cancelCount).toBe(0);
    });

    it("refuses a second run while one is in flight", async () => {
        client.statusResults = [progress(false), progress(true)];

        const pending = runner.run(serverUrl, "SELECT 1");
        const second = await runner.run(serverUrl, "SELECT 2");

        expect(second.kind).toBe("failed");

        await vi.advanceTimersByTimeAsync(10000);
        await pending;

        expect(runner.isRunning).toBe(false);
    });

    it("allows a second run after the first one finished", async () => {
        client.submitResult = progress(true);

        expect((await runner.run(serverUrl, "SELECT 1")).kind).toBe("completed");
        expect((await runner.run(serverUrl, "SELECT 2")).kind).toBe("completed");
    });

    it("hands back the result sets of a completed run", async () => {
        client.submitResult = progress(true, [], [{ columns: [{ name: "Id", type: 2 }], rows: [[1], [2]] }]);

        const outcome = await runner.run(serverUrl, "SELECT Id FROM Person");

        expect(outcome.kind).toBe("completed");

        if (outcome.kind === "completed") {
            expect(outcome.progress.resultSets).toHaveLength(1);
        }
    });

    it("exposes the identifier of the run in flight", async () => {
        client.statusResults = [progress(false), progress(true)];

        const pending = runner.run(serverUrl, "SELECT 1");

        // The identifier only exists once the submit has come back.
        await vi.advanceTimersByTimeAsync(0);

        expect(runner.identifier).toBe(identifier);

        await vi.advanceTimersByTimeAsync(10000);
        await pending;

        expect(runner.identifier).toBeUndefined();
    });
});
