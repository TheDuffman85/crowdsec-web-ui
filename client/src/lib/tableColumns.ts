import { DEFAULT_TABLE_COLUMN_PREFERENCES, TABLE_COLUMN_DEFINITIONS } from '../../../shared/contracts';
import type { TableColumnId, TableColumnPreferenceTable, TableColumnPreferences } from '../types';

const TABLE_COLUMN_PREFERENCES_STORAGE_KEY = 'crowdsec-web-ui:table-column-preferences';

// Keeps the row actions reachable when the columns are wider than the page. The backgrounds
// are opaque versions of the row and header colors, so scrolled cells do not show through.
// The row needs the `group` class for the hover color.
const STICKY_ACTIONS_CLASS_NAME = 'lg:sticky lg:end-0 transition-colors group-hover:bg-gray-50 dark:group-hover:bg-[color-mix(in_srgb,var(--color-gray-700)_50%,var(--color-gray-800))]';
export const STICKY_ACTIONS_HEADER_CLASS_NAME = 'lg:sticky lg:end-0 bg-gray-50 dark:bg-[color-mix(in_srgb,var(--color-gray-900)_50%,var(--color-gray-800))]';
export const STICKY_ACTIONS_CELL_CLASS_NAME = `${STICKY_ACTIONS_CLASS_NAME} bg-white dark:bg-gray-800`;
export const STICKY_ACTIONS_EXPIRED_CELL_CLASS_NAME = `${STICKY_ACTIONS_CLASS_NAME} bg-gray-50 dark:bg-[color-mix(in_srgb,var(--color-gray-900)_20%,var(--color-gray-800))]`;
export const STICKY_ACTIONS_NESTED_CELL_CLASS_NAME = STICKY_ACTIONS_EXPIRED_CELL_CLASS_NAME;

export type TableColumnWidths = Record<string, number>;

export const MIN_TABLE_COLUMN_WIDTH = 72;
export const MAX_TABLE_COLUMN_WIDTH = 960;

export function loadStoredTableColumnPreferences(): TableColumnPreferences {
    if (typeof window === 'undefined') {
        return cloneDefaultTableColumnPreferences();
    }

    try {
        const rawValue = window.localStorage.getItem(TABLE_COLUMN_PREFERENCES_STORAGE_KEY);
        if (!rawValue) {
            return cloneDefaultTableColumnPreferences();
        }
        return normalizeTableColumnPreferences(JSON.parse(rawValue));
    } catch {
        return cloneDefaultTableColumnPreferences();
    }
}

export function saveStoredTableColumnPreferences(preferences: TableColumnPreferences): void {
    if (typeof window === 'undefined') {
        return;
    }

    try {
        window.localStorage.setItem(
            TABLE_COLUMN_PREFERENCES_STORAGE_KEY,
            JSON.stringify(normalizeTableColumnPreferences(preferences)),
        );
    } catch {
        // Column preferences are browser-local convenience state; ignore storage failures.
    }
}

export function loadStoredTableColumnOrders(
    table: TableColumnPreferenceTable,
    preferences: TableColumnId[],
): TableColumnId[] {
    const storedOrders = readStoredColumnOrders(table);
    if (storedOrders) {
        return mergeStoredColumnOrder(table, storedOrders);
    }

    return mergeColumnOrder(table, preferences);
}

export function saveStoredTableColumnOrders(
    table: TableColumnPreferenceTable,
    columnOrders: TableColumnId[],
): void {
    if (typeof window === 'undefined') {
        return;
    }

    try {
        window.localStorage.setItem(getColumnOrderStorageKey(table), JSON.stringify(columnOrders));
    } catch {
        // Column order is browser-local convenience state; ignore storage failures.
    }
}

export function getDefaultTableColumnOrder(table: TableColumnPreferenceTable): TableColumnId[] {
    return TABLE_COLUMN_DEFINITIONS[table].map((column) => column.id);
}

export function orderVisibleTableColumns(columnOrder: TableColumnId[], visibleColumns: TableColumnId[]): TableColumnId[] {
    const visibleColumnIds = new Set(visibleColumns);
    return columnOrder.filter((columnId) => visibleColumnIds.has(columnId));
}

export function clampTableColumnWidth(width: number): number {
    return Math.round(Math.min(MAX_TABLE_COLUMN_WIDTH, Math.max(MIN_TABLE_COLUMN_WIDTH, width)));
}

export function loadStoredTableColumnWidths(table: TableColumnPreferenceTable): TableColumnWidths {
    if (typeof window === 'undefined') {
        return {};
    }

    try {
        const parsedValue = JSON.parse(window.localStorage.getItem(getColumnWidthsStorageKey(table)) ?? 'null') as unknown;
        if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
            return {};
        }

        const widths: TableColumnWidths = {};
        for (const [columnId, width] of Object.entries(parsedValue)) {
            if (typeof width === 'number' && Number.isFinite(width)) {
                widths[columnId] = clampTableColumnWidth(width);
            }
        }
        return widths;
    } catch {
        return {};
    }
}

export function saveStoredTableColumnWidths(table: TableColumnPreferenceTable, widths: TableColumnWidths): void {
    if (typeof window === 'undefined') {
        return;
    }

    try {
        if (Object.keys(widths).length === 0) {
            window.localStorage.removeItem(getColumnWidthsStorageKey(table));
        } else {
            window.localStorage.setItem(getColumnWidthsStorageKey(table), JSON.stringify(widths));
        }
    } catch {
        // Column widths are browser-local convenience state; ignore storage failures.
    }
}

function cloneDefaultTableColumnPreferences(): TableColumnPreferences {
    return {
        alerts: [...DEFAULT_TABLE_COLUMN_PREFERENCES.alerts],
        decisions: [...DEFAULT_TABLE_COLUMN_PREFERENCES.decisions],
    };
}

function normalizeTableColumnPreferences(value: unknown): TableColumnPreferences {
    const preferences = cloneDefaultTableColumnPreferences();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return preferences;
    }

    const input = value as Partial<Record<TableColumnPreferenceTable, unknown>>;
    for (const table of ['alerts', 'decisions'] as const) {
        const rawPreference = input[table];
        if (Array.isArray(rawPreference)) {
            const columns = normalizeTableColumnIds(table, rawPreference);
            if (columns) {
                preferences[table] = columns;
            }
            continue;
        }

        if (!rawPreference || typeof rawPreference !== 'object') {
            continue;
        }

        const viewportInput = rawPreference as { desktop?: unknown; mobile?: unknown };
        const columns = normalizeTableColumnIds(table, viewportInput.desktop) ||
            normalizeTableColumnIds(table, viewportInput.mobile);
        if (columns) {
            preferences[table] = columns;
        }
    }

    return preferences;
}

function normalizeTableColumnIds(table: TableColumnPreferenceTable, value: unknown): TableColumnId[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const validColumnIds = new Set(TABLE_COLUMN_DEFINITIONS[table].map((column) => column.id));
    const seenColumnIds = new Set<string>();
    const nextColumns: TableColumnId[] = [];
    for (const columnId of value) {
        if (typeof columnId !== 'string' || !validColumnIds.has(columnId as TableColumnId) || seenColumnIds.has(columnId)) {
            continue;
        }
        seenColumnIds.add(columnId);
        nextColumns.push(columnId as TableColumnId);
    }
    return nextColumns;
}

function getColumnOrderStorageKey(table: TableColumnPreferenceTable): string {
    return `crowdsec-web-ui:${table}:table-column-order`;
}

function getColumnWidthsStorageKey(table: TableColumnPreferenceTable): string {
    return `crowdsec-web-ui:${table}:table-column-widths`;
}

function readStoredColumnOrders(table: TableColumnPreferenceTable): TableColumnId[] | null {
    if (typeof window === 'undefined') {
        return null;
    }

    try {
        const rawValue = window.localStorage.getItem(getColumnOrderStorageKey(table));
        if (!rawValue) {
            return null;
        }
        const parsedValue = JSON.parse(rawValue) as unknown;
        if (Array.isArray(parsedValue)) {
            return parsedValue;
        }

        if (parsedValue && typeof parsedValue === 'object') {
            const legacyValue = parsedValue as { desktop?: unknown; mobile?: unknown };
            if (Array.isArray(legacyValue.desktop)) {
                return legacyValue.desktop;
            }
            if (Array.isArray(legacyValue.mobile)) {
                return legacyValue.mobile;
            }
        }

        return null;
    } catch {
        return null;
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
