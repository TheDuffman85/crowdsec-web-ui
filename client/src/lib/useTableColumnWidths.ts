import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import type { TableColumnPreferenceTable } from '../types';
import {
    MAX_TABLE_COLUMN_WIDTH,
    MIN_TABLE_COLUMN_WIDTH,
    clampTableColumnWidth,
    loadStoredTableColumnWidths,
    saveStoredTableColumnWidths,
    type TableColumnWidths,
} from './tableColumns';

export interface TableLayoutColumn {
    id: string;
    /** Makes the column non-resizable, for columns whose content has a known size. */
    fixedWidth?: number;
    /** Used when the column has no stored width yet, like one that was just made visible. */
    defaultWidth?: number;
}

interface TableLayout {
    /** The column without a width takes up the space left when the others do not fill the table. */
    cols: { id: string; width: number | undefined }[];
    totalWidth: number;
}

interface ColumnDrag {
    columnId: string;
    columns: TableLayoutColumn[];
    handle: HTMLElement;
    threshold: number;
    startX: number;
    x: number;
    /** Physical direction of the last movement, so a drag away from an edge does not scroll towards it. */
    movement: number;
    active: boolean;
    baseWidths: TableColumnWidths;
    currentWidths: TableColumnWidths;
    startWidth: number;
    scrolled: number;
    frame: number | null;
    isRtl: boolean;
    scroller: HTMLElement | null;
    paneStart: number;
    paneEnd: number;
    firstHiddenRow: HTMLTableRowElement | null;
    stopListening: () => void;
}

const DEFAULT_COLUMN_WIDTH = 180;
const MOUSE_DRAG_THRESHOLD = 2;
const TOUCH_DRAG_THRESHOLD = 6;
const DOUBLE_TAP_MS = 350;
const KEYBOARD_STEP = 16;
const KEYBOARD_LARGE_STEP = 64;
const OFFSCREEN_ROW_MARGIN = 200;
const ROWS_SHOWN_PER_FRAME = 50;
const EDGE_SCROLL_ZONE = 40;
const EDGE_SCROLL_MAX_SPEED = 14;

function computeLayout(columns: TableLayoutColumn[], widths: TableColumnWidths): TableLayout {
    const flexColumn = columns.findLast((column) => column.fixedWidth === undefined);
    let totalWidth = 0;
    const cols = columns.map((column) => {
        const width = column.fixedWidth ?? widths[column.id] ?? column.defaultWidth ?? DEFAULT_COLUMN_WIDTH;
        totalWidth += width;
        return { id: column.id, width: column === flexColumn ? undefined : width };
    });
    return { cols, totalWidth };
}

// Dragging writes to the DOM directly and only commits to React state at the end, since a state
// update per pointer move would re-render every row of the table.
function applyLayout(table: HTMLTableElement, layout: TableLayout): void {
    table.dataset.columnWidths = 'fixed';
    table.style.width = `${layout.totalWidth}px`;
    getColElements(table).forEach((col, index) => {
        const width = layout.cols[index]?.width;
        col.style.width = width === undefined ? '' : `${width}px`;
    });
}

function clearLayout(table: HTMLTableElement): void {
    delete table.dataset.columnWidths;
    table.style.width = '';
    getColElements(table).forEach((col) => {
        col.style.width = '';
    });
}

function getColElements(table: HTMLTableElement): NodeListOf<HTMLTableColElement> {
    return table.querySelectorAll<HTMLTableColElement>(':scope > colgroup > col');
}

function readHeaderWidths(table: HTMLTableElement): TableColumnWidths {
    const widths: TableColumnWidths = {};
    table.querySelectorAll<HTMLElement>(':scope > thead th[data-column-id]').forEach((header) => {
        widths[header.dataset.columnId as string] = clampTableColumnWidth(header.getBoundingClientRect().width);
    });
    return widths;
}

/** Lays the table out for its content once and reads the width of a column from that. */
function measureContentWidth(table: HTMLTableElement, columnId: string): number | null {
    const header = table.querySelector<HTMLElement>(`:scope > thead th[data-column-id="${columnId}"]`);
    if (!header) return null;

    const colWidths = Array.from(getColElements(table), (col) => col.style.width);
    const previousMode = table.dataset.columnWidths;
    const previousWidth = table.style.width;
    clearLayout(table);
    table.dataset.columnWidths = 'measuring';
    const width = header.getBoundingClientRect().width;

    if (previousMode) table.dataset.columnWidths = previousMode;
    else delete table.dataset.columnWidths;
    table.style.width = previousWidth;
    getColElements(table).forEach((col, index) => {
        col.style.width = colWidths[index] ?? '';
    });
    return clampTableColumnWidth(width);
}

/**
 * Takes the rows below the viewport out of the layout for the duration of a drag, so that its
 * cost stays the same however many rows are loaded. The header is in view while dragging, so
 * there are no rows above the viewport. The margin keeps the height of the page unchanged.
 */
function hideRowsBelowViewport(table: HTMLTableElement): HTMLTableRowElement | null {
    const rows = table.tBodies[0]?.rows;
    if (!rows) return null;

    const limit = window.innerHeight + OFFSCREEN_ROW_MARGIN;
    let start = 0;
    let end = rows.length;
    while (start < end) {
        const middle = Math.floor((start + end) / 2);
        if ((rows[middle] as HTMLTableRowElement).getBoundingClientRect().top > limit) end = middle;
        else start = middle + 1;
    }

    const firstHiddenRow = rows[start];
    if (!firstHiddenRow) return null;

    const hiddenHeight = table.getBoundingClientRect().bottom - firstHiddenRow.getBoundingClientRect().top;
    firstHiddenRow.dataset.hideFromHere = '';
    table.style.marginBottom = `${hiddenHeight}px`;
    return firstHiddenRow;
}

/**
 * Brings the rows back over several frames, since rendering them all at once can block the page
 * for a noticeable time on a long table. They are out of view, so this does not show.
 * Returns a function that finishes right away.
 */
function showHiddenRows(table: HTMLTableElement, firstHiddenRow: HTMLTableRowElement): () => void {
    const fullHeight = table.getBoundingClientRect().height + (parseFloat(table.style.marginBottom) || 0);
    let hiddenRow: HTMLTableRowElement | null = firstHiddenRow;
    let frame: number | null = null;

    const finish = () => {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        if (hiddenRow) delete hiddenRow.dataset.hideFromHere;
        hiddenRow = null;
        table.style.marginBottom = '';
    };

    const showNextRows = () => {
        let nextRow: Element | null = hiddenRow;
        for (let count = 0; count < ROWS_SHOWN_PER_FRAME && nextRow; count += 1) {
            nextRow = nextRow.nextElementSibling;
        }
        if (!nextRow || !hiddenRow) {
            finish();
            return;
        }

        delete hiddenRow.dataset.hideFromHere;
        hiddenRow = nextRow as HTMLTableRowElement;
        hiddenRow.dataset.hideFromHere = '';
        table.style.marginBottom = `${Math.max(0, fullHeight - table.getBoundingClientRect().height)}px`;
        frame = requestAnimationFrame(showNextRows);
    };

    frame = requestAnimationFrame(showNextRows);
    return finish;
}

function getInlineEndEdge(element: Element, isRtl: boolean): number {
    const rect = element.getBoundingClientRect();
    return isRtl ? rect.left : rect.right;
}

/** Physical pixels to scroll this frame, when the pointer is pushed against an edge of the visible columns. */
function getEdgeScrollSpeed(drag: ColumnDrag): number {
    if (!drag.scroller) return 0;

    let speed = 0;
    if (drag.movement > 0 && drag.x > drag.paneEnd - EDGE_SCROLL_ZONE) {
        speed = Math.min(1, (drag.x - (drag.paneEnd - EDGE_SCROLL_ZONE)) / EDGE_SCROLL_ZONE) * EDGE_SCROLL_MAX_SPEED;
    } else if (drag.movement < 0 && drag.x < drag.paneStart + EDGE_SCROLL_ZONE) {
        speed = Math.max(-1, (drag.x - (drag.paneStart + EDGE_SCROLL_ZONE)) / EDGE_SCROLL_ZONE) * EDGE_SCROLL_MAX_SPEED;
    }
    if (speed === 0) return 0;

    const widthDirection = drag.isRtl ? -1 : 1;
    const currentWidth = drag.currentWidths[drag.columnId] ?? drag.startWidth;
    // Growing the column makes the room to scroll into, while shrinking it needs scrolled content to bring back.
    const canScroll = speed * widthDirection > 0
        ? currentWidth < MAX_TABLE_COLUMN_WIDTH
        : currentWidth > MIN_TABLE_COLUMN_WIDTH && drag.scroller.scrollLeft !== 0;
    return canScroll ? speed : 0;
}

export function useTableColumnWidths(
    table: TableColumnPreferenceTable,
    tableRef: RefObject<HTMLTableElement | null>,
    columns: TableLayoutColumn[],
) {
    const [widths, setWidths] = useState<TableColumnWidths>(() => loadStoredTableColumnWidths(table));
    const dragRef = useRef<ColumnDrag | null>(null);
    const lastTapRef = useRef<{ columnId: string; time: number } | null>(null);
    const finishShowingRowsRef = useRef<(() => void) | null>(null);

    const hasCustomWidths = Object.keys(widths).length > 0;
    const layout = computeLayout(columns, hasCustomWidths ? widths : {});

    const commitWidths = useCallback((nextWidths: TableColumnWidths) => {
        setWidths(nextWidths);
        saveStoredTableColumnWidths(table, nextWidths);
    }, [table]);

    const resetWidths = useCallback(() => {
        commitWidths({});
    }, [commitWidths]);

    const endDrag = useCallback((drag: ColumnDrag) => {
        if (drag.frame !== null) cancelAnimationFrame(drag.frame);
        if (drag.firstHiddenRow && tableRef.current) {
            finishShowingRowsRef.current = showHiddenRows(tableRef.current, drag.firstHiddenRow);
        }
        drag.stopListening();
        drag.handle.removeAttribute('data-resizing');
        dragRef.current = null;
    }, [tableRef]);

    useEffect(() => () => {
        if (dragRef.current) endDrag(dragRef.current);
        finishShowingRowsRef.current?.();
    }, [endDrag]);

    const writeDragWidth = (drag: ColumnDrag, edgeScroll: number) => {
        const tableElement = tableRef.current;
        if (!tableElement) return;

        const distance = drag.x - drag.startX + drag.scrolled + edgeScroll;
        const width = clampTableColumnWidth(drag.startWidth + (drag.isRtl ? -distance : distance));
        drag.currentWidths = { ...drag.baseWidths, [drag.columnId]: width };
        applyLayout(tableElement, computeLayout(drag.columns, drag.currentWidths));
    };

    const runDragFrame = (drag: ColumnDrag) => {
        drag.frame = null;
        const speed = getEdgeScrollSpeed(drag);
        writeDragWidth(drag, speed);

        if (speed !== 0 && drag.scroller) {
            const scrollLeft = drag.scroller.scrollLeft;
            drag.scroller.scrollLeft = scrollLeft + speed;
            drag.scrolled += drag.scroller.scrollLeft - scrollLeft;
            // The pointer may rest at the edge without any further events to drive the scrolling.
            drag.frame = requestAnimationFrame(() => runDragFrame(drag));
        }
    };

    const activateDrag = (drag: ColumnDrag, tableElement: HTMLTableElement) => {
        const header = drag.handle.closest('th');
        if (!header) return;

        finishShowingRowsRef.current?.();
        const measuredWidths = readHeaderWidths(tableElement);
        const edgeBefore = getInlineEndEdge(header, drag.isRtl);
        // Without custom widths the columns are frozen as they are. With them, the stored width is
        // kept for the last column, which may be stretched to fill the table.
        drag.baseWidths = hasCustomWidths ? { ...widths } : { ...widths, ...measuredWidths };
        drag.startWidth = measuredWidths[drag.columnId] ?? DEFAULT_COLUMN_WIDTH;
        drag.currentWidths = { ...drag.baseWidths, [drag.columnId]: drag.startWidth };
        drag.firstHiddenRow = hideRowsBelowViewport(tableElement);
        applyLayout(tableElement, computeLayout(drag.columns, drag.currentWidths));

        // The first switch to the fixed layout can move the columns. The edge stays under the pointer.
        if (!hasCustomWidths) {
            drag.startX += getInlineEndEdge(header, drag.isRtl) - edgeBefore;
        }

        const scroller = drag.scroller;
        if (scroller) {
            const rect = scroller.getBoundingClientRect();
            const pinnedHeader = scroller.querySelector('thead th:last-child');
            const pinnedWidth = pinnedHeader && getComputedStyle(pinnedHeader).position === 'sticky'
                ? pinnedHeader.getBoundingClientRect().width
                : 0;
            drag.paneStart = rect.left + (drag.isRtl ? pinnedWidth : 0);
            drag.paneEnd = rect.right - (drag.isRtl ? 0 : pinnedWidth);
        }

        drag.active = true;
        drag.handle.setAttribute('data-resizing', '');
    };

    const cancelDrag = (drag: ColumnDrag) => {
        const tableElement = tableRef.current;
        if (drag.active && tableElement) {
            if (hasCustomWidths) applyLayout(tableElement, layout);
            else clearLayout(tableElement);
        }
        endDrag(drag);
    };

    const commitDrag = (drag: ColumnDrag) => {
        writeDragWidth(drag, 0);
        commitWidths(drag.currentWidths);
        endDrag(drag);
        lastTapRef.current = null;
    };

    // A release can go unreported, like outside of the window. The drag must not stick to the pointer then.
    const finishUnreleasedDrag = (drag: ColumnDrag) => {
        if (drag.active) commitDrag(drag);
        else endDrag(drag);
    };

    const fitColumnToContent = (columnId: string) => {
        const tableElement = tableRef.current;
        if (!tableElement) return;

        finishShowingRowsRef.current?.();
        const measuredWidths = hasCustomWidths ? {} : readHeaderWidths(tableElement);
        const contentWidth = measureContentWidth(tableElement, columnId);
        if (contentWidth !== null) {
            commitWidths({ ...widths, ...measuredWidths, [columnId]: contentWidth });
        }
    };

    const getHandleProps = (columnId: string) => ({
        'aria-valuenow': hasCustomWidths ? layout.cols.find((col) => col.id === columnId)?.width ?? widths[columnId] : undefined,
        'aria-valuemin': MIN_TABLE_COLUMN_WIDTH,
        'aria-valuemax': MAX_TABLE_COLUMN_WIDTH,
        onPointerDown: (event: PointerEvent<HTMLElement>) => {
            if (event.button !== 0 || !tableRef.current) return;
            if (dragRef.current) finishUnreleasedDrag(dragRef.current);

            const handle = event.currentTarget;
            handle.setPointerCapture?.(event.pointerId);
            const onKeyDown = (keyEvent: globalThis.KeyboardEvent) => {
                if (keyEvent.key === 'Escape' && dragRef.current) cancelDrag(dragRef.current);
            };
            window.addEventListener('keydown', onKeyDown);
            dragRef.current = {
                columnId,
                columns,
                handle,
                threshold: event.pointerType === 'mouse' ? MOUSE_DRAG_THRESHOLD : TOUCH_DRAG_THRESHOLD,
                startX: event.clientX,
                x: event.clientX,
                movement: 0,
                active: false,
                baseWidths: {},
                currentWidths: {},
                startWidth: 0,
                scrolled: 0,
                frame: null,
                isRtl: getComputedStyle(tableRef.current).direction === 'rtl',
                scroller: tableRef.current.closest<HTMLElement>('[data-horizontal-scroller]'),
                paneStart: 0,
                paneEnd: 0,
                firstHiddenRow: null,
                stopListening: () => window.removeEventListener('keydown', onKeyDown),
            };
        },
        // Keeps the browser from starting a text selection or a native drag, which would end the pointer events.
        onMouseDown: (event: MouseEvent<HTMLElement>) => {
            event.preventDefault();
        },
        onPointerMove: (event: PointerEvent<HTMLElement>) => {
            const drag = dragRef.current;
            if (!drag || !tableRef.current) return;
            if (event.pointerType === 'mouse' && event.buttons === 0) {
                finishUnreleasedDrag(drag);
                return;
            }

            if (event.clientX !== drag.x) drag.movement = Math.sign(event.clientX - drag.x);
            drag.x = event.clientX;
            if (!drag.active) {
                if (Math.abs(drag.x - drag.startX) < drag.threshold) return;
                activateDrag(drag, tableRef.current);
            }
            // Pointer events can outpace the display, and each write costs a table layout.
            drag.frame ??= requestAnimationFrame(() => runDragFrame(drag));
        },
        onPointerUp: (event: PointerEvent<HTMLElement>) => {
            const drag = dragRef.current;
            if (!drag) return;

            if (drag.active) {
                commitDrag(drag);
                return;
            }

            endDrag(drag);
            const lastTap = lastTapRef.current;
            if (lastTap?.columnId === columnId && event.timeStamp - lastTap.time < DOUBLE_TAP_MS) {
                lastTapRef.current = null;
                fitColumnToContent(columnId);
            } else {
                lastTapRef.current = { columnId, time: event.timeStamp };
            }
        },
        onPointerCancel: () => {
            if (dragRef.current) cancelDrag(dragRef.current);
        },
        onLostPointerCapture: () => {
            if (dragRef.current) finishUnreleasedDrag(dragRef.current);
        },
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                fitColumnToContent(columnId);
                return;
            }
            if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || !tableRef.current) return;

            event.preventDefault();
            const measuredWidths = readHeaderWidths(tableRef.current);
            const isRtl = getComputedStyle(tableRef.current).direction === 'rtl';
            const step = (event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP) * (event.key === 'ArrowRight' ? 1 : -1);
            const width = (measuredWidths[columnId] ?? DEFAULT_COLUMN_WIDTH) + (isRtl ? -step : step);
            commitWidths({
                ...(hasCustomWidths ? widths : { ...widths, ...measuredWidths }),
                [columnId]: clampTableColumnWidth(width),
            });
        },
    });

    return {
        tableProps: {
            'data-column-widths': hasCustomWidths ? 'fixed' : undefined,
            style: hasCustomWidths ? { width: layout.totalWidth } : undefined,
        },
        cols: layout.cols.map((col) => ({ id: col.id, width: hasCustomWidths ? col.width : undefined })),
        hasCustomWidths,
        resetWidths,
        getHandleProps,
    };
}

export type TableColumnWidthsController = ReturnType<typeof useTableColumnWidths>;
