import {
    compileAlertSearch,
    compileDecisionSearch,
    getSearchDateRange,
    getSearchFacetSelection,
    replaceSearchDateRange,
    replaceSearchFacetSelection,
    serializeSearchNode,
    type SearchDateRange,
    type SearchFacetSelection,
    type SearchNode,
    type SearchPage,
} from '../../../shared/search';
import type { FacetField } from '../types';
import type { DashboardSimulationFilter } from '../../../shared/contracts';

export const QUICK_FILTERS_STORAGE_KEY = 'crowdsec-web-ui:quick-filters';
export type QuickFilterSimulationValue = DashboardSimulationFilter | 'none';

export const ALERT_QUICK_FILTER_FIELDS: FacetField[] = [
    'id',
    'instance',
    'scenario',
    'kind',
    'country',
    'region',
    'city',
    'as',
    'ip',
    'target',
    'machine',
    'origin',
    'decision',
];

export const DECISION_QUICK_FILTER_FIELDS: FacetField[] = [
    'id',
    'instance',
    'scenario',
    'kind',
    'country',
    'region',
    'city',
    'as',
    'ip',
    'action',
    'status',
    'target',
    'machine',
    'origin',
    'alert',
];

const ALL_QUICK_FILTER_FIELDS = new Set<FacetField>([
    ...ALERT_QUICK_FILTER_FIELDS,
    ...DECISION_QUICK_FILTER_FIELDS,
]);

export interface StoredQuickFilters {
    selections: Partial<Record<FacetField, SearchFacetSelection>>;
    dateRange: SearchDateRange;
    simulation: QuickFilterSimulationValue;
}

export function emptyStoredQuickFilters(): StoredQuickFilters {
    return {
        selections: {},
        dateRange: { start: '', end: '' },
        simulation: 'all',
    };
}

export function loadStoredQuickFilters(): StoredQuickFilters {
    if (typeof window === 'undefined') return emptyStoredQuickFilters();

    try {
        const rawValue = window.localStorage.getItem(QUICK_FILTERS_STORAGE_KEY);
        return rawValue ? normalizeStoredQuickFilters(JSON.parse(rawValue)) : emptyStoredQuickFilters();
    } catch {
        return emptyStoredQuickFilters();
    }
}

export function saveStoredQuickFilters(filters: StoredQuickFilters): void {
    if (typeof window === 'undefined') return;

    try {
        window.localStorage.setItem(
            QUICK_FILTERS_STORAGE_KEY,
            JSON.stringify(normalizeStoredQuickFilters(filters)),
        );
    } catch {
        // Quick filters are browser-local convenience state; ignore storage failures.
    }
}

export function getQuickFilterFields(page: SearchPage): FacetField[] {
    return page === 'alerts' ? ALERT_QUICK_FILTER_FIELDS : DECISION_QUICK_FILTER_FIELDS;
}

export function getStoredQuickFilterSelection(
    filters: StoredQuickFilters,
    field: FacetField,
): SearchFacetSelection {
    return filters.selections[field] ?? { included: [], excluded: [] };
}

export function getQuickFilterSimulation(
    searchAst: SearchNode | null,
    fallback: QuickFilterSimulationValue = 'all',
): QuickFilterSimulationValue {
    if (fallback !== 'all') return fallback;
    const selection = getSearchFacetSelection(searchAst, 'sim');
    const included = new Set(selection.included);
    const excluded = new Set(selection.excluded);
    if (included.size === 1 && included.has('live') && excluded.size === 0) return 'live';
    if (included.size === 1 && included.has('simulated') && excluded.size === 0) return 'simulated';
    if (included.size === 0 && excluded.size === 1 && excluded.has('simulated')) return 'live';
    if (included.size === 0 && excluded.size === 1 && excluded.has('live')) return 'simulated';
    if (
        included.size === 0
        && excluded.size === 2
        && excluded.has('live')
        && excluded.has('simulated')
    ) {
        return 'none';
    }
    return 'all';
}

export function quickFilterSimulationSelection(
    value: QuickFilterSimulationValue,
): SearchFacetSelection {
    if (value === 'live' || value === 'simulated') {
        return { included: [value], excluded: [] };
    }
    if (value === 'none') {
        return { included: [], excluded: ['live', 'simulated'] };
    }
    return { included: [], excluded: [] };
}

export function setStoredQuickFilterSelection(
    filters: StoredQuickFilters,
    field: FacetField,
    selection: SearchFacetSelection,
): StoredQuickFilters {
    const selections = { ...filters.selections };
    const normalizedSelection = normalizeSelection(selection);
    if (isSelectionActive(normalizedSelection)) selections[field] = normalizedSelection;
    else delete selections[field];
    return { ...filters, selections };
}

export function mergeStoredQuickFiltersIntoQuery(
    page: SearchPage,
    query: string,
    filters: StoredQuickFilters,
): string {
    const compiled = page === 'alerts'
        ? compileAlertSearch(query, { machineEnabled: true, originEnabled: true })
        : compileDecisionSearch(query, { machineEnabled: true, originEnabled: true });
    if (!compiled.ok) return query;

    let ast = compiled.ast;
    for (const field of getQuickFilterFields(page)) {
        const storedSelection = getStoredQuickFilterSelection(filters, field);
        const querySelection = getSearchFacetSelection(ast, field);
        if (!isSelectionActive(querySelection) && isSelectionActive(storedSelection)) {
            ast = replaceSearchFacetSelection(ast, field, storedSelection);
        }
    }

    const queryDateRange = getSearchDateRange(ast);
    const nextDateRange = {
        start: queryDateRange.start || filters.dateRange.start,
        end: queryDateRange.end || filters.dateRange.end,
    };
    if (
        nextDateRange.start !== queryDateRange.start
        || nextDateRange.end !== queryDateRange.end
    ) {
        ast = replaceSearchDateRange(ast, nextDateRange);
    }

    const querySimulation = getSearchFacetSelection(ast, 'sim');
    if (
        !isSelectionActive(querySimulation)
        && filters.simulation !== 'all'
    ) {
        ast = replaceSearchFacetSelection(
            ast,
            'sim',
            quickFilterSimulationSelection(filters.simulation),
        );
    }

    return serializeSearchNode(ast);
}

export function syncStoredQuickFiltersFromSearch(
    filters: StoredQuickFilters,
    page: SearchPage,
    searchAst: SearchNode | null,
    dateRange: SearchDateRange,
): StoredQuickFilters {
    let next = filters;
    for (const field of getQuickFilterFields(page)) {
        next = setStoredQuickFilterSelection(
            next,
            field,
            getSearchFacetSelection(searchAst, field),
        );
    }
    const simulation = getQuickFilterSimulation(searchAst);
    return {
        ...next,
        dateRange: {
            start: dateRange.start,
            end: dateRange.end,
        },
        simulation,
    };
}

export function storedQuickFiltersEqual(
    left: StoredQuickFilters,
    right: StoredQuickFilters,
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeStoredQuickFilters(value: unknown): StoredQuickFilters {
    const normalized = emptyStoredQuickFilters();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;

    const input = value as { selections?: unknown; dateRange?: unknown; simulation?: unknown };
    if (input.selections && typeof input.selections === 'object' && !Array.isArray(input.selections)) {
        for (const [field, selection] of Object.entries(input.selections)) {
            if (!ALL_QUICK_FILTER_FIELDS.has(field as FacetField)) continue;
            const normalizedSelection = normalizeSelection(selection);
            if (isSelectionActive(normalizedSelection)) {
                normalized.selections[field as FacetField] = normalizedSelection;
            }
        }
    }

    if (input.dateRange && typeof input.dateRange === 'object' && !Array.isArray(input.dateRange)) {
        const dateRange = input.dateRange as Partial<SearchDateRange>;
        normalized.dateRange = {
            start: typeof dateRange.start === 'string' ? dateRange.start : '',
            end: typeof dateRange.end === 'string' ? dateRange.end : '',
        };
    }

    if (
        input.simulation === 'live'
        || input.simulation === 'simulated'
        || input.simulation === 'none'
    ) {
        normalized.simulation = input.simulation;
    }

    return normalized;
}

function normalizeSelection(value: unknown): SearchFacetSelection {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { included: [], excluded: [] };
    }

    const selection = value as Partial<SearchFacetSelection>;
    const included = normalizeValues(selection.included);
    const includedValues = new Set(included);
    return {
        included,
        excluded: normalizeValues(selection.excluded).filter((candidate) => !includedValues.has(candidate)),
    };
}

function normalizeValues(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((candidate): candidate is string => typeof candidate === 'string'))];
}

function isSelectionActive(selection: SearchFacetSelection): boolean {
    return selection.included.length > 0 || selection.excluded.length > 0;
}
