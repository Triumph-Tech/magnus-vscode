import { buildCsv, CsvOptions } from "../resultFormatting";
import { QueryResultSet } from "../types";

/**
 * The CSV file export.
 *
 * The document is assembled by the shared `buildCsv` builder, so an exported
 * file and a Copy as CSV of the same rows are byte identical. Writing the file
 * is the caller's job; this module only produces text.
 */

/**
 * Serializes one whole result set as a CSV document.
 *
 * @param resultSet The result set to serialize.
 * @param options The delimiter, line separator, header and NULL choices.
 *
 * @returns The CSV document.
 */
export function serializeResultSetToCsv(resultSet: QueryResultSet, options?: CsvOptions): string {
    return buildCsv(resultSet.columns, resultSet.rows, options);
}

/**
 * Serializes several result sets as one CSV document.
 *
 * CSV has no way to hold more than one table, so the sets are stacked with a
 * blank line between them and each one carries its own header row. Exporting a
 * single set is the normal case; this exists so that Export all has a defined
 * meaning for CSV rather than silently dropping every set but the first.
 *
 * @param resultSets The result sets to serialize, in order.
 * @param options The delimiter, line separator, header and NULL choices.
 *
 * @returns The CSV document.
 */
export function serializeResultSetsToCsv(resultSets: QueryResultSet[], options?: CsvOptions): string {
    const lineSeparator = options?.lineSeparator ?? "\r\n";

    return resultSets
        .map(set => serializeResultSetToCsv(set, options))
        .join(lineSeparator);
}
