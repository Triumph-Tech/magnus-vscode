import type { Workbook, Worksheet } from "exceljs";
import { formatByteArray, formatDateTime, getCellDisplayValue, isNullValue, uniqueColumnKeys } from "../resultFormatting";
import { QueryColumn, QueryColumnType, QueryResultSet } from "../types";

/**
 * The Excel (`.xlsx`) file export.
 *
 * exceljs builds the workbook in memory and hands back the bytes, so this stays
 * a pure function of the result sets: the caller decides where the bytes go.
 *
 * Each result set becomes its own worksheet, which is the one thing a workbook
 * can do that CSV cannot.
 *
 * Values keep their type where Excel has one, so that a number sorts as a
 * number and a date shows in the reader's own date format. Byte arrays become
 * their hexadecimal preview, since a spreadsheet cell is no place for a blob.
 * Because exceljs writes those values as literal strings, a value that a
 * spreadsheet would otherwise read as a formula needs no neutralizing here.
 *
 * exceljs is loaded with a dynamic `import` inside the serializer rather than at
 * the top of the module, because it is a megabyte of JavaScript that would
 * otherwise be parsed on every activation of the extension, whether or not
 * anybody ever exports a workbook. Only the types are imported statically, and
 * those disappear at compile time.
 */

/** The width, in characters, that no exported column exceeds. */
export const maxColumnWidth = 60;

/** The width, in characters, that every exported column at least gets. */
export const minColumnWidth = 8;

/** The number of rows scanned when sizing a column to its content. */
export const columnWidthSampleRows = 200;

/** The number format applied to a datetime column. */
export const dateTimeNumberFormat = "yyyy-mm-dd hh:mm:ss";

/**
 * Serializes one result set as an `.xlsx` workbook.
 *
 * @param resultSet The result set to serialize.
 * @param sheetName The name for the worksheet.
 *
 * @returns The bytes of the workbook.
 */
export async function serializeResultSetToExcel(resultSet: QueryResultSet, sheetName?: string): Promise<Buffer> {
    return serializeResultSetsToExcel([resultSet], sheetName ? [sheetName] : undefined);
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
    const exceljs = await import("exceljs");
    const workbook = new exceljs.Workbook();
    const created = new Date();

    workbook.created = created;
    workbook.modified = created;

    // A workbook with no worksheet at all is not a valid file, so an export of
    // nothing still produces one empty sheet.
    if (resultSets.length === 0) {
        workbook.addWorksheet(sheetNameFor(sheetNames, 0));
    }

    for (let index = 0; index < resultSets.length; index++) {
        addResultSetSheet(workbook, resultSets[index], sheetNameFor(sheetNames, index));
    }

    const bytes = await workbook.xlsx.writeBuffer();

    return Buffer.from(bytes as ArrayBuffer);
}

/**
 * Adds one result set to a workbook as a worksheet.
 *
 * @param workbook The workbook to add to.
 * @param resultSet The result set to write.
 * @param name The name for the worksheet.
 */
function addResultSetSheet(workbook: Workbook, resultSet: QueryResultSet, name: string): void {
    const sheet = workbook.addWorksheet(name);
    const keys = uniqueColumnKeys(resultSet.columns);

    sheet.columns = resultSet.columns.map((column, index) => ({
        header: column.name,
        key: keys[index],
        width: columnWidth(column, resultSet.rows, index),
        style: column.type === QueryColumnType.DateTime ? { numFmt: dateTimeNumberFormat } : undefined
    }));

    for (const row of resultSet.rows) {
        sheet.addRow(resultSet.columns.map((column, index) => excelValueFor(column, row[index])));
    }

    styleHeaderRow(sheet);
}

/**
 * Makes the header row bold and keeps it in view while the sheet scrolls.
 *
 * @param sheet The worksheet to style.
 */
function styleHeaderRow(sheet: Worksheet): void {
    const header = sheet.getRow(1);

    header.font = { bold: true };
    header.commit();

    sheet.views = [{ state: "frozen", ySplit: 1 }];
}

/**
 * Produces the value written into a worksheet cell.
 *
 * @param column The column the value came from.
 * @param value The raw value from the result set.
 *
 * @returns The value exceljs should store, which is null for a NULL.
 */
function excelValueFor(column: QueryColumn, value: unknown): unknown {
    if (isNullValue(value)) {
        return null;
    }

    if (column.type === QueryColumnType.Boolean) {
        return getCellDisplayValue(column.type, value) === "1";
    }

    if (column.type === QueryColumnType.Number) {
        const parsed = Number(getCellDisplayValue(column.type, value));

        return Number.isFinite(parsed) ? parsed : getCellDisplayValue(column.type, value);
    }

    if (column.type === QueryColumnType.DateTime) {
        const iso = formatDateTime(value);
        const parsed = Date.parse(iso);

        // A datetime that did not parse is written as its own text rather than
        // silently becoming the epoch.
        return Number.isNaN(parsed) ? iso : new Date(parsed);
    }

    if (column.type === QueryColumnType.ByteArray) {
        return formatByteArray(value);
    }

    return getCellDisplayValue(column.type, value);
}

/**
 * Sizes a column to its content, within bounds.
 *
 * Only the first `columnWidthSampleRows` rows are measured. Scanning a hundred
 * thousand rows to widen a column is not worth the time, and a column whose
 * long values start late still wraps rather than being lost.
 *
 * @param column The column being sized.
 * @param rows The rows of the result set.
 * @param index The position of the column in each row.
 *
 * @returns The width in characters.
 */
function columnWidth(column: QueryColumn, rows: unknown[][], index: number): number {
    let widest = column.name.length;
    const sampled = Math.min(rows.length, columnWidthSampleRows);

    for (let row = 0; row < sampled; row++) {
        const value = rows[row][index];
        const length = isNullValue(value) ? 4 : getCellDisplayValue(column.type, value).length;

        if (length > widest) {
            widest = length;

            if (widest >= maxColumnWidth) {
                return maxColumnWidth;
            }
        }
    }

    // The two extra characters keep a value from touching the cell border.
    return Math.max(minColumnWidth, Math.min(maxColumnWidth, widest + 2));
}

/**
 * Produces a worksheet name that Excel accepts.
 *
 * Excel rejects brackets, asterisks, slashes, backslashes, question marks and
 * colons in a sheet name, and caps it at 31 characters. A name that breaks
 * either rule makes the whole file unopenable.
 *
 * @param names The names the caller supplied, if any.
 * @param index The position of the result set.
 *
 * @returns The sanitized worksheet name.
 */
function sheetNameFor(names: string[] | undefined, index: number): string {
    const requested = names?.[index];
    const fallback = `Results ${index + 1}`;

    if (requested === undefined || requested.trim() === "") {
        return fallback;
    }

    const cleaned = requested.replace(/[[\]*/\\?:]/g, " ").trim().slice(0, 31);

    return cleaned === "" ? fallback : cleaned;
}
