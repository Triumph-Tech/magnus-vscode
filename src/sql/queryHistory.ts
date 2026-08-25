/**
 * Query history: the shape of a recorded run, the rules for adding one to the
 * list, and the filtering and formatting that the Query History quick pick
 * needs.
 *
 * History lives in `globalState`, which means two things drive the design here.
 * It has to stay small, so statement text is capped and results are never
 * stored (spec 5.3); and it has to survive being written by an older version of
 * the extension, hand edited, or corrupted, so {@link parseStoredHistory} trusts
 * nothing it reads.
 *
 * Nothing here touches vscode, so every rule is unit testable.
 */

import { serverHostLabel } from "./bindingDecisions";
import { normalizeServerUrl } from "./nodeCache";
import { distinctTablesInOrder, extractAliasMap, maskNonCode } from "./sqlContext";

/**
 * The largest statement text that is kept, in characters.
 *
 * Long enough that a real query survives whole, small enough that a full
 * history of 500 entries cannot grow past a few megabytes of `globalState`.
 * Anything longer is cut at the cap and marked truncated, so the entry is still
 * useful for finding the run even though re-running it would be wrong.
 */
export const maxStoredStatementLength = 8 * 1024;

/** The longest quick pick label, in characters, before it is cut with an ellipsis. */
export const maxLabelLength = 80;

/**
 * The number of tables a structural label names before the rest become a count.
 *
 * Three is what fits beside the verb without crowding out the description, and a
 * query touching more than three tables is identified well enough by the first
 * three it names.
 */
export const maxLabelTables = 3;

/** The default number of entries kept, matching the `magnus.sql.historySize` default. */
export const defaultHistorySize = 500;

/** How a run ended. */
export type HistoryOutcome = "success" | "error" | "cancelled";

/** What a successful run produced, without any of the data it returned. */
export type HistoryResultSummary = {
    /** How many result sets the run produced. */
    resultSetCount: number;

    /** How many rows there were across every result set. */
    totalRows: number;
};

/** One recorded run of one statement. */
export type HistoryEntry = {
    /** A stable identifier, used to match a quick pick selection back to its entry. */
    id: string;

    /** The normalized URL of the server the statement ran against. */
    serverUrl: string;

    /** The database the statement ran against, when the server reported one. */
    database?: string;

    /** The statement text, cut at {@link maxStoredStatementLength}. Never any results. */
    statementText: string;

    /** True when {@link statementText} was cut and is no longer the whole statement. */
    truncated: boolean;

    /** A single line of the statement, for the quick pick label. */
    label: string;

    /** When the run started, as an ISO 8601 string. */
    startedAt: string;

    /** How long the run took, in milliseconds. */
    durationMs: number;

    /** What the run produced, or null when it failed, was cancelled, or returned no result sets. */
    resultSummary: HistoryResultSummary | null;

    /** How the run ended. */
    outcome: HistoryOutcome;

    /** The first line of the server's error, when the run failed. */
    errorSummary?: string;
};

/** Everything a caller has to supply to record a run. */
export type HistoryEntryInput = {
    /** A stable identifier for the entry. */
    id: string;

    /** The URL of the server the statement ran against. */
    serverUrl: string;

    /** The database the statement ran against, if known. */
    database?: string;

    /** The full statement text. Cut to {@link maxStoredStatementLength} on the way in. */
    statementText: string;

    /** When the run started, as an ISO 8601 string. */
    startedAt: string;

    /** How long the run took, in milliseconds. */
    durationMs: number;

    /** What the run produced, if anything. */
    resultSummary?: HistoryResultSummary | null;

    /** How the run ended. */
    outcome: HistoryOutcome;

    /** The server's error message, if the run failed. Cut to one line. */
    errorSummary?: string;
};

/** One row of the Query History quick pick. */
export type HistoryPickItem = {
    /** The identifier of the entry this row stands for. */
    entryId: string;

    /** The first meaningful line of the statement. */
    label: string;

    /** The server host and how long ago the run was. */
    description: string;

    /** The outcome, the duration and the row counts. */
    detail: string;
};

/** The number of milliseconds in one second. */
const oneSecondMs = 1000;

/** The number of milliseconds in one minute. */
const oneMinuteMs = 60 * oneSecondMs;

/** The number of milliseconds in one hour. */
const oneHourMs = 60 * oneMinuteMs;

/** The number of milliseconds in one day. */
const oneDayMs = 24 * oneHourMs;

/** The outcomes that {@link parseStoredHistory} will accept. */
const knownOutcomes: HistoryOutcome[] = ["success", "error", "cancelled"];

/**
 * Shapes a run into the entry that gets stored.
 *
 * The statement text is cut at {@link maxStoredStatementLength} and a short
 * single line label is derived for the quick pick, so that neither the display
 * nor the storage has to re-derive anything later.
 *
 * @param input The details of the run.
 *
 * @returns The entry to store.
 */
export function createHistoryEntry(input: HistoryEntryInput): HistoryEntry {
    const truncated = input.statementText.length > maxStoredStatementLength;
    const statementText = truncated ? input.statementText.substring(0, maxStoredStatementLength) : input.statementText;

    const entry: HistoryEntry = {
        id: input.id,
        serverUrl: normalizeServerUrl(input.serverUrl),
        statementText: statementText,
        truncated: truncated,
        label: makeLabel(statementText),
        startedAt: input.startedAt,
        durationMs: Math.max(0, Math.round(input.durationMs)),
        resultSummary: input.resultSummary ?? null,
        outcome: input.outcome
    };

    if (input.database) {
        entry.database = input.database;
    }

    if (input.errorSummary) {
        entry.errorSummary = firstLine(input.errorSummary);
    }

    return entry;
}

/**
 * Adds an entry to the history, newest first.
 *
 * Two rules shape the result. The list is capped at `maxSize` and a `maxSize` of
 * zero or less means history is switched off, which stores nothing and drops
 * whatever was there. And re-running the statement you just ran updates the
 * entry you already have rather than stacking another one: an identical
 * statement text and server as the newest entry replaces that entry's timing and
 * outcome, keeping its identifier so an open quick pick still resolves. Without
 * that rule, iterating on one query twenty times buries everything else.
 *
 * Note that only the newest entry is considered. Alternating between two
 * statements deliberately keeps both, because the order they were run in is the
 * useful part of the history.
 *
 * @param entries The current history, newest first.
 * @param entry The entry to add.
 * @param maxSize The number of entries to keep, or 0 to disable history.
 *
 * @returns The new history, newest first. The input list is never modified.
 */
export function addEntry(entries: HistoryEntry[], entry: HistoryEntry, maxSize: number): HistoryEntry[] {
    if (maxSize <= 0) {
        return [];
    }

    const newest = entries[0];

    if (newest && newest.serverUrl === entry.serverUrl && newest.statementText === entry.statementText) {
        const merged: HistoryEntry = {
            ...entry,
            id: newest.id
        };

        return [merged, ...entries.slice(1)].slice(0, maxSize);
    }

    return [entry, ...entries].slice(0, maxSize);
}

/**
 * Filters the history down to the entries that match a search.
 *
 * The rule is token contains, not subsequence: the query is split on
 * whitespace, and every token has to appear somewhere in the statement text,
 * the server URL or the database name, case insensitively. Subsequence matching
 * would make `sel` match almost every entry; requiring each token to appear in
 * full keeps the result predictable when someone types two words.
 *
 * @param entries The history to filter.
 * @param query The search text. Empty or whitespace matches everything.
 *
 * @returns The matching entries, in their original order.
 */
export function filterEntries(entries: HistoryEntry[], query: string): HistoryEntry[] {
    const tokens = query.toLowerCase().split(/\s+/).filter(token => token.length > 0);

    if (tokens.length === 0) {
        return [...entries];
    }

    return entries.filter(entry => {
        const haystack = `${entry.statementText}\n${entry.serverUrl}\n${entry.database ?? ""}`.toLowerCase();

        return tokens.every(token => haystack.indexOf(token) >= 0);
    });
}

/**
 * Builds the rows of the Query History quick pick.
 *
 * @param entries The history to show, newest first.
 * @param now The current time in milliseconds, as `Date.now()` would report it. Passed in so that the relative times are testable.
 *
 * @returns One row per entry, in the same order.
 */
export function buildHistoryPickItems(entries: HistoryEntry[], now: number): HistoryPickItem[] {
    return entries.map(entry => ({
        entryId: entry.id,
        label: entry.label,
        description: describeEntry(entry, now),
        detail: detailOf(entry)
    }));
}

/**
 * Reads the history out of storage, discarding anything that is not a usable
 * entry.
 *
 * Accepts either the JSON string that `globalState` held or an already parsed
 * value, because both spellings have shipped. A corrupt store degrades to a
 * shorter history, never to a thrown error: losing history is an annoyance, and
 * failing to activate over it is not acceptable.
 *
 * @param stored The stored value: a JSON string, an array, or anything else.
 *
 * @returns The entries that were valid, in stored order.
 */
export function parseStoredHistory(stored: unknown): HistoryEntry[] {
    const value = typeof stored === "string" ? tryParseJson(stored) : stored;

    if (!Array.isArray(value)) {
        return [];
    }

    const entries: HistoryEntry[] = [];

    for (const candidate of value) {
        const entry = coerceEntry(candidate);

        if (entry) {
            entries.push(entry);
        }
    }

    return entries;
}

/**
 * Validates one stored value as a history entry, repairing the parts that can
 * be repaired.
 *
 * The identifier, server and statement text have to be there: without them the
 * entry cannot be shown, re-run or matched. Everything else has a safe default,
 * so an entry written by an older version that lacked a field still shows up.
 *
 * @param candidate The value read from storage.
 *
 * @returns The entry, or null if it cannot be made usable.
 */
function coerceEntry(candidate: unknown): HistoryEntry | null {
    if (typeof candidate !== "object" || candidate === null) {
        return null;
    }

    const record = candidate as Record<string, unknown>;

    if (typeof record.id !== "string" || record.id.length === 0) {
        return null;
    }

    if (typeof record.serverUrl !== "string" || record.serverUrl.length === 0) {
        return null;
    }

    if (typeof record.statementText !== "string" || record.statementText.length === 0) {
        return null;
    }

    const statementText = record.statementText.substring(0, maxStoredStatementLength);
    const outcome = knownOutcomes.indexOf(record.outcome as HistoryOutcome) >= 0 ? record.outcome as HistoryOutcome : "success";

    const entry: HistoryEntry = {
        id: record.id,
        serverUrl: normalizeServerUrl(record.serverUrl),
        statementText: statementText,
        truncated: record.truncated === true || record.statementText.length > maxStoredStatementLength,
        label: typeof record.label === "string" && record.label.length > 0 ? record.label : makeLabel(statementText),
        startedAt: isIsoDate(record.startedAt) ? record.startedAt as string : new Date(0).toISOString(),
        durationMs: typeof record.durationMs === "number" && isFinite(record.durationMs) && record.durationMs >= 0 ? record.durationMs : 0,
        resultSummary: coerceSummary(record.resultSummary),
        outcome: outcome
    };

    if (typeof record.database === "string" && record.database.length > 0) {
        entry.database = record.database;
    }

    if (typeof record.errorSummary === "string" && record.errorSummary.length > 0) {
        entry.errorSummary = firstLine(record.errorSummary);
    }

    return entry;
}

/**
 * Validates a stored result summary.
 *
 * @param candidate The value read from storage.
 *
 * @returns The summary, or null if it is missing or malformed.
 */
function coerceSummary(candidate: unknown): HistoryResultSummary | null {
    if (typeof candidate !== "object" || candidate === null) {
        return null;
    }

    const record = candidate as Record<string, unknown>;

    if (typeof record.resultSetCount !== "number" || typeof record.totalRows !== "number") {
        return null;
    }

    if (!isFinite(record.resultSetCount) || !isFinite(record.totalRows)) {
        return null;
    }

    return {
        resultSetCount: Math.max(0, Math.round(record.resultSetCount)),
        totalRows: Math.max(0, Math.round(record.totalRows))
    };
}

/**
 * Parses JSON without throwing.
 *
 * @param text The text to parse.
 *
 * @returns The parsed value, or undefined if the text is not JSON.
 */
function tryParseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}

/**
 * Determines if a value is a string that `Date` can read as a point in time.
 *
 * @param value The value to check.
 *
 * @returns True if the value is a usable date string.
 */
function isIsoDate(value: unknown): boolean {
    return typeof value === "string" && !isNaN(new Date(value).getTime());
}

/**
 * Reduces a statement to the one line that names it.
 *
 * Three tiers, in order:
 *
 * 1. A comment the statement opens with is the label. Someone who wrote
 *    `-- unduplicated attendance for Q3` above a query has already named it
 *    better than any rule could, and the comment is what they will recognize in
 *    the list. An earlier version skipped leading comments to get at the
 *    `SELECT` under them, which threw that away.
 * 2. Otherwise a structural summary: the statement's verb and the tables it
 *    touches, such as `SELECT · Attendance, AttendanceOccurrence, Person +4`.
 *    The first line of a formatted query is usually `SELECT` and nothing else,
 *    or the first of forty column expressions; the tables are what distinguish
 *    one run from another.
 * 3. Failing both, the first meaningful line, which is what a statement with no
 *    comment and no table reference (a `DECLARE`, an `EXEC`) is left with.
 *
 * The tables come from {@link extractAliasMap}, which deliberately ignores
 * everything inside parentheses, so a statement whose only tables are in a
 * derived table falls through to tier 3 rather than claiming tables it is not
 * sure of.
 *
 * The label is display only. Dedupe in {@link addEntry} and searching in
 * {@link filterEntries} both work off the statement text, so nothing here can
 * change which entries are kept or found.
 *
 * @param statementText The statement text.
 *
 * @returns A single line of at most {@link maxLabelLength} characters.
 */
function makeLabel(statementText: string): string {
    const chosen = leadingCommentLabel(statementText)
        ?? structuralLabel(statementText)
        ?? firstMeaningfulLine(statementText);

    return capLabel(chosen);
}

/**
 * Reads the label out of a comment the statement opens with.
 *
 * @param statementText The statement text.
 *
 * @returns The comment text without its markers, or null when the statement does not open with a comment that has anything in it.
 */
function leadingCommentLabel(statementText: string): string | null {
    const text = statementText.replace(/^\s+/, "");

    if (text.startsWith("--")) {
        return textOrNull(text.substring(2).split(/\r?\n/)[0] ?? "");
    }

    if (!text.startsWith("/*")) {
        return null;
    }

    const close = text.indexOf("*/", 2);
    const body = close < 0 ? text.substring(2) : text.substring(2, close);

    for (const line of body.split(/\r?\n/)) {
        // The leading asterisks of a block comment written as a banner are
        // markers too, not part of what the author wrote.
        const stripped = line.replace(/^\s*\*+/, "");

        if (stripped.trim().length > 0) {
            return textOrNull(stripped);
        }
    }

    return null;
}

/**
 * Builds the summary of what a statement does: its verb and the tables it names.
 *
 * @param statementText The statement text.
 *
 * @returns The summary, or null when the statement has no verb or names no table.
 */
function structuralLabel(statementText: string): string | null {
    const verb = firstKeyword(maskNonCode(statementText));

    if (!verb) {
        return null;
    }

    const tables = distinctTablesInOrder(extractAliasMap(statementText));

    if (tables.length === 0) {
        return null;
    }

    const shown = tables.slice(0, maxLabelTables);
    const remaining = tables.length - shown.length;
    const listed = remaining > 0 ? `${shown.join(", ")} +${remaining}` : shown.join(", ");

    return `${verb} · ${listed}`;
}

/**
 * Reads the first word of a piece of masked SQL, which is the statement's verb.
 *
 * @param masked The statement text with its strings and comments blanked out.
 *
 * @returns The word in upper case, or null when there is no word at all.
 */
function firstKeyword(masked: string): string | null {
    const match = /[A-Za-z_@#][A-Za-z0-9_@#$]*/.exec(masked);

    if (!match) {
        return null;
    }

    return match[0].toUpperCase();
}

/**
 * Finds the first line of a statement that has anything on it but a comment.
 *
 * @param statementText The statement text.
 *
 * @returns The line, or the statement's own first line when every line is blank or a comment.
 */
function firstMeaningfulLine(statementText: string): string {
    for (const line of statementText.split(/\r?\n/)) {
        const trimmed = line.trim();

        if (trimmed.length === 0 || trimmed.startsWith("--")) {
            continue;
        }

        return trimmed;
    }

    return statementText.trim().split(/\r?\n/)[0]?.trim() ?? "";
}

/**
 * Collapses the whitespace of a label and cuts it to length.
 *
 * @param text The label text.
 *
 * @returns A single line of at most {@link maxLabelLength} characters.
 */
function capLabel(text: string): string {
    const collapsed = text.trim().replace(/\s+/g, " ");

    if (collapsed.length <= maxLabelLength) {
        return collapsed;
    }

    return `${collapsed.substring(0, maxLabelLength - 1).trimEnd()}…`;
}

/**
 * Reduces a string to null when there is nothing in it but whitespace.
 *
 * @param text The string to check.
 *
 * @returns The trimmed string, or null when it is empty.
 */
function textOrNull(text: string): string | null {
    const trimmed = text.trim();

    return trimmed.length > 0 ? trimmed : null;
}

/**
 * Reduces a message to its first non empty line.
 *
 * @param text The message.
 *
 * @returns The first line, trimmed.
 */
function firstLine(text: string): string {
    for (const line of text.split(/\r?\n/)) {
        if (line.trim().length > 0) {
            return line.trim();
        }
    }

    return text.trim();
}

/**
 * Builds the quick pick description of an entry: where it ran and how long ago.
 *
 * @param entry The entry to describe.
 * @param now The current time in milliseconds.
 *
 * @returns The description.
 */
function describeEntry(entry: HistoryEntry, now: number): string {
    const parts = [serverHost(entry.serverUrl)];

    if (entry.database) {
        parts.push(entry.database);
    }

    parts.push(formatRelativeTime(entry.startedAt, now));

    return parts.join(" · ");
}

/**
 * Builds the quick pick detail of an entry: how it ended and what it produced.
 *
 * @param entry The entry to describe.
 *
 * @returns The detail.
 */
function detailOf(entry: HistoryEntry): string {
    const parts: string[] = [];

    if (entry.outcome === "success") {
        const summary = entry.resultSummary;

        if (summary) {
            parts.push(pluralize(summary.resultSetCount, "result set"));
            parts.push(pluralize(summary.totalRows, "row"));
        }
        else {
            parts.push("no results");
        }
    }
    else if (entry.outcome === "cancelled") {
        parts.push("cancelled");
    }
    else {
        parts.push(entry.errorSummary ? `error: ${entry.errorSummary}` : "error");
    }

    parts.push(formatDuration(entry.durationMs));

    if (entry.truncated) {
        parts.push("statement truncated");
    }

    return parts.join(" · ");
}

/**
 * Formats a count with its noun, pluralized and thousands separated.
 *
 * @param count The count.
 * @param noun The singular noun.
 *
 * @returns The formatted count, such as `1 row` or `1,234 rows`.
 */
function pluralize(count: number, noun: string): string {
    return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Formats a duration for display.
 *
 * @param durationMs The duration in milliseconds.
 *
 * @returns The duration in milliseconds under a second, otherwise in seconds.
 */
export function formatDuration(durationMs: number): string {
    if (durationMs < oneSecondMs) {
        return `${Math.round(durationMs)} ms`;
    }

    return `${(durationMs / oneSecondMs).toFixed(1)} s`;
}

/**
 * Formats how long ago something happened, in the coarse way a history list
 * wants: exactness stops mattering after a few minutes.
 *
 * @param startedAt The ISO 8601 time the run started.
 * @param now The current time in milliseconds.
 *
 * @returns A phrase such as `just now`, `12m ago`, `3h ago`, `2d ago`, or the date for anything older than a week.
 */
export function formatRelativeTime(startedAt: string, now: number): string {
    const started = new Date(startedAt).getTime();

    if (isNaN(started)) {
        return "unknown time";
    }

    const elapsed = now - started;

    if (elapsed < 0) {
        return "just now";
    }

    if (elapsed < oneMinuteMs) {
        return "just now";
    }

    if (elapsed < oneHourMs) {
        return `${Math.floor(elapsed / oneMinuteMs)}m ago`;
    }

    if (elapsed < oneDayMs) {
        return `${Math.floor(elapsed / oneHourMs)}h ago`;
    }

    if (elapsed < 7 * oneDayMs) {
        return `${Math.floor(elapsed / oneDayMs)}d ago`;
    }

    return new Date(started).toISOString().substring(0, 10);
}

/**
 * Reduces a server URL to the host that a history row shows.
 *
 * This delegates to {@link serverHostLabel}, which is the same reduction the
 * status bar uses. Doing it in one place is what keeps credentials out of the
 * history: a URL entered as `https://user:pass@host` used to show its userinfo
 * here while the status bar stripped it.
 *
 * @param serverUrl The server URL.
 *
 * @returns The host, or the original string if no host can be found.
 */
export function serverHost(serverUrl: string): string {
    return serverHostLabel(serverUrl);
}
