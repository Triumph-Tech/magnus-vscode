// @ts-nocheck
/*
 * The query results panel: the header, the Messages view, and the results grid.
 *
 * Plain JavaScript on purpose: the panel loads this file directly through
 * `asWebviewUri`, so it never goes through the extension's webpack build. It
 * also means the shape checks and the two content helpers (`detectCellContent`,
 * `prettyPrintJson`) are repeated here rather than imported; the authoritative
 * versions live in `panelProtocol.ts` and `resultFormatting.ts`.
 *
 * ## What this file owns and what it does not
 *
 * The webview owns pixels and pointers. It does not own values: every cell it
 * shows arrived already formatted, it holds only the rows it has been given, and
 * a copy or an export is a message to the extension host, which reads the raw
 * rows it kept. That is what lets a selection reaching past the render cap copy
 * real values, and it is why nothing here reformats anything.
 *
 * ## The grid
 *
 * One grid per result set, each virtualized: the scroll container holds a canvas
 * as tall as every row would be, and only the rows in view (plus an overscan
 * band) exist as elements. Scrolling reuses the row elements that are still in
 * the window and builds only the ones that entered it, which is what keeps a
 * 100,000 row set smooth. A row that has not been received yet renders as a
 * placeholder and triggers a `requestRows` for the block it belongs to.
 *
 * Sections below, in order: state, helpers, tabs, grid construction, row
 * rendering, column widths, selection, clipboard and export, the inspector, the
 * menus, keyboard handling, and the message pump.
 */

(function () {
    "use strict";

    const vscode = acquireVsCodeApi();

    // #region Constants

    /** The height of every row, in pixels. Fixed, which is what makes the windowing arithmetic exact. */
    const rowHeight = 22;

    /** The number of rows rendered above and below the visible band. */
    const overscanRows = 8;

    /** The number of rows asked for in one request, matching the extension's chunk size. */
    const rowRequestBlock = 500;

    /** The narrowest a column may be measured or dragged to, in pixels. */
    const minColumnWidth = 64;

    /** The widest a column may be measured to, in pixels. Dragging past this is allowed. */
    const maxAutoColumnWidth = 420;

    /** The width of the row number gutter, in pixels. */
    const gutterWidth = 62;

    /** The horizontal padding of a cell, which measuring has to allow for. */
    const cellPadding = 16;

    /** The number of received rows sampled when a column is measured. */
    const widthSampleRows = 60;

    /** The entries of the Copy as… menu, in the order the protocol lists them. */
    const copyMenuItems = [
        { format: "tabDelimited", label: "Tab delimited" },
        { format: "tabDelimitedWithHeaders", label: "Tab delimited, with headers" },
        { format: "markdown", label: "Markdown table" },
        { format: "csv", label: "CSV" },
        { format: "json", label: "JSON" },
        { format: "insert", label: "INSERT statements" }
    ];

    /** The entries of the Export… menu. */
    const exportMenuItems = [
        { format: "csv", label: "CSV…" },
        { format: "json", label: "JSON…" },
        { format: "excel", label: "Excel workbook…" }
    ];

    // #endregion

    // #region State

    const serverLabel = document.getElementById("server-label");
    const statementPreview = document.getElementById("statement-preview");
    const statusLabel = document.getElementById("status");
    const cancelButton = document.getElementById("cancel-button");
    const messageList = document.getElementById("message-list");
    const messagesView = document.getElementById("messages-view");
    const messagesTab = document.getElementById("tab-messages");
    const tabStrip = document.getElementById("tab-strip");
    const toolbar = document.getElementById("toolbar");
    const resultsHost = document.getElementById("results-host");
    const selectionSummary = document.getElementById("selection-summary");
    const transposeButton = document.getElementById("transpose-button");
    const inspector = document.getElementById("inspector");
    const inspectorTitle = document.getElementById("inspector-title");
    const inspectorKind = document.getElementById("inspector-kind");
    const inspectorBody = document.getElementById("inspector-body");
    const inspectorClose = document.getElementById("inspector-close");
    const contextMenu = document.getElementById("context-menu");
    const measure = document.getElementById("measure");

    /** True while a run is in flight, which is what the timer and button follow. */
    let isRunning = false;

    /** The time the current run started, in milliseconds. */
    let startedAt = 0;

    /** The handle of the interval that ticks the running duration. */
    let tickHandle = 0;

    /** The number of messages rendered so far, so an empty view can be detected. */
    let messageCount = 0;

    /** The result sets of the current run, in order. */
    let sets = [];

    /** Which tab is showing: "messages", or the index of a result set. */
    let activeTab = "messages";

    /** The duration the run reported, shown in every footer once it is known. */
    let runDurationMs = null;

    /** Which view the inspector shows: the active cell, or the active row transposed. */
    let inspectorMode = "cell";

    // #endregion

    // #region Helpers

    /**
     * Formats a duration the way the header shows it.
     *
     * Mirrors `formatDuration` in queryHistory.ts so that a run reads the same
     * in the panel header as it does in the Query History quick pick. The
     * webview cannot import from src, which is the established pattern for the
     * small shared rules repeated in this file.
     *
     * @param {number} milliseconds The duration in milliseconds.
     *
     * @returns {string} The duration in milliseconds under a second, otherwise in seconds with one decimal.
     */
    function formatDuration(milliseconds) {
        const value = Math.max(0, milliseconds);

        if (value < 1000) {
            return `${Math.round(value)} ms`;
        }

        return `${(value / 1000).toFixed(1)} s`;
    }

    /**
     * Formats a count with thousands separators.
     *
     * @param {number} count The number to format.
     *
     * @returns {string} The formatted number.
     */
    function formatCount(count) {
        return count.toLocaleString("en-US");
    }

    /**
     * Removes every child of an element.
     *
     * @param {Element} element The element to empty.
     */
    function clearElement(element) {
        while (element.firstChild) {
            element.removeChild(element.firstChild);
        }
    }

    /**
     * Guesses what kind of content a value holds so the inspector can present it.
     *
     * Repeats `detectCellContent` from resultFormatting.ts.
     *
     * @param {string} display The display text of the cell.
     *
     * @returns {string} One of "json", "xml" or "text".
     */
    function detectCellContent(display) {
        const text = String(display).trim();

        if (text === "") {
            return "text";
        }

        if (text.startsWith("{") || text.startsWith("[")) {
            try {
                const parsed = JSON.parse(text);

                if (typeof parsed === "object" && parsed !== null) {
                    return "json";
                }
            }
            catch (error) {
                // Not JSON, fall through to the other tests.
            }
        }

        if (/^<[?!/]?[A-Za-z_]/.test(text) && text.includes(">")) {
            return "xml";
        }

        return "text";
    }

    /**
     * Pretty prints a JSON document with a stable two space indent.
     *
     * Repeats `prettyPrintJson` from resultFormatting.ts.
     *
     * @param {string} text The text to pretty print.
     *
     * @returns {string} The formatted document, or the text unchanged when it is not JSON.
     */
    function prettyPrintJson(text) {
        try {
            return JSON.stringify(JSON.parse(text), undefined, 2);
        }
        catch (error) {
            return text;
        }
    }

    /**
     * Measures how wide a piece of text renders in the grid's font.
     *
     * @param {string} text The text to measure.
     *
     * @returns {number} The width in pixels.
     */
    function measureText(text) {
        measure.textContent = text;

        return measure.getBoundingClientRect().width;
    }

    /**
     * Gets the result set that is currently showing.
     *
     * @returns {object|null} The active set, or null when Messages is showing.
     */
    function getActiveSet() {
        return typeof activeTab === "number" ? sets[activeTab] ?? null : null;
    }

    // #endregion

    // #region Header and messages

    /**
     * Updates the status text of the header.
     *
     * @param {string} text The text to show.
     * @param {boolean} isError True to show the text as an error.
     */
    function setStatus(text, isError) {
        statusLabel.textContent = text;
        statusLabel.classList.toggle("is-error", isError === true);
    }

    /**
     * Starts or stops the interval that ticks the running duration.
     *
     * @param {boolean} running True while a run is in flight.
     */
    function setRunning(running) {
        isRunning = running;
        cancelButton.hidden = !running;

        if (tickHandle !== 0) {
            clearInterval(tickHandle);
            tickHandle = 0;
        }

        if (running) {
            tickHandle = setInterval(function () {
                setStatus(`Running… ${formatDuration(Date.now() - startedAt)}`, false);
            }, 100);
        }
    }

    /**
     * Determines whether a server message should be shown as an error.
     *
     * @param {object} message The message the server emitted.
     *
     * @returns {boolean} True if the message is an error.
     */
    function isErrorMessage(message) {
        if (typeof message.code === "number" && message.code > 0) {
            return true;
        }

        return typeof message.level === "number" && message.level > 10;
    }

    /**
     * Empties the Messages view.
     */
    function clearMessages() {
        clearElement(messageList);

        messageCount = 0;
    }

    /**
     * Adds one line to the Messages view.
     *
     * @param {string} text The text of the line.
     * @param {boolean} isError True to style the line as an error.
     * @param {number|null} lineNumber The source line the entry points at, if any.
     */
    function appendLine(text, isError, lineNumber) {
        const item = document.createElement("li");

        if (isError === true) {
            item.classList.add("is-error");
        }

        if (typeof lineNumber === "number" && lineNumber >= 1) {
            const button = document.createElement("button");

            button.type = "button";
            button.className = "message-link";
            button.textContent = `${text} [line ${lineNumber}]`;
            button.addEventListener("click", function () {
                vscode.postMessage({
                    type: "revealLine",
                    lineNumber: lineNumber
                });
            });

            item.appendChild(button);
        }
        else {
            item.textContent = text;
        }

        messageList.appendChild(item);
        messageCount += 1;

        // Keep the newest line in view, the way an output channel does.
        item.scrollIntoView({
            block: "nearest"
        });
    }

    /**
     * Adds the "nothing to show" placeholder when a run produced no messages.
     */
    function appendEmptyPlaceholder() {
        const item = document.createElement("li");

        item.className = "is-empty";
        item.textContent = "The server reported no messages.";

        messageList.appendChild(item);
    }

    // #endregion

    // #region Tabs

    /**
     * Shows one tab and hides the rest.
     *
     * @param {string|number} tab Either "messages" or the index of a result set.
     */
    function activateTab(tab) {
        activeTab = tab;

        const isMessages = tab === "messages";

        messagesView.hidden = !isMessages;
        resultsHost.hidden = isMessages;
        toolbar.hidden = isMessages;

        messagesTab.classList.toggle("active", isMessages);
        messagesTab.setAttribute("aria-selected", isMessages ? "true" : "false");

        for (const set of sets) {
            if (!set) {
                continue;
            }

            const isActive = set.index === tab;

            set.tab.classList.toggle("active", isActive);
            set.tab.setAttribute("aria-selected", isActive ? "true" : "false");
            set.wrapper.hidden = !isActive;
        }

        closeMenus();
        closeInspector();

        const set = getActiveSet();

        if (set) {
            // A hidden grid has no measurable viewport, so the first render of a
            // set has to wait until it is the one showing.
            measureColumns(set);
            renderSet(set);
            updateSelectionSummary(set);
            set.viewport.focus({ preventScroll: true });
        }
    }

    /**
     * Removes every result set tab and grid, which a new run starts with.
     */
    function resetResultSets() {
        for (const set of sets) {
            if (set) {
                set.tab.remove();
                set.wrapper.remove();
            }
        }

        sets = [];
        runDurationMs = null;

        clearElement(resultsHost);
        activateTab("messages");
    }

    // #endregion

    // #region Grid construction

    /**
     * Builds the tab, the grid and the footer of one result set.
     *
     * @param {object} message The validated `resultSetStart` message.
     *
     * @returns {object} The state of the new set.
     */
    function createSet(message) {
        const set = {
            index: message.index,
            columns: message.columns,
            columnCount: message.columns.length,
            totalRows: message.totalRows,
            notice: message.truncatedNotice,
            initialRows: message.renderedRows,
            isStreaming: true,
            rows: [],
            requested: {},
            widths: [],
            isMeasured: false,
            selection: null,
            renderedRows: new Map()
        };

        const tab = document.createElement("button");

        tab.type = "button";
        tab.className = "tab";
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", "false");
        tab.textContent = `Results ${message.index + 1}`;
        tab.addEventListener("click", function () {
            activateTab(set.index);
        });

        tabStrip.insertBefore(tab, messagesTab);

        const wrapper = document.createElement("div");

        wrapper.className = "grid-wrapper";
        wrapper.hidden = true;

        const viewport = document.createElement("div");

        viewport.className = "grid-viewport";
        viewport.tabIndex = 0;
        viewport.setAttribute("role", "grid");
        viewport.setAttribute("aria-label", `Result set ${message.index + 1}`);
        viewport.setAttribute("aria-rowcount", String(set.totalRows + 1));
        viewport.setAttribute("aria-colcount", String(set.columnCount + 1));

        const headerStrip = document.createElement("div");
        const header = buildHeader(set);
        const canvas = document.createElement("div");

        // The header sits outside the vertical scroll rather than sticking to
        // the top of it: a sticky header covers whichever row is under it, and a
        // grid should never hide a row. Its horizontal scroll is tied to the
        // body's instead, which is what keeps the columns lined up.
        headerStrip.className = "grid-head-strip";
        headerStrip.appendChild(header);

        canvas.className = "grid-canvas";
        canvas.style.height = `${set.totalRows * rowHeight}px`;

        viewport.appendChild(canvas);

        const footer = document.createElement("div");
        const footerCount = document.createElement("span");
        const footerNotice = document.createElement("span");

        footer.className = "grid-footer";
        footerCount.className = "footer-count";
        footerNotice.className = "footer-notice";

        footer.appendChild(footerCount);
        footer.appendChild(footerNotice);

        wrapper.appendChild(headerStrip);
        wrapper.appendChild(viewport);
        wrapper.appendChild(footer);
        resultsHost.appendChild(wrapper);

        set.tab = tab;
        set.wrapper = wrapper;
        set.viewport = viewport;
        set.headerStrip = headerStrip;
        set.header = header;
        set.canvas = canvas;
        set.footerCount = footerCount;
        set.footerNotice = footerNotice;

        viewport.addEventListener("scroll", function () {
            headerStrip.scrollLeft = viewport.scrollLeft;
            scheduleRender(set);
        });

        viewport.addEventListener("keydown", function (event) {
            onGridKeyDown(set, event);
        });

        viewport.addEventListener("contextmenu", function (event) {
            onGridContextMenu(set, event);
        });

        updateFooter(set);

        return set;
    }

    /**
     * Builds the header row of a grid, including its resize handles.
     *
     * @param {object} set The state of the result set.
     *
     * @returns {HTMLElement} The header row.
     */
    function buildHeader(set) {
        const header = document.createElement("div");

        header.className = "grid-header";
        header.setAttribute("role", "row");

        const corner = document.createElement("div");

        corner.className = "grid-corner";
        corner.setAttribute("role", "columnheader");
        corner.title = "Select every cell";
        corner.style.width = `${gutterWidth}px`;
        corner.addEventListener("click", function () {
            selectAllCells(set);
        });

        header.appendChild(corner);

        for (let column = 0; column < set.columnCount; column++) {
            const cell = document.createElement("div");
            const label = document.createElement("span");
            const resizer = document.createElement("span");

            cell.className = "grid-head-cell";
            cell.setAttribute("role", "columnheader");
            cell.title = set.columns[column].name;

            label.className = "head-label";
            label.textContent = set.columns[column].name;

            resizer.className = "col-resizer";

            cell.appendChild(label);
            cell.appendChild(resizer);
            header.appendChild(cell);

            label.addEventListener("click", function () {
                selectColumn(set, column);
            });

            resizer.addEventListener("mousedown", function (event) {
                beginColumnResize(set, column, event);
            });

            resizer.addEventListener("dblclick", function (event) {
                event.preventDefault();
                autoFitColumn(set, column);
            });
        }

        set.headerCells = Array.prototype.slice.call(header.querySelectorAll(".grid-head-cell"));

        return header;
    }

    /**
     * Updates the footer of a result set.
     *
     * @param {object} set The state of the result set.
     */
    function updateFooter(set) {
        const rows = `${formatCount(set.totalRows)} ${set.totalRows === 1 ? "row" : "rows"}`;

        set.footerCount.textContent = runDurationMs === null
            ? rows
            : `${rows} · ${formatCount(Math.round(runDurationMs))} ms`;

        set.footerNotice.textContent = set.notice ?? "";
    }

    // #endregion

    // #region Row rendering

    /**
     * Renders a set on the next frame, collapsing a burst of scroll events into
     * one pass.
     *
     * @param {object} set The state of the result set.
     */
    function scheduleRender(set) {
        if (set.frameHandle) {
            return;
        }

        set.frameHandle = requestAnimationFrame(function () {
            set.frameHandle = 0;
            renderSet(set);
        });
    }

    /**
     * Renders the rows of a set that are in view, and asks for any it does not
     * hold yet.
     *
     * @param {object} set The state of the result set.
     */
    function renderSet(set) {
        if (set.wrapper.hidden) {
            return;
        }

        const top = set.viewport.scrollTop;
        const first = Math.max(0, Math.floor(top / rowHeight) - overscanRows);
        const last = Math.min(set.totalRows - 1, Math.ceil((top + set.viewport.clientHeight) / rowHeight) + overscanRows);

        for (const entry of Array.from(set.renderedRows.entries())) {
            if (entry[0] < first || entry[0] > last) {
                entry[1].remove();
                set.renderedRows.delete(entry[0]);
            }
        }

        for (let index = first; index <= last; index++) {
            if (!set.renderedRows.has(index)) {
                const row = buildRow(set, index);

                set.canvas.appendChild(row);
                set.renderedRows.set(index, row);
            }
        }

        requestMissingRows(set, first, last);
    }

    /**
     * Builds one row element.
     *
     * @param {object} set The state of the result set.
     * @param {number} index The zero based row index.
     *
     * @returns {HTMLElement} The row element.
     */
    function buildRow(set, index) {
        const payload = set.rows[index];
        const row = document.createElement("div");

        row.className = "grid-row";
        row.setAttribute("role", "row");
        row.setAttribute("aria-rowindex", String(index + 2));
        row.style.top = `${index * rowHeight}px`;
        row.style.height = `${rowHeight}px`;

        const gutter = document.createElement("div");

        gutter.className = "grid-gutter";
        gutter.setAttribute("role", "rowheader");
        gutter.style.width = `${gutterWidth}px`;
        gutter.textContent = formatCount(index + 1);
        gutter.addEventListener("mousedown", function (event) {
            event.preventDefault();
            selectRow(set, index);
        });

        row.appendChild(gutter);

        for (let column = 0; column < set.columnCount; column++) {
            const cell = document.createElement("div");

            cell.className = "grid-cell";
            cell.setAttribute("role", "gridcell");
            cell.setAttribute("aria-colindex", String(column + 2));
            cell.style.width = `${set.widths[column]}px`;

            if (payload) {
                const value = payload[column];

                cell.textContent = value ? value.display : "";

                if (value && value.isNull) {
                    cell.classList.add("is-null");
                }
            }
            else {
                cell.classList.add("is-placeholder");
                cell.textContent = "…";
            }

            cell.addEventListener("mousedown", function (event) {
                onCellMouseDown(set, index, column, event);
            });

            cell.addEventListener("mouseenter", function () {
                onCellMouseEnter(set, index, column);
            });

            cell.addEventListener("dblclick", function () {
                inspectorMode = "cell";
                openInspector(set);
            });

            row.appendChild(cell);
        }

        applyRowSelection(set, row, index);

        return row;
    }

    /**
     * Rebuilds the rendered rows of a range, which is what makes newly arrived
     * rows replace their placeholders.
     *
     * @param {object} set The state of the result set.
     * @param {number} start The first row of the range.
     * @param {number} end The row after the range.
     */
    function invalidateRows(set, start, end) {
        for (let index = start; index < end; index++) {
            const existing = set.renderedRows.get(index);

            if (existing) {
                existing.remove();
                set.renderedRows.delete(index);
            }
        }

        scheduleRender(set);
    }

    /**
     * Asks the extension host for any rows in view that have not arrived.
     *
     * Requests are aligned to fixed blocks and remembered, so scrolling through
     * the same gap twice does not ask twice.
     *
     * @param {object} set The state of the result set.
     * @param {number} first The first row in view.
     * @param {number} last The last row in view.
     */
    function requestMissingRows(set, first, last) {
        for (let index = first; index <= last; index++) {
            if (set.rows[index]) {
                continue;
            }

            // The rows of the initial render are already on their way, so a
            // first paint mid-stream must not ask for them a second time.
            if (set.isStreaming && index < set.initialRows) {
                continue;
            }

            const block = Math.floor(index / rowRequestBlock) * rowRequestBlock;

            if (set.requested[block]) {
                continue;
            }

            set.requested[block] = true;

            vscode.postMessage({
                type: "requestRows",
                resultSet: set.index,
                startRow: block,
                count: rowRequestBlock
            });
        }
    }

    /**
     * Stores a chunk of rows and repaints whatever of it is on screen.
     *
     * @param {object} set The state of the result set.
     * @param {number} startRow The row the chunk starts at.
     * @param {Array} rows The formatted rows.
     */
    function storeRows(set, startRow, rows) {
        for (let offset = 0; offset < rows.length; offset++) {
            set.rows[startRow + offset] = rows[offset];
        }

        invalidateRows(set, startRow, startRow + rows.length);
    }

    // #endregion

    // #region Column widths

    /**
     * Rounds a measured width into the range a column may take.
     *
     * The extra pixel is what keeps a value that measured to a fraction from
     * being ellipsized by its own rounding.
     *
     * @param {number} width The measured width, in pixels.
     *
     * @returns {number} The width to use.
     */
    function clampColumnWidth(width) {
        return Math.min(maxAutoColumnWidth, Math.max(minColumnWidth, Math.ceil(width) + 1));
    }

    /**
     * Measures the columns of a set from its header and the rows it holds.
     *
     * Measuring needs a laid out document, so this is deliberately deferred
     * until the set's tab is showing, and repeated once rows have arrived.
     *
     * @param {object} set The state of the result set.
     */
    function measureColumns(set) {
        if (set.isMeasured || set.wrapper.hidden) {
            return;
        }

        const sample = [];

        for (let index = 0; index < set.totalRows && sample.length < widthSampleRows; index++) {
            if (set.rows[index]) {
                sample.push(set.rows[index]);
            }
        }

        for (let column = 0; column < set.columnCount; column++) {
            let width = measureText(set.columns[column].name) + cellPadding + 10;

            for (const row of sample) {
                const value = row[column];

                if (value && value.display !== "") {
                    width = Math.max(width, measureText(value.display) + cellPadding);
                }
            }

            set.widths[column] = clampColumnWidth(width);
        }

        set.isMeasured = sample.length > 0;

        applyColumnWidths(set);
    }

    /**
     * Pushes the current column widths onto the header, the rendered rows and the
     * grid's own width, which is what gives the grid its horizontal scroll.
     *
     * @param {object} set The state of the result set.
     */
    function applyColumnWidths(set) {
        let total = gutterWidth;

        for (let column = 0; column < set.columnCount; column++) {
            const width = set.widths[column] ?? minColumnWidth;

            total += width;

            set.headerCells[column].style.width = `${width}px`;
        }

        set.header.style.width = `${total}px`;
        set.canvas.style.width = `${total}px`;

        for (const row of set.renderedRows.values()) {
            const cells = row.children;

            for (let column = 0; column < set.columnCount; column++) {
                cells[column + 1].style.width = `${set.widths[column]}px`;
            }
        }
    }

    /**
     * Starts a column resize drag.
     *
     * @param {object} set The state of the result set.
     * @param {number} column The column being resized.
     * @param {MouseEvent} event The mousedown that started the drag.
     */
    function beginColumnResize(set, column, event) {
        event.preventDefault();
        event.stopPropagation();

        const startX = event.clientX;
        const startWidth = set.widths[column] ?? minColumnWidth;

        const onMove = function (moveEvent) {
            set.widths[column] = Math.max(minColumnWidth, Math.round(startWidth + moveEvent.clientX - startX));

            applyColumnWidths(set);
        };

        const onUp = function () {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.classList.remove("is-resizing");
        };

        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        document.body.classList.add("is-resizing");
    }

    /**
     * Sizes one column to the widest of its header and the rows in hand.
     *
     * @param {object} set The state of the result set.
     * @param {number} column The column to fit.
     */
    function autoFitColumn(set, column) {
        let width = measureText(set.columns[column].name) + cellPadding + 10;
        let sampled = 0;

        for (let index = 0; index < set.totalRows && sampled < widthSampleRows; index++) {
            const row = set.rows[index];

            if (!row) {
                continue;
            }

            sampled += 1;

            const value = row[column];

            if (value && value.display !== "") {
                width = Math.max(width, measureText(value.display) + cellPadding);
            }
        }

        set.widths[column] = clampColumnWidth(width);

        applyColumnWidths(set);
    }

    // #endregion

    // #region Selection

    /**
     * Orders the anchor and focus of a selection into a rectangle inside the set.
     *
     * Repeats the arithmetic of `gridSelection.ts`, which is what the extension
     * host applies to the raw rows when the selection is copied.
     *
     * @param {object} set The state of the result set.
     *
     * @returns {object|null} The rectangle, or null when nothing is selected.
     */
    function selectionRect(set) {
        if (!set.selection || set.totalRows === 0 || set.columnCount === 0) {
            return null;
        }

        const anchor = set.selection.anchor;
        const focus = set.selection.focus;

        return {
            startRow: Math.max(0, Math.min(anchor.row, focus.row)),
            startColumn: Math.max(0, Math.min(anchor.column, focus.column)),
            endRow: Math.min(set.totalRows - 1, Math.max(anchor.row, focus.row)),
            endColumn: Math.min(set.columnCount - 1, Math.max(anchor.column, focus.column))
        };
    }

    /**
     * Sets the selection of a set and repaints it.
     *
     * @param {object} set The state of the result set.
     * @param {object} anchor The cell the selection is anchored on.
     * @param {object} focus The active cell.
     */
    function setSelection(set, anchor, focus) {
        set.selection = {
            anchor: anchor,
            focus: focus
        };

        applySelection(set);
        updateSelectionSummary(set);

        if (!inspector.hidden && set === getActiveSet()) {
            openInspector(set);
        }
    }

    /**
     * Applies the selection classes to the rows that are rendered.
     *
     * @param {object} set The state of the result set.
     */
    function applySelection(set) {
        for (const entry of set.renderedRows.entries()) {
            applyRowSelection(set, entry[1], entry[0]);
        }
    }

    /**
     * Applies the selection classes to one row.
     *
     * @param {object} set The state of the result set.
     * @param {HTMLElement} row The row element.
     * @param {number} index The zero based row index.
     */
    function applyRowSelection(set, row, index) {
        const rect = selectionRect(set);
        const focus = set.selection ? set.selection.focus : null;
        const inRows = rect !== null && index >= rect.startRow && index <= rect.endRow;
        const cells = row.children;

        row.classList.toggle("is-selected-row", inRows);

        for (let column = 0; column < set.columnCount; column++) {
            const cell = cells[column + 1];

            cell.classList.toggle("is-selected", inRows && column >= rect.startColumn && column <= rect.endColumn);
            cell.classList.toggle("is-active", focus !== null && focus.row === index && focus.column === column);
        }
    }

    /**
     * Updates the "3 × 2 selected" text in the toolbar.
     *
     * @param {object} set The state of the result set.
     */
    function updateSelectionSummary(set) {
        // Every set shares the one toolbar, so a set that is not showing must
        // not describe its own selection there.
        if (set !== getActiveSet()) {
            return;
        }

        const rect = selectionRect(set);

        if (!rect) {
            selectionSummary.textContent = "";

            return;
        }

        const rows = rect.endRow - rect.startRow + 1;
        const columns = rect.endColumn - rect.startColumn + 1;

        selectionSummary.textContent = rows === 1 && columns === 1
            ? `Row ${formatCount(rect.startRow + 1)}, ${set.columns[rect.startColumn].name}`
            : `${formatCount(rows)} × ${formatCount(columns)} selected`;
    }

    /**
     * Selects every cell of a set.
     *
     * @param {object} set The state of the result set.
     */
    function selectAllCells(set) {
        if (set.totalRows === 0 || set.columnCount === 0) {
            return;
        }

        setSelection(set, { row: 0, column: 0 }, { row: set.totalRows - 1, column: set.columnCount - 1 });
    }

    /**
     * Selects a whole column.
     *
     * @param {object} set The state of the result set.
     * @param {number} column The column to select.
     */
    function selectColumn(set, column) {
        if (set.totalRows === 0) {
            return;
        }

        setSelection(set, { row: 0, column: column }, { row: set.totalRows - 1, column: column });
        set.viewport.focus({ preventScroll: true });
    }

    /**
     * Selects a whole row.
     *
     * @param {object} set The state of the result set.
     * @param {number} index The row to select.
     */
    function selectRow(set, index) {
        if (set.columnCount === 0) {
            return;
        }

        setSelection(set, { row: index, column: 0 }, { row: index, column: set.columnCount - 1 });
        set.viewport.focus({ preventScroll: true });
    }

    /**
     * Starts a click, a shift click or a drag on a cell.
     *
     * @param {object} set The state of the result set.
     * @param {number} row The row that was pressed.
     * @param {number} column The column that was pressed.
     * @param {MouseEvent} event The mousedown event.
     */
    function onCellMouseDown(set, row, column, event) {
        if (event.button === 2) {
            // The context menu handler deals with a right click, and moving the
            // selection out from under it would be surprising.
            if (!isCellSelected(set, row, column)) {
                setSelection(set, { row: row, column: column }, { row: row, column: column });
            }

            return;
        }

        event.preventDefault();
        closeMenus();
        set.viewport.focus({ preventScroll: true });

        if (event.shiftKey && set.selection) {
            setSelection(set, set.selection.anchor, { row: row, column: column });

            return;
        }

        setSelection(set, { row: row, column: column }, { row: row, column: column });

        set.isDragging = true;

        const onUp = function () {
            set.isDragging = false;
            document.removeEventListener("mouseup", onUp);
        };

        document.addEventListener("mouseup", onUp);
    }

    /**
     * Extends a drag as the pointer moves across cells.
     *
     * @param {object} set The state of the result set.
     * @param {number} row The row the pointer entered.
     * @param {number} column The column the pointer entered.
     */
    function onCellMouseEnter(set, row, column) {
        if (!set.isDragging || !set.selection) {
            return;
        }

        setSelection(set, set.selection.anchor, { row: row, column: column });
    }

    /**
     * Determines whether a cell is inside the current selection.
     *
     * @param {object} set The state of the result set.
     * @param {number} row The row of the cell.
     * @param {number} column The column of the cell.
     *
     * @returns {boolean} True when the cell is selected.
     */
    function isCellSelected(set, row, column) {
        const rect = selectionRect(set);

        return rect !== null
            && row >= rect.startRow
            && row <= rect.endRow
            && column >= rect.startColumn
            && column <= rect.endColumn;
    }

    /**
     * Moves the active cell, extending the selection when asked.
     *
     * @param {object} set The state of the result set.
     * @param {number} rowDelta How far to move vertically.
     * @param {number} columnDelta How far to move horizontally.
     * @param {boolean} extend True to keep the anchor where it is.
     */
    function moveActiveCell(set, rowDelta, columnDelta, extend) {
        if (set.totalRows === 0 || set.columnCount === 0) {
            return;
        }

        const current = set.selection ? set.selection.focus : { row: 0, column: 0 };
        const focus = {
            row: Math.max(0, Math.min(set.totalRows - 1, current.row + rowDelta)),
            column: Math.max(0, Math.min(set.columnCount - 1, current.column + columnDelta))
        };

        setSelection(set, extend && set.selection ? set.selection.anchor : focus, focus);
        scrollCellIntoView(set, focus);
    }

    /**
     * Scrolls a cell into view.
     *
     * @param {object} set The state of the result set.
     * @param {object} cell The cell to reveal.
     */
    function scrollCellIntoView(set, cell) {
        const top = cell.row * rowHeight;
        const visibleTop = set.viewport.scrollTop;
        const visibleBottom = visibleTop + set.viewport.clientHeight;

        if (top < visibleTop) {
            set.viewport.scrollTop = top;
        }
        else if (top + rowHeight > visibleBottom) {
            set.viewport.scrollTop = top + rowHeight - set.viewport.clientHeight;
        }

        let left = gutterWidth;

        for (let column = 0; column < cell.column; column++) {
            left += set.widths[column] ?? minColumnWidth;
        }

        const width = set.widths[cell.column] ?? minColumnWidth;

        if (left - gutterWidth < set.viewport.scrollLeft) {
            set.viewport.scrollLeft = Math.max(0, left - gutterWidth);
        }
        else if (left + width > set.viewport.scrollLeft + set.viewport.clientWidth) {
            set.viewport.scrollLeft = left + width - set.viewport.clientWidth;
        }

        scheduleRender(set);
    }

    // #endregion

    // #region Clipboard and export

    /**
     * Asks the extension host to copy the current selection.
     *
     * @param {object} set The state of the result set.
     * @param {string} format The format to copy as.
     */
    function copySelection(set, format) {
        const rect = selectionRect(set);

        if (!rect) {
            return;
        }

        vscode.postMessage({
            type: "copySelection",
            resultSet: set.index,
            startRow: rect.startRow,
            startColumn: rect.startColumn,
            endRow: rect.endRow,
            endColumn: rect.endColumn,
            format: format
        });
    }

    /**
     * Asks the extension host to export a result set, or all of them.
     *
     * @param {number|string} target The index of the set, or "all".
     * @param {string} format The format to export to.
     */
    function requestExport(target, format) {
        vscode.postMessage({
            type: "exportResultSet",
            resultSet: target,
            format: format
        });
    }

    // #endregion

    // #region Inspector

    /**
     * Opens the inspector on the active cell or the active row.
     *
     * @param {object} set The state of the result set.
     */
    function openInspector(set) {
        const rect = selectionRect(set);

        if (!rect) {
            return;
        }

        const payload = set.rows[rect.startRow];

        inspector.hidden = false;
        clearElement(inspectorBody);

        if (!payload) {
            inspectorTitle.textContent = `Row ${formatCount(rect.startRow + 1)}`;
            inspectorKind.textContent = "loading";

            const pending = document.createElement("p");

            pending.className = "inspector-pending";
            pending.textContent = "This row has not been loaded yet.";

            inspectorBody.appendChild(pending);

            return;
        }

        if (inspectorMode === "row") {
            renderRowInspector(set, rect.startRow, payload);

            return;
        }

        renderCellInspector(set, rect.startRow, rect.startColumn, payload[rect.startColumn]);
    }

    /**
     * Renders one cell in the inspector, presented by what it appears to hold.
     *
     * @param {object} set The state of the result set.
     * @param {number} row The row of the cell.
     * @param {number} column The column of the cell.
     * @param {object} value The formatted cell.
     */
    function renderCellInspector(set, row, column, value) {
        inspectorTitle.textContent = `${set.columns[column].name} · row ${formatCount(row + 1)}`;

        if (!value) {
            inspectorKind.textContent = "";

            return;
        }

        if (value.isNull) {
            inspectorKind.textContent = "null";

            const empty = document.createElement("p");

            empty.className = "inspector-null";
            empty.textContent = "NULL";

            inspectorBody.appendChild(empty);

            return;
        }

        const kind = detectCellContent(value.display);
        const block = document.createElement("pre");

        inspectorKind.textContent = kind;
        block.className = kind === "text" ? "inspector-text" : "inspector-code";
        block.textContent = kind === "json" ? prettyPrintJson(value.display) : value.display;

        inspectorBody.appendChild(block);
    }

    /**
     * Renders a whole row in the inspector, transposed into name and value pairs.
     *
     * @param {object} set The state of the result set.
     * @param {number} row The row to show.
     * @param {Array} payload The formatted cells of the row.
     */
    function renderRowInspector(set, row, payload) {
        inspectorTitle.textContent = `Row ${formatCount(row + 1)}`;
        inspectorKind.textContent = `${formatCount(set.columnCount)} ${set.columnCount === 1 ? "column" : "columns"}`;

        const list = document.createElement("dl");

        list.className = "inspector-record";

        for (let column = 0; column < set.columnCount; column++) {
            const name = document.createElement("dt");
            const value = document.createElement("dd");
            const cell = payload[column];

            name.textContent = set.columns[column].name;

            if (cell && cell.isNull) {
                value.classList.add("is-null");
                value.textContent = "NULL";
            }
            else {
                value.textContent = cell ? cell.display : "";
            }

            list.appendChild(name);
            list.appendChild(value);
        }

        inspectorBody.appendChild(list);
    }

    /**
     * Closes the inspector.
     */
    function closeInspector() {
        inspector.hidden = true;

        clearElement(inspectorBody);
    }

    // #endregion

    // #region Menus

    /**
     * Builds a dropdown menu under a toolbar button.
     *
     * @param {HTMLElement} host The element that holds the button.
     * @param {HTMLElement} button The button that opens the menu.
     * @param {Array} items The entries, each with a label and an action.
     */
    function buildDropdown(host, button, items) {
        const menu = document.createElement("div");

        menu.className = "menu";
        menu.setAttribute("role", "menu");
        menu.hidden = true;

        for (const item of items) {
            menu.appendChild(buildMenuEntry(item, function () {
                menu.hidden = true;
                button.setAttribute("aria-expanded", "false");
            }));
        }

        host.appendChild(menu);

        button.addEventListener("click", function (event) {
            event.stopPropagation();

            const willOpen = menu.hidden;

            closeMenus();

            menu.hidden = !willOpen;
            button.setAttribute("aria-expanded", willOpen ? "true" : "false");

            if (willOpen) {
                const first = menu.querySelector(".menu-item");

                if (first) {
                    first.focus();
                }
            }
        });
    }

    /**
     * Builds one entry of a menu.
     *
     * @param {object} item The entry, with a label, an action and an optional separator flag.
     * @param {Function} afterAction Called once the action has run.
     *
     * @returns {HTMLElement} The entry element.
     */
    function buildMenuEntry(item, afterAction) {
        if (item.separator) {
            const separator = document.createElement("div");

            separator.className = "menu-separator";
            separator.setAttribute("role", "separator");
            separator.textContent = item.label ?? "";

            return separator;
        }

        const entry = document.createElement("button");

        entry.type = "button";
        entry.className = "menu-item";
        entry.setAttribute("role", "menuitem");
        entry.textContent = item.label;
        entry.disabled = item.isEnabled === false;
        entry.addEventListener("click", function (event) {
            event.stopPropagation();

            item.action();

            if (afterAction) {
                afterAction();
            }
        });

        return entry;
    }

    /**
     * Closes every open menu, dropdown or context.
     */
    function closeMenus() {
        for (const menu of document.querySelectorAll(".menu")) {
            menu.hidden = true;
        }

        for (const button of document.querySelectorAll("[aria-haspopup='true']")) {
            button.setAttribute("aria-expanded", "false");
        }

        contextMenu.hidden = true;
    }

    /**
     * Builds the entries of the Copy as… menu for a set.
     *
     * @param {object} set The state of the result set.
     *
     * @returns {Array} The entries.
     */
    function copyEntries(set) {
        return copyMenuItems.map(function (item) {
            return {
                label: item.label,
                action: function () {
                    copySelection(set, item.format);
                }
            };
        });
    }

    /**
     * Builds the entries of the Export… menu for a set.
     *
     * @param {object} set The state of the result set.
     *
     * @returns {Array} The entries.
     */
    function exportEntries(set) {
        const entries = exportMenuItems.map(function (item) {
            return {
                label: item.label,
                action: function () {
                    requestExport(set.index, item.format);
                }
            };
        });

        entries.push({
            separator: true,
            label: "All result sets"
        });

        for (const item of exportMenuItems) {
            entries.push({
                label: item.label,
                action: function () {
                    requestExport("all", item.format);
                }
            });
        }

        return entries;
    }

    /**
     * Opens the grid's own context menu.
     *
     * A custom menu rather than the platform one, because the platform menu of a
     * webview offers a browser's commands, not a grid's.
     *
     * @param {object} set The state of the result set.
     * @param {MouseEvent} event The contextmenu event.
     */
    function onGridContextMenu(set, event) {
        event.preventDefault();
        closeMenus();
        clearElement(contextMenu);

        const entries = [{
            label: "Copy",
            action: function () {
                copySelection(set, "tabDelimited");
            }
        }, {
            separator: true,
            label: "Copy as"
        }];

        for (const entry of copyEntries(set)) {
            entries.push(entry);
        }

        entries.push({
            separator: true,
            label: "Inspect"
        }, {
            label: "Inspect cell",
            action: function () {
                inspectorMode = "cell";
                openInspector(set);
            }
        }, {
            label: "Inspect row",
            action: function () {
                inspectorMode = "row";
                transposeButton.setAttribute("aria-pressed", "true");
                openInspector(set);
            }
        }, {
            separator: true,
            label: "Export"
        });

        for (const entry of exportEntries(set)) {
            entries.push(entry);
        }

        for (const entry of entries) {
            contextMenu.appendChild(buildMenuEntry(entry, closeMenus));
        }

        contextMenu.hidden = false;

        // Placed after being shown so that its measured size can keep it on
        // screen. Setting the properties through the CSSOM keeps the content
        // security policy out of it.
        const bounds = contextMenu.getBoundingClientRect();
        const left = Math.min(event.clientX, Math.max(0, window.innerWidth - bounds.width - 4));
        const top = Math.min(event.clientY, Math.max(0, window.innerHeight - bounds.height - 4));

        contextMenu.style.left = `${left}px`;
        contextMenu.style.top = `${top}px`;

        const first = contextMenu.querySelector(".menu-item");

        if (first) {
            first.focus();
        }
    }

    // #endregion

    // #region Keyboard

    /**
     * Handles a key press inside a grid.
     *
     * @param {object} set The state of the result set.
     * @param {KeyboardEvent} event The keydown event.
     */
    function onGridKeyDown(set, event) {
        const accel = event.ctrlKey || event.metaKey;

        if (accel && (event.key === "a" || event.key === "A")) {
            event.preventDefault();
            selectAllCells(set);

            return;
        }

        if (accel && (event.key === "c" || event.key === "C")) {
            event.preventDefault();
            copySelection(set, "tabDelimited");

            return;
        }

        if (event.key === "Escape") {
            closeMenus();
            closeInspector();

            return;
        }

        if (event.key === "Enter") {
            event.preventDefault();
            openInspector(set);

            return;
        }

        const rowsPerPage = Math.max(1, Math.floor(set.viewport.clientHeight / rowHeight) - 1);

        if (event.key === "ArrowDown") {
            event.preventDefault();
            moveActiveCell(set, 1, 0, event.shiftKey);
        }
        else if (event.key === "ArrowUp") {
            event.preventDefault();
            moveActiveCell(set, -1, 0, event.shiftKey);
        }
        else if (event.key === "ArrowRight") {
            event.preventDefault();
            moveActiveCell(set, 0, 1, event.shiftKey);
        }
        else if (event.key === "ArrowLeft") {
            event.preventDefault();
            moveActiveCell(set, 0, -1, event.shiftKey);
        }
        else if (event.key === "PageDown") {
            event.preventDefault();
            moveActiveCell(set, rowsPerPage, 0, event.shiftKey);
        }
        else if (event.key === "PageUp") {
            event.preventDefault();
            moveActiveCell(set, -rowsPerPage, 0, event.shiftKey);
        }
        else if (event.key === "Home") {
            event.preventDefault();
            moveActiveCell(set, accel ? -set.totalRows : 0, -set.columnCount, event.shiftKey);
        }
        else if (event.key === "End") {
            event.preventDefault();
            moveActiveCell(set, accel ? set.totalRows : 0, set.columnCount, event.shiftKey);
        }
    }

    // #endregion

    // #region Message pump

    /**
     * Renders the "a run has started" message.
     *
     * @param {object} message The validated message.
     */
    function onRunStarted(message) {
        serverLabel.textContent = message.serverLabel;
        statementPreview.textContent = message.statementPreview;

        clearMessages();
        resetResultSets();

        startedAt = Date.now();

        setRunning(true);
        setStatus("Running…", false);
    }

    /**
     * Renders the messages the server emitted.
     *
     * @param {object} message The validated message.
     */
    function onMessages(message) {
        for (const entry of message.messages) {
            appendLine(entry.message, isErrorMessage(entry), typeof entry.lineNumber === "number" ? entry.lineNumber : null);
        }
    }

    /**
     * Creates the tab and the grid of a result set that is about to stream.
     *
     * @param {object} message The validated message.
     */
    function onResultSetStart(message) {
        const set = createSet(message);

        sets[message.index] = set;

        // The first result set is what the person ran the query for, so it takes
        // the focus as soon as it exists. This repeats `defaultPanelTab`.
        if (message.index === 0) {
            activateTab(0);
        }

        if (message.truncatedNotice) {
            appendLine(message.truncatedNotice, false, null);
        }
    }

    /**
     * Stores a chunk of rows.
     *
     * @param {object} message The validated message.
     */
    function onResultSetRows(message) {
        const set = sets[message.index];

        if (!set) {
            return;
        }

        storeRows(set, message.startRow, message.rows);

        if (!set.isMeasured) {
            measureColumns(set);
        }
    }

    /**
     * Finishes the initial render of a result set.
     *
     * @param {object} message The validated message.
     */
    function onResultSetEnd(message) {
        const set = sets[message.index];

        if (!set) {
            return;
        }

        set.isStreaming = false;

        measureColumns(set);

        if (!set.selection && set.totalRows > 0 && set.columnCount > 0) {
            setSelection(set, { row: 0, column: 0 }, { row: 0, column: 0 });
        }

        renderSet(set);
    }

    /**
     * Stores rows that were asked for while scrolling.
     *
     * @param {object} message The validated message.
     */
    function onMoreRows(message) {
        const set = sets[message.index];

        if (!set) {
            return;
        }

        storeRows(set, message.startRow, message.rows);

        if (message.rows.length === 0) {
            // Nothing came back for that block, so stop asking for it forever
            // while still allowing a later, different request.
            const block = Math.floor(message.startRow / rowRequestBlock) * rowRequestBlock;

            set.requested[block] = true;
        }
    }

    /**
     * Renders the end of a run.
     *
     * @param {object} message The validated message.
     */
    function onRunCompleted(message) {
        setRunning(false);

        runDurationMs = message.durationMs;

        for (const set of sets) {
            if (set) {
                updateFooter(set);
            }
        }

        if (message.status === "cancelled") {
            setStatus(`Cancelled after ${formatDuration(message.durationMs)}`, false);
            appendLine("The query was cancelled.", false, null);

            return;
        }

        if (message.status === "failed") {
            setStatus(`Failed after ${formatDuration(message.durationMs)}`, true);

            if (message.errorMessage) {
                appendLine(message.errorMessage, true, null);
            }

            return;
        }

        setStatus(`Completed in ${formatDuration(message.durationMs)}`, false);

        if (message.resultSets) {
            const setText = `${message.resultSets.setCount} result ${message.resultSets.setCount === 1 ? "set" : "sets"}`;
            const rowText = `${formatCount(message.resultSets.rowCount)} ${message.resultSets.rowCount === 1 ? "row" : "rows"}`;

            appendLine(`${setText} (${rowText})`, false, null);
        }

        if (messageCount === 0) {
            appendEmptyPlaceholder();
        }
    }

    /**
     * Validates a message that arrived from the extension host and renders it.
     *
     * The checks repeat the authoritative ones in `panelProtocol.ts`, which is
     * TypeScript this file cannot import. Anything unrecognized is ignored.
     *
     * @param {unknown} data The value the extension host posted.
     */
    function handleMessage(data) {
        if (typeof data !== "object" || data === null) {
            return;
        }

        if (data.type === "runStarted" && typeof data.serverLabel === "string" && typeof data.statementPreview === "string") {
            onRunStarted(data);

            return;
        }

        if (data.type === "messages" && Array.isArray(data.messages)) {
            onMessages(data);

            return;
        }

        if (data.type === "resultSetStart" && Array.isArray(data.columns) && typeof data.index === "number" && typeof data.totalRows === "number") {
            onResultSetStart(data);

            return;
        }

        if (data.type === "resultSetRows" && Array.isArray(data.rows) && typeof data.index === "number" && typeof data.startRow === "number") {
            onResultSetRows(data);

            return;
        }

        if (data.type === "resultSetEnd" && typeof data.index === "number") {
            onResultSetEnd(data);

            return;
        }

        if (data.type === "moreRows" && Array.isArray(data.rows) && typeof data.index === "number" && typeof data.startRow === "number") {
            onMoreRows(data);

            return;
        }

        if (data.type === "runCompleted" && typeof data.durationMs === "number") {
            onRunCompleted(data);
        }
    }

    // #endregion

    // #region Wiring

    cancelButton.addEventListener("click", function () {
        if (!isRunning) {
            return;
        }

        setStatus("Cancelling…", false);

        vscode.postMessage({
            type: "cancelRun"
        });
    });

    messagesTab.addEventListener("click", function () {
        activateTab("messages");
    });

    inspectorClose.addEventListener("click", function () {
        closeInspector();
    });

    transposeButton.addEventListener("click", function () {
        const set = getActiveSet();

        inspectorMode = inspectorMode === "row" ? "cell" : "row";
        transposeButton.setAttribute("aria-pressed", inspectorMode === "row" ? "true" : "false");

        if (set) {
            openInspector(set);
        }
    });

    buildDropdown(document.getElementById("copy-menu-host"), document.getElementById("copy-menu-button"), copyMenuItems.map(function (item) {
        return {
            label: item.label,
            action: function () {
                const set = getActiveSet();

                if (set) {
                    copySelection(set, item.format);
                }
            }
        };
    }));

    buildDropdown(document.getElementById("export-menu-host"), document.getElementById("export-menu-button"), (function () {
        const entries = exportMenuItems.map(function (item) {
            return {
                label: item.label,
                action: function () {
                    const set = getActiveSet();

                    if (set) {
                        requestExport(set.index, item.format);
                    }
                }
            };
        });

        entries.push({
            separator: true,
            label: "All result sets"
        });

        for (const item of exportMenuItems) {
            entries.push({
                label: item.label,
                action: function () {
                    requestExport("all", item.format);
                }
            });
        }

        return entries;
    }()));

    document.addEventListener("click", function () {
        closeMenus();
    });

    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
            closeMenus();
        }
    });

    window.addEventListener("resize", function () {
        const set = getActiveSet();

        if (set) {
            scheduleRender(set);
        }
    });

    window.addEventListener("message", function (event) {
        handleMessage(event.data);
    });

    vscode.postMessage({
        type: "ready"
    });

    // #endregion
}());
