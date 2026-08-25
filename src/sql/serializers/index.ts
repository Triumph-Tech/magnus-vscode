import { CellSanitizeOptions } from "../resultFormatting";
import { ExportFormat } from "./formats";
import { QueryResultSet } from "../types";
import { serializeResultSetsToCsv, serializeResultSetToCsv } from "./csv";
import { serializeResultSetsToJson, serializeResultSetToJson } from "./json";

/**
 * The file export serializers, and the one dispatcher over them.
 *
 * Every serializer takes result sets and returns the finished document. None of
 * them touch the file system: the export command owns the save dialog and the
 * write, which is what lets all of this be unit tested without one.
 *
 * The Excel serializer is reached through a dynamic `import` rather than a
 * static one, because it pulls in exceljs: about a megabyte of JavaScript that
 * would otherwise be parsed on every activation of the extension. Nothing here
 * loads it until an Excel export actually runs.
 */

export { serializeResultSetToCsv, serializeResultSetsToCsv } from "./csv";
export { serializeResultSetToJson, serializeResultSetsToJson } from "./json";
export { ExportFormat, exportFormats, exportFileExtensions, isExportFormat } from "./formats";

/**
 * Serializes one result set as an `.xlsx` workbook.
 *
 * @param resultSet The result set to serialize.
 * @param sheetName The name for the worksheet.
 *
 * @returns The bytes of the workbook.
 */
export async function serializeResultSetToExcel(resultSet: QueryResultSet, sheetName?: string): Promise<Buffer> {
    const excel = await import("./excel");

    return excel.serializeResultSetToExcel(resultSet, sheetName);
}

/**
 * Serializes several result sets as one `.xlsx` workbook, one worksheet each.
 *
 * @param resultSets The result sets to serialize, in order.
 * @param sheetNames The names for the worksheets, defaulting to Results 1..N.
 *
 * @returns The bytes of the workbook.
 */
export async function serializeResultSetsToExcel(resultSets: QueryResultSet[], sheetNames?: string[]): Promise<Buffer> {
    const excel = await import("./excel");

    return excel.serializeResultSetsToExcel(resultSets, sheetNames);
}

/**
 * Serializes result sets in the requested format.
 *
 * The text formats return a string and Excel returns bytes, so callers write
 * the result with the encoding the document asks for rather than assuming one.
 *
 * @param format The format to serialize to.
 * @param resultSets The result sets to serialize, in order.
 * @param options Whether to neutralize a value a spreadsheet would read as a formula.
 *
 * @returns The finished document.
 */
export async function serializeResultSets(format: ExportFormat, resultSets: QueryResultSet[], options?: CellSanitizeOptions): Promise<string | Buffer> {
    if (format === "csv") {
        return serializeResultSetsToCsv(resultSets, options);
    }

    if (format === "json") {
        return serializeResultSetsToJson(resultSets);
    }

    return serializeResultSetsToExcel(resultSets);
}

/**
 * Serializes one result set in the requested format.
 *
 * @param format The format to serialize to.
 * @param resultSet The result set to serialize.
 * @param options Whether to neutralize a value a spreadsheet would read as a formula.
 *
 * @returns The finished document.
 */
export async function serializeResultSet(format: ExportFormat, resultSet: QueryResultSet, options?: CellSanitizeOptions): Promise<string | Buffer> {
    if (format === "csv") {
        return serializeResultSetToCsv(resultSet, options);
    }

    if (format === "json") {
        return serializeResultSetToJson(resultSet);
    }

    return serializeResultSetToExcel(resultSet);
}
