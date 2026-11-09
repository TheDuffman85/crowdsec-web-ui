import type { ReactNode } from 'react';
import { useI18n } from '../../lib/i18n';
import type { ResizableTableController } from '../../lib/useResizableTable';
import { HorizontalScrollArea } from './HorizontalScrollArea';
import { ResizableColumnHeader, TableColumnGroup } from './ResizableColumnHeader';

interface ResizableTableProps {
    table: ResizableTableController;
    className?: string;
    bodyClassName?: string;
    children: ReactNode;
}

/**
 * A table with resizable columns in a horizontal scroll area, like on the Alerts and Decisions
 * pages. Columns with a fixed width keep a plain header. The scroll area keeps its scrollbar at
 * the bottom of the page, so no ancestor may clip with overflow-hidden; overflow-clip works.
 */
export function ResizableTable({ table, className = '', bodyClassName, children }: ResizableTableProps) {
    const { tableRef, columnWidths, columns } = table;
    return (
        <HorizontalScrollArea>
            <table ref={tableRef} {...columnWidths.tableProps} className={`min-w-full text-left text-sm ${className}`}>
                <TableColumnGroup columnWidths={columnWidths} />
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                    <tr>
                        {columns.map((column) => (column.fixedWidth === undefined
                            ? <ResizableColumnHeader key={column.id} columnId={column.id} label={column.label} className={column.className} columnWidths={columnWidths} />
                            : <th key={column.id} className={column.className}>{column.label}</th>))}
                    </tr>
                </thead>
                <tbody className={bodyClassName}>{children}</tbody>
            </table>
        </HorizontalScrollArea>
    );
}

/** Returns a table to the automatic widths; only shown once a column was resized. */
export function ResetColumnWidthsButton({ table }: { table: ResizableTableController }) {
    const { t } = useI18n();
    if (!table.columnWidths.hasCustomWidths) return null;
    return (
        <button
            type="button"
            onClick={table.columnWidths.resetWidths}
            className="inline-flex cursor-pointer items-center whitespace-nowrap rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-primary-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
        >
            {t('components.tableColumns.resetWidths')}
        </button>
    );
}
