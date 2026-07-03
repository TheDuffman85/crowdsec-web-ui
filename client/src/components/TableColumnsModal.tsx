import { useEffect, useRef, useState } from 'react';
import { GripVertical, RotateCcw } from 'lucide-react';
import Sortable from 'sortablejs';
import { DEFAULT_TABLE_COLUMN_PREFERENCES, TABLE_COLUMN_DEFINITIONS } from '../../../shared/contracts';
import type { TableColumnId, TableColumnPreferenceTable } from '../types';
import { Modal } from './ui/Modal';
import { useI18n } from '../lib/i18n';
import {
    getDefaultTableColumnOrder,
    loadStoredTableColumnOrders,
    orderVisibleTableColumns,
    saveStoredTableColumnOrders,
} from '../lib/tableColumns';

interface TableColumnsModalProps {
    isOpen: boolean;
    table: TableColumnPreferenceTable;
    columnPreferences: TableColumnId[];
    onClose: () => void;
    onSave: (visiblePreferences: TableColumnId[]) => void;
}

export function TableColumnsModal({
    isOpen,
    table,
    columnPreferences,
    onClose,
    onSave,
}: TableColumnsModalProps) {
    const { t } = useI18n();

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t('components.tableColumns.title')} maxWidth="max-w-lg">
            <TableColumnsModalContent
                table={table}
                columnPreferences={columnPreferences}
                onClose={onClose}
                onSave={onSave}
            />
        </Modal>
    );
}

function TableColumnsModalContent({
    table,
    columnPreferences,
    onClose,
    onSave,
}: Omit<TableColumnsModalProps, 'isOpen'>) {
    const { t } = useI18n();
    const [draftColumns, setDraftColumns] = useState<TableColumnId[]>(columnPreferences);
    const [draftColumnOrder, setDraftColumnOrder] = useState<TableColumnId[]>(() => (
        loadStoredTableColumnOrders(table, columnPreferences)
    ));
    const listRef = useRef<HTMLDivElement | null>(null);
    const sortableRef = useRef<Sortable | null>(null);
    const definitions = TABLE_COLUMN_DEFINITIONS[table];
    const definitionById = new Map<TableColumnId, (typeof definitions)[number]>(
        definitions.map((definition) => [definition.id, definition]),
    );

    useEffect(() => {
        const list = listRef.current;
        if (!list || draftColumnOrder.length <= 1) {
            sortableRef.current?.destroy();
            sortableRef.current = null;
            return;
        }

        sortableRef.current?.destroy();
        sortableRef.current = new Sortable(list, {
            animation: 150,
            handle: '.drag-handle',
            ghostClass: 'sortable-ghost',
            chosenClass: 'sortable-chosen',
            onEnd: (event) => {
                const oldIndex = event.oldIndex;
                const newIndex = event.newIndex;
                if (
                    oldIndex === undefined ||
                    newIndex === undefined ||
                    oldIndex === newIndex
                ) {
                    return;
                }

                setDraftColumnOrder((current) => moveItem(current, oldIndex, newIndex));
            },
        });

        return () => {
            sortableRef.current?.destroy();
            sortableRef.current = null;
        };
    }, [draftColumnOrder.length]);

    const toggleColumn = (columnId: TableColumnId) => {
        setDraftColumns((currentColumns) => (
            currentColumns.includes(columnId)
                ? currentColumns.filter((id) => id !== columnId)
                : orderVisibleTableColumns(draftColumnOrder, [...currentColumns, columnId])
        ));
    };
    const visiblePreferences = buildVisiblePreferences(draftColumnOrder, draftColumns);

    const resetColumns = () => {
        setDraftColumns([...DEFAULT_TABLE_COLUMN_PREFERENCES[table]]);
        setDraftColumnOrder(getDefaultTableColumnOrder(table));
    };

    const getColumnLabel = (columnId: TableColumnId, fallback: string) =>
        t(`tableColumns.${columnId}`, { defaultValue: fallback });

    return (
        <div className="space-y-5">
            <div className="space-y-2">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t('components.tableColumns.description')}
                </p>
            </div>
            <div ref={listRef} className="grid grid-cols-1 gap-2">
                {draftColumnOrder.map((columnId) => {
                    const column = definitionById.get(columnId);
                    if (!column) {
                        return null;
                    }
                    const checkboxId = `${table}-column-${column.id}`;
                    return (
                        <div
                            key={column.id}
                            className="flex items-center gap-3 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700/50"
                        >
                            <span
                                className={`drag-handle shrink-0 rounded-md p-1 text-gray-400 transition-colors ${
                                    draftColumnOrder.length < 2
                                        ? 'cursor-not-allowed opacity-40'
                                        : 'cursor-grab hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200'
                                }`}
                                title={t('components.tableColumns.dragToReorder')}
                                aria-label={t('components.tableColumns.dragToReorderColumn', { column: getColumnLabel(column.id, column.label) })}
                            >
                                <GripVertical size={16} aria-hidden="true" />
                            </span>
                            <input
                                id={checkboxId}
                                type="checkbox"
                                checked={draftColumns.includes(column.id)}
                                onChange={() => toggleColumn(column.id)}
                                className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                            />
                            <label htmlFor={checkboxId} className="flex-1 cursor-pointer">
                                {getColumnLabel(column.id, column.label)}
                            </label>
                        </div>
                    );
                })}
            </div>
            <div className="flex items-center justify-between gap-3">
                <button
                    type="button"
                    onClick={resetColumns}
                    className="inline-flex min-w-0 items-center justify-center gap-1.5 rounded-md border border-gray-300 px-2 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 sm:gap-2 sm:px-3 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                    <RotateCcw size={16} className="shrink-0" aria-hidden="true" />
                    <span className="truncate">{t('components.tableColumns.resetDefaults')}</span>
                </button>
                <div className="flex items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-md border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            saveStoredTableColumnOrders(table, draftColumnOrder);
                            onSave(visiblePreferences);
                        }}
                        className="rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700"
                    >
                        {t('common.save')}
                    </button>
                </div>
            </div>
        </div>
    );
}

function buildVisiblePreferences(columnOrder: TableColumnId[], preferences: TableColumnId[]): TableColumnId[] {
    return columnOrder.filter((columnId) => preferences.includes(columnId));
}


function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
    if (fromIndex === toIndex) {
        return items;
    }

    const nextItems = [...items];
    const [movedItem] = nextItems.splice(fromIndex, 1);
    nextItems.splice(toIndex, 0, movedItem);
    return nextItems;
}
