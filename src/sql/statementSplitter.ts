/**
 * T-SQL statement and batch boundary detection, plus the destructive statement
 * classification that the production confirmation prompt depends on.
 *
 * This is a tokenizer, not a parser. It tracks the few lexical constructs that
 * can hide a boundary character (string literals, quoted identifiers, line and
 * block comments) and then splits on top level semicolons and on `GO` batch
 * separators. It will meet T-SQL it cannot make sense of; when that happens the
 * person still has "run selection" and "run whole document" as ground truth, so
 * a wrong boundary is never fatal.
 *
 * Nothing here touches vscode, so every rule is unit testable.
 */

import { isWordPart, isWordStart, skipBlockComment, skipLineComment } from "./sqlLexemes";

/**
 * A single statement or batch found in a document.
 *
 * The offsets bound the significant text of the statement: leading and trailing
 * whitespace is excluded, so `text` always equals
 * `source.substring(startOffset, endOffset)`. A trailing semicolon is part of
 * the statement; a `GO` separator never is.
 */
export type Statement = {
    /** The exact source text of the statement, without surrounding whitespace. */
    text: string;

    /** The offset into the document of the first character of the statement. */
    startOffset: number;

    /** The offset into the document just past the last character of the statement. */
    endOffset: number;

    /** The zero based line number that {@link startOffset} falls on. */
    startLine: number;
};

/**
 * How a statement is treated by the production confirmation prompt.
 *
 * Callers treat `unknown` exactly like `destructive` on a production tagged
 * server, so an unrecognized shape fails safe.
 */
export type StatementClassification = "read" | "destructive" | "unknown";

/**
 * The keywords that mark a statement as changing something.
 *
 * Exported because the run guard scans a whole batch for these as well, and one
 * list is the only way the two checks can agree.
 */
export const destructiveKeywords: readonly string[] = [
    "update",
    "delete",
    "insert",
    "merge",
    "truncate",
    "drop",
    "alter",
    "create",
    "exec",
    "execute",
    "grant",
    "deny",
    "revoke"
];

/**
 * The keywords that mark a statement as safe to run without confirmation.
 *
 * `begin` is deliberately absent: `BEGIN TRANSACTION` and a `BEGIN ... END`
 * block are indistinguishable to a tokenizer, so it stays unknown.
 */
const readKeywords = [
    "select",
    "declare",
    "set",
    "print",
    "use"
];

/** The keywords that can follow a common table expression and decide its classification. */
const cteBodyKeywords = [
    "select",
    "insert",
    "update",
    "delete",
    "merge"
];

/**
 * Splits a document into the statements and batches it contains.
 *
 * Segments that hold nothing but whitespace and comments are dropped, because
 * there is nothing there to run.
 *
 * @param text The full text of the document.
 *
 * @returns The statements in document order.
 */
export function splitStatements(text: string): Statement[] {
    const statements: Statement[] = [];
    const lineStarts = buildLineStarts(text);
    let segmentStart = 0;
    let index = 0;

    /**
     * Records the text between `segmentStart` and `end` as a statement and
     * begins a new segment at `nextStart`.
     */
    const pushSegment = (end: number, nextStart: number): void => {
        const statement = makeStatement(text, segmentStart, end, lineStarts);

        if (statement) {
            statements.push(statement);
        }

        segmentStart = nextStart;
    };

    while (index < text.length) {
        const character = text[index];

        if (isAtLineStart(text, index)) {
            const separator = matchBatchSeparator(text, index);

            if (separator !== undefined) {
                pushSegment(index, separator);
                index = separator;

                continue;
            }
        }

        if (character === "'" || character === "\"" || character === "[") {
            index = skipQuoted(text, index);

            continue;
        }

        if (character === "-" && text[index + 1] === "-") {
            index = skipLineComment(text, index);

            continue;
        }

        if (character === "/" && text[index + 1] === "*") {
            index = skipBlockComment(text, index);

            continue;
        }

        if (character === ";") {
            pushSegment(index + 1, index + 1);
            index += 1;

            continue;
        }

        index += 1;
    }

    pushSegment(text.length, text.length);

    return statements;
}

/**
 * Finds the statement that a cursor sits in.
 *
 * A cursor inside a statement, or immediately after its last character, resolves
 * to that statement. A cursor in the whitespace, comments or `GO` separator
 * between two statements resolves to the nearest preceding statement, because
 * that is the statement the person just finished typing. A cursor before the
 * first statement resolves to the first statement.
 *
 * @param statements The statements of the document, as returned by {@link splitStatements}.
 * @param offset The offset of the cursor into the document.
 *
 * @returns The statement the cursor belongs to, or undefined if there are none.
 */
export function statementAt(statements: Statement[], offset: number): Statement | undefined {
    if (statements.length === 0) {
        return undefined;
    }

    let previous: Statement | undefined;

    for (const statement of statements) {
        if (offset >= statement.startOffset && offset <= statement.endOffset) {
            return statement;
        }

        if (statement.endOffset < offset) {
            previous = statement;
        }
    }

    return previous ?? statements[0];
}

/**
 * Classifies a statement by its first significant keyword.
 *
 * A leading common table expression is followed through: the classification
 * comes from the first of `SELECT`, `INSERT`, `UPDATE`, `DELETE` or `MERGE`
 * that appears outside the expression's parentheses. Anything unrecognized is
 * `unknown`, which callers treat as destructive on production.
 *
 * @param text The text of a single statement.
 *
 * @returns The classification of the statement.
 */
export function classifyStatement(text: string): StatementClassification {
    const words = significantWords(text, 1);

    if (words.length === 0) {
        return "unknown";
    }

    const keyword = words[0].toLowerCase();

    if (keyword === "with") {
        return classifyCommonTableExpression(text);
    }

    if (destructiveKeywords.indexOf(keyword) >= 0) {
        return "destructive";
    }

    if (readKeywords.indexOf(keyword) >= 0) {
        return "read";
    }

    return "unknown";
}

/**
 * Classifies a statement that begins with a common table expression.
 *
 * @param text The text of a single statement, whose first keyword is `WITH`.
 *
 * @returns The classification of the statement.
 */
function classifyCommonTableExpression(text: string): StatementClassification {
    const words = significantWords(text, 0);

    for (const word of words.slice(1)) {
        const keyword = word.toLowerCase();

        if (cteBodyKeywords.indexOf(keyword) >= 0) {
            return keyword === "select" ? "read" : "destructive";
        }
    }

    return "unknown";
}

/**
 * Collects the words of a statement that are neither inside a string, a quoted
 * identifier, a comment nor a set of parentheses.
 *
 * @param text The text of a single statement.
 * @param limit The maximum number of words to collect, or 0 for no limit.
 *
 * @returns The words in the order they appear.
 */
function significantWords(text: string, limit: number): string[] {
    const words: string[] = [];
    let depth = 0;
    let index = 0;

    while (index < text.length) {
        const character = text[index];

        if (character === "'" || character === "\"" || character === "[") {
            index = skipQuoted(text, index);

            continue;
        }

        if (character === "-" && text[index + 1] === "-") {
            index = skipLineComment(text, index);

            continue;
        }

        if (character === "/" && text[index + 1] === "*") {
            index = skipBlockComment(text, index);

            continue;
        }

        if (character === "(") {
            depth += 1;
            index += 1;

            continue;
        }

        if (character === ")") {
            depth = Math.max(0, depth - 1);
            index += 1;

            continue;
        }

        if (isWordStart(character)) {
            const start = index;

            while (index < text.length && isWordPart(text[index])) {
                index += 1;
            }

            if (depth === 0) {
                words.push(text.substring(start, index));

                if (limit > 0 && words.length >= limit) {
                    return words;
                }
            }

            continue;
        }

        index += 1;
    }

    return words;
}

/**
 * Builds a statement from a segment of the document, trimming the whitespace at
 * both ends.
 *
 * @param text The full text of the document.
 * @param start The offset of the first character of the segment.
 * @param end The offset just past the last character of the segment.
 * @param lineStarts The offset of the first character of each line of the document.
 *
 * @returns The statement, or undefined if the segment has nothing to run in it.
 */
function makeStatement(text: string, start: number, end: number, lineStarts: number[]): Statement | undefined {
    let trimmedStart = start;
    let trimmedEnd = end;

    while (trimmedStart < trimmedEnd && isWhitespace(text[trimmedStart])) {
        trimmedStart += 1;
    }

    while (trimmedEnd > trimmedStart && isWhitespace(text[trimmedEnd - 1])) {
        trimmedEnd -= 1;
    }

    if (trimmedStart >= trimmedEnd) {
        return undefined;
    }

    const statementText = text.substring(trimmedStart, trimmedEnd);

    if (!hasRunnableContent(statementText)) {
        return undefined;
    }

    return {
        text: statementText,
        startOffset: trimmedStart,
        endOffset: trimmedEnd,
        startLine: lineOfOffset(lineStarts, trimmedStart)
    };
}

/**
 * Determines if a segment holds anything other than whitespace, comments and
 * stray semicolons.
 *
 * @param text The text of the segment.
 *
 * @returns True if there is something worth running.
 */
function hasRunnableContent(text: string): boolean {
    let index = 0;

    while (index < text.length) {
        const character = text[index];

        if (character === "-" && text[index + 1] === "-") {
            index = skipLineComment(text, index);

            continue;
        }

        if (character === "/" && text[index + 1] === "*") {
            index = skipBlockComment(text, index);

            continue;
        }

        if (!isWhitespace(character) && character !== ";") {
            return true;
        }

        index += 1;
    }

    return false;
}

/**
 * Skips a string literal or a quoted identifier.
 *
 * Single quotes, double quotes and brackets all use a doubled closing character
 * as the escape, so one routine handles all three.
 *
 * @param text The text being scanned.
 * @param index The offset of the opening character.
 *
 * @returns The offset just past the closing character, or the end of the text if the literal is unterminated.
 */
function skipQuoted(text: string, index: number): number {
    const open = text[index];
    const close = open === "[" ? "]" : open;
    let scan = index + 1;

    while (scan < text.length) {
        if (text[scan] === close) {
            if (text[scan + 1] === close) {
                scan += 2;

                continue;
            }

            return scan + 1;
        }

        scan += 1;
    }

    return text.length;
}

/**
 * Determines if an offset is the first non whitespace position of its line,
 * which is where a `GO` separator is allowed to appear.
 *
 * @param text The text being scanned.
 * @param index The offset to check.
 *
 * @returns True if only whitespace precedes the offset on its line.
 */
function isAtLineStart(text: string, index: number): boolean {
    let scan = index - 1;

    while (scan >= 0) {
        const character = text[scan];

        if (character === "\n") {
            return true;
        }

        if (character !== " " && character !== "\t" && character !== "\r") {
            return false;
        }

        scan -= 1;
    }

    return true;
}

/**
 * Matches a `GO` batch separator at an offset that starts a line.
 *
 * The word must be alone on its line, case insensitive, optionally followed by
 * a repeat count and a trailing line comment.
 *
 * @param text The text being scanned.
 * @param index The offset of the candidate `G`.
 *
 * @returns The offset just past the separator, or undefined if this is not one.
 */
function matchBatchSeparator(text: string, index: number): number | undefined {
    const first = text[index];
    const second = text[index + 1];

    if ((first !== "g" && first !== "G") || (second !== "o" && second !== "O")) {
        return undefined;
    }

    let scan = index + 2;

    if (scan < text.length && isWordPart(text[scan])) {
        return undefined;
    }

    scan = skipSpacesAndTabs(text, scan);

    while (scan < text.length && text[scan] >= "0" && text[scan] <= "9") {
        scan += 1;
    }

    scan = skipSpacesAndTabs(text, scan);

    if (text[scan] === "-" && text[scan + 1] === "-") {
        scan = skipLineComment(text, scan);
    }

    if (scan >= text.length) {
        return scan;
    }

    if (text[scan] === "\n") {
        return scan + 1;
    }

    if (text[scan] === "\r" && text[scan + 1] === "\n") {
        return scan + 2;
    }

    return undefined;
}

/**
 * Skips the spaces and tabs at an offset.
 *
 * @param text The text being scanned.
 * @param index The offset to start at.
 *
 * @returns The offset of the first character that is not a space or a tab.
 */
function skipSpacesAndTabs(text: string, index: number): number {
    let scan = index;

    while (scan < text.length && (text[scan] === " " || text[scan] === "\t")) {
        scan += 1;
    }

    return scan;
}

/**
 * Builds the offset of the first character of every line of a document.
 *
 * @param text The full text of the document.
 *
 * @returns The offsets, one per line, in line order.
 */
function buildLineStarts(text: string): number[] {
    const starts = [0];

    for (let index = 0; index < text.length; index++) {
        if (text[index] === "\n") {
            starts.push(index + 1);
        }
    }

    return starts;
}

/**
 * Finds the line that an offset falls on.
 *
 * A binary search rather than a walk from the top, because this is called once
 * per statement and a script with a statement per line would otherwise cost the
 * square of its length.
 *
 * @param lineStarts The offset of the first character of each line, in ascending order.
 * @param offset The offset to locate.
 *
 * @returns The zero based line number.
 */
function lineOfOffset(lineStarts: number[], offset: number): number {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low < high) {
        const middle = low + Math.ceil((high - low) / 2);

        if (lineStarts[middle] <= offset) {
            low = middle;
        }
        else {
            high = middle - 1;
        }
    }

    return low;
}

/**
 * Determines if a character is whitespace.
 *
 * @param character The character to check.
 *
 * @returns True if the character is whitespace.
 */
function isWhitespace(character: string): boolean {
    return character === " " || character === "\t" || character === "\r" || character === "\n" || character === "\f" || character === "\v";
}

