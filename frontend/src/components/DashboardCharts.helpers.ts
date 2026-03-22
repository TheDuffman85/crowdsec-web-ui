import type { DateRangeSelection } from '../types';

export type SliderDragMode = 'move' | 'start' | 'end';

export interface BrushWindow {
    startIndex: number;
    endIndex: number;
}

export interface SliderDragState {
    mode: SliderDragMode;
    pointerStartX: number;
    initialStartIndex: number;
    initialEndIndex: number;
    bucketWidth: number;
    bucketCount: number;
}

export interface BrushSelectionPayload {
    dateRange: DateRangeSelection | null;
    isAtEnd: boolean;
}

export function getDraggedBrushWindow(
    dragState: SliderDragState,
    clientX: number,
    currentRange: BrushWindow,
): BrushWindow | null {
    if (dragState.bucketWidth <= 0) {
        return null;
    }

    const deltaIndex = Math.round((clientX - dragState.pointerStartX) / dragState.bucketWidth);
    let nextStartIndex = dragState.initialStartIndex;
    let nextEndIndex = dragState.initialEndIndex;

    if (dragState.mode === 'move') {
        const selectionWidth = dragState.initialEndIndex - dragState.initialStartIndex;
        const maxStartIndex = Math.max(0, dragState.bucketCount - selectionWidth - 1);
        nextStartIndex = Math.min(
            Math.max(0, dragState.initialStartIndex + deltaIndex),
            maxStartIndex,
        );
        nextEndIndex = nextStartIndex + selectionWidth;
    } else if (dragState.mode === 'start') {
        nextStartIndex = Math.min(
            Math.max(0, dragState.initialStartIndex + deltaIndex),
            dragState.initialEndIndex,
        );
    } else {
        nextEndIndex = Math.max(
            dragState.initialStartIndex,
            Math.min(dragState.bucketCount - 1, dragState.initialEndIndex + deltaIndex),
        );
    }

    if (
        nextStartIndex === currentRange.startIndex &&
        nextEndIndex === currentRange.endIndex
    ) {
        return null;
    }

    return { startIndex: nextStartIndex, endIndex: nextEndIndex };
}

export function getBrushSelectionPayload(
    data: Array<{ bucketKey: string }>,
    nextRange: BrushWindow,
): BrushSelectionPayload | null {
    const startItem = data[nextRange.startIndex];
    const endItem = data[nextRange.endIndex];
    if (!startItem || !endItem) {
        return null;
    }

    const isStartReset = nextRange.startIndex === 0;
    const isAtEnd = nextRange.endIndex >= data.length - 1;
    const isFullRange = isStartReset && isAtEnd;

    return {
        dateRange: isFullRange ? null : {
            start: startItem.bucketKey,
            end: endItem.bucketKey,
        },
        isAtEnd,
    };
}
