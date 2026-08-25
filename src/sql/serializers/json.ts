import { buildJson } from "../resultFormatting";
import { QueryResultSet } from "../types";

/**
 * The JSON file export.
 *
 * One result set becomes an array of objects, exactly what Copy as JSON puts on
 * the clipboard. Several result sets become an array of those arrays, which
 * keeps the shape honest instead of concatenating rows whose columns differ.
 */

/**
 * Serializes one whole result set as a JSON document.
 *
 * @param resultSet The result set to serialize.
 *
 * @returns The JSON document, indented with two spaces.
 */
export function serializeResultSetToJson(resultSet: QueryResultSet): string {
    return buildJson(resultSet.columns, resultSet.rows);
}

/**
 * Serializes several result sets as one JSON document.
 *
 * A single set is written as a plain array of objects, so that the common case
 * produces the document a consumer expects. Two or more are written as an array
 * of arrays.
 *
 * @param resultSets The result sets to serialize, in order.
 *
 * @returns The JSON document, indented with two spaces.
 */
export function serializeResultSetsToJson(resultSets: QueryResultSet[]): string {
    if (resultSets.length === 1) {
        return serializeResultSetToJson(resultSets[0]);
    }

    const sets = resultSets.map(set => JSON.parse(serializeResultSetToJson(set)) as unknown);

    return JSON.stringify(sets, undefined, 2);
}
