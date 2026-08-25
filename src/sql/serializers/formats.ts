/**
 * The names of the export formats, and nothing else.
 *
 * This lives apart from `index.ts` so that a module which only needs to
 * validate a format name, such as the panel protocol, does not pull the Excel
 * serializer and its exceljs dependency in behind it.
 */

/** The formats a result set can be exported to. */
export type ExportFormat = "csv" | "json" | "excel";

/** Every export format, in the order the panel's buttons list them. */
export const exportFormats: readonly ExportFormat[] = ["csv", "json", "excel"];

/** The file extension each export format uses. */
export const exportFileExtensions: Readonly<Record<ExportFormat, string>> = {
    csv: "csv",
    json: "json",
    excel: "xlsx"
};

/**
 * Determines whether a value names an export format.
 *
 * @param value The value to check, which may have come from the webview.
 *
 * @returns True when the value names an export format.
 */
export function isExportFormat(value: unknown): value is ExportFormat {
    return typeof value === "string" && (exportFormats as readonly string[]).includes(value);
}
