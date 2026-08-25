import { quoteIdentifier, quoteQualifiedIdentifier } from "./resultFormatting";

/**
 * The statement that Select Top 1000 generates.
 *
 * Pure so that the shape of the generated SQL is pinned by tests rather than by
 * running it against a server. The identifier quoting is shared with the copy
 * and export formats (`resultFormatting`), which is what keeps a generated
 * statement and a generated INSERT bracketing names the same way.
 */

/** The number of rows Select Top 1000 asks for. */
export const selectTopRowCount = 1000;

/**
 * Builds the statement that Select Top 1000 opens in a query editor.
 *
 * The column list is written out rather than a `*` so that the statement is a
 * starting point someone can edit: dropping a column is a line delete. A table
 * whose columns could not be read still gets a runnable statement, with a `*`
 * standing in for the list.
 *
 * @param tableName The table to select from, optionally schema qualified.
 * @param columns The names of the columns to select, in the order the server reported them.
 * @param rowCount The number of rows to ask for.
 *
 * @returns The statement text.
 */
export function buildSelectTopStatement(tableName: string, columns: readonly string[], rowCount: number = selectTopRowCount): string {
    const top = Math.max(1, Math.floor(rowCount));
    const target = quoteQualifiedIdentifier(tableName);
    const usable = columns.filter(name => name.trim() !== "");

    if (usable.length === 0) {
        return `SELECT TOP (${top}) *\nFROM ${target}\n`;
    }

    const columnList = usable
        .map(name => `    ${quoteIdentifier(name)}`)
        .join(",\n");

    return `SELECT TOP (${top})\n${columnList}\nFROM ${target}\n`;
}
