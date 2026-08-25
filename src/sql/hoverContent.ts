/**
 * The markdown of the hover that a table name in a SQL editor gets.
 *
 * Two things can be known about a table, and either one on its own is worth
 * showing: what the table is for, which comes from the static Rock catalog, and
 * what columns it has, which comes from whatever the object explorer already
 * cached for the bound server. Neither is fetched for a hover, so this module
 * has to render gracefully when it is given only one of them, or neither.
 *
 * Nothing here touches vscode.
 */

import { findRockTable } from "./rockCatalog";

/**
 * Builds the markdown of a table hover.
 *
 * Every column is listed. The list used to be capped at 30 with an "and N more"
 * line, on the theory that a hover covering the query was worse than one that
 * stopped short; the cap turned out to hide exactly what people opened the hover
 * for on the wide tables where it mattered most, and a vscode hover scrolls.
 *
 * @param tableName The table name as written in the query.
 * @param columns The cached column names of that table, or undefined when none are cached.
 *
 * @returns The markdown to show, or null when nothing is known about the table.
 */
export function buildTableHover(tableName: string, columns?: string[]): string | null {
    const table = findRockTable(tableName);
    const hasColumns = columns !== undefined && columns.length > 0;

    if (!table && !hasColumns) {
        return null;
    }

    const lines: string[] = [`**${table?.name ?? tableName}**`];

    if (table) {
        lines.push("");
        lines.push(table.description);
    }

    if (hasColumns) {
        const all = columns as string[];

        lines.push("");
        lines.push(`_${countLabel(all.length)}_`);
        lines.push("");

        for (const column of all) {
            lines.push(`- \`${escapeCodeSpan(column)}\``);
        }
    }

    return lines.join("\n");
}

/**
 * Neutralizes a name that is about to be placed inside a Markdown code span.
 *
 * Column names come from the server, and a name holding a backtick would close
 * the span early and let the rest of the name render as live markdown. Replacing
 * the backtick with the visually similar single quote keeps the name readable
 * while making the span impossible to escape.
 *
 * @param name The name to place inside the code span.
 *
 * @returns The name with any backtick replaced.
 */
function escapeCodeSpan(name: string): string {
    return name.replace(/`/g, "'");
}

/**
 * Builds the heading that introduces the column list.
 *
 * @param count The number of columns the table has.
 *
 * @returns The heading text.
 */
function countLabel(count: number): string {
    return `${count.toLocaleString("en-US")} column${count === 1 ? "" : "s"}`;
}
