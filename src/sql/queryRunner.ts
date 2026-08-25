import { classifySqlError } from "./sqlErrors";
import { classifyCompletion, mergeMessages, nextPollDelay, retryDelayMs, shouldRetryPoll } from "./queryDecisions";
import { ExecuteQueryProgress, QueryMessage } from "./types";

/**
 * The lifecycle of one query execution: submit it, poll the server until it is
 * done, stream the messages it emits along the way, and cancel it on request.
 *
 * Every rule this loop follows lives in {@link queryDecisions}, so the only
 * thing here is the side effects. The client is taken as an interface rather
 * than as {@link SqlApi} so that the loop can be unit tested with fake timers
 * and no HTTP.
 */

/**
 * The part of {@link SqlApi} that one execution needs.
 */
export interface IQueryExecutionClient {
    /**
     * Starts executing a query on the server.
     *
     * @param serverUrl The URL of the server to execute the query on.
     * @param query The SQL statement text to execute.
     *
     * @returns The initial progress of the execution, including its identifier.
     */
    executeQuery(serverUrl: string, query: string): Promise<ExecuteQueryProgress>;

    /**
     * Gets the current progress of a query execution.
     *
     * @param serverUrl The URL of the server the query is running on.
     * @param identifier The identifier of the execution.
     *
     * @returns The current progress of the execution.
     */
    getQueryStatus(serverUrl: string, identifier: string): Promise<ExecuteQueryProgress>;

    /**
     * Asks the server to cancel a running query.
     *
     * @param serverUrl The URL of the server the query is running on.
     * @param identifier The identifier of the execution to cancel.
     */
    cancelQuery(serverUrl: string, identifier: string): Promise<void>;
}

/**
 * How one execution ended.
 */
export type QueryRunOutcome =
    /** The server finished the query, successfully or with SQL errors in its messages. */
    | { kind: "completed"; progress: ExecuteQueryProgress; durationMs: number }
    /** The person cancelled the query. */
    | { kind: "cancelled"; durationMs: number }
    /** The execution could not be submitted, or the poll loop gave up. */
    | { kind: "failed"; error: Error; durationMs: number };

/**
 * The callbacks an execution reports progress through.
 */
export type QueryRunCallbacks = {
    /**
     * Called with only the messages that have not been reported yet, each time
     * the server returns some.
     *
     * @param messages The messages that are new since the last call.
     */
    onMessages?: (messages: QueryMessage[]) => void;
};

/**
 * The seams a test replaces to control time.
 */
export type QueryRunnerOptions = {
    /** Returns the current time in milliseconds. Defaults to `Date.now`. */
    now?: () => number;

    /**
     * Waits for the given number of milliseconds. Defaults to `setTimeout`.
     *
     * @param milliseconds The number of milliseconds to wait.
     */
    delay?: (milliseconds: number) => Promise<void>;
};

/**
 * Runs a single query against a server and reports on it as it goes.
 *
 * One instance runs one query at a time. The caller keeps an instance per query
 * editor so that cancelling one editor's query leaves the others alone.
 */
export class QueryRunner {
    // #region Private Properties

    /** The client used to submit, poll and cancel the execution. */
    private client: IQueryExecutionClient;

    /** Returns the current time in milliseconds. */
    private now: () => number;

    /** Waits for the given number of milliseconds. */
    private delay: (milliseconds: number) => Promise<void>;

    /** True from the moment a run is submitted until its outcome is returned. */
    private running: boolean = false;

    /** True once cancellation has been asked for, until the run ends. */
    private cancelRequested: boolean = false;

    /** True once the cancel request has been sent to the server for this run. */
    private cancelSent: boolean = false;

    /** The URL of the server the current run is on, while one is in flight. */
    private currentServerUrl?: string;

    /** The server side identifier of the current run, once it has been assigned. */
    private currentIdentifier?: string;

    // #endregion

    // #region Constructors

    /**
     * Creates a new instance of the query runner.
     *
     * @param client The client used to talk to the server's SQL endpoints.
     * @param options The seams a test replaces to control time.
     */
    public constructor(client: IQueryExecutionClient, options?: QueryRunnerOptions) {
        this.client = client;
        this.now = options?.now ?? (() => Date.now());
        this.delay = options?.delay ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
    }

    // #endregion

    // #region Public Properties

    /** True while a query is in flight. */
    public get isRunning(): boolean {
        return this.running;
    }

    /** The server side identifier of the query in flight, if there is one. */
    public get identifier(): string | undefined {
        return this.currentIdentifier;
    }

    // #endregion

    // #region Private Functions

    /**
     * Forgets everything about the run that just ended.
     */
    private reset(): void {
        this.running = false;
        this.cancelRequested = false;
        this.cancelSent = false;
        this.currentServerUrl = undefined;
        this.currentIdentifier = undefined;
    }

    /**
     * Tells the server to cancel a run, at most once per run.
     *
     * @param serverUrl The URL of the server the query is running on.
     * @param identifier The identifier of the execution to cancel.
     */
    private async sendCancel(serverUrl: string, identifier: string): Promise<void> {
        if (this.cancelSent) {
            return;
        }

        this.cancelSent = true;

        try {
            await this.client.cancelQuery(serverUrl, identifier);
        }
        catch (error) {
            // The query may well have finished on its own by now, which is not
            // something to report.
            console.log("Failed to cancel the query.", error);
        }
    }

    /**
     * Reports the messages of a progress response that have not been seen yet.
     *
     * @param known The messages already reported for this run.
     * @param progress The progress response just received.
     * @param callbacks The callbacks the caller wants progress on.
     *
     * @returns Every message now known for the run.
     */
    private reportMessages(known: QueryMessage[], progress: ExecuteQueryProgress, callbacks: QueryRunCallbacks): QueryMessage[] {
        const merged = mergeMessages(known, progress.messages ?? []);

        if (merged.newMessages.length > 0) {
            callbacks.onMessages?.(merged.newMessages);
        }

        return merged.messages;
    }

    // #endregion

    // #region Public Functions

    /**
     * Submits a query and does not return until the server is done with it, the
     * person cancels it, or it fails.
     *
     * Errors are never thrown out of here. A caller that has to render an
     * outcome should not also have to catch, and every failure mode is one of
     * the outcomes.
     *
     * @param serverUrl The URL of the server to run the query on.
     * @param query The SQL statement text to run.
     * @param callbacks The callbacks the caller wants progress on.
     *
     * @returns How the execution ended.
     */
    public async run(serverUrl: string, query: string, callbacks: QueryRunCallbacks = {}): Promise<QueryRunOutcome> {
        if (this.running) {
            return {
                kind: "failed",
                error: new Error("A query is already running in this editor."),
                durationMs: 0
            };
        }

        this.running = true;
        this.cancelRequested = false;
        this.currentServerUrl = serverUrl;
        this.currentIdentifier = undefined;

        const startedAt = this.now();
        let messages: QueryMessage[] = [];
        let progress: ExecuteQueryProgress;

        try {
            progress = await this.client.executeQuery(serverUrl, query);
        }
        catch (error) {
            const failure = classifySqlError(error, serverUrl);

            this.reset();

            return {
                kind: "failed",
                error: failure,
                durationMs: this.now() - startedAt
            };
        }

        this.currentIdentifier = progress.identifier;
        messages = this.reportMessages(messages, progress, callbacks);

        // Cancellation asked for while the submit was in flight still has to
        // reach the server, since by then it has a query of its own to stop.
        if (this.cancelRequested) {
            await this.sendCancel(serverUrl, progress.identifier);

            const durationMs = this.now() - startedAt;

            this.reset();

            return {
                kind: "cancelled",
                durationMs
            };
        }

        if (classifyCompletion(progress) === "complete") {
            const durationMs = this.now() - startedAt;

            this.reset();

            return {
                kind: "completed",
                progress,
                durationMs
            };
        }

        let consecutiveFailures = 0;
        let firstFailureAt = 0;

        for (;;) {
            const waitMs = consecutiveFailures > 0
                ? retryDelayMs(consecutiveFailures)
                : nextPollDelay(this.now() - startedAt);

            await this.delay(waitMs);

            if (this.cancelRequested) {
                const durationMs = this.now() - startedAt;

                this.reset();

                return {
                    kind: "cancelled",
                    durationMs
                };
            }

            try {
                progress = await this.client.getQueryStatus(serverUrl, this.currentIdentifier);
            }
            catch (error) {
                consecutiveFailures += 1;

                if (consecutiveFailures === 1) {
                    firstFailureAt = this.now();
                }

                if (!shouldRetryPoll(consecutiveFailures, this.now() - firstFailureAt)) {
                    const failure = classifySqlError(error, serverUrl);
                    const durationMs = this.now() - startedAt;

                    this.reset();

                    return {
                        kind: "failed",
                        error: failure,
                        durationMs
                    };
                }

                continue;
            }

            consecutiveFailures = 0;
            messages = this.reportMessages(messages, progress, callbacks);

            if (this.cancelRequested) {
                await this.sendCancel(serverUrl, this.currentIdentifier);

                const durationMs = this.now() - startedAt;

                this.reset();

                return {
                    kind: "cancelled",
                    durationMs
                };
            }

            if (classifyCompletion(progress) === "complete") {
                const durationMs = this.now() - startedAt;

                this.reset();

                return {
                    kind: "completed",
                    progress,
                    durationMs
                };
            }
        }
    }

    /**
     * Stops polling the current run and asks the server to cancel it.
     *
     * The poll loop notices the request at its next turn and returns a
     * cancelled outcome, so there is exactly one place that ends a run.
     */
    public async cancel(): Promise<void> {
        if (!this.running || this.cancelRequested) {
            return;
        }

        this.cancelRequested = true;

        const serverUrl = this.currentServerUrl;
        const identifier = this.currentIdentifier;

        if (serverUrl !== undefined && identifier !== undefined) {
            await this.sendCancel(serverUrl, identifier);
        }
    }

    // #endregion
}
