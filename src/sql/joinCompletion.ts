/**
 * The rules that turn "the cursor is right after a JOIN" into whole join clauses
 * ready to insert.
 *
 * This is where the Rock join convention is offered now. It used to live in the
 * column list after `alias.`, on the theory that a `*Id` column is the moment the
 * convention matters. Feedback was that it made the column list worse for its
 * actual purpose: you type `a.` to pick a column, and a handful of multi-line
 * `INNER JOIN` clauses sitting in that list are noise at best, and at worst get
 * accepted by accident in the middle of a `SELECT` list. A join belongs where a
 * join is being written, so that is where it is offered.
 *
 * Everything here is pure: an alias map, whatever column lists happen to be
 * cached, and the static catalog go in, and a list of completions comes out.
 *
 * Nothing here touches vscode.
 */

import type { SqlCompletionItem } from "./completionItems";
import { curatedForeignKeyColumns, suggestJoin } from "./rockCatalog";
import { bareIdentifier, sqlQualifiedIdentifierPattern } from "./sqlLexemes";

/**
 * The sort tier a join clause goes in, which `completionItems` publishes as
 * `sortTiers.joinClause`.
 *
 * It lives here rather than there so that the dependency runs one way: the item
 * builders know about the join builder, and the join builder knows nothing about
 * them beyond the shape of an item.
 */
export const joinClauseSortTier = "2";

/** One table reference a statement already has, as the join builder needs it. */
export type InScopeTable = {
    /** The alias the statement gave the table, or its bare name when it has none. */
    alias: string;

    /** The table name as written. */
    tableName: string;
};

/** The column lists that are on hand, keyed by lower cased table name. */
export type CachedColumnsByTable = Record<string, string[] | undefined>;

/** One hop of a join path, parsed back out of a generated snippet. */
type JoinHop = {
    /** The table being joined, spelled the way it should be written. */
    table: string;

    /** The alias the hop gives that table. */
    alias: string;

    /** Everything after the `ON`, including any trailing comment. */
    condition: string;
};

/**
 * Turns an alias map into the table references the join builder walks.
 *
 * The alias comes from the map's key, which is lower cased. That is deliberate
 * and harmless: T-SQL identifiers are case insensitive, so a clause written
 * against `att` resolves against a table declared as `Att`. Taking the key also
 * means an unaliased `FROM Person` contributes `person` as its own alias, which
 * is exactly how the query has to refer to it.
 *
 * @param aliases The alias map of the statement, as returned by `extractAliasMap`.
 *
 * @returns One entry per table reference, in the order they appeared.
 */
export function inScopeTables(aliases: Map<string, string>): InScopeTable[] {
    const tables: InScopeTable[] = [];

    for (const [alias, tableName] of aliases) {
        tables.push({ alias: alias, tableName: tableName });
    }

    return tables;
}

/**
 * Picks an alias for a newly joined table that nothing in the statement is using.
 *
 * The preferred alias is the conventional short one the catalog already wrote
 * into the join path (`pa` for `PersonAlias`, `dv` for `DefinedValue`), because
 * matching what Rock's own documentation and every other Rock query uses is worth
 * more than novelty. Only when it is taken does a number get appended, and the
 * numbering starts at 2 so the second `PersonAlias` in a statement is `pa2`.
 *
 * @param preferred The conventional alias for the table.
 * @param taken The aliases already in use, in any casing.
 *
 * @returns An alias that {@link taken} does not hold, matched case insensitively because T-SQL identifiers are.
 */
export function freshAlias(preferred: string, taken: Set<string>): string {
    const base = preferred.length > 0 ? preferred : "t";
    const claimed = new Set<string>([...taken].map(alias => alias.toLowerCase()));

    if (!claimed.has(base.toLowerCase())) {
        return base;
    }

    for (let suffix = 2; ; suffix++) {
        const candidate = `${base}${suffix}`;

        if (!claimed.has(candidate.toLowerCase())) {
            return candidate;
        }
    }
}

/**
 * Builds the join clauses to offer at a `joinTarget` position.
 *
 * One item per foreign key column of every table the statement already has in
 * scope, plus a second item for each of the curated two hop paths. The insert
 * text never repeats the `JOIN` keyword, because the cursor is already past the
 * one the user typed.
 *
 * Where a column list comes from matters to how good the list is, not to how it
 * is built: a real one from the object explorer cache when there is one, and the
 * catalog's curated foreign keys when there is not. An empty cached list counts
 * as no list, since a table with no columns is not a thing.
 *
 * @param aliases The alias map of the statement so far.
 * @param columnsByTable The column lists on hand, keyed by lower cased table name.
 *
 * @returns The clauses to offer, which is empty when nothing in scope has a joinable column.
 */
export function buildJoinClauseCompletions(aliases: Map<string, string>, columnsByTable: CachedColumnsByTable): SqlCompletionItem[] {
    const tables = inScopeTables(aliases);
    const taken = new Set<string>();
    const items: SqlCompletionItem[] = [];

    for (const table of tables) {
        taken.add(table.alias.toLowerCase());
    }

    for (let index = 0; index < tables.length; index++) {
        const table = tables[index];
        const cached = columnsByTable[table.tableName.toLowerCase()];
        const columns = cached && cached.length > 0 ? cached : curatedForeignKeyColumns(table.tableName);

        for (const column of columns) {
            items.push(...clausesForColumn(table, column, index, taken));
        }
    }

    return items;
}

/**
 * Builds the one or two clauses that one foreign key column contributes.
 *
 * @param table The in scope table that owns the column.
 * @param column The column name.
 * @param tableIndex The position of the table in the statement, which orders the list.
 * @param taken The aliases already in use, which this does not modify.
 *
 * @returns The clauses, or an empty array when the column has no canonical join.
 */
function clausesForColumn(table: InScopeTable, column: string, tableIndex: number, taken: Set<string>): SqlCompletionItem[] {
    if (!/Id$/i.test(column)) {
        return [];
    }

    const suggestion = suggestJoin(column, table.alias);

    if (!suggestion) {
        return [];
    }

    const hops = parseHops(suggestion.snippet, taken);

    if (hops.length === 0) {
        return [];
    }

    const first = hops[0];
    const order = `${joinClauseSortTier}${String(tableIndex).padStart(2, "0")}${column.toLowerCase()}`;
    const items: SqlCompletionItem[] = [];

    if (hops.length > 1) {
        // The fuller path first. For PersonAliasId, reaching Person is what
        // someone is nearly always after, and having to accept two completions in
        // a row to get there is the thing this feature exists to remove.
        const last = hops[hops.length - 1];

        items.push({
            label: `${bareIdentifier(first.table)} → ${bareIdentifier(last.table)} (via ${table.alias}.${column})`,
            kind: "snippet",
            detail: `Both hops from ${table.alias}.${column}`,
            documentation: `${suggestion.explanation}\n\nThe hop after the first carries its own INNER JOIN, since only one JOIN keyword has been typed. It is always spelled INNER JOIN, whatever kind of join it is being added to: an outer join to the first table almost never means the second one should be outer too.`,
            insertText: hops.map((hop, position) => writeHop(hop, position)).join("\n"),
            isSnippet: false,
            filterText: `${hops.map(hop => bareIdentifier(hop.table)).join(" ")} ${column}`,
            sortText: `${order}a`
        });
    }

    items.push({
        label: `${bareIdentifier(first.table)} ON …${column}`,
        kind: "snippet",
        detail: `${table.alias}.${column} → ${bareIdentifier(first.table)}.Id`,
        documentation: suggestion.explanation,
        insertText: writeHop(first, 0),
        isSnippet: false,
        filterText: `${bareIdentifier(first.table)} ${column}`,
        sortText: `${order}b`
    });

    return items;
}

/**
 * Reads a generated join snippet back into its hops, giving each one an alias
 * that the statement is not already using.
 *
 * Re-parsing text this module's own dependency just generated looks roundabout,
 * and the alternative was worse: the catalog's join paths are the documented,
 * copy-pasteable form of Rock's conventions, and splitting them into structured
 * hops would mean maintaining the same knowledge twice, once for the hover and
 * the diagnostic and once for this. A line that does not parse is skipped rather
 * than guessed at.
 *
 * @param snippet The snippet from `suggestJoin`, one hop per line.
 * @param taken The aliases already in use. Not modified; collisions are resolved against a copy.
 *
 * @returns The hops with fresh aliases, or an empty array if any line was not a join clause.
 */
function parseHops(snippet: string, taken: Set<string>): JoinHop[] {
    // The table of a generated hop can carry its schema, so this is the one
    // place that wants the pattern that swallows dots.
    const clause = new RegExp(`^INNER JOIN\\s+(${sqlQualifiedIdentifierPattern})\\s+([A-Za-z_][A-Za-z0-9_]*)\\s+ON\\s+([\\s\\S]+)$`);
    const claimed = new Set<string>(taken);
    const renames = new Map<string, string>();
    const parsed: JoinHop[] = [];

    for (const line of snippet.split("\n")) {
        const match = clause.exec(line.trim());

        if (!match) {
            return [];
        }

        const alias = freshAlias(match[2], claimed);

        claimed.add(alias.toLowerCase());

        if (alias !== match[2]) {
            renames.set(match[2], alias);
        }

        parsed.push({ table: match[1], alias: alias, condition: match[3] });
    }

    return parsed.map(hop => ({
        table: hop.table,
        alias: hop.alias,
        condition: applyRenames(hop.condition, renames)
    }));
}

/**
 * Rewrites the aliases a join condition refers to, all in one pass so that a
 * rename can never be renamed again.
 *
 * @param condition The condition text.
 * @param renames The aliases that changed, keyed by their original spelling.
 *
 * @returns The condition, with every renamed alias updated.
 */
function applyRenames(condition: string, renames: Map<string, string>): string {
    if (renames.size === 0) {
        return condition;
    }

    const pattern = new RegExp(`\\b(${[...renames.keys()].join("|")})\\b`, "g");

    return condition.replace(pattern, matched => renames.get(matched) ?? matched);
}

/**
 * Writes one hop as the text to insert.
 *
 * @param hop The hop.
 * @param position Its position in the chain. The first hop follows the `JOIN` keyword the user typed, so it does not carry one.
 *
 * @returns The clause text.
 */
function writeHop(hop: JoinHop, position: number): string {
    const clause = `${hop.table} ${hop.alias} ON ${hop.condition}`;

    return position === 0 ? clause : `INNER JOIN ${clause}`;
}
