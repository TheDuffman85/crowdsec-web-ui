import { useState } from 'react';
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
    onSave: (viewport: TableColumnPreferenceViewport, visibleColumns: TableColumnId[]) => void;
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
    const definitions = TABLE_COLUMN_DEFINITIONS[table];
    const draftColumns = draftPreferences[selectedViewport];

    const selectViewport = (viewport: TableColumnPreferenceViewport) => {
        setSelectedViewport(viewport);
    };

    const toggleColumn = (columnId: TableColumnId) => {
        setDraftPreferences((current) => {
            const currentColumns = current[selectedViewport];
            return {
                ...current,
                [selectedViewport]: currentColumns.includes(columnId)
                    ? currentColumns.filter((id) => id !== columnId)
                    : [...currentColumns, columnId],
            };
        });
    };

    return (
        <div className="space-y-5">
            <div className="space-y-2">
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
                <p className="text-sm text-gray-500 dark:text-gray-400">
                    Column choices are saved separately for desktop and mobile; the app automatically uses the matching layout for your screen.
                </p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {definitions.map((column) => {
                    const checkboxId = `${table}-${selectedViewport}-column-${column.id}`;
                    return (
                        <label
                            key={column.id}
                            htmlFor={checkboxId}
                            className="flex items-center gap-3 rounded-md border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50"
                        >
                            <input
                                id={checkboxId}
                                type="checkbox"
                                checked={draftColumns.includes(column.id)}
                                onChange={() => toggleColumn(column.id)}
                                className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                            />
                            <span>{column.label}</span>
                        </label>
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
                    onClick={() => onSave(selectedViewport, draftPreferences[selectedViewport])}
                    disabled={saving}
                    className="rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {saving ? 'Saving...' : 'Save'}
                </button>
            </div>
        </div>
    );
}
