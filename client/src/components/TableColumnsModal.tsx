import { useEffect, useRef, useState } from 'react';
import { Copy, GripVertical } from 'lucide-react';
import Sortable from 'sortablejs';
import { TABLE_COLUMN_DEFINITIONS } from '../../../shared/contracts';
import type { TableColumnId, TableColumnPreferenceTable, TableColumnPreferenceViewport, TableColumnViewportPreferences } from '../types';
import { Modal } from './ui/Modal';

interface TableColumnsModalProps {
    isOpen: boolean;
    table: TableColumnPreferenceTable;
    activeViewport: TableColumnPreferenceViewport;
    columnPreferences: TableColumnViewportPreferences;
    saving?: boolean;
    onClose: () => void;
    onSave: (visiblePreferences: TableColumnViewportPreferences) => void;
}

export function TableColumnsModal({
    isOpen,
    table,
    activeViewport,
    columnPreferences,
    saving = false,
    onClose,
    onSave,
}: TableColumnsModalProps) {
    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Table columns" maxWidth="max-w-lg">
            <TableColumnsModalContent
                table={table}
                activeViewport={activeViewport}
                columnPreferences={columnPreferences}
                saving={saving}
                onClose={onClose}
                onSave={onSave}
            />
        </Modal>
    );
}

function TableColumnsModalContent({
    table,
    activeViewport,
    columnPreferences,
    saving,
    onClose,
    onSave,
}: Omit<TableColumnsModalProps, 'isOpen'>) {
    const [selectedViewport, setSelectedViewport] = useState<TableColumnPreferenceViewport>(activeViewport);
    const [draftPreferences, setDraftPreferences] = useState<TableColumnViewportPreferences>(columnPreferences);
    const [draftColumnOrders, setDraftColumnOrders] = useState<TableColumnViewportPreferences>(() => loadColumnOrders(table, columnPreferences));
    const listRef = useRef<HTMLDivElement | null>(null);
    const sortableRef = useRef<Sortable | null>(null);
    const definitions = TABLE_COLUMN_DEFINITIONS[table];
    const definitionById = new Map<TableColumnId, (typeof definitions)[number]>(
        definitions.map((definition) => [definition.id, definition]),
    );
    const draftColumns = draftPreferences[selectedViewport];
    const draftColumnOrder = draftColumnOrders[selectedViewport];

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

                setDraftColumnOrders((current) => ({
                    ...current,
                    [selectedViewport]: moveItem(current[selectedViewport], oldIndex, newIndex),
                }));
            },
        });

        return () => {
            sortableRef.current?.destroy();
            sortableRef.current = null;
        };
    }, [draftColumnOrder.length, selectedViewport]);

    useEffect(() => {
        sortableRef.current?.option('disabled', saving);
    }, [saving]);

    const selectViewport = (viewport: TableColumnPreferenceViewport) => {
        setSelectedViewport(viewport);
    };

    const toggleColumn = (columnId: TableColumnId) => {
        setDraftPreferences((current) => {
            const currentColumns = current[selectedViewport];
            const nextColumns = currentColumns.includes(columnId)
                ? currentColumns.filter((id) => id !== columnId)
                : orderVisibleColumns(draftColumnOrders[selectedViewport], [...currentColumns, columnId]);
            return {
                ...current,
                [selectedViewport]: nextColumns,
            };
        });
    };
    const syncTargetViewport = getOtherViewport(selectedViewport);
    const visiblePreferences = buildVisiblePreferences(draftColumnOrders, draftPreferences);

    const syncViewport = () => {
        setDraftPreferences((current) => ({
            ...current,
            [syncTargetViewport]: [...visiblePreferences[selectedViewport]],
        }));
        setDraftColumnOrders((current) => ({
            ...current,
            [syncTargetViewport]: [...current[selectedViewport]],
        }));
    };

    return (
        <div className="space-y-5">
            <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex rounded-md border border-gray-300 bg-gray-100 p-1 dark:border-gray-700 dark:bg-gray-900">
                        {(['desktop', 'mobile'] as const).map((viewport) => (
                            <button
                                key={viewport}
                                type="button"
                                onClick={() => selectViewport(viewport)}
                                className={`rounded px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                                    selectedViewport === viewport
                                        ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-white'
                                        : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'
                                }`}
                            >
                                {viewport}
                            </button>
                        ))}
                    </div>
                    <button
                        type="button"
                        onClick={syncViewport}
                        disabled={saving}
                        className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                        <Copy size={16} aria-hidden="true" />
                        <span>Sync to {syncTargetViewport}</span>
                    </button>
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                    Column choices are saved separately for desktop and mobile; the app automatically uses the matching layout for your screen.
                </p>
            </div>
            <div ref={listRef} className="grid grid-cols-1 gap-2">
                {draftColumnOrder.map((columnId) => {
                    const column = definitionById.get(columnId);
                    if (!column) {
                        return null;
                    }
                    const checkboxId = `${table}-${selectedViewport}-column-${column.id}`;
                    return (
                        <div
                            key={column.id}
                            className="flex items-center gap-3 rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700/50"
                        >
                            <span
                                className={`drag-handle shrink-0 rounded-md p-1 text-gray-400 transition-colors ${
                                    saving || draftColumnOrder.length < 2
                                        ? 'cursor-not-allowed opacity-40'
                                        : 'cursor-grab hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200'
                                }`}
                                title="Drag to reorder"
                                aria-label={`Drag to reorder ${column.label}`}
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
                                {column.label}
                            </label>
                        </div>
                    );
                })}
            </div>
            <div className="flex items-center justify-end gap-2">
                <button
                    type="button"
                    onClick={onClose}
                    className="rounded-md border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    onClick={() => {
                        saveColumnOrders(table, draftColumnOrders);
                        onSave(visiblePreferences);
                    }}
                    disabled={saving}
                    className="rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {saving ? 'Saving...' : 'Save'}
                </button>
            </div>
        </div>
    );
}

function loadColumnOrders(
    table: TableColumnPreferenceTable,
    preferences: TableColumnViewportPreferences,
): TableColumnViewportPreferences {
    const storedOrders = readStoredColumnOrders(table);
    if (storedOrders) {
        return {
            desktop: mergeStoredColumnOrder(table, storedOrders.desktop),
            mobile: mergeStoredColumnOrder(table, storedOrders.mobile),
        };
    }

    return {
        desktop: mergeColumnOrder(table, preferences.desktop),
        mobile: mergeColumnOrder(table, preferences.mobile),
    };
}

function buildVisiblePreferences(
    columnOrders: TableColumnViewportPreferences,
    preferences: TableColumnViewportPreferences,
): TableColumnViewportPreferences {
    return {
        desktop: columnOrders.desktop.filter((columnId) => preferences.desktop.includes(columnId)),
        mobile: columnOrders.mobile.filter((columnId) => preferences.mobile.includes(columnId)),
    };
}

function getOtherViewport(viewport: TableColumnPreferenceViewport): TableColumnPreferenceViewport {
    return viewport === 'desktop' ? 'mobile' : 'desktop';
}

function getColumnOrderStorageKey(table: TableColumnPreferenceTable): string {
    return `crowdsec-web-ui:${table}:table-column-order`;
}

function readStoredColumnOrders(table: TableColumnPreferenceTable): TableColumnViewportPreferences | null {
    if (typeof window === 'undefined') {
        return null;
    }

    try {
        const rawValue = window.localStorage.getItem(getColumnOrderStorageKey(table));
        if (!rawValue) {
            return null;
        }
        const parsedValue = JSON.parse(rawValue) as Partial<TableColumnViewportPreferences>;
        if (!Array.isArray(parsedValue.desktop) || !Array.isArray(parsedValue.mobile)) {
            return null;
        }

        return {
            desktop: parsedValue.desktop,
            mobile: parsedValue.mobile,
        };
    } catch {
        return null;
    }
}

function saveColumnOrders(table: TableColumnPreferenceTable, columnOrders: TableColumnViewportPreferences): void {
    if (typeof window === 'undefined') {
        return;
    }

    try {
        window.localStorage.setItem(getColumnOrderStorageKey(table), JSON.stringify(columnOrders));
    } catch {
        // Column order is a convenience preference; server-visible columns still save without local storage.
    }
}

function mergeStoredColumnOrder(
    table: TableColumnPreferenceTable,
    storedColumns: TableColumnId[],
): TableColumnId[] {
    const validColumnIds = new Set(TABLE_COLUMN_DEFINITIONS[table].map((column) => column.id));
    const orderedColumns = storedColumns.filter((columnId) => validColumnIds.has(columnId));
    const orderedColumnIds = new Set(orderedColumns);
    const missingColumns = TABLE_COLUMN_DEFINITIONS[table]
        .map((column) => column.id)
        .filter((columnId) => !orderedColumnIds.has(columnId));
    return [...orderedColumns, ...missingColumns];
}

function mergeColumnOrder(table: TableColumnPreferenceTable, visibleColumns: TableColumnId[]): TableColumnId[] {
    const validColumnIds = new Set(TABLE_COLUMN_DEFINITIONS[table].map((column) => column.id));
    const orderedVisibleColumns = visibleColumns.filter((columnId) => validColumnIds.has(columnId));
    const visibleColumnIds = new Set(orderedVisibleColumns);
    const hiddenColumns = TABLE_COLUMN_DEFINITIONS[table]
        .map((column) => column.id)
        .filter((columnId) => !visibleColumnIds.has(columnId));
    if (hiddenColumns.includes('id')) {
        return ['id', ...orderedVisibleColumns, ...hiddenColumns.filter((columnId) => columnId !== 'id')];
    }

    return [...orderedVisibleColumns, ...hiddenColumns];
}

function orderVisibleColumns(columnOrder: TableColumnId[], visibleColumns: TableColumnId[]): TableColumnId[] {
    const visibleColumnIds = new Set(visibleColumns);
    return columnOrder.filter((columnId) => visibleColumnIds.has(columnId));
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
