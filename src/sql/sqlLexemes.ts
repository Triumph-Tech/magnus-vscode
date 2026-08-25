/**
 * The lexical primitives every SQL scanner in this folder shares: what a word
 * character is, how to skip a comment, how an identifier is spelled in a regular
 * expression, and how to take an identifier's quoting back off.
 *
 * These used to be copied into `statementSplitter`, `sqlContext`,
 * `gridCommandDecisions`, `joinCompletion` and `rockCatalog`, which is how the
 * same four functions came to exist four times and the same identifier pattern
 * three times with three slightly different character classes. The scanners
 * themselves stay separate on purpose: `statementSplitter` masks bracketed
 * identifiers and `sqlContext` must not, because completion needs to see
 * `[Person]`. What is shared is only the part that cannot legitimately differ.
 *
 * Nothing here touches vscode.
 */

/**
 * The characters an identifier can start with, as a regular expression source
 * fragment without its brackets.
 */
const identifierStartClass = "[A-Za-z_@#]";

/** The characters an identifier can continue with, as a regular expression source fragment. */
const identifierPartClass = "[A-Za-z0-9_@#$]";

/**
 * A SQL identifier, bracketed or bare, as a regular expression source fragment.
 *
 * Already wrapped in a non capturing group, so it can be dropped into a larger
 * pattern as it is or wrapped in `(…)` when the match is wanted.
 */
export const sqlIdentifierPattern = `(?:\\[[^\\]]+\\]|${identifierStartClass}${identifierPartClass}*)`;

/**
 * A SQL identifier that may carry its schema, as a regular expression source
 * fragment.
 *
 * The dot lives in the character class rather than being spelled out as a
 * repeated group, which is what lets a single match cover `dbo.Person` as well
 * as `Person`. Only use this where a qualified name is wanted as one token;
 * {@link sqlIdentifierPattern} is the right one everywhere else, because a
 * pattern that swallows dots cannot tell an owner from its column.
 */
export const sqlQualifiedIdentifierPattern = `(?:\\[[^\\]]+\\]|${identifierStartClass}[A-Za-z0-9_@#$.]*)`;

/**
 * Determines if a character can begin a word.
 *
 * @param character The character to check.
 *
 * @returns True if the character can begin a word.
 */
export function isWordStart(character: string): boolean {
    return /[A-Za-z_@#]/.test(character);
}

/**
 * Determines if a character can continue a word.
 *
 * @param character The character to check.
 *
 * @returns True if the character can continue a word.
 */
export function isWordPart(character: string): boolean {
    return /[A-Za-z0-9_@#$]/.test(character);
}

/**
 * Skips a `--` line comment.
 *
 * @param text The text being scanned.
 * @param index The offset of the first dash.
 *
 * @returns The offset of the line break that ends the comment, or the end of the text.
 */
export function skipLineComment(text: string, index: number): number {
    let scan = index + 2;

    while (scan < text.length && text[scan] !== "\n") {
        scan += 1;
    }

    return scan;
}

/**
 * Skips a block comment, honoring the nesting that T-SQL allows.
 *
 * @param text The text being scanned.
 * @param index The offset of the opening slash.
 *
 * @returns The offset just past the outermost closing delimiter, or the end of the text if it is unterminated.
 */
export function skipBlockComment(text: string, index: number): number {
    let depth = 0;
    let scan = index;

    while (scan < text.length) {
        if (text[scan] === "/" && text[scan + 1] === "*") {
            depth += 1;
            scan += 2;

            continue;
        }

        if (text[scan] === "*" && text[scan + 1] === "/") {
            depth -= 1;
            scan += 2;

            if (depth === 0) {
                return scan;
            }

            continue;
        }

        scan += 1;
    }

    return text.length;
}

/**
 * Removes the brackets from an identifier, if it has any.
 *
 * This is the core of every "what is this identifier really called" question in
 * the folder: a doubled `]]` inside the brackets is an escaped `]`, so it
 * collapses back to one.
 *
 * @param name The identifier as written.
 *
 * @returns The identifier without its brackets.
 */
export function unbracketIdentifier(name: string): string {
    if (name.length >= 2 && name.startsWith("[") && name.endsWith("]")) {
        return name.substring(1, name.length - 1).replace(/]]/g, "]");
    }

    return name;
}

/**
 * Removes the brackets or the double quotes from an identifier, if it has
 * either.
 *
 * Separate from {@link unbracketIdentifier} because only some callers read text
 * that could have come from a `QUOTED_IDENTIFIER` query. Where a `"name"` is not
 * possible, accepting one would mean treating a string literal as an identifier.
 *
 * @param name The identifier as written.
 *
 * @returns The bare identifier.
 */
export function unquoteIdentifier(name: string): string {
    if (name.length >= 2 && name.startsWith("\"") && name.endsWith("\"")) {
        return name.substring(1, name.length - 1);
    }

    return unbracketIdentifier(name);
}

/**
 * Reduces a possibly qualified, possibly quoted name to the bare name of the
 * object itself.
 *
 * `[dbo].[Person]` and `dbo.Person` both come back as `Person`. A dot inside
 * brackets is not handled here, because every caller is reading a name that
 * either came from a catalog or was matched by {@link sqlIdentifierPattern}.
 *
 * @param name The name as written.
 *
 * @returns The last part of the name, without its quoting.
 */
export function bareIdentifier(name: string): string {
    const parts = name.split(".");
    const last = parts[parts.length - 1] ?? "";

    return unquoteIdentifier(last.trim());
}
