/**
 * The rules that turn a cursor context plus whatever data is on hand into the
 * list of completions to offer.
 *
 * The provider that wraps this module owns everything vscode: reading the
 * document, resolving the bound server, asking the object explorer for columns
 * and turning each item below into a `vscode.CompletionItem`. The decisions
 * about what is offered, how it is spelled and what order it comes in all live
 * here, so they are unit testable without a server or an editor.
 *
 * Nothing here touches vscode.
 */

import { CompletionContext } from "./sqlContext";
import { rockTables, writeTableName } from "./rockCatalog";
import { buildJoinClauseCompletions, CachedColumnsByTable, joinClauseSortTier } from "./joinCompletion";
import { bareIdentifier } from "./sqlLexemes";

/** The kind of thing a completion stands for, mapped to a vscode kind by the provider. */
export type SqlCompletionKind = "column" | "table" | "snippet";

/**
 * Everything the provider was able to gather for one completion request.
 *
 * Every field is optional, because every one of them can be missing for reasons
 * that are not worth interrupting typing over: an unbound document, a server that
 * is down, a table nobody has looked at yet. {@link buildCompletions} decides what
 * a context can still offer without each of them.
 */
export type CompletionData = {
    /** The columns of the one table an `afterDot` or `general` context resolved to. */
    columns?: string[];

    /** The table names cached for the bound server. */
    liveTableNames?: string[];

    /** The alias map of the statement, for a `joinTarget` context. */
    aliases?: Map<string, string>;

    /** The column lists on hand for the tables in scope, keyed by lower cased table name. */
    columnsByTable?: CachedColumnsByTable;
};

/** One completion to offer, in the shape the provider needs to build a vscode item. */
export type SqlCompletionItem = {
    /** The text shown in the list. */
    label: string;

    /** What the item stands for. */
    kind: SqlCompletionKind;

    /** The one line shown beside the label, if any. */
    detail?: string;

    /** The longer explanation shown in the details pane, if any. */
    documentation?: string;

    /** The text to insert. A snippet body when {@link isSnippet} is true. */
    insertText: string;

    /** True when {@link insertText} is a snippet body rather than plain text. */
    isSnippet: boolean;

    /**
     * The text vscode matches what is being typed against, when the label is not
     * the right thing to match. Left undefined by everything whose label is the
     * identifier it inserts.
     */
    filterText?: string;

    /** The value vscode sorts on, which is what puts the tiers in order. */
    sortText: string;
};

/**
 * The sort tiers, lowest first.
 *
 * Sorting is done by a leading digit rather than by relying on vscode's own
 * ranking, because the ranking treats every item of the same kind alike and we
 * want generated join clauses above bare table names, and live table names above
 * the static catalog, when the cursor is after a `JOIN`. A single digit is
 * enough: nothing here needs more than a handful of tiers.
 *
 * The tiers do not all appear in one list. A column list and a join clause list
 * are never offered at the same position, which is the point of the redesign that
 * moved join clauses out of the column list.
 */
export const sortTiers = {
    /** A real column of the table under the cursor. */
    column: "1",

    /** A generated join clause, where a join target belongs. */
    joinClause: joinClauseSortTier,

    /** A table of the static Rock catalog, where a table name belongs. */
    catalogTableInTablePosition: "3",

    /** A table that actually exists on the bound server, where a table name belongs. */
    liveTableInTablePosition: "4"
};

/**
 * Builds the completions for the columns of one table.
 *
 * Columns and nothing else. This used to append a generated join clause for every
 * foreign key column, which is how the Rock join convention was surfaced. It is
 * now offered after a `JOIN` keyword instead (see {@link ./joinCompletion}),
 * because a column list is where someone goes to pick a column: multi-line
 * `INNER JOIN` clauses in it were noise, and accepting one by accident dropped a
 * join clause into the middle of a `SELECT` list.
 *
 * @param columns The column names of the table, in the order the server reported them.
 *
 * @returns The completions to offer.
 */
export function buildColumnCompletions(columns: string[]): SqlCompletionItem[] {
    return columns.map(column => ({
        label: column,
        kind: "column" as SqlCompletionKind,
        insertText: column,
        isSnippet: false,
        sortText: `${sortTiers.column}${column.toLowerCase()}`
    }));
}

/**
 * Builds the completions for a position where a table name belongs.
 *
 * Both lists are offered: the static catalog, because it carries the one line
 * of what each table is for, and whatever the object explorer has already
 * loaded for the bound server, because a Rock install has plenty of tables the
 * catalog does not name. A table in both lists appears once, described by the
 * catalog.
 *
 * @param liveTableNames The table names already cached for the bound server, if any.
 *
 * @returns The completions to offer, the catalog first.
 */
export function buildTableCompletions(liveTableNames: string[]): SqlCompletionItem[] {
    const items: SqlCompletionItem[] = [];
    const seen = new Set<string>();

    for (const table of rockTables) {
        seen.add(table.name.toLowerCase());

        items.push({
            label: table.name,
            kind: "table",
            detail: table.description,
            insertText: writeTableName(table.name),
            isSnippet: false,
            sortText: `${sortTiers.catalogTableInTablePosition}${table.name.toLowerCase()}`
        });
    }

    for (const name of liveTableNames) {
        const bare = bareIdentifier(name);

        if (bare.length === 0 || seen.has(bare.toLowerCase())) {
            continue;
        }

        seen.add(bare.toLowerCase());

        items.push({
            label: bare,
            kind: "table",
            detail: "On this server",
            insertText: writeTableName(bare),
            isSnippet: false,
            sortText: `${sortTiers.liveTableInTablePosition}${bare.toLowerCase()}`
        });
    }

    return items;
}

/**
 * Builds the completions for a position that is inside a statement but is not a
 * table name or a column reference, given the one table the statement has in
 * scope.
 *
 * Columns only: no generated joins. Inserting a whole `INNER JOIN` clause into
 * the middle of a `SELECT` list would be wrong.
 *
 * On the space trigger character: a space right after `SELECT` does pop this
 * list unfiltered, and that is deliberate. It can only happen when the statement
 * resolves to exactly one table, so every item in it is a column of the table
 * the query is already reading; vscode narrows the list as soon as a character is
 * typed. The alternative, requiring an explicit Ctrl+Space, would hide the
 * feature from the people it was added for.
 *
 * @param columns The column names of the table in scope, in the order the server reported them.
 *
 * @returns The completions to offer.
 */
export function buildSingleTableColumnCompletions(columns: string[]): SqlCompletionItem[] {
    return buildColumnCompletions(columns);
}

/**
 * Builds the completions for a cursor context.
 *
 * This is the whole decision in one place: which of the builders above applies,
 * and what happens when the data a context wants is not there. An `afterDot`
 * context with no columns yields nothing rather than falling back to the table
 * list, because offering table names after `a.` is noise.
 *
 * Table names are offered in the `tableName` context and nowhere else. They used
 * to be offered in the `general` context too, at a tier below everything else,
 * on the theory that a table name is occasionally what you want in the middle of
 * a `WHERE` clause. User feedback was that it fired everywhere and was noise; a
 * table name now only appears where a table name can go.
 *
 * A `general` context offers the columns of the single table the statement has in
 * scope, and offers nothing at all when the statement has none or several. See
 * {@link soleTableInScope} for that rule.
 *
 * A `joinTarget` context offers both lists: the join clauses the statement's own
 * tables imply, then plain table names. The clauses come first because they are
 * the contextual answer, and the table names are still there because plenty of
 * joins go somewhere the catalog has never heard of.
 *
 * @param context The context the cursor is in.
 * @param data The data the provider was able to gather without failing.
 *
 * @returns The completions to offer, which may be empty.
 */
export function buildCompletions(context: CompletionContext, data: CompletionData): SqlCompletionItem[] {
    if (context.kind === "none") {
        return [];
    }

    if (context.kind === "afterDot") {
        if (!data.columns || data.columns.length === 0) {
            return [];
        }

        return buildColumnCompletions(data.columns);
    }

    if (context.kind === "joinTarget") {
        return [
            ...buildJoinClauseCompletions(data.aliases ?? new Map<string, string>(), data.columnsByTable ?? {}),
            ...buildTableCompletions(data.liveTableNames ?? [])
        ];
    }

    if (context.kind === "tableName") {
        return buildTableCompletions(data.liveTableNames ?? []);
    }

    if (!data.columns || data.columns.length === 0) {
        return [];
    }

    return buildSingleTableColumnCompletions(data.columns);
}
