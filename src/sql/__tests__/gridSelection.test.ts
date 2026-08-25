import { describe, expect, it } from "vitest";
import { clampSelection, extractSelection, isCellSelected, normalizeSelection, selectAll, selectionSize } from "../gridSelection";
import { QueryColumn, QueryColumnType } from "../types";

const columns: QueryColumn[] = [
    { name: "A", type: QueryColumnType.Number },
    { name: "B", type: QueryColumnType.String },
    { name: "C", type: QueryColumnType.String }
];

const rows: unknown[][] = [
    [1, "a1", "b1"],
    [2, "a2", "b2"],
    [3, "a3", "b3"],
    [4, "a4", "b4"]
];

describe("normalizeSelection", () => {
    it("keeps a forward drag as it is", () => {
        expect(normalizeSelection({ row: 1, column: 0 }, { row: 3, column: 2 }))
            .toEqual({ startRow: 1, startColumn: 0, endRow: 3, endColumn: 2 });
    });

    it("orders a drag that ran up and to the left", () => {
        expect(normalizeSelection({ row: 3, column: 2 }, { row: 1, column: 0 }))
            .toEqual({ startRow: 1, startColumn: 0, endRow: 3, endColumn: 2 });
    });

    it("orders each axis independently", () => {
        expect(normalizeSelection({ row: 3, column: 0 }, { row: 1, column: 2 }))
            .toEqual({ startRow: 1, startColumn: 0, endRow: 3, endColumn: 2 });
    });

    it("makes a single cell a one by one rectangle", () => {
        expect(normalizeSelection({ row: 2, column: 1 }, { row: 2, column: 1 }))
            .toEqual({ startRow: 2, startColumn: 1, endRow: 2, endColumn: 1 });
    });

    it("floors fractional positions and pulls negatives up to zero", () => {
        expect(normalizeSelection({ row: 1.9, column: -4 }, { row: 3.2, column: 2.7 }))
            .toEqual({ startRow: 1, startColumn: 0, endRow: 3, endColumn: 2 });
    });

    it("treats a position that is not a number as zero", () => {
        expect(normalizeSelection({ row: Number.NaN, column: 1 }, { row: 2, column: Number.POSITIVE_INFINITY }))
            .toEqual({ startRow: 0, startColumn: 0, endRow: 2, endColumn: 1 });
    });
});

describe("clampSelection", () => {
    it("leaves a selection inside the bounds alone", () => {
        expect(clampSelection({ startRow: 1, startColumn: 0, endRow: 2, endColumn: 1 }, 4, 3))
            .toEqual({ startRow: 1, startColumn: 0, endRow: 2, endColumn: 1 });
    });

    it("pulls an end past the last row or column back in", () => {
        expect(clampSelection({ startRow: 0, startColumn: 0, endRow: 99, endColumn: 99 }, 4, 3))
            .toEqual({ startRow: 0, startColumn: 0, endRow: 3, endColumn: 2 });
    });

    it("rejects a selection that starts past the end", () => {
        expect(clampSelection({ startRow: 9, startColumn: 0, endRow: 12, endColumn: 1 }, 4, 3)).toBeNull();
        expect(clampSelection({ startRow: 0, startColumn: 7, endRow: 1, endColumn: 9 }, 4, 3)).toBeNull();
    });

    it("rejects any selection over an empty result set", () => {
        expect(clampSelection({ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }, 0, 3)).toBeNull();
        expect(clampSelection({ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }, 4, 0)).toBeNull();
    });

    it("orders the selection before clamping it", () => {
        expect(clampSelection({ startRow: 3, startColumn: 2, endRow: 1, endColumn: 0 }, 4, 3))
            .toEqual({ startRow: 1, startColumn: 0, endRow: 3, endColumn: 2 });
    });

    it("floors fractional bounds", () => {
        expect(clampSelection({ startRow: 0, startColumn: 0, endRow: 9, endColumn: 9 }, 2.9, 1.9))
            .toEqual({ startRow: 0, startColumn: 0, endRow: 1, endColumn: 0 });
    });
});

describe("selectionSize", () => {
    it("counts the rows, columns and cells", () => {
        expect(selectionSize({ startRow: 1, startColumn: 0, endRow: 3, endColumn: 2 }))
            .toEqual({ rowCount: 3, columnCount: 3, cellCount: 9 });
    });

    it("counts one cell for a single cell selection", () => {
        expect(selectionSize({ startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 }))
            .toEqual({ rowCount: 1, columnCount: 1, cellCount: 1 });
    });

    it("never reports a negative size", () => {
        expect(selectionSize({ startRow: 5, startColumn: 5, endRow: 1, endColumn: 1 }))
            .toEqual({ rowCount: 0, columnCount: 0, cellCount: 0 });
    });
});

describe("extractSelection", () => {
    it("cuts out the selected block", () => {
        expect(extractSelection(columns, rows, { startRow: 1, startColumn: 1, endRow: 2, endColumn: 2 })).toEqual({
            columns: [columns[1], columns[2]],
            rows: [["a2", "b2"], ["a3", "b3"]]
        });
    });

    it("cuts out a single cell", () => {
        expect(extractSelection(columns, rows, { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 })).toEqual({
            columns: [columns[0]],
            rows: [[1]]
        });
    });

    it("clamps a selection that reaches past the rows", () => {
        const slice = extractSelection(columns, rows, { startRow: 2, startColumn: 0, endRow: 99, endColumn: 99 });

        expect(slice?.rows).toEqual([[3, "a3", "b3"], [4, "a4", "b4"]]);
        expect(slice?.columns).toEqual(columns);
    });

    it("returns null when nothing is selectable", () => {
        expect(extractSelection(columns, [], { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 })).toBeNull();
        expect(extractSelection([], rows, { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 })).toBeNull();
        expect(extractSelection(columns, rows, { startRow: 10, startColumn: 0, endRow: 11, endColumn: 0 })).toBeNull();
    });

    it("does not mutate the source rows", () => {
        extractSelection(columns, rows, { startRow: 0, startColumn: 1, endRow: 1, endColumn: 1 });

        expect(rows[0]).toEqual([1, "a1", "b1"]);
    });
});

describe("selectAll", () => {
    it("covers every cell", () => {
        expect(selectAll(4, 3)).toEqual({ startRow: 0, startColumn: 0, endRow: 3, endColumn: 2 });
    });

    it("returns null for an empty result set", () => {
        expect(selectAll(0, 3)).toBeNull();
        expect(selectAll(4, 0)).toBeNull();
    });
});

describe("isCellSelected", () => {
    const rect = { startRow: 1, startColumn: 1, endRow: 2, endColumn: 2 };

    it("includes the corners", () => {
        expect(isCellSelected(rect, { row: 1, column: 1 })).toBe(true);
        expect(isCellSelected(rect, { row: 2, column: 2 })).toBe(true);
    });

    it("excludes cells outside on any side", () => {
        expect(isCellSelected(rect, { row: 0, column: 1 })).toBe(false);
        expect(isCellSelected(rect, { row: 3, column: 1 })).toBe(false);
        expect(isCellSelected(rect, { row: 1, column: 0 })).toBe(false);
        expect(isCellSelected(rect, { row: 1, column: 3 })).toBe(false);
    });
});
