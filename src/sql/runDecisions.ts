import { needsDestructiveConfirmation, ServerEnvironment } from "./documentBindings";
import { maskNonCode } from "./sqlContext";
import { classifyStatement, destructiveKeywords, splitStatements, Statement, statementAt } from "./statementSplitter";

/**
 * The keywords that make a whole run destructive wherever they appear in it.
 *
 * The splitter's list plus `into`, which cannot lead a statement and so has no
 * place in that list, but does mean a `SELECT` is writing a table.
 */
const wholeRunDestructiveKeywords: readonly string[] = [...destructiveKeywords, "into"];

/**
 * The decisions the run commands make before anything is submitted: which text
 * runs, whether the person has to confirm it first, and where the CodeLens
 * entries go.
 *
 * All of it is pure so that the command layer is only editor plumbing, and so
 * that the production confirmation matrix can be covered by tests rather than by
 * hoping.
 */

/**
 * The text that a run command decided to execute.
 */
export type RunTarget = {
    /** The SQL text to submit. */
    text: string;

    /** How the text was chosen, used for the panel header and for messages. */
    source: "selection" | "statement" | "document";
};

/**
 * One "Run" CodeLens to place above a statement.
 */
export type RunLens = {
    /** The offset into the document of the first character of the statement. */
    startOffset: number;

    /** The offset into the document just past the last character of the statement. */
    endOffset: number;

    /** The zero based line the lens sits on. */
    startLine: number;

    /** The text of the statement the lens runs. */
    text: string;
};

/**
 * Decides what a Run Query command runs.
 *
 * A non-empty selection is the person being explicit, and wins. Anything else
 * runs the whole document, which is the ground truth that a splitter miss can
 * always fall back to.
 *
 * @param documentText The full text of the document.
 * @param selectedText The selected text, which may be empty.
 *
 * @returns The text to run, or null when there is nothing to run.
 */
export function resolveRunTarget(documentText: string, selectedText: string): RunTarget | null {
    if (selectedText.trim() !== "") {
        return {
            text: selectedText,
            source: "selection"
        };
    }

    if (documentText.trim() === "") {
        return null;
    }

    return {
        text: documentText,
        source: "document"
    };
}

/**
 * Decides what a Run Statement command runs.
 *
 * The statement containing the cursor is preferred. When the splitter finds
 * nothing at all the whole document runs instead, because a tokenizer miss must
 * never leave the person unable to run anything.
 *
 * @param documentText The full text of the document.
 * @param cursorOffset The offset of the cursor into the document.
 *
 * @returns The text to run, or null when there is nothing to run.
 */
export function resolveStatementTarget(documentText: string, cursorOffset: number): RunTarget | null {
    if (documentText.trim() === "") {
        return null;
    }

    const statement = statementAt(splitStatements(documentText), cursorOffset);

    if (!statement) {
        return {
            text: documentText,
            source: "document"
        };
    }

    return {
        text: statement.text,
        source: "statement"
    };
}

/**
 * Decides whether the person has to confirm before this text runs.
 *
 * Every statement in the text is classified, not just the first one, because a
 * batch that opens with a `SELECT` and goes on to `UPDATE` is exactly the case a
 * production guard exists for. Text the splitter finds no statements in is
 * classified as a whole, which fails safe through `unknown`.
 *
 * @param text The SQL text that is about to run.
 * @param environment The tag on the bound server, if it has one.
 * @param alwaysAllowServers The URLs of the servers the person chose to stop being asked about.
 * @param serverUrl The URL of the bound server.
 *
 * @returns True if the person must confirm before the text runs.
 */
export function runNeedsConfirmation(text: string, environment: ServerEnvironment, alwaysAllowServers: string[], serverUrl: string): boolean {
    for (const classification of classifyRunText(text)) {
        if (needsDestructiveConfirmation(environment, classification, alwaysAllowServers, serverUrl)) {
            return true;
        }
    }

    return false;
}

/**
 * Classifies every statement in a run.
 *
 * A statement is classified by its first keyword, which is blind to a batch
 * written without semicolons: `DECLARE @x INT` on one line and
 * `DELETE FROM Person` on the next is one statement to the splitter, and its
 * first keyword is `DECLARE`. So the whole run is scanned for destructive
 * keywords as well, and when a run that every statement called `read` turns out
 * to hold one, a `destructive` verdict for the run is added to the list. The
 * scan only ever adds prompts, which is the only direction a guard like this may
 * be wrong in.
 *
 * @param text The SQL text that is about to run.
 *
 * @returns The classification of each statement, plus a verdict for the whole run when the statements between them missed something.
 */
export function classifyRunText(text: string): ReturnType<typeof classifyStatement>[] {
    const statements = splitStatements(text);
    const classifications = statements.length === 0
        ? (text.trim() === "" ? [] : [classifyStatement(text)])
        : statements.map(statement => classifyStatement(statement.text));

    if (classifications.length === 0 || classifications.some(classification => classification !== "read")) {
        return classifications;
    }

    if (!containsDestructiveKeyword(text)) {
        return classifications;
    }

    return [...classifications, "destructive"];
}

/**
 * Determines if a piece of SQL uses a destructive keyword anywhere in it.
 *
 * The text is masked first, so a `delete` inside a string literal or a comment
 * is invisible, and only whole words count, so a column called `DeletedDateTime`
 * is not a `DELETE`. `into` is checked alongside the splitter's own list to
 * catch `SELECT * INTO NewTable FROM Person`, which writes a table without any
 * of the usual keywords leading the statement.
 *
 * @param text The SQL text that is about to run.
 *
 * @returns True if a destructive keyword appears as a word of the code.
 */
export function containsDestructiveKeyword(text: string): boolean {
    const words = maskNonCode(text).match(/[A-Za-z_@#][A-Za-z0-9_@#$]*/g);

    if (!words) {
        return false;
    }

    return words.some(word => wholeRunDestructiveKeywords.indexOf(word.toLowerCase()) >= 0);
}

/**
 * Builds the "Run" CodeLens entries for a document.
 *
 * @param documentText The full text of the document.
 * @param isEnabled The value of the `magnus.sql.codeLens` setting.
 *
 * @returns One lens per statement, or an empty array when the setting is off.
 */
export function buildRunLenses(documentText: string, isEnabled: boolean): RunLens[] {
    if (!isEnabled) {
        return [];
    }

    return splitStatements(documentText).map(toRunLens);
}

/**
 * Turns a statement into the lens that runs it.
 *
 * @param statement The statement the splitter found.
 *
 * @returns The lens to place above it.
 */
function toRunLens(statement: Statement): RunLens {
    return {
        startOffset: statement.startOffset,
        endOffset: statement.endOffset,
        startLine: statement.startLine,
        text: statement.text
    };
}

/**
 * Shortens a statement to something that fits in a panel header or a dialog.
 *
 * @param text The SQL text.
 * @param maximumLength The greatest number of characters to keep.
 *
 * @returns The text on one line, truncated with an ellipsis if it had to be.
 */
export function summarizeStatement(text: string, maximumLength: number = 80): string {
    const collapsed = text.replace(/\s+/g, " ").trim();

    if (collapsed.length <= maximumLength) {
        return collapsed;
    }

    return `${collapsed.substring(0, Math.max(0, maximumLength - 1))}…`;
}
