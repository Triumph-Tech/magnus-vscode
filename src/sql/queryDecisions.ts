import { ExecuteQueryProgress, QueryMessage } from "./types";

/**
 * The decisions made while one query execution runs: how often to poll the
 * `Sql/Status` endpoint, which of the messages it returned are new, how long to
 * keep retrying after the network drops, and how much of a large result set the
 * grid renders up front.
 *
 * Everything here is pure so that the polling loop in the side effecting runner
 * has no rules of its own.
 */

/** The delay used for the first polls of a query, in milliseconds. */
export const initialPollDelayMs = 250;

/** The longest delay between two polls of a query, in milliseconds. */
export const maxPollDelayMs = 1000;

/** How long the poll loop keeps retrying after the network drops, in milliseconds. */
export const retryBudgetMs = 30000;

/** The longest delay between two retries after a failed poll, in milliseconds. */
export const maxRetryDelayMs = 5000;

/** The number of rows the grid renders up front unless the setting says otherwise. */
export const defaultMaxRenderRows = 10000;

/**
 * The largest render cap the setting can ask for.
 *
 * There is deliberately no way to turn the cap off. Rendering a million rows in
 * one burst is a freeze the person cannot escape, and nothing is lost by
 * capping: every row past it arrives as the grid scrolls, and copies and
 * exports always cover the whole set.
 */
export const maxRenderRowsCeiling = 100000;

/**
 * Whether the server is still working on a query.
 */
export type QueryCompletionState = "running" | "complete";

/**
 * The outcome of folding a `Sql/Status` response into the messages already
 * shown.
 */
export type MessageMergeResult = {
    /** Every message known for this execution, in order. */
    messages: QueryMessage[];

    /** Only the messages that were not already known, in order. */
    newMessages: QueryMessage[];
};

/**
 * How much of a result set the grid renders before the person scrolls.
 */
export type RenderPlan = {
    /** The number of rows to put in the initial render. */
    initialRows: number;

    /** The notice for the footer and the Messages tab, or null when everything is rendered. */
    truncatedNotice: string | null;
};

/**
 * Decides how long to wait before polling `Sql/Status` again.
 *
 * The curve is a short staircase: 250 ms for the first second, 500 ms up to
 * three seconds, then 1 s for as long as the query runs. Quick queries feel
 * instant and long ones stop hammering the server.
 *
 * @param elapsedMs The number of milliseconds since the query was submitted.
 *
 * @returns The number of milliseconds to wait before the next poll.
 */
export function nextPollDelay(elapsedMs: number): number {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 1000) {
        return initialPollDelayMs;
    }

    if (elapsedMs < 3000) {
        return 500;
    }

    return maxPollDelayMs;
}

/**
 * Folds the messages of a `Sql/Status` response into the messages already known.
 *
 * The endpoint accumulates messages, so an ordinary response repeats everything
 * seen so far with the new entries appended. That case is detected by prefix, so
 * nothing is shown twice. A response that is not an extension of what is known
 * (a server that drained its queue instead, or a reconnect) is appended whole
 * rather than dropped, because losing a SQL error message is worse than showing
 * one twice.
 *
 * @param existing The messages already known for this execution.
 * @param incoming The messages from the latest response.
 *
 * @returns The merged list along with only the messages that are new.
 */
export function mergeMessages(existing: QueryMessage[], incoming: QueryMessage[]): MessageMergeResult {
    if (incoming.length === 0) {
        return {
            messages: [...existing],
            newMessages: []
        };
    }

    const sharedLength = Math.min(existing.length, incoming.length);
    let isPrefix = true;

    for (let index = 0; index < sharedLength; index++) {
        if (!areMessagesEqual(existing[index], incoming[index])) {
            isPrefix = false;

            break;
        }
    }

    if (isPrefix) {
        const newMessages = incoming.slice(existing.length);

        return {
            messages: newMessages.length > 0 ? [...existing, ...newMessages] : [...existing],
            newMessages
        };
    }

    return {
        messages: [...existing, ...incoming],
        newMessages: [...incoming]
    };
}

/**
 * Determines if two messages describe the same server side event.
 *
 * @param left The first message.
 * @param right The second message.
 *
 * @returns True if the two messages are indistinguishable.
 */
function areMessagesEqual(left: QueryMessage, right: QueryMessage): boolean {
    return left.message === right.message
        && (left.code ?? null) === (right.code ?? null)
        && (left.level ?? null) === (right.level ?? null)
        && (left.state ?? null) === (right.state ?? null)
        && (left.lineNumber ?? null) === (right.lineNumber ?? null);
}

/**
 * Decides whether a failed poll should be tried again.
 *
 * A dropped network connection is retried for 30 seconds and then reported. The
 * server side query keeps its own lifecycle, so giving up on the poll does not
 * cancel it.
 *
 * @param consecutiveFailures The number of polls that have failed in a row, including the one just now.
 * @param elapsedSinceFirstFailureMs The number of milliseconds since the first of those failures.
 *
 * @returns True if the poll loop should wait and try again.
 */
export function shouldRetryPoll(consecutiveFailures: number, elapsedSinceFirstFailureMs: number): boolean {
    if (consecutiveFailures <= 0) {
        return false;
    }

    if (!Number.isFinite(elapsedSinceFirstFailureMs) || elapsedSinceFirstFailureMs < 0) {
        return true;
    }

    return elapsedSinceFirstFailureMs < retryBudgetMs;
}

/**
 * Decides how long to wait before retrying a failed poll.
 *
 * The delay doubles from 500 ms and is capped at 5 s, which fits several
 * attempts into the 30 second budget without spinning.
 *
 * @param consecutiveFailures The number of polls that have failed in a row, including the one just now.
 *
 * @returns The number of milliseconds to wait before the next attempt.
 */
export function retryDelayMs(consecutiveFailures: number): number {
    if (consecutiveFailures <= 1) {
        return 500;
    }

    return Math.min(maxRetryDelayMs, 500 * Math.pow(2, consecutiveFailures - 1));
}

/**
 * Determines whether the server has finished with a query.
 *
 * @param progress The latest progress reported by `Sql/ExecuteQuery` or `Sql/Status`.
 *
 * @returns Whether the query is still running or is complete.
 */
export function classifyCompletion(progress: ExecuteQueryProgress): QueryCompletionState {
    return progress.isComplete ? "complete" : "running";
}

/**
 * Decides how much of a result set the grid renders up front, and what to say
 * about the rest.
 *
 * Rows past the cap are held in memory and rendered as the grid scrolls, and
 * exports always include everything, so the notice states the full row count
 * explicitly rather than implying anything was lost.
 *
 * There is always a cap. A setting of zero or less is not "no limit" but a
 * request the extension cannot honor without freezing the panel, so it falls
 * back to {@link defaultMaxRenderRows}, and anything absurd is clamped to
 * {@link maxRenderRowsCeiling}.
 *
 * @param totalRows The number of rows the server returned.
 * @param maxRenderRows The value of the `magnus.sql.maxRenderRows` setting.
 *
 * @returns The number of rows to render and the notice to show, if any.
 */
export function renderPlan(totalRows: number, maxRenderRows: number): RenderPlan {
    const rows = Math.max(0, Math.floor(totalRows));
    const cap = resolveMaxRenderRows(maxRenderRows);

    if (rows <= cap) {
        return {
            initialRows: rows,
            truncatedNotice: null
        };
    }

    return {
        initialRows: cap,
        truncatedNotice: `Showing the first ${formatRowCount(cap)} rows. All ${formatRowCount(rows)} rows were returned and are included in copies and exports.`
    };
}

/**
 * Resolves the render cap the setting asks for into one the panel can honor.
 *
 * @param maxRenderRows The value of the `magnus.sql.maxRenderRows` setting.
 *
 * @returns The cap to apply, which is always at least one row.
 */
export function resolveMaxRenderRows(maxRenderRows: number): number {
    if (!Number.isFinite(maxRenderRows) || maxRenderRows <= 0) {
        return defaultMaxRenderRows;
    }

    return Math.min(maxRenderRowsCeiling, Math.max(1, Math.floor(maxRenderRows)));
}

/**
 * Formats a row count for display in a notice.
 *
 * @param count The number of rows.
 *
 * @returns The count with thousands separators.
 */
function formatRowCount(count: number): string {
    return count.toLocaleString("en-US");
}
