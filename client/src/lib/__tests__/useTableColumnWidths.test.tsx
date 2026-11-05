import { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ResizableColumnHeader, TableColumnGroup } from '../../components/ui/ResizableColumnHeader';
import { useTableColumnWidths, type TableLayoutColumn } from '../useTableColumnWidths';
import { MAX_TABLE_COLUMN_WIDTH, MIN_TABLE_COLUMN_WIDTH } from '../tableColumns';

const STORAGE_KEY = 'crowdsec-web-ui:alerts:table-column-widths';
const HEADER_WIDTHS: Record<string, number> = { time: 150, scenario: 250, source: 200 };
const ROW_HEIGHT = 50;

function TestTable({ rowCount = 2, columns = ['time', 'scenario', 'source'] }: { rowCount?: number; columns?: string[] }) {
    const tableRef = useRef<HTMLTableElement>(null);
    const layout: TableLayoutColumn[] = [
        { id: 'select', fixedWidth: 64 },
        ...columns.map((id) => ({ id })),
        { id: 'actions', fixedWidth: 160 },
    ];
    const columnWidths = useTableColumnWidths('alerts', tableRef, layout);

    return (
        <div data-horizontal-scroller>
            <button type="button" onClick={columnWidths.resetWidths}>reset</button>
            <table ref={tableRef} data-testid="table" {...columnWidths.tableProps}>
                <TableColumnGroup columnWidths={columnWidths} />
                <thead>
                    <tr>
                        <th>select</th>
                        {columns.map((id) => (
                            <ResizableColumnHeader key={id} columnId={id} label={id} className="" columnWidths={columnWidths} />
                        ))}
                        <th>actions</th>
                    </tr>
                </thead>
                <tbody>
                    {Array.from({ length: rowCount }, (_, index) => <tr key={index} data-row={index}><td>row</td></tr>)}
                </tbody>
            </table>
        </div>
    );
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
    return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) };
}

function getHandle(columnId: string): HTMLElement {
    return screen.getByRole('separator', { name: new RegExp(columnId) });
}

function getCols(): HTMLTableColElement[] {
    return Array.from(screen.getByTestId('table').querySelectorAll('col'));
}

describe('useTableColumnWidths', () => {
    let frames: FrameRequestCallback[];

    function flushFrames() {
        act(() => {
            let remaining = 100;
            while (frames.length > 0 && remaining > 0) {
                remaining -= 1;
                frames.shift()?.(0);
            }
        });
    }

    function drag(columnId: string, distance: number, pointerType = 'mouse') {
        const handle = getHandle(columnId);
        fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerType });
        fireEvent.pointerMove(handle, { buttons: 1, clientX: 500 + distance, pointerType });
        flushFrames();
        return handle;
    }

    beforeEach(() => {
        window.localStorage.clear();
        document.documentElement.dir = 'ltr';
        frames = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        vi.stubGlobal('cancelAnimationFrame', () => {
            frames = [];
        });
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect(this: HTMLElement) {
            const columnId = this.dataset.columnId;
            if (columnId) return rect(0, 0, HEADER_WIDTHS[columnId] ?? 100, 40);
            const rowIndex = this.dataset.row;
            if (rowIndex !== undefined) return rect(0, 40 + Number(rowIndex) * ROW_HEIGHT, 1000, ROW_HEIGHT);
            if (this.tagName === 'TABLE') {
                const shownRows = Array.from((this as HTMLTableElement).tBodies[0]?.rows ?? []);
                const firstHidden = shownRows.findIndex((row) => row.hasAttribute('data-hide-from-here'));
                return rect(0, 0, 1000, 40 + (firstHidden === -1 ? shownRows.length : firstHidden) * ROW_HEIGHT);
            }
            return rect(0, 0, 1000, 500);
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    test('leaves the table to the automatic layout until a column is resized', () => {
        render(<TestTable />);

        const table = screen.getByTestId('table');
        expect(table).not.toHaveAttribute('data-column-widths');
        expect(table.style.width).toBe('');
        expect(getCols().every((col) => col.style.width === '')).toBe(true);
    });

    test('a click on the handle does not switch the layout', () => {
        render(<TestTable />);

        const handle = getHandle('scenario');
        fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerType: 'mouse' });
        fireEvent.pointerUp(handle, { clientX: 500, pointerType: 'mouse' });

        expect(screen.getByTestId('table')).not.toHaveAttribute('data-column-widths');
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    test('resizes through the DOM while dragging and commits on release', () => {
        render(<TestTable />);

        const handle = drag('scenario', 50);
        const table = screen.getByTestId('table');
        expect(table).toHaveAttribute('data-column-widths', 'fixed');
        expect(handle).toHaveAttribute('data-resizing');
        expect(getCols()[2]?.style.width).toBe('300px');
        expect(table.style.width).toBe(`${64 + 150 + 300 + 200 + 160}px`);
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

        fireEvent.pointerUp(handle, { clientX: 550, pointerType: 'mouse' });

        expect(handle).not.toHaveAttribute('data-resizing');
        expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({ time: 150, scenario: 300, source: 200 });
        expect(getCols()[2]?.style.width).toBe('300px');
        expect(table.style.width).toBe(`${64 + 150 + 300 + 200 + 160}px`);
    });

    test('leaves the width of the last resizable column open, so it fills the table', () => {
        render(<TestTable />);

        const handle = drag('scenario', 50);
        fireEvent.pointerUp(handle, { clientX: 550, pointerType: 'mouse' });

        const cols = getCols();
        expect(cols[0]?.style.width).toBe('64px');
        expect(cols[3]?.style.width).toBe('');
        expect(cols[4]?.style.width).toBe('160px');
    });

    test('keeps widths within the limits', () => {
        render(<TestTable />);

        const shrinking = drag('scenario', -5000);
        expect(getCols()[2]?.style.width).toBe(`${MIN_TABLE_COLUMN_WIDTH}px`);
        fireEvent.pointerUp(shrinking, { clientX: -4500, pointerType: 'mouse' });

        const growing = drag('scenario', 5000);
        expect(getCols()[2]?.style.width).toBe(`${MAX_TABLE_COLUMN_WIDTH}px`);
        fireEvent.pointerUp(growing, { clientX: 5500, pointerType: 'mouse' });
    });

    test('dragging follows the inline direction in right-to-left layouts', () => {
        document.documentElement.dir = 'rtl';
        const getComputedStyle = window.getComputedStyle.bind(window);
        vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => new Proxy(getComputedStyle(element), {
            get(style, property) {
                if (property === 'direction') return 'rtl';
                const value = Reflect.get(style, property) as unknown;
                return typeof value === 'function' ? value.bind(style) as unknown : value;
            },
        }));
        render(<TestTable />);

        drag('scenario', -50);

        expect(getCols()[2]?.style.width).toBe('300px');
    });

    test('Escape and a canceled pointer restore the previous layout', () => {
        render(<TestTable />);

        drag('scenario', 50);
        fireEvent.keyDown(window, { key: 'Escape' });

        const table = screen.getByTestId('table');
        expect(table).not.toHaveAttribute('data-column-widths');
        expect(getCols()[2]?.style.width).toBe('');

        const handle = drag('scenario', 50);
        fireEvent.pointerCancel(handle);

        expect(table).not.toHaveAttribute('data-column-widths');
        expect(table.style.width).toBe('');
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    test('a release that goes unreported ends the drag with the next pointer event', () => {
        render(<TestTable />);

        const handle = drag('scenario', 50);
        fireEvent.pointerMove(handle, { buttons: 0, clientX: 700, pointerType: 'mouse' });
        flushFrames();

        expect(handle).not.toHaveAttribute('data-resizing');
        expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}').scenario).toBe(300);

        drag('scenario', 50);
        fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerType: 'mouse' });
        expect(handle).not.toHaveAttribute('data-resizing');
        fireEvent.pointerUp(handle, { clientX: 500, pointerType: 'mouse' });

        const lostHandle = drag('scenario', 50);
        fireEvent.lostPointerCapture(lostHandle);
        expect(lostHandle).not.toHaveAttribute('data-resizing');
    });

    test('touch needs a larger movement before it counts as a drag', () => {
        render(<TestTable />);

        const handle = getHandle('scenario');
        fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerType: 'touch' });
        fireEvent.pointerMove(handle, { buttons: 1, clientX: 503, pointerType: 'touch' });
        flushFrames();
        expect(screen.getByTestId('table')).not.toHaveAttribute('data-column-widths');

        fireEvent.pointerMove(handle, { buttons: 1, clientX: 520, pointerType: 'touch' });
        flushFrames();
        expect(getCols()[2]?.style.width).toBe('270px');
    });

    test('a double tap fits the column to its content', () => {
        render(<TestTable />);

        const handle = getHandle('scenario');
        for (const timeStamp of [1000, 1200]) {
            fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerType: 'touch' });
            const up = new PointerEvent('pointerup', { bubbles: true, clientX: 500, pointerType: 'touch' });
            Object.defineProperty(up, 'timeStamp', { value: timeStamp });
            fireEvent(handle, up);
        }

        expect(screen.getByTestId('table')).toHaveAttribute('data-column-widths', 'fixed');
        expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}').scenario).toBe(250);
    });

    test('two slow taps do not fit the column', () => {
        render(<TestTable />);

        const handle = getHandle('scenario');
        for (const timeStamp of [1000, 2000]) {
            fireEvent.pointerDown(handle, { button: 0, clientX: 500, pointerType: 'touch' });
            const up = new PointerEvent('pointerup', { bubbles: true, clientX: 500, pointerType: 'touch' });
            Object.defineProperty(up, 'timeStamp', { value: timeStamp });
            fireEvent(handle, up);
        }

        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    test('the arrow keys resize the column and Enter fits it', () => {
        render(<TestTable />);

        const handle = getHandle('scenario');
        fireEvent.keyDown(handle, { key: 'ArrowRight' });
        expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}').scenario).toBe(266);

        fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
        expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}').scenario).toBe(186);

        fireEvent.keyDown(handle, { key: 'Enter' });
        expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}').scenario).toBe(250);
    });

    test('restores stored widths and can reset them', () => {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ time: 111, scenario: 222, source: 333 }));
        render(<TestTable />);

        const table = screen.getByTestId('table');
        expect(table).toHaveAttribute('data-column-widths', 'fixed');
        expect(getCols()[1]?.style.width).toBe('111px');
        expect(table.style.width).toBe(`${64 + 111 + 222 + 333 + 160}px`);

        fireEvent.click(screen.getByRole('button', { name: 'reset' }));

        expect(table).not.toHaveAttribute('data-column-widths');
        expect(table.style.width).toBe('');
        expect(getCols()[1]?.style.width).toBe('');
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    test('gives columns without a stored width a default', () => {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ time: 111 }));
        render(<TestTable columns={['time', 'machine', 'source']} />);

        expect(getCols()[2]?.style.width).toBe('180px');
    });

    test('ignores invalid stored widths', () => {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ time: 'wide', scenario: 10 }));
        render(<TestTable />);

        expect(getCols()[2]?.style.width).toBe(`${MIN_TABLE_COLUMN_WIDTH}px`);
        expect(getCols()[1]?.style.width).toBe('180px');
    });

    test('takes the rows below the viewport out of the layout during a drag and brings them back gradually', () => {
        const rowCount = 300;
        render(<TestTable rowCount={rowCount} />);
        const table = screen.getByTestId('table') as HTMLTableElement;
        const rows = table.tBodies[0]?.rows as HTMLCollectionOf<HTMLTableRowElement>;
        const fullHeight = 40 + rowCount * ROW_HEIGHT;
        const hiddenRowIndex = () => Array.from(rows).findIndex((row) => row.hasAttribute('data-hide-from-here'));

        const handle = drag('scenario', 50);

        const firstHidden = hiddenRowIndex();
        const firstHiddenTop = 40 + firstHidden * ROW_HEIGHT;
        expect(firstHiddenTop).toBeGreaterThan(window.innerHeight);
        expect(firstHidden).toBeLessThan(rowCount);
        expect(table.style.marginBottom).toBe(`${fullHeight - firstHiddenTop}px`);

        fireEvent.pointerUp(handle, { clientX: 550, pointerType: 'mouse' });

        // Still hidden right after the release, with the rows coming back frame by frame.
        expect(hiddenRowIndex()).toBe(firstHidden);
        act(() => {
            frames.shift()?.(0);
        });
        expect(hiddenRowIndex()).toBe(firstHidden + 50);
        expect(table.style.marginBottom).toBe(`${fullHeight - (firstHiddenTop + 50 * ROW_HEIGHT)}px`);

        flushFrames();
        expect(hiddenRowIndex()).toBe(-1);
        expect(table.style.marginBottom).toBe('');
    });

    test('a new drag shows the remaining rows before it measures', () => {
        render(<TestTable rowCount={300} />);
        const table = screen.getByTestId('table') as HTMLTableElement;
        const rows = table.tBodies[0]?.rows as HTMLCollectionOf<HTMLTableRowElement>;
        const firstHandle = drag('scenario', 50);
        const firstHidden = Array.from(rows).findIndex((row) => row.hasAttribute('data-hide-from-here'));
        fireEvent.pointerUp(firstHandle, { clientX: 550, pointerType: 'mouse' });

        drag('time', 20);

        expect(Array.from(rows).filter((row) => row.hasAttribute('data-hide-from-here'))).toHaveLength(1);
        expect(Array.from(rows).findIndex((row) => row.hasAttribute('data-hide-from-here'))).toBe(firstHidden);
    });

    test('names the handle and keeps it out of the header name', () => {
        render(<TestTable />);

        expect(screen.getByRole('columnheader', { name: 'scenario' })).toContainElement(getHandle('scenario'));
        expect(getHandle('scenario')).toHaveAttribute('aria-orientation', 'vertical');
        expect(getHandle('scenario')).toHaveAttribute('tabindex', '0');
    });
});
