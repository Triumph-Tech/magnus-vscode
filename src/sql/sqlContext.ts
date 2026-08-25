/**
 * The pure decision logic behind SQL completion, hover and diagnostics: where a
 * cursor sits lexically, which aliases a statement declares, and which table an
 * identifier under the cursor refers to.
 *
 * Like {@link ./statementSplitter}, this is a tokenizer and not a parser. It
 * knows only the lexical constructs that can hide an identifier (string
 * literals, quoted identifiers, line and block comments) and the shape of a
 * `FROM` or `JOIN` clause. Where it cannot be sure, it says nothing: a missing
 * completion is a small annoyance, a wrong alias map produces wrong warnings.
 *
 * Why a second scanner rather than reusing the splitter's: the splitter
 * produces statement boundaries and masks bracketed identifiers along with
 * everything else, and completion has to see inside `[Person]`. The two agree on
 * the rules they share by importing them from {@link ./sqlLexemes} (doubled
 * closing character as the escape, nested block comments, unterminated
 * constructs run to the end); what differs below is only the part that has to.
 *
 * Nothing here touches vscode, so every rule is unit testable.
 */

import { isWordPart, isWordStart, skipBlockComment, skipLineComment, unbracketIdentifier } from "./sqlLexemes";

/** The kinds of text that an identifier can hide inside. */
export type NonCodeKind = "string" | "lineComment" | "blockComment";

/**
 * A span of text that is not code: a string literal, a quoted identifier that
 * uses double quotes, or a comment.
 *
 * Bracketed identifiers such as `[Group]` are deliberately not regions. They
 * are code, and both the alias map and the diagnostics need to see inside them.
 */
export type NonCodeRegion = {
    /** The offset of the first character of the region, which is its opening delimiter. */
    start: number;

    /** The offset just past the last character of the region. */
    end: number;

    /** What kind of text the region holds. */
    kind: NonCodeKind;

    /** True when the region was never closed and therefore runs to the end of the text. */
    open: boolean;
};

/** What kind of completion applies at a cursor position. */
export type CompletionContext =
    /** The cursor is inside a string or a comment, so nothing should be offered. */
    | { kind: "none" }

    /** The cursor follows `alias.`, so the columns of that alias or table apply. */
    | { kind: "afterDot"; aliasOrTable: string }

    /** The cursor is where a table name belongs, so the table list applies. */
    | { kind: "tableName" }

    /**
     * The cursor is right after a `JOIN` keyword, so whole join clauses apply as
     * well as table names.
     */
    | { kind: "joinTarget" }

    /** The cursor is somewhere else in a statement, so keywords, tables and snippets all apply. */
    | { kind: "general" };

/** The table that an identifier under the cursor refers to. */
export type TableReference = {
    /** The table name, with any schema qualifier and brackets removed. */
    tableName: string;
};

/** The keywords that introduce a table reference. */
const tableIntroducers = ["from", "join"];

/**
 * The words that may never be taken for a table alias.
 *
 * Anything that can legally follow a table reference has to be here, or
 * `FROM Person WHERE ...` would record `WHERE` as an alias for `Person`.
 */
const nonAliasWords = [
    "and",
    "apply",
    "as",
    "asc",
    "between",
    "by",
    "cross",
    "desc",
    "delete",
    "except",
    "exists",
    "for",
    "full",
    "group",
    "having",
    "in",
    "inner",
    "insert",
    "intersect",
    "into",
    "is",
    "join",
    "left",
    "not",
    "on",
    "option",
    "or",
    "order",
    "outer",
    "pivot",
    "right",
    "select",
    "set",
    "union",
    "unpivot",
    "update",
    "values",
    "where",
    "while",
    "with"
];

/**
 * The keywords that end the table list of a `FROM` clause.
 *
 * Their presence after the last `FROM` or `JOIN` is what tells
 * {@link completionContext} that the cursor is no longer in a table position.
 */
const clauseEndingWords = [
    "and",
    "by",
    "case",
    "cross",
    "delete",
    "except",
    "exists",
    "for",
    "from",
    "full",
    "group",
    "having",
    "inner",
    "insert",
    "intersect",
    "into",
    "join",
    "left",
    "on",
    "option",
    "or",
    "order",
    "outer",
    "pivot",
    "right",
    "select",
    "set",
    "union",
    "unpivot",
    "update",
    "values",
    "where",
    "while",
    "with"
];

/**
 * Finds every string, quoted identifier and comment in a piece of SQL.
 *
 * @param text The SQL text to scan.
 *
 * @returns The regions in document order.
 */
export function findNonCodeRegions(text: string): NonCodeRegion[] {
    const regions: NonCodeRegion[] = [];
    let index = 0;

    while (index < text.length) {
        const character = text[index];

        if (character === "[") {
            index = skipBracketed(text, index);

            continue;
        }

        if (character === "'" || character === "\"") {
            const end = skipQuoted(text, index);

            regions.push({
                start: index,
                end: end,
                kind: "string",
                open: end === text.length && text[end - 1] !== character
            });
            index = end;

            continue;
        }

        if (character === "-" && text[index + 1] === "-") {
            const end = skipLineComment(text, index);

            regions.push({
                start: index,
                end: end,
                kind: "lineComment",
                open: end >= text.length
            });
            index = end;

            continue;
        }

        if (character === "/" && text[index + 1] === "*") {
            const end = skipBlockComment(text, index);

            regions.push({
                start: index,
                end: end,
                kind: "blockComment",
                open: !text.substring(0, end).endsWith("*/")
            });
            index = end;

            continue;
        }

        index += 1;
    }

    return regions;
}

/**
 * Replaces every string, quoted identifier and comment with spaces, keeping
 * every offset and line break exactly where it was.
 *
 * Every rule in this module and in `rockCatalog` runs against the masked text,
 * which is how a `JOIN` inside a comment or a `.PersonAliasId` inside a string
 * literal becomes invisible without any special casing.
 *
 * @param text The SQL text to mask.
 *
 * @returns Text of the same length as the input, with non code characters replaced by spaces.
 */
export function maskNonCode(text: string): string {
    return maskRegions(text, findNonCodeRegions(text));
}

/**
 * Masks a text whose non code regions have already been found.
 *
 * Everything that runs per keystroke goes through here rather than through
 * {@link maskNonCode}, because the regions are wanted in their own right as
 * well and scanning for them twice is scanning the document twice. The masked
 * text is assembled out of the slices between the regions rather than one
 * character at a time: a document of any size is then a handful of substring
 * copies instead of an array as long as the text.
 *
 * @param text The SQL text to mask.
 * @param regions The regions of the text, as returned by {@link findNonCodeRegions}.
 *
 * @returns Text of the same length as the input, with non code characters replaced by spaces.
 */
export function maskRegions(text: string, regions: NonCodeRegion[]): string {
    if (regions.length === 0) {
        return text;
    }

    const parts: string[] = [];
    let cursor = 0;

    for (const region of regions) {
        if (region.start > cursor) {
            parts.push(text.substring(cursor, region.start));
        }

        parts.push(text.substring(region.start, region.end).replace(/[^\r\n]/g, " "));
        cursor = region.end;
    }

    if (cursor < text.length) {
        parts.push(text.substring(cursor));
    }

    return parts.join("");
}

/**
 * Everything the completion, hover and diagnostic rules want to know about one
 * version of a document, worked out once.
 *
 * The three pieces are the whole cost of understanding a SQL document, and each
 * of them used to be recomputed by every rule that needed it: a completion
 * scanned for regions, masked, and then masked again inside the alias map. Held
 * together they are computed once per document version instead.
 */
export type SqlAnalysis = {
    /** The text the analysis describes. */
    text: string;

    /** The strings, quoted identifiers and comments in the text. */
    regions: NonCodeRegion[];

    /** The text with every non code region replaced by spaces. */
    masked: string;

    /** The alias map of the text, as returned by {@link extractAliasMap}. */
    aliases: Map<string, string>;
};

/**
 * Works out everything the rules want to know about a piece of SQL.
 *
 * @param text The SQL text to analyze.
 *
 * @returns The analysis of that text.
 */
export function analyzeSql(text: string): SqlAnalysis {
    const regions = findNonCodeRegions(text);
    const masked = maskRegions(text, regions);

    return {
        text,
        regions,
        masked,
        aliases: extractAliasMapFromMasked(masked)
    };
}

/**
 * Determines if a cursor offset sits inside a string or a comment.
 *
 * The delimiters belong to the code around them: an offset on the opening quote
 * is outside, and so is an offset just past a closing quote or a closing block comment delimiter.
 * An offset at the end of a line comment or of an unterminated construct is
 * inside, because there is no closing delimiter for the cursor to have passed.
 *
 * @param regions The regions of the text, as returned by {@link findNonCodeRegions}.
 * @param offset The cursor offset.
 *
 * @returns True if completion should stay silent at that offset.
 */
export function isInNonCode(regions: NonCodeRegion[], offset: number): boolean {
    for (const region of regions) {
        if (offset <= region.start) {
            continue;
        }

        if (offset < region.end) {
            return true;
        }

        if (offset === region.end && (region.open || region.kind === "lineComment")) {
            return true;
        }
    }

    return false;
}

/**
 * Builds the alias map of a piece of SQL: every alias and bare table name that
 * a top level `FROM` or `JOIN` clause declares, keyed by its lower cased
 * spelling.
 *
 * Handles `[bracketed]` names, `schema.table` and `database.schema.table`
 * qualifiers, `AS` and aliases written without it, and comma separated table
 * lists. A table reference with no alias maps its own bare name to itself, so
 * `FROM Person` yields `person -> Person` and hover works on unaliased queries.
 *
 * Everything inside parentheses is skipped: derived tables, common table
 * expression bodies and function arguments. Their aliases are real, but their
 * scope is not something a tokenizer can work out, and a wrong alias map is
 * worse than a short one.
 *
 * @param sqlText The SQL text to scan.
 *
 * @returns A map of lower cased alias or bare table name to the table name as written.
 */
export function extractAliasMap(sqlText: string): Map<string, string> {
    return extractAliasMapFromMasked(maskNonCode(sqlText));
}

/**
 * Builds the alias map of a piece of SQL that has already been masked.
 *
 * @param masked The masked SQL text, as returned by {@link maskNonCode}.
 *
 * @returns A map of lower cased alias or bare table name to the table name as written.
 */
export function extractAliasMapFromMasked(masked: string): Map<string, string> {
    const aliases = new Map<string, string>();
    let depth = 0;
    let index = 0;

    while (index < masked.length) {
        const character = masked[index];

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

        if (character === "[") {
            index = skipBracketed(masked, index);

            continue;
        }

        if (!isWordStart(character)) {
            index += 1;

            continue;
        }

        const word = readWord(masked, index);

        index = word.end;

        if (depth > 0 || tableIntroducers.indexOf(word.text.toLowerCase()) < 0) {
            continue;
        }

        index = readTableList(masked, index, aliases);
    }

    return aliases;
}

/**
 * Lists the distinct tables an alias map names, in the order they appeared.
 *
 * The order is the map's own insertion order, which {@link extractAliasMap}
 * fills in document order. A table named twice, whether under two aliases or in
 * two clauses, appears once, matched case insensitively and spelled the way it
 * was written the first time.
 *
 * @param aliases The alias map of the statement, as returned by {@link extractAliasMap}.
 *
 * @returns The table names in the order they appeared, without repeats.
 */
export function distinctTablesInOrder(aliases: Map<string, string>): string[] {
    const tables: string[] = [];
    const seen = new Set<string>();

    for (const tableName of aliases.values()) {
        const key = tableName.toLowerCase();

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        tables.push(tableName);
    }

    return tables;
}

/**
 * Finds the one table a statement has in scope, for the completions that only
 * make sense when there is exactly one.
 *
 * The rule is deliberately about the number of table *references*, not the
 * number of distinct table names: an alias map with exactly one entry means the
 * query reads exactly one table, so an unqualified column of it is unambiguous.
 * Anything else yields null, including a self join such as
 * `FROM Person p JOIN Person q`, where the two entries name the same table but an
 * unqualified column would be an error in the query. Zero entries yields null
 * too: there is nothing to guess from, and guessing is worse than staying quiet.
 *
 * Because {@link extractAliasMap} skips everything inside parentheses, a table
 * that only appears in a derived table or a common table expression body is not
 * in scope here either, which is the conservative answer.
 *
 * @param aliases The alias map of the statement, as returned by {@link extractAliasMap}.
 *
 * @returns The table name as written, or null when the statement does not resolve to exactly one table.
 */
export function soleTableInScope(aliases: Map<string, string>): string | null {
    if (aliases.size !== 1) {
        return null;
    }

    for (const tableName of aliases.values()) {
        return tableName;
    }

    return null;
}

/**
 * Decides what kind of completion applies at a cursor position.
 *
 * @param text The full text of the document.
 * @param offset The cursor offset.
 *
 * @returns The completion context at that offset.
 */
export function completionContext(text: string, offset: number): CompletionContext {
    return completionContextIn(analyzeSql(text), offset);
}

/**
 * Decides what kind of completion applies at a cursor position of a document
 * that has already been analyzed.
 *
 * @param analysis The analysis of the document.
 * @param offset The cursor offset.
 *
 * @returns The completion context at that offset.
 */
export function completionContextIn(analysis: SqlAnalysis, offset: number): CompletionContext {
    const { text, regions, masked } = analysis;
    const clamped = Math.max(0, Math.min(offset, text.length));

    if (isInNonCode(regions, clamped)) {
        return { kind: "none" };
    }

    const wordStart = startOfWordAt(masked, clamped);
    const beforeWord = masked.substring(0, wordStart);

    if (beforeWord.endsWith(".")) {
        const owner = identifierEndingAt(masked, beforeWord.length - 1);

        if (owner) {
            return { kind: "afterDot", aliasOrTable: owner };
        }

        return { kind: "general" };
    }

    if (isTablePosition(beforeWord)) {
        if (isJoinTargetPosition(beforeWord)) {
            return { kind: "joinTarget" };
        }

        return { kind: "tableName" };
    }

    return { kind: "general" };
}

/**
 * Finds the table that the identifier under the cursor refers to, for hover.
 *
 * An alias resolves through {@link extractAliasMap}. A bare or schema qualified
 * name resolves to itself. A column reference resolves to nothing: in `p.Name`
 * with the cursor on `Name`, the owner `p` is a known alias, so `Name` is a
 * column and not a table. In `dbo.Person` the owner is not a known alias, so
 * `Person` is taken as the table.
 *
 * @param text The full text of the document.
 * @param offset The cursor offset.
 *
 * @returns The table reference under the cursor, or null if there is not one.
 */
export function tableNameAt(text: string, offset: number): TableReference | null {
    return tableNameIn(analyzeSql(text), offset);
}

/**
 * Finds the table that the identifier under the cursor refers to, in a document
 * that has already been analyzed.
 *
 * @param analysis The analysis of the document.
 * @param offset The cursor offset.
 *
 * @returns The table reference under the cursor, or null if there is not one.
 */
export function tableNameIn(analysis: SqlAnalysis, offset: number): TableReference | null {
    const { text, regions, masked, aliases } = analysis;
    const clamped = Math.max(0, Math.min(offset, text.length));

    if (isInNonCode(regions, clamped)) {
        return null;
    }

    const identifier = identifierAt(masked, clamped);

    if (!identifier) {
        return null;
    }

    const resolved = aliases.get(identifier.text.toLowerCase());

    if (resolved) {
        return { tableName: unbracketIdentifier(resolved) };
    }

    const owner = precedingOwner(masked, identifier.start);

    if (owner && aliases.has(owner.toLowerCase())) {
        return null;
    }

    return { tableName: unbracketIdentifier(identifier.text) };
}

/**
 * Determines whether the text before a partial word puts the cursor where a
 * table name belongs.
 *
 * The test is deliberately narrow: there has to be a `FROM` or `JOIN` before
 * the cursor, and what follows it has to be either nothing or a table list that
 * ends in a comma. Any clause keyword in between means the table list is over.
 *
 * @param beforeWord The masked text before the word being typed.
 *
 * @returns True if the table list applies at the cursor.
 */
function isTablePosition(beforeWord: string): boolean {
    const introducer = lastIntroducer(beforeWord);

    if (introducer < 0) {
        return false;
    }

    const remainder = beforeWord.substring(introducer).trimEnd();

    if (remainder.length > 0 && !remainder.endsWith(",")) {
        return false;
    }

    for (const word of wordsOf(remainder)) {
        if (clauseEndingWords.indexOf(word.toLowerCase()) >= 0) {
            return false;
        }
    }

    return true;
}

/**
 * Determines whether a table position is specifically the target of a `JOIN`.
 *
 * Called only for a position {@link isTablePosition} has already accepted, so
 * the question left is which keyword opened it. Three rules narrow it down:
 *
 * - The last introducer has to be `JOIN` rather than `FROM`. That covers the
 *   whole family, because `INNER`, `LEFT OUTER`, `RIGHT` and `FULL` are all just
 *   words in front of the same keyword.
 * - `CROSS JOIN` is excluded. It takes no `ON` clause, so a generated join
 *   clause would not even parse there; a plain table name is the right offer.
 *   `CROSS APPLY` never reaches here at all, since it is not an introducer.
 * - Nothing may follow the keyword but whitespace. `isTablePosition` also accepts
 *   a table list ending in a comma, and a comma separated list after a `JOIN` is
 *   past the point where one clause can be inserted, so those stay `tableName`.
 *
 * A partial identifier being typed is invisible here, because the caller passes
 * the text before the word under the cursor. `JOIN Att` and `JOIN ` are the same
 * position.
 *
 * @param beforeWord The masked text before the word being typed.
 *
 * @returns True if a whole join clause can be inserted at the cursor.
 */
function isJoinTargetPosition(beforeWord: string): boolean {
    const pattern = /\b(from|join)\b/gi;
    let last: RegExpExecArray | null = null;
    let match = pattern.exec(beforeWord);

    while (match) {
        last = match;
        match = pattern.exec(beforeWord);
    }

    if (!last || last[1].toLowerCase() !== "join") {
        return false;
    }

    if (beforeWord.substring(last.index + last[0].length).trim().length > 0) {
        return false;
    }

    const words = wordsOf(beforeWord.substring(0, last.index));

    return (words[words.length - 1] ?? "").toLowerCase() !== "cross";
}

/**
 * Finds the offset just past the last `FROM` or `JOIN` keyword in a piece of
 * masked text.
 *
 * @param masked The masked text to search.
 *
 * @returns The offset just past the keyword, or -1 if there is none.
 */
function lastIntroducer(masked: string): number {
    const pattern = /\b(from|join)\b/gi;
    let found = -1;
    let match = pattern.exec(masked);

    while (match) {
        found = match.index + match[0].length;
        match = pattern.exec(masked);
    }

    return found;
}

/**
 * Reads the comma separated table references that follow a `FROM` or `JOIN`
 * keyword, recording each alias.
 *
 * @param masked The masked SQL text.
 * @param index The offset just past the introducing keyword.
 * @param aliases The map to record aliases in.
 *
 * @returns The offset to continue scanning from.
 */
function readTableList(masked: string, index: number, aliases: Map<string, string>): number {
    let scan = index;

    for (;;) {
        scan = skipSpaces(masked, scan);

        if (masked[scan] === "(") {
            return scan;
        }

        const table = readQualifiedName(masked, scan);

        if (!table) {
            return scan;
        }

        scan = table.end;

        const afterTable = skipSpaces(masked, scan);

        if (masked[afterTable] === "(") {
            return afterTable;
        }

        const alias = readAlias(masked, afterTable);

        if (alias) {
            aliases.set(alias.text.toLowerCase(), table.text);
            scan = alias.end;
        }
        else {
            aliases.set(table.text.toLowerCase(), table.text);
        }

        const afterAlias = skipSpaces(masked, scan);

        if (masked[afterAlias] !== ",") {
            return scan;
        }

        scan = afterAlias + 1;
    }
}

/**
 * Reads a possibly qualified, possibly bracketed table name.
 *
 * The last part of the qualifier is the table, so `Rock.dbo.[Group]` reads as
 * `Group`.
 *
 * @param masked The masked SQL text.
 * @param index The offset of the first character of the name.
 *
 * @returns The table name and the offset just past it, or null if there is no name there.
 */
function readQualifiedName(masked: string, index: number): { text: string; end: number } | null {
    let scan = index;
    let last: string | undefined;

    for (;;) {
        const part = readNamePart(masked, scan);

        if (!part) {
            return last === undefined ? null : { text: unbracketIdentifier(last), end: scan };
        }

        last = part.text;
        scan = part.end;

        if (masked[scan] !== ".") {
            return { text: unbracketIdentifier(last), end: scan };
        }

        scan += 1;
    }
}

/**
 * Reads one part of a qualified name: either a bracketed identifier or a word.
 *
 * @param masked The masked SQL text.
 * @param index The offset to read at.
 *
 * @returns The part and the offset just past it, or null if there is not one there.
 */
function readNamePart(masked: string, index: number): { text: string; end: number } | null {
    if (masked[index] === "[") {
        const end = skipBracketed(masked, index);

        return { text: masked.substring(index, end), end: end };
    }

    if (index < masked.length && isWordStart(masked[index])) {
        const word = readWord(masked, index);

        return { text: word.text, end: word.end };
    }

    return null;
}

/**
 * Reads the alias of a table reference, with or without the `AS` keyword.
 *
 * @param masked The masked SQL text.
 * @param index The offset just past the table name.
 *
 * @returns The alias and the offset just past it, or null if the reference has no alias.
 */
function readAlias(masked: string, index: number): { text: string; end: number } | null {
    let scan = index;
    const first = readNamePart(masked, scan);

    if (!first) {
        return null;
    }

    if (first.text.toLowerCase() === "as") {
        scan = skipSpaces(masked, first.end);

        const named = readNamePart(masked, scan);

        if (!named || nonAliasWords.indexOf(named.text.toLowerCase()) >= 0) {
            return null;
        }

        return { text: unbracketIdentifier(named.text), end: named.end };
    }

    if (nonAliasWords.indexOf(first.text.toLowerCase()) >= 0) {
        return null;
    }

    if (masked[first.end] === ".") {
        return null;
    }

    return { text: unbracketIdentifier(first.text), end: first.end };
}

/**
 * Finds the identifier that an offset falls in or immediately after.
 *
 * @param masked The masked SQL text.
 * @param offset The cursor offset.
 *
 * @returns The identifier and its start offset, or null if the cursor is not on one.
 */
function identifierAt(masked: string, offset: number): { text: string; start: number } | null {
    const bracketed = bracketedIdentifierAt(masked, offset);

    if (bracketed) {
        return bracketed;
    }

    const start = startOfWordAt(masked, offset);
    let end = offset;

    while (end < masked.length && isWordPart(masked[end])) {
        end += 1;
    }

    if (start >= end || !isWordStart(masked[start])) {
        return null;
    }

    return { text: masked.substring(start, end), start: start };
}

/**
 * Finds the bracketed identifier that an offset falls inside.
 *
 * @param masked The masked SQL text.
 * @param offset The cursor offset.
 *
 * @returns The identifier and its start offset, or null if the cursor is not inside one.
 */
function bracketedIdentifierAt(masked: string, offset: number): { text: string; start: number } | null {
    const open = masked.lastIndexOf("[", Math.max(0, offset - 1));

    if (open < 0) {
        return null;
    }

    const end = skipBracketed(masked, open);

    if (offset > open && offset < end) {
        return { text: masked.substring(open, end), start: open };
    }

    return null;
}

/**
 * Finds the identifier that owns a dotted reference, given the offset of the
 * owned part.
 *
 * @param masked The masked SQL text.
 * @param start The offset of the first character of the owned identifier.
 *
 * @returns The owner identifier, or undefined if the reference is not dotted.
 */
function precedingOwner(masked: string, start: number): string | undefined {
    if (start === 0 || masked[start - 1] !== ".") {
        return undefined;
    }

    return identifierEndingAt(masked, start - 1);
}

/**
 * Reads the identifier that ends immediately before an offset.
 *
 * @param masked The masked SQL text.
 * @param end The offset just past the last character of the identifier.
 *
 * @returns The identifier without its brackets, or undefined if there is not one there.
 */
function identifierEndingAt(masked: string, end: number): string | undefined {
    if (masked[end - 1] === "]") {
        const open = masked.lastIndexOf("[", end - 1);

        if (open < 0) {
            return undefined;
        }

        return unbracketIdentifier(masked.substring(open, end));
    }

    let start = end;

    while (start > 0 && isWordPart(masked[start - 1])) {
        start -= 1;
    }

    if (start >= end) {
        return undefined;
    }

    return masked.substring(start, end);
}

/**
 * Finds the start of the word that an offset falls in or immediately after.
 *
 * @param masked The masked SQL text.
 * @param offset The cursor offset.
 *
 * @returns The offset of the first character of the word, or the offset itself if there is no word.
 */
function startOfWordAt(masked: string, offset: number): number {
    let start = offset;

    while (start > 0 && isWordPart(masked[start - 1])) {
        start -= 1;
    }

    return start;
}

/**
 * Collects the words of a piece of masked text.
 *
 * @param masked The masked text.
 *
 * @returns The words in the order they appear.
 */
function wordsOf(masked: string): string[] {
    return masked.match(/[A-Za-z_@#][A-Za-z0-9_@#$]*/g) ?? [];
}

/**
 * Reads the word at an offset.
 *
 * @param masked The masked text.
 * @param index The offset of the first character of the word.
 *
 * @returns The word and the offset just past it.
 */
function readWord(masked: string, index: number): { text: string; end: number } {
    let end = index;

    while (end < masked.length && isWordPart(masked[end])) {
        end += 1;
    }

    return { text: masked.substring(index, end), end: end };
}

/**
 * Skips the spaces, tabs and line breaks at an offset.
 *
 * @param text The text being scanned.
 * @param index The offset to start at.
 *
 * @returns The offset of the first character that is not whitespace.
 */
function skipSpaces(text: string, index: number): number {
    let scan = index;

    while (scan < text.length && /\s/.test(text[scan])) {
        scan += 1;
    }

    return scan;
}

/**
 * Skips a bracketed identifier, honoring the doubled `]]` escape.
 *
 * @param text The text being scanned.
 * @param index The offset of the opening bracket.
 *
 * @returns The offset just past the closing bracket, or the end of the text if it is unterminated.
 */
function skipBracketed(text: string, index: number): number {
    let scan = index + 1;

    while (scan < text.length) {
        if (text[scan] === "]") {
            if (text[scan + 1] === "]") {
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
 * Skips a string literal or a double quoted identifier, honoring the doubled
 * quote escape.
 *
 * @param text The text being scanned.
 * @param index The offset of the opening quote.
 *
 * @returns The offset just past the closing quote, or the end of the text if it is unterminated.
 */
function skipQuoted(text: string, index: number): number {
    const quote = text[index];
    let scan = index + 1;

    while (scan < text.length) {
        if (text[scan] === quote) {
            if (text[scan + 1] === quote) {
                scan += 2;

                continue;
            }

            return scan + 1;
        }

        scan += 1;
    }

    return text.length;
}

