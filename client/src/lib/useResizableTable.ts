import { useRef } from 'react';
import type { TableColumnWidthsKey } from './tableColumns';
import { useTableColumnWidths, type TableLayoutColumn } from './useTableColumnWidths';

export interface ResizableTableColumn extends TableLayoutColumn {
    label: string;
    /** Classes of the header cell. */
    className: string;
}

/** Column widths of a table whose columns are all shown at once, so they are known up front. */
export function useResizableTable(key: TableColumnWidthsKey, columns: ResizableTableColumn[]) {
    const tableRef = useRef<HTMLTableElement>(null);
    const columnWidths = useTableColumnWidths(key, tableRef, columns);
    return { tableRef, columnWidths, columns };
}

export type ResizableTableController = ReturnType<typeof useResizableTable>;
