import { useI18n } from '../../lib/i18n';
import type { TableColumnWidthsController } from '../../lib/useTableColumnWidths';

const GRIP_LINE_CLASS_NAME = 'h-full w-px bg-gray-300 transition-colors duration-100 group-hover/resize:w-0.5 group-hover/resize:bg-primary-500 group-focus-visible/resize:w-0.5 group-focus-visible/resize:bg-primary-500 group-data-[resizing]/resize:w-0.5 group-data-[resizing]/resize:bg-primary-500 dark:bg-gray-600 dark:group-hover/resize:bg-primary-500 dark:group-focus-visible/resize:bg-primary-500 dark:group-data-[resizing]/resize:bg-primary-500';

interface ResizableColumnHeaderProps {
    columnId: string;
    label: string;
    className: string;
    columnWidths: TableColumnWidthsController;
}

/** A table header whose end edge can be dragged, or moved with the arrow keys, to resize the column. */
export function ResizableColumnHeader({ columnId, label, className, columnWidths }: ResizableColumnHeaderProps) {
    const { t } = useI18n();
    const resizeLabel = t('components.tableColumns.resizeColumn', { column: label });

    return (
        // The explicit name keeps the handle out of what is announced for each cell in the column.
        <th data-column-id={columnId} aria-label={label} className={`relative ${className}`}>
            {label}
            {/* touch-none hands the gesture to the handle. Everywhere else, touches keep scrolling the table. */}
            <span
                {...columnWidths.getHandleProps(columnId)}
                role="separator"
                aria-orientation="vertical"
                aria-label={resizeLabel}
                title={t('components.tableColumns.resizeHandleHint')}
                tabIndex={0}
                className="group/resize absolute inset-y-0 end-0 flex w-3 cursor-col-resize touch-none select-none items-center justify-end outline-none [-webkit-touch-callout:none] pointer-coarse:w-7"
            >
                <span className="flex h-3.5 gap-px transition-[height] duration-100 group-hover/resize:h-full group-focus-visible/resize:h-full group-data-[resizing]/resize:h-full">
                    <span className={GRIP_LINE_CLASS_NAME} />
                    {/* Without hover to reveal the handle, touch screens get a second line that reads as a grip. */}
                    <span className={`${GRIP_LINE_CLASS_NAME} hidden pointer-coarse:block`} />
                </span>
            </span>
        </th>
    );
}

export function TableColumnGroup({ columnWidths }: { columnWidths: TableColumnWidthsController }) {
    return (
        <colgroup>
            {columnWidths.cols.map((col) => (
                <col key={col.id} style={col.width === undefined ? undefined : { width: col.width }} />
            ))}
        </colgroup>
    );
}
