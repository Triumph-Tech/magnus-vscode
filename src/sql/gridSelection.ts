import { QueryColumn } from "./types";

/**
 * The arithmetic of a grid selection: turning the anchor and focus cells of a
 * click and drag into an ordered rectangle, keeping that rectangle inside the
 * result set, and cutting the selected block out of the rows.
 *
 * The webview owns the pointer events, but none of the arithmetic, so that the
 * awkward cases (a drag that ends above where it started, a selection held over
 * a result set that has since been replaced by a smaller one) are covered by
 * unit tests rather than by clicking around.
 */

/**
 * One cell of the grid, by position.
 */
export type CellPosition = {
    /** The zero based row index. */
    row: number;

    /** The zero based column index. */
    column: number;
};

/**
 * A rectangular region of one result set. Both ends are inclusive.
 */
export type SelectionRect = {
    /** The first row of the region. */
    startRow: number;

    /** The first column of the region. */
    startColumn: number;

    /** The last row of the region. */
    endRow: number;

    /** The last column of the region. */
    endColumn: number;
};

/**
 * The size of a selection.
 */
export type SelectionSize = {
    /** The number of rows the selection covers. */
    rowCount: number;

    /** The number of columns the selection covers. */
    columnCount: number;

    /** The number of cells the selection covers. */
    cellCount: number;
};

/**
 * The columns and rows a selection covers.
 */
export type SelectionSlice = {
    /** The selected columns, in order. */
    columns: QueryColumn[];

    /** The selected rows, each holding only the selected columns. */
    rows: unknown[][];
};

/**
 * Orders the anchor and focus cells of a drag into a rectangle.
 *
 * A drag runs in whichever direction the person moved, so either end may hold
 * the smaller index. Fractional or negative inputs are floored and pulled up to
 * zero, since a pointer position that lands outside the grid is a normal thing
 * for the webview to report.
 *
 * @param anchor The cell the drag started on.
 * @param focus The cell the drag is currently over.
 *
 * @returns The rectangle covering both cells.
 */
export function normalizeSelection(anchor: CellPosition, focus: CellPosition): SelectionRect {
    const anchorRow = toIndex(anchor.row);
    const anchorColumn = toIndex(anchor.column);
    const focusRow = toIndex(focus.row);
    const focusColumn = toIndex(focus.column);

    return {
        startRow: Math.min(anchorRow, focusRow),
        startColumn: Math.min(anchorColumn, focusColumn),
        endRow: Math.max(anchorRow, focusRow),
        endColumn: Math.max(anchorColumn, focusColumn)
    };
}

/**
 * Pulls a selection inside the bounds of a result set.
 *
 * A result set with no rows or no columns has nothing to select, and a
 * selection entirely past the end of one is not a selection either, so both
 * yield null rather than an empty rectangle that callers would have to
 * recognize.
 *
 * @param rect The selection to clamp.
 * @param rowCount The number of rows the result set holds.
 * @param columnCount The number of columns the result set holds.
 *
 * @returns The clamped selection, or null when nothing of it remains.
 */
export function clampSelection(rect: SelectionRect, rowCount: number, columnCount: number): SelectionRect | null {
    const rows = Math.max(0, Math.floor(rowCount));
    const columns = Math.max(0, Math.floor(columnCount));

    if (rows === 0 || columns === 0) {
        return null;
    }

    const ordered = normalizeSelection({ row: rect.startRow, column: rect.startColumn }, { row: rect.endRow, column: rect.endColumn });

    if (ordered.startRow >= rows || ordered.startColumn >= columns) {
        return null;
    }

    return {
        startRow: ordered.startRow,
        startColumn: ordered.startColumn,
        endRow: Math.min(ordered.endRow, rows - 1),
        endColumn: Math.min(ordered.endColumn, columns - 1)
    };
}

/**
 * Measures a selection.
 *
 * @param rect The selection to measure.
 *
 * @returns The number of rows, columns and cells it covers.
 */
export function selectionSize(rect: SelectionRect): SelectionSize {
    const rowCount = Math.max(0, rect.endRow - rect.startRow + 1);
    const columnCount = Math.max(0, rect.endColumn - rect.startColumn + 1);

    return {
        rowCount,
        columnCount,
        cellCount: rowCount * columnCount
    };
}

/**
 * Cuts the selected block out of a result set.
 *
 * The selection is clamped first, so a stale rectangle cannot read past the end
 * of the rows and produce a block padded with undefined.
 *
 * @param columns The columns of the result set.
 * @param rows The rows of the result set.
 * @param rect The selection to extract.
 *
 * @returns The selected columns and rows, or null when the selection covers nothing.
 */
export function extractSelection(columns: QueryColumn[], rows: unknown[][], rect: SelectionRect): SelectionSlice | null {
    const clamped = clampSelection(rect, rows.length, columns.length);

    if (!clamped) {
        return null;
    }

    return {
        columns: columns.slice(clamped.startColumn, clamped.endColumn + 1),
        rows: rows
            .slice(clamped.startRow, clamped.endRow + 1)
            .map(row => row.slice(clamped.startColumn, clamped.endColumn + 1))
    };
}

/**
 * Produces the selection that covers a whole result set.
 *
 * @param rowCount The number of rows the result set holds.
 * @param columnCount The number of columns the result set holds.
 *
 * @returns The selection, or null when the result set is empty.
 */
export function selectAll(rowCount: number, columnCount: number): SelectionRect | null {
    return clampSelection({ startRow: 0, startColumn: 0, endRow: rowCount - 1, endColumn: columnCount - 1 }, rowCount, columnCount);
}

/**
 * Determines whether a cell falls inside a selection.
 *
 * @param rect The selection.
 * @param cell The cell to test.
 *
 * @returns True when the cell is inside the selection.
 */
export function isCellSelected(rect: SelectionRect, cell: CellPosition): boolean {
    return cell.row >= rect.startRow
        && cell.row <= rect.endRow
        && cell.column >= rect.startColumn
        && cell.column <= rect.endColumn;
}

/**
 * Normalizes a value that should be a grid index.
 *
 * @param value The value reported by the webview.
 *
 * @returns The value as a non-negative whole number.
 */
function toIndex(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.floor(value));
}
