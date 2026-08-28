import { lazy, memo, startTransition, Suspense, useEffect, useState, useMemo, useCallback, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { fetchDashboardStats, fetchConfig } from "../lib/api";
import { useRefresh } from "../contexts/useRefresh";
import { Card, CardContent } from "../components/ui/Card";
import { StatCard } from "../components/StatCard";
import { ScenarioName } from "../components/ScenarioName";
import { QuickFilterDisabledNotice, QuickFilters, type QuickFilterDefinition, type QuickFilterSectionId } from "../components/QuickFilters";
import { CollapsibleSearchControls } from "../components/CollapsibleSearchControls";
import { HighlightedSearchInput } from "../components/HighlightedSearchInput";
import { SearchSyntaxModal } from "../components/SearchSyntaxModal";
import {
    ShieldAlert,
    Gavel,
    Activity,
    TrendingUp
} from "lucide-react";
import { DASHBOARD_COLORS } from "../lib/dashboardColors";
import { getCountryCodesMatchingName, getCountryName } from "../lib/utils";
import type {
    ConfigResponse,
    DashboardFilters,
    DashboardStatsBucket,
    DashboardStatsResponse,
    FacetField,
    SimulationFilter,
} from '../types';
import { useI18n } from "../lib/i18n";
import { getBrowserTimeZone, useDateTime } from "../lib/dateTime";
import {
    ALERT_QUICK_FILTER_FIELDS,
    DECISION_QUICK_FILTER_FIELDS,
    emptyStoredQuickFilters,
    getStoredQuickFilterSelection,
    loadStoredQuickFilters,
    quickFilterSimulationSelection,
    saveStoredQuickFilters,
    setStoredQuickFilterSelection,
    storedQuickFiltersEqual,
    type QuickFilterSimulationValue,
    type StoredQuickFilters,
} from "../lib/quickFilters";
import { getQuickFilterCompatibility } from "../lib/quickFilterCompatibility";
import {
    compileAlertSearch,
    compileDecisionSearch,
    getSearchDateRange,
    getSearchFacetSelection,
    getSearchHelpDefinition,
    replaceSearchDateRange,
    replaceSearchFacetSelection,
    serializeSearchNode,
    type SearchDateRange,
    type SearchFacetSelection,
    type SearchNode,
    type SearchParseError,
    type SearchHelpDefinition,
} from "../../../shared/search";

type Granularity = 'day' | 'hour';
type ScaleMode = 'linear' | 'symlog';
type PercentageBasis = 'filtered' | 'global';
type FilterKey = 'country' | 'scenario' | 'as' | 'ip' | 'target';
type DashboardStatListItem = DashboardStatsResponse['topCountries'][number];

const DASHBOARD_QUICK_FILTER_FIELDS: FacetField[] = [
    'country',
    'scenario',
    'kind',
    'as',
    'ip',
    'target',
    'id',
    'instance',
    'region',
    'city',
    'machine',
    'origin',
];

const DASHBOARD_UNAVAILABLE_QUICK_FILTER_FIELDS: FacetField[] = [
    'decision',
    'action',
    'status',
    'alert',
];
const DASHBOARD_SEARCH_FEATURES = { machineEnabled: true, originEnabled: true };
const PERCENTAGE_BASES: PercentageBasis[] = ['filtered', 'global'];

const DASHBOARD_ALL_QUICK_FILTER_FIELDS = new Set<FacetField>([
    ...DASHBOARD_QUICK_FILTER_FIELDS,
    ...DASHBOARD_UNAVAILABLE_QUICK_FILTER_FIELDS,
]);

interface DashboardCountState {
    alerts: number;
    decisions: number;
    simulatedAlerts: number;
    simulatedDecisions: number;
}

interface InFlightDashboardLoad {
    requestId: number;
    signal?: AbortSignal;
}

const ActivityBarChart = memo(lazy(async () => ({ default: (await import('../components/DashboardCharts')).ActivityBarChart })));
const WorldMapCard = memo(lazy(async () => ({ default: (await import('../components/WorldMapCard')).WorldMapCard })));

const EMPTY_FILTERS: DashboardFilters = {
    dateRange: null,
    dateRangeSticky: false,
    country: null,
    scenario: null,
    as: null,
    ip: null,
    target: null,
    simulation: 'all',
};

const EMPTY_TOTALS: DashboardCountState = {
    alerts: 0,
    decisions: 0,
    simulatedAlerts: 0,
    simulatedDecisions: 0,
};

const EMPTY_DASHBOARD_STATS: DashboardStatsResponse = {
    totals: EMPTY_TOTALS,
    filteredTotals: EMPTY_TOTALS,
    globalTotal: 0,
    topTargets: [],
    topCountries: [],
    allCountries: [],
    attackLocations: [],
    topScenarios: [],
    topAS: [],
    series: {
        alertsHistory: [],
        simulatedAlertsHistory: [],
        decisionsHistory: [],
        simulatedDecisionsHistory: [],
        activeDecisionsHistory: [],
        activeSimulatedDecisionsHistory: [],
        unfilteredAlertsHistory: [],
        unfilteredSimulatedAlertsHistory: [],
        unfilteredDecisionsHistory: [],
        unfilteredSimulatedDecisionsHistory: [],
    },
};

function dashboardConfigMatches(
    current: ConfigResponse | null,
    next: ConfigResponse,
): boolean {
    if (!current) return false;
    return current.lookback_hours === next.lookback_hours
        && current.simulations_enabled === next.simulations_enabled
        && JSON.stringify(current.lapi_status) === JSON.stringify(next.lapi_status)
        && JSON.stringify(current.instances || []) === JSON.stringify(next.instances || []);
}

function parseStoredGranularity(value: string | null): Granularity {
    return value === 'hour' ? 'hour' : 'day';
}

function parseStoredScaleMode(value: string | null): ScaleMode {
    return value === 'symlog' ? 'symlog' : 'linear';
}

function parseStoredPercentageBasis(value: string | null): PercentageBasis {
    return value === 'filtered' ? 'filtered' : 'global';
}

function parseLegacyStoredFilters(value: string | null): DashboardFilters {
    if (!value) {
        return EMPTY_FILTERS;
    }

    try {
        return {
            ...EMPTY_FILTERS,
            ...(JSON.parse(value) as Partial<DashboardFilters>),
        };
    } catch (error) {
        console.error("Failed to parse saved filters", error);
        return EMPTY_FILTERS;
    }
}

function migrateLegacyDashboardFilters(stored: StoredQuickFilters): {
    filters: StoredQuickFilters;
    simulation: QuickFilterSimulationValue;
    dateRangeSticky: boolean;
} {
    const legacyStorageKey = 'dashboard_filters';
    const legacy = parseLegacyStoredFilters(localStorage.getItem(legacyStorageKey));
    localStorage.removeItem(legacyStorageKey);
    let filters = stored;
    const legacySelections: Array<[FacetField, string | null]> = [
        ['country', legacy.country],
        ['scenario', legacy.scenario],
        ['as', legacy.as],
        ['ip', legacy.ip],
        ['target', legacy.target],
    ];

    for (const [field, value] of legacySelections) {
        const existing = getStoredQuickFilterSelection(filters, field);
        if (value && existing.included.length === 0 && existing.excluded.length === 0) {
            filters = setStoredQuickFilterSelection(filters, field, {
                included: [value],
                excluded: [],
            });
        }
    }

    if (
        legacy.dateRange
        && !filters.dateRange.start
        && !filters.dateRange.end
    ) {
        filters = {
            ...filters,
            dateRange: {
                start: legacy.dateRange.start,
                end: legacy.dateRange.end,
            },
        };
    }

    if (filters.simulation === 'all' && legacy.simulation !== 'all') {
        filters = {
            ...filters,
            simulation: legacy.simulation,
        };
    }

    return {
        filters,
        simulation: filters.simulation,
        dateRangeSticky: legacy.dateRangeSticky,
    };
}

function buildStoredSearchAst(
    stored: StoredQuickFilters,
    fields: FacetField[],
    includeDateRange: boolean,
): SearchNode | null {
    let ast: SearchNode | null = null;
    for (const field of fields) {
        ast = replaceSearchFacetSelection(
            ast,
            field,
            getStoredQuickFilterSelection(stored, field),
        );
    }
    if (stored.simulation === 'none') {
        ast = replaceSearchFacetSelection(
            ast,
            'sim',
            quickFilterSimulationSelection(stored.simulation),
        );
    }

    return includeDateRange
        ? replaceSearchDateRange(ast, stored.dateRange)
        : ast;
}

function buildDashboardVisibleSearchAst(stored: StoredQuickFilters): SearchNode | null {
    const ast = buildStoredSearchAst(stored, DASHBOARD_QUICK_FILTER_FIELDS, true);
    return replaceSearchFacetSelection(
        ast,
        'sim',
        quickFilterSimulationSelection(stored.simulation),
    );
}

function stripDashboardQuickFilters(searchAst: SearchNode | null): string {
    let ast = searchAst;
    for (const field of DASHBOARD_QUICK_FILTER_FIELDS) {
        ast = removeDashboardExactFacetPredicates(ast, field);
    }
    ast = removeDashboardExactFacetPredicates(ast, 'sim');
    ast = replaceSearchDateRange(ast, { start: '', end: '' });
    return serializeSearchNode(ast);
}

function getDashboardExactFacetSelection(
    searchAst: SearchNode | null,
    field: string,
): SearchFacetSelection {
    const included = new Set<string>();
    const excluded = new Set<string>();
    const normalizedField = field.toLowerCase();

    const collect = (node: SearchNode | null, negated: boolean): void => {
        if (!node) return;
        if (
            node.kind === 'comparison'
            && node.field.toLowerCase() === normalizedField
            && (node.operator === '=' || node.operator === '<>')
        ) {
            const isExcluded = negated !== (node.operator === '<>');
            (isExcluded ? excluded : included).add(node.value);
            return;
        }
        if (node.kind === 'not') {
            collect(node.expression, !negated);
            return;
        }
        if (node.kind === 'binary') {
            collect(node.left, negated);
            collect(node.right, negated);
        }
    };

    collect(searchAst, false);
    return { included: [...included], excluded: [...excluded] };
}

function removeDashboardExactFacetPredicates(
    searchAst: SearchNode | null,
    field: string,
): SearchNode | null {
    if (!searchAst) return null;
    const normalizedField = field.toLowerCase();
    if (
        searchAst.kind === 'comparison'
        && searchAst.field.toLowerCase() === normalizedField
        && (searchAst.operator === '=' || searchAst.operator === '<>')
    ) {
        return null;
    }
    if (searchAst.kind === 'not') {
        const expression = removeDashboardExactFacetPredicates(searchAst.expression, field);
        return expression ? { ...searchAst, expression } : null;
    }
    if (searchAst.kind === 'binary') {
        const left = removeDashboardExactFacetPredicates(searchAst.left, field);
        const right = removeDashboardExactFacetPredicates(searchAst.right, field);
        if (!left) return right;
        if (!right) return left;
        return { ...searchAst, left, right };
    }
    return searchAst;
}

function getDashboardQuickFilterSimulation(searchAst: SearchNode | null): QuickFilterSimulationValue {
    const selection = getDashboardExactFacetSelection(searchAst, 'sim');
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

function syncDashboardQuickFiltersFromSearch(
    stored: StoredQuickFilters,
    searchAst: SearchNode | null,
): StoredQuickFilters {
    let next = stored;
    for (const field of DASHBOARD_QUICK_FILTER_FIELDS) {
        next = setStoredQuickFilterSelection(
            next,
            field,
            getDashboardExactFacetSelection(searchAst, field),
        );
    }
    return {
        ...next,
        dateRange: getSearchDateRange(searchAst),
        simulation: getDashboardQuickFilterSimulation(searchAst),
    };
}

function buildDashboardSearchHelp(): SearchHelpDefinition {
    const alertHelp = getSearchHelpDefinition('alerts', DASHBOARD_SEARCH_FEATURES);
    const decisionHelp = getSearchHelpDefinition('decisions', DASHBOARD_SEARCH_FEATURES);
    const decisionFields = new Set(decisionHelp.fields.map((field) => field.name));
    return {
        ...alertHelp,
        title: 'Dashboard Search Syntax',
        titleKey: 'pages.dashboard.searchSyntaxTitle',
        fields: alertHelp.fields.filter((field) => decisionFields.has(field.name)),
        examples: alertHelp.examples.filter((example) => (
            compileDecisionSearch(example.query, DASHBOARD_SEARCH_FEATURES).ok
        )),
    };
}

function getSingleIncludedSelection(
    stored: StoredQuickFilters,
    field: FacetField,
): string | null {
    const selection = getStoredQuickFilterSelection(stored, field);
    return selection.included.length === 1 && selection.excluded.length === 0
        ? selection.included[0]
        : null;
}

function toDashboardFilters(
    stored: StoredQuickFilters,
    simulation: QuickFilterSimulationValue,
    dateRangeSticky: boolean,
): DashboardFilters {
    return {
        dateRange: stored.dateRange.start || stored.dateRange.end
            ? { ...stored.dateRange }
            : null,
        dateRangeSticky,
        country: getSingleIncludedSelection(stored, 'country'),
        scenario: getSingleIncludedSelection(stored, 'scenario'),
        as: getSingleIncludedSelection(stored, 'as'),
        ip: getSingleIncludedSelection(stored, 'ip'),
        target: getSingleIncludedSelection(stored, 'target'),
        simulation: simulation === 'none' ? 'all' : simulation,
    };
}

function toActivitySeries(
    buckets: DashboardStatsBucket[],
    formatDate: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string,
    formatTime: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string,
) {
    return buckets.map((bucket) => ({
        date: bucket.date,
        count: bucket.count,
        label: bucket.date.includes('T')
            ? `${formatDate(bucket.fullDate, { month: 'short', day: 'numeric' })}, ${formatTime(bucket.fullDate, { hour: '2-digit', minute: '2-digit' })}`
            : formatDate(bucket.fullDate, { month: 'short', day: 'numeric' }),
        fullDate: bucket.fullDate,
    }));
}

function quoteSearchValue(value: string): string {
    if (/^[^\s()"]+$/.test(value) && !['AND', 'OR', 'NOT'].includes(value.toUpperCase())) {
        return value;
    }

    return `"${value.replace(/"/g, '')}"`;
}

function combineDashboardSearchQuery(...queries: Array<string | null | undefined>): string {
    const normalizedQueries = queries
        .map((query) => query?.trim() ?? '')
        .filter(Boolean);
    if (normalizedQueries.length < 2) return normalizedQueries[0] ?? '';
    return normalizedQueries.map((query) => `(${query})`).join(' AND ');
}

function getDashboardSearchError(query: string): SearchParseError | null {
    const alertSearch = compileAlertSearch(query, DASHBOARD_SEARCH_FEATURES);
    if (!alertSearch.ok) return alertSearch.error;
    const decisionSearch = compileDecisionSearch(query, DASHBOARD_SEARCH_FEATURES);
    return decisionSearch.ok ? null : decisionSearch.error;
}

function initializeDashboardSearch(
    stored: ReturnType<typeof migrateLegacyDashboardFilters>,
    query: string,
): ReturnType<typeof migrateLegacyDashboardFilters> & {
    customSearch: string;
    quickFiltersCompatible: boolean;
} {
    if (!query || getDashboardSearchError(query)) {
        return { ...stored, customSearch: '', quickFiltersCompatible: true };
    }

    const compiled = compileAlertSearch(query, DASHBOARD_SEARCH_FEATURES);
    if (!compiled.ok) {
        return { ...stored, customSearch: '', quickFiltersCompatible: true };
    }
    const compatibility = getQuickFilterCompatibility(
        compiled.ast,
        DASHBOARD_QUICK_FILTER_FIELDS,
    );
    if (!compatibility.compatible) {
        return {
            ...stored,
            customSearch: query,
            quickFiltersCompatible: false,
        };
    }

    let filters = stored.filters;
    for (const field of DASHBOARD_QUICK_FILTER_FIELDS) {
        const selection = getSearchFacetSelection(compiled.ast, field);
        if (selection.included.length > 0 || selection.excluded.length > 0) {
            filters = setStoredQuickFilterSelection(filters, field, {
                included: [],
                excluded: [],
            });
        }
    }

    const dateRange = getSearchDateRange(compiled.ast);
    if (dateRange.start || dateRange.end) {
        filters = { ...filters, dateRange: { start: '', end: '' } };
    }
    const simulation = getSearchFacetSelection(compiled.ast, 'sim');
    if (simulation.included.length > 0 || simulation.excluded.length > 0) {
        filters = { ...filters, simulation: 'all' };
    }

    return {
        ...stored,
        filters,
        simulation: filters.simulation,
        customSearch: query,
        quickFiltersCompatible: true,
    };
}

function buildDashboardDrilldownQuery(
    searchAst: SearchNode | null,
    simulation: SimulationFilter,
    simulationsEnabled: boolean,
    advancedSearch = '',
): string {
    const query = serializeSearchNode(searchAst);
    const clauses = [query, advancedSearch.trim()].filter(Boolean);

    if (simulationsEnabled && simulation !== 'all') {
        clauses.push(`sim=${quoteSearchValue(simulation)}`);
    }

    return clauses.join(' AND ');
}

function buildDashboardDrilldownHref(pathname: '/alerts' | '/decisions', query: string): string {
    if (!query) {
        return pathname;
    }

    const params = new URLSearchParams();
    params.set('q', query);
    return `${pathname}?${params.toString()}`;
}

function withSelectedZeroItem<TItem extends DashboardStatListItem>(
    items: TItem[],
    selectedValue: string | null,
    createItem: (selectedValue: string) => TItem,
): TItem[] {
    if (!selectedValue) {
        return items;
    }

    const hasSelectedItem = items.some((item) =>
        item.value === selectedValue ||
        item.label === selectedValue ||
        item.countryCode === selectedValue
    );

    if (hasSelectedItem) {
        return items;
    }

    return [createItem(selectedValue), ...items];
}

function statItemMatchesValue(item: DashboardStatListItem, value: string): boolean {
    return item.value === value ||
        item.label === value ||
        item.countryCode === value;
}

function scopeStaleStatItemsToSelected<TItem extends DashboardStatListItem>(
    items: TItem[],
    selectedValue: string | null,
    shouldScope: boolean,
): TItem[] {
    if (!shouldScope || !selectedValue) {
        return items;
    }

    return items.filter((item) => statItemMatchesValue(item, selectedValue));
}

export function Dashboard() {
    const [searchParams, setSearchParams] = useSearchParams();
    const { language, t } = useI18n();
    const { formatDate, formatTime } = useDateTime();
    const { refreshSignal } = useRefresh();
    const [initialLoading, setInitialLoading] = useState(true);
    const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
    const [dashboardStatsPending, setDashboardStatsPending] = useState(false);
    const [filterApplying, setFilterApplying] = useState(false);
    const [filterApplicationVersion, setFilterApplicationVersion] = useState(0);
    const [config, setConfig] = useState<ConfigResponse | null>(null);
    const [initialStoredFilters] = useState(() => initializeDashboardSearch(
        migrateLegacyDashboardFilters(loadStoredQuickFilters()),
        searchParams.get('q') ?? '',
    ));

    // Initialize state from local storage or defaults
    const [granularity, setGranularity] = useState<Granularity>(() => parseStoredGranularity(localStorage.getItem('dashboard_granularity')));
    const [scaleMode, setScaleMode] = useState<ScaleMode>(() => parseStoredScaleMode(localStorage.getItem('dashboard_scale_mode')));

    // Percentage Basis: 'filtered' or 'global'
    const [percentageBasis, setPercentageBasis] = useState<PercentageBasis>(() => parseStoredPercentageBasis(localStorage.getItem('dashboard_percentage_basis')));
    const [dashboardSearchDraft, setDashboardSearchDraft] = useState(() => (
        initialStoredFilters.quickFiltersCompatible
            ? combineDashboardSearchQuery(
                serializeSearchNode(buildDashboardVisibleSearchAst(initialStoredFilters.filters)),
                initialStoredFilters.customSearch,
            )
            : initialStoredFilters.customSearch
    ));
    const [dashboardCustomSearch, setDashboardCustomSearch] = useState(initialStoredFilters.customSearch);
    const dashboardCustomSearchRef = useRef(initialStoredFilters.customSearch);
    const dashboardSearchEditedByUserRef = useRef(false);
    const [showDashboardSearchSyntax, setShowDashboardSearchSyntax] = useState(false);
    const dashboardSearchInputRef = useRef<HTMLInputElement | null>(null);
    const dashboardSearchHelp = useMemo(() => buildDashboardSearchHelp(), []);
    const dashboardSearchError = useMemo(
        () => getDashboardSearchError(dashboardSearchDraft),
        [dashboardSearchDraft],
    );
    const dashboardQuickFilterCompatibility = useMemo(() => {
        if (dashboardSearchError) {
            return { compatible: false as const, reason: 'syntax-error' as const };
        }
        const compiled = compileAlertSearch(dashboardSearchDraft, DASHBOARD_SEARCH_FEATURES);
        return compiled.ok
            ? getQuickFilterCompatibility(compiled.ast, DASHBOARD_QUICK_FILTER_FIELDS)
            : { compatible: false as const, reason: 'syntax-error' as const };
    }, [dashboardSearchDraft, dashboardSearchError]);
    const quickFilterDisabledReason = dashboardQuickFilterCompatibility.compatible
        ? undefined
        : t(`components.quickFilters.disabled.${dashboardQuickFilterCompatibility.reason}`);

    const [configRequestFailed, setConfigRequestFailed] = useState(false);
    const [dashboardStats, setDashboardStats] = useState<DashboardStatsResponse | null>(null);
    const [dashboardStatsLoadKey, setDashboardStatsLoadKey] = useState<string | null>(null);
    const dashboardStatsRef = useRef<DashboardStatsResponse | null>(null);
    const loadDataRef = useRef<(
        isBackground?: boolean,
        signal?: AbortSignal,
        force?: boolean,
    ) => Promise<void>>(async () => {});
    const lastRefreshSignalRef = useRef(refreshSignal);
    const inFlightLoadKeysRef = useRef(new Map<string, InFlightDashboardLoad>());
    const nextLoadRequestIdRef = useRef(0);
    const lastCompletedLoadRef = useRef<{ key: string; completedAt: number } | null>(null);
    const pendingStatsRetryTimeoutRef = useRef<number | null>(null);
    const filterApplyingRef = useRef(false);
    const latestFilterApplicationVersionRef = useRef(0);

    const [persistedQuickFilters, setPersistedQuickFilters] = useState<StoredQuickFilters>(
        initialStoredFilters.filters,
    );
    const persistedQuickFiltersRef = useRef(persistedQuickFilters);
    const [simulationFilter, setSimulationFilter] = useState<QuickFilterSimulationValue>(
        initialStoredFilters.simulation,
    );
    const [quickFiltersAppliedCompatible, setQuickFiltersAppliedCompatible] = useState(
        initialStoredFilters.quickFiltersCompatible,
    );
    const [dateRangeSticky, setDateRangeSticky] = useState(initialStoredFilters.dateRangeSticky);
    const effectiveQuickFilters = useMemo(
        () => quickFiltersAppliedCompatible ? persistedQuickFilters : emptyStoredQuickFilters(),
        [persistedQuickFilters, quickFiltersAppliedCompatible],
    );
    const effectiveSimulationFilter = quickFiltersAppliedCompatible ? simulationFilter : 'all';
    const quickFilterInteractionsEnabled = (
        quickFiltersAppliedCompatible
        && dashboardQuickFilterCompatibility.compatible
    );
    const filters = useMemo(
        () => toDashboardFilters(
            effectiveQuickFilters,
            effectiveSimulationFilter,
            quickFiltersAppliedCompatible ? dateRangeSticky : false,
        ),
        [
            dateRangeSticky,
            effectiveQuickFilters,
            effectiveSimulationFilter,
            quickFiltersAppliedCompatible,
        ],
    );
    const dashboardAlertFacetAst = useMemo(
        () => buildStoredSearchAst(effectiveQuickFilters, ALERT_QUICK_FILTER_FIELDS, false),
        [effectiveQuickFilters],
    );
    const dashboardDecisionFacetAst = useMemo(
        () => buildStoredSearchAst(effectiveQuickFilters, DECISION_QUICK_FILTER_FIELDS, false),
        [effectiveQuickFilters],
    );
    const dashboardAlertSearchAst = useMemo(
        () => buildStoredSearchAst(effectiveQuickFilters, ALERT_QUICK_FILTER_FIELDS, true),
        [effectiveQuickFilters],
    );
    const dashboardDecisionSearchAst = useMemo(
        () => buildStoredSearchAst(effectiveQuickFilters, DECISION_QUICK_FILTER_FIELDS, true),
        [effectiveQuickFilters],
    );
    useEffect(() => {
        if (!storedQuickFiltersEqual(loadStoredQuickFilters(), persistedQuickFilters)) {
            saveStoredQuickFilters(persistedQuickFilters);
        }
    }, [persistedQuickFilters]);

    useEffect(() => {
        localStorage.setItem('dashboard_granularity', granularity);
    }, [granularity]);

    useEffect(() => {
        localStorage.setItem('dashboard_scale_mode', scaleMode);
    }, [scaleMode]);

    useEffect(() => {
        localStorage.setItem('dashboard_percentage_basis', percentageBasis);
    }, [percentageBasis]);

    const finishFilterApplication = useCallback(() => {
        filterApplyingRef.current = false;
        setFilterApplying(false);
    }, []);

    const startFilterApplication = useCallback((applyChange: () => void) => {
        if (filterApplyingRef.current) {
            return false;
        }

        const nextVersion = latestFilterApplicationVersionRef.current + 1;
        latestFilterApplicationVersionRef.current = nextVersion;
        filterApplyingRef.current = true;
        setFilterApplying(true);
        setFilterApplicationVersion(nextVersion);
        applyChange();
        return true;
    }, []);

    const updatePersistedQuickFilters = useCallback((
        update: (current: StoredQuickFilters) => StoredQuickFilters,
    ) => {
        const current = persistedQuickFiltersRef.current;
        const next = update(current);
        if (storedQuickFiltersEqual(current, next)) return false;
        persistedQuickFiltersRef.current = next;
        saveStoredQuickFilters(next);
        setPersistedQuickFilters(next);
        setDashboardSearchDraft(combineDashboardSearchQuery(
            serializeSearchNode(buildDashboardVisibleSearchAst(next)),
            dashboardCustomSearchRef.current,
        ));
        return true;
    }, []);

    const updateDashboardCustomSearch = useCallback((search: string) => {
        dashboardCustomSearchRef.current = search;
        setDashboardCustomSearch(search);
        setDashboardSearchDraft(combineDashboardSearchQuery(
            serializeSearchNode(buildDashboardVisibleSearchAst(persistedQuickFiltersRef.current)),
            search,
        ));
    }, []);

    const updateDashboardSearchDraftFromUser = useCallback((search: string) => {
        dashboardSearchEditedByUserRef.current = true;
        setDashboardSearchDraft(search);
    }, []);

    useEffect(() => {
        if (dashboardSearchError) return;
        const timeout = window.setTimeout(() => {
            const compiled = compileAlertSearch(dashboardSearchDraft, DASHBOARD_SEARCH_FEATURES);
            if (!compiled.ok) return;
            const compatibility = getQuickFilterCompatibility(
                compiled.ast,
                DASHBOARD_QUICK_FILTER_FIELDS,
            );
            if (!compatibility.compatible) {
                dashboardSearchEditedByUserRef.current = false;
                dashboardCustomSearchRef.current = dashboardSearchDraft;
                setDashboardCustomSearch(dashboardSearchDraft);
                setQuickFiltersAppliedCompatible(false);
                const nextParams = new URLSearchParams(searchParams);
                if (dashboardSearchDraft) nextParams.set('q', dashboardSearchDraft);
                else nextParams.delete('q');
                if (nextParams.toString() !== searchParams.toString()) {
                    setSearchParams(nextParams, { replace: true });
                }
                return;
            }
            const nextFilters = syncDashboardQuickFiltersFromSearch(
                persistedQuickFiltersRef.current,
                compiled.ast,
            );
            const searchDateRangeChanged = (
                nextFilters.dateRange.start !== persistedQuickFiltersRef.current.dateRange.start
                || nextFilters.dateRange.end !== persistedQuickFiltersRef.current.dateRange.end
            );
            if (dashboardSearchEditedByUserRef.current && searchDateRangeChanged) {
                setDateRangeSticky(false);
            }
            dashboardSearchEditedByUserRef.current = false;
            const nextCustomSearch = stripDashboardQuickFilters(compiled.ast);
            dashboardCustomSearchRef.current = nextCustomSearch;
            setDashboardCustomSearch(nextCustomSearch);
            setSimulationFilter(nextFilters.simulation);
            setQuickFiltersAppliedCompatible(true);
            if (!storedQuickFiltersEqual(persistedQuickFiltersRef.current, nextFilters)) {
                persistedQuickFiltersRef.current = nextFilters;
                saveStoredQuickFilters(nextFilters);
                setPersistedQuickFilters(nextFilters);
            }
            const nextParams = new URLSearchParams(searchParams);
            if (dashboardSearchDraft) nextParams.set('q', dashboardSearchDraft);
            else nextParams.delete('q');
            if (nextParams.toString() !== searchParams.toString()) {
                setSearchParams(nextParams, { replace: true });
            }
        }, 300);
        return () => window.clearTimeout(timeout);
    }, [
        dashboardSearchDraft,
        dashboardSearchError,
        searchParams,
        setSearchParams,
    ]);

    // Handler to change granularity and clear date range simultaneously (explicit user action)
    const handleGranularityChange = useCallback((newGranularity: Granularity) => {
        if (newGranularity === granularity && filters.dateRange === null) {
            return;
        }

        startFilterApplication(() => {
            setGranularity(newGranularity);
            if (!quickFilterInteractionsEnabled) return;
            setDateRangeSticky(false);
            updatePersistedQuickFilters((current) => ({
                ...current,
                dateRange: { start: '', end: '' },
            }));
        });
    }, [
        filters.dateRange,
        granularity,
        quickFilterInteractionsEnabled,
        startFilterApplication,
        updatePersistedQuickFilters,
    ]);

    const buildDashboardStatsFilters = useCallback((): Record<string, string> => {
        const requestFilters: Record<string, string> = {
            granularity,
            tz_offset: String(new Date().getTimezoneOffset()),
            instance: searchParams.get('instance') || 'all',
        };
        const browserTimeZone = getBrowserTimeZone();
        if (browserTimeZone) requestFilters.browser_tz = browserTimeZone;

        if (filters.country) requestFilters.country = filters.country;
        if (filters.scenario) requestFilters.scenario = filters.scenario;
        if (filters.as) requestFilters.as = filters.as;
        if (filters.ip) requestFilters.ip = filters.ip;
        if (filters.target) requestFilters.target = filters.target;
        const alertQuery = combineDashboardSearchQuery(
            serializeSearchNode(dashboardAlertFacetAst),
            dashboardCustomSearch,
        );
        const decisionQuery = combineDashboardSearchQuery(
            serializeSearchNode(dashboardDecisionFacetAst),
            dashboardCustomSearch,
        );
        if (alertQuery) requestFilters.q = alertQuery;
        if (decisionQuery) requestFilters.decision_q = decisionQuery;
        if (filters.dateRange) {
            requestFilters.dateStart = filters.dateRange.start;
            requestFilters.dateEnd = filters.dateRange.end;
        }
        if (filters.simulation !== 'all') {
            requestFilters.simulation = filters.simulation;
        }

        return requestFilters;
    }, [
        dashboardAlertFacetAst,
        dashboardCustomSearch,
        dashboardDecisionFacetAst,
        filters,
        granularity,
        searchParams,
    ]);

    const loadData = useCallback(async (isBackground = false, signal?: AbortSignal, force = false) => {
        const requestFilters = buildDashboardStatsFilters();
        const loadKey = JSON.stringify(requestFilters);
        const isFilterApplication = filterApplyingRef.current &&
            filterApplicationVersion === latestFilterApplicationVersionRef.current;
        const lastCompletedLoad = lastCompletedLoadRef.current;
        const inFlightLoad = inFlightLoadKeysRef.current.get(loadKey);
        if (!force && (
            (inFlightLoad && !inFlightLoad.signal?.aborted) ||
            (lastCompletedLoad?.key === loadKey && Date.now() - lastCompletedLoad.completedAt < 250)
        )) {
            if (filterApplyingRef.current) {
                finishFilterApplication();
            }
            return;
        }

        const requestId = nextLoadRequestIdRef.current + 1;
        nextLoadRequestIdRef.current = requestId;
        inFlightLoadKeysRef.current.set(loadKey, { requestId, signal });
        const shouldBlockWithInitialLoading = !dashboardStatsRef.current && !isBackground;
        if (shouldBlockWithInitialLoading) {
            setInitialLoading(true);
        } else {
            setBackgroundRefreshing(true);
        }

        let completedLoadWasPending = false;
        let completedLoadHadRenderableStats = false;
        try {
            const [configData, dashboardStatsData] = await Promise.all([
                fetchConfig(),
                fetchDashboardStats(requestFilters, { signal }),
            ]);
            if (signal?.aborted || requestId !== nextLoadRequestIdRef.current) {
                return;
            }

            setConfig((current) => dashboardConfigMatches(current, configData) ? current : configData);
            setConfigRequestFailed(false);
            if (pendingStatsRetryTimeoutRef.current !== null) {
                window.clearTimeout(pendingStatsRetryTimeoutRef.current);
                pendingStatsRetryTimeoutRef.current = null;
            }
            const hasCurrentStats = dashboardStatsRef.current !== null && (
                dashboardStatsRef.current.pending !== true
                || dashboardStatsRef.current.stale === true
            );
            const responseHasRenderableStats = dashboardStatsData.pending !== true
                || dashboardStatsData.stale === true;
            completedLoadHadRenderableStats = hasCurrentStats || responseHasRenderableStats;
            completedLoadWasPending = dashboardStatsData.pending === true;
            setDashboardStatsPending(completedLoadWasPending);
            if (!dashboardStatsData.pending || !hasCurrentStats) {
                dashboardStatsRef.current = dashboardStatsData;
                const applyDashboardStats = () => {
                    setDashboardStats(dashboardStatsData);
                    setDashboardStatsLoadKey(loadKey);
                };
                if (isBackground && !isFilterApplication && hasCurrentStats) {
                    startTransition(applyDashboardStats);
                } else {
                    applyDashboardStats();
                }
            }
            if (dashboardStatsData.pending) {
                pendingStatsRetryTimeoutRef.current = window.setTimeout(() => {
                    pendingStatsRetryTimeoutRef.current = null;
                    void loadDataRef.current(true);
                }, dashboardStatsData.retryAfterMs ?? 1500);
            }

        } catch (error) {
            if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
                return;
            }
            console.error("Failed to load dashboard data", error);
            setConfigRequestFailed(true);
            setDashboardStatsPending(false);
        } finally {
            if (inFlightLoadKeysRef.current.get(loadKey)?.requestId === requestId) {
                inFlightLoadKeysRef.current.delete(loadKey);
            }
            if (!signal?.aborted && !completedLoadWasPending) {
                lastCompletedLoadRef.current = { key: loadKey, completedAt: Date.now() };
            }
            if (!signal?.aborted) {
                setInitialLoading(completedLoadWasPending && !completedLoadHadRenderableStats);
                setBackgroundRefreshing(false);
            }
            if (
                filterApplyingRef.current &&
                requestId === nextLoadRequestIdRef.current &&
                !signal?.aborted
            ) {
                finishFilterApplication();
            }
        }
    }, [buildDashboardStatsFilters, filterApplicationVersion, finishFilterApplication]);

    useEffect(() => {
        loadDataRef.current = loadData;
    }, [loadData]);

    useEffect(() => {
        const controller = new AbortController();
        queueMicrotask(() => {
            void loadData(false, controller.signal);
        });

        return () => {
            controller.abort();
            if (pendingStatsRetryTimeoutRef.current !== null) {
                window.clearTimeout(pendingStatsRetryTimeoutRef.current);
                pendingStatsRetryTimeoutRef.current = null;
            }
        };
    }, [loadData]);

    // Background Refresh
    useEffect(() => {
        if (refreshSignal <= lastRefreshSignalRef.current) {
            return;
        }

        lastRefreshSignalRef.current = refreshSignal;
        const controller = new AbortController();
        void loadDataRef.current(true, controller.signal, true);
        return () => controller.abort();
    }, [refreshSignal]);

    const dashboardData = dashboardStats ?? EMPTY_DASHBOARD_STATS;
    const stats = dashboardData.totals;
    const requestedInstanceId = searchParams.get('instance') || 'all';
    const configuredInstances = useMemo(() => config?.instances || [], [config?.instances]);
    const instanceNames = useMemo(
        () => Object.fromEntries(configuredInstances.map((instance) => [instance.id, instance.name])),
        [configuredInstances],
    );
    const isAllInstancesScope = requestedInstanceId === 'all' && configuredInstances.length > 1;
    const selectedInstance = requestedInstanceId === 'all'
        ? configuredInstances[0]
        : configuredInstances.find((instance) => instance.id === requestedInstanceId);
    const onlineInstanceCount = isAllInstancesScope
        ? configuredInstances.filter((instance) => instance.lapi_status.isConnected).length
        : Number(selectedInstance?.lapi_status.isConnected ?? config?.lapi_status.isConnected ?? false);
    const totalInstanceCount = isAllInstancesScope ? configuredInstances.length : 1;
    const lapiAvailability = configRequestFailed || onlineInstanceCount === 0
        ? 'offline'
        : onlineInstanceCount === totalInstanceCount
            ? 'online'
            : 'partial';
    const lapiStatusLabel = isAllInstancesScope && lapiAvailability === 'online'
        ? t('pages.dashboard.allLapisOnline')
        : lapiAvailability === 'partial'
            ? t('pages.dashboard.lapisPartiallyOnline')
            : lapiAvailability === 'online'
                ? t('common.online')
                : t('common.offline');
    const lapiStatusTone = lapiAvailability === 'online'
        ? {
            background: 'bg-green-100 dark:bg-green-900/20',
            icon: 'text-green-600 dark:text-green-400',
            text: 'text-gray-900 dark:text-white',
        }
        : lapiAvailability === 'partial'
            ? {
                background: 'bg-amber-100 dark:bg-amber-900/20',
                icon: 'text-amber-600 dark:text-amber-400',
                text: 'text-amber-600 dark:text-amber-400',
            }
            : {
                background: 'bg-red-100 dark:bg-red-900/20',
                icon: 'text-red-600 dark:text-red-400',
                text: 'text-red-600 dark:text-red-400',
            };
    const currentDashboardStatsLoadKey = useMemo(() => JSON.stringify(buildDashboardStatsFilters()), [buildDashboardStatsFilters]);
    const isDashboardStatsStaleForFilters = dashboardStatsLoadKey !== null && dashboardStatsLoadKey !== currentDashboardStatsLoadKey;

    const statistics = useMemo(() => {
        return {
            topTargets: withSelectedZeroItem(
                scopeStaleStatItemsToSelected(dashboardData.topTargets, filters.target, isDashboardStatsStaleForFilters),
                filters.target,
                (target) => ({ label: target, count: 0 }),
            ),
            topCountries: withSelectedZeroItem(
                scopeStaleStatItemsToSelected(dashboardData.topCountries, filters.country, isDashboardStatsStaleForFilters),
                filters.country,
                (countryCode) => ({
                    label: dashboardData.allCountries.find((country) => country.countryCode === countryCode)?.label ?? countryCode,
                    value: countryCode,
                    countryCode,
                    count: 0,
                }),
            ),
            allCountries: dashboardData.allCountries,
            topScenarios: withSelectedZeroItem(
                scopeStaleStatItemsToSelected(dashboardData.topScenarios, filters.scenario, isDashboardStatsStaleForFilters),
                filters.scenario,
                (scenario) => ({ label: scenario, count: 0 }),
            ),
            topAS: withSelectedZeroItem(
                scopeStaleStatItemsToSelected(dashboardData.topAS, filters.as, isDashboardStatsStaleForFilters),
                filters.as,
                (asName) => ({ label: asName, count: 0 }),
            ),
            alertsHistory: toActivitySeries(dashboardData.series.alertsHistory, formatDate, formatTime),
            simulatedAlertsHistory: toActivitySeries(dashboardData.series.simulatedAlertsHistory, formatDate, formatTime),
            decisionsHistory: toActivitySeries(dashboardData.series.decisionsHistory, formatDate, formatTime),
            simulatedDecisionsHistory: toActivitySeries(dashboardData.series.simulatedDecisionsHistory, formatDate, formatTime),
            activeDecisionsHistory: toActivitySeries(dashboardData.series.activeDecisionsHistory, formatDate, formatTime),
            activeSimulatedDecisionsHistory: toActivitySeries(dashboardData.series.activeSimulatedDecisionsHistory, formatDate, formatTime),
            unfilteredAlertsHistory: toActivitySeries(dashboardData.series.unfilteredAlertsHistory, formatDate, formatTime),
            unfilteredSimulatedAlertsHistory: toActivitySeries(dashboardData.series.unfilteredSimulatedAlertsHistory, formatDate, formatTime),
            unfilteredDecisionsHistory: toActivitySeries(dashboardData.series.unfilteredDecisionsHistory, formatDate, formatTime),
            unfilteredSimulatedDecisionsHistory: toActivitySeries(dashboardData.series.unfilteredSimulatedDecisionsHistory, formatDate, formatTime),
        };
    }, [dashboardData, filters.as, filters.country, filters.scenario, filters.target, formatDate, formatTime, isDashboardStatsStaleForFilters]);
    

    // Handle Filters
    const toggleFilter = useCallback((type: FilterKey, value: string | null | undefined) => {
        if (!value || filterApplyingRef.current || !quickFilterInteractionsEnabled) {
            return;
        }

        startFilterApplication(() => {
            updatePersistedQuickFilters((current) => {
                const selection = getStoredQuickFilterSelection(current, type);
                const included = selection.included.includes(value)
                    ? selection.included.filter((candidate) => candidate !== value)
                    : [...selection.included, value];
                return setStoredQuickFilterSelection(current, type, {
                    included,
                    excluded: selection.excluded.filter((candidate) => candidate !== value),
                });
            });
        });
    }, [quickFilterInteractionsEnabled, startFilterApplication, updatePersistedQuickFilters]);
    const handleCountrySelect = useCallback((code: string) => {
        toggleFilter('country', code);
    }, [toggleFilter]);

    const clearFilters = () => {
        const hasStoredFilters = Object.values(
            persistedQuickFiltersRef.current.selections,
        ).some((selection) => Boolean(
            selection
            && (selection.included.length > 0 || selection.excluded.length > 0)
        )) || Boolean(
            persistedQuickFiltersRef.current.dateRange.start
            || persistedQuickFiltersRef.current.dateRange.end
        );
        if (
            filterApplyingRef.current ||
            (
                !hasStoredFilters &&
                simulationFilter === 'all' &&
                !dashboardCustomSearch
            )
        ) {
            return;
        }

        startFilterApplication(() => {
            updateDashboardCustomSearch('');
            setSimulationFilter('all');
            setDateRangeSticky(false);
            updatePersistedQuickFilters(() => emptyStoredQuickFilters());
        });
    };

    const handleDateRangeSelect = useCallback((
        dateRange: DashboardFilters['dateRange'],
        isAtEnd: boolean,
    ) => {
        if (filterApplyingRef.current || !quickFilterInteractionsEnabled) {
            return;
        }

        const nextDateRangeSticky = isAtEnd && dateRange !== null;
        const dateRangeUnchanged = filters.dateRange?.start === dateRange?.start &&
            filters.dateRange?.end === dateRange?.end;
        if (dateRangeUnchanged && filters.dateRangeSticky === nextDateRangeSticky) {
            return;
        }

        startFilterApplication(() => {
            setDateRangeSticky(nextDateRangeSticky);
            updatePersistedQuickFilters((current) => ({
                ...current,
                dateRange: dateRange
                    ? { start: dateRange.start, end: dateRange.end }
                    : { start: '', end: '' },
            }));
        });
    }, [
        filters.dateRange,
        filters.dateRangeSticky,
        quickFilterInteractionsEnabled,
        startFilterApplication,
        updatePersistedQuickFilters,
    ]);

    const applyFacetSelection = useCallback((
        field: FacetField,
        selection: SearchFacetSelection,
    ) => {
        if (
            filterApplyingRef.current
            || !quickFilterInteractionsEnabled
            || !DASHBOARD_ALL_QUICK_FILTER_FIELDS.has(field)
        ) {
            return;
        }

        if (!DASHBOARD_QUICK_FILTER_FIELDS.includes(field)) {
            updatePersistedQuickFilters((current) => setStoredQuickFilterSelection(
                current,
                field,
                selection,
            ));
            return;
        }

        startFilterApplication(() => {
            updatePersistedQuickFilters((current) => setStoredQuickFilterSelection(
                current,
                field,
                selection,
            ));
        });
    }, [quickFilterInteractionsEnabled, startFilterApplication, updatePersistedQuickFilters]);

    const applyQuickFilterDateRange = useCallback((range: SearchDateRange) => {
        if (filterApplyingRef.current || !quickFilterInteractionsEnabled) return;
        const nextRange = range.start || range.end
            ? { start: range.start, end: range.end }
            : null;
        handleDateRangeSelect(nextRange, false);
    }, [handleDateRangeSelect, quickFilterInteractionsEnabled]);
    const applyQuickFilterSimulation = useCallback((simulation: QuickFilterSimulationValue) => {
        if (
            filterApplyingRef.current
            || !quickFilterInteractionsEnabled
            || simulation === simulationFilter
        ) return;
        startFilterApplication(() => {
            setSimulationFilter(simulation);
            updatePersistedQuickFilters((current) => ({
                ...current,
                simulation,
            }));
        });
    }, [
        quickFilterInteractionsEnabled,
        simulationFilter,
        startFilterApplication,
        updatePersistedQuickFilters,
    ]);

    const quickFilterFields = useMemo<QuickFilterDefinition[]>(() => [
        { field: 'scenario', label: t('tableColumns.scenario') },
        { field: 'kind', label: t('tableColumns.kind') },
        { field: 'country', label: t('tableColumns.country') },
        { field: 'as', label: t('tableColumns.as') },
        { field: 'ip', label: t('tableColumns.source') },
        { field: 'target', label: t('tableColumns.target') },
        { field: 'id', label: t('tableColumns.id') },
        { field: 'instance', label: t('tableColumns.instance') },
        { field: 'region', label: t('tableColumns.region') },
        { field: 'city', label: t('tableColumns.city') },
        { field: 'machine', label: t('tableColumns.machine') },
        { field: 'origin', label: t('tableColumns.origin') },
        { field: 'decision', label: t('tableColumns.decisions'), applicable: false },
        { field: 'action', label: t('tableColumns.action'), applicable: false },
        { field: 'status', label: t('tableColumns.expiration'), applicable: false },
        { field: 'alert', label: t('tableColumns.alert'), applicable: false },
    ], [t]);
    const quickFilterSectionOrder = useMemo<QuickFilterSectionId[]>(
        () => [
            'date',
            ...quickFilterFields
                .filter(({ applicable }) => applicable !== false)
                .map(({ field }) => field),
        ],
        [quickFilterFields],
    );
    const formatFacetValue = useCallback((field: FacetField, value: string) => {
        if (field === 'country') return getCountryName(value, language) || value;
        if (field === 'instance') return instanceNames[value] || value;
        return value;
    }, [instanceNames, language]);
    const getFacetSearchValues = useCallback((field: FacetField, search: string) => {
        if (field === 'country') return getCountryCodesMatchingName(search, language);
        if (field !== 'instance') return [];
        const normalizedSearch = search.trim().toLocaleLowerCase(language);
        return Object.entries(instanceNames)
            .filter(([, name]) => name.toLocaleLowerCase(language).includes(normalizedSearch))
            .map(([id]) => id);
    }, [instanceNames, language]);
    const getDashboardFacetSelection = useCallback((
        field: FacetField,
        selection: SearchFacetSelection,
    ) => (
        DASHBOARD_QUICK_FILTER_FIELDS.includes(field)
            ? selection
            : getStoredQuickFilterSelection(persistedQuickFilters, field)
    ), [persistedQuickFilters]);

    const simulationsEnabled = config?.simulations_enabled === true;
    const alertDrilldownQuery = buildDashboardDrilldownQuery(
        dashboardAlertSearchAst,
        filters.simulation,
        simulationsEnabled,
        dashboardCustomSearch,
    );
    const decisionDrilldownQuery = buildDashboardDrilldownQuery(
        dashboardDecisionSearchAst,
        filters.simulation,
        simulationsEnabled,
        dashboardCustomSearch,
    );
    const alertsLink = buildDashboardDrilldownHref('/alerts', alertDrilldownQuery);
    const decisionsLink = buildDashboardDrilldownHref('/decisions', decisionDrilldownQuery);
    const filteredTotals = dashboardData.filteredTotals;
    const filteredSimulationAlertsCount = filteredTotals.simulatedAlerts;
    const filteredSimulationDecisionsCount = filteredTotals.simulatedDecisions;
    const totalLiveAlerts = stats.alerts - stats.simulatedAlerts;
    const totalAllDecisions = stats.decisions + stats.simulatedDecisions;
    const filteredAllDecisions = filteredTotals.decisions + filteredSimulationDecisionsCount;
    const modeAwareAlertsTotal = filters.simulation === 'simulated'
        ? stats.simulatedAlerts
        : filters.simulation === 'live'
            ? totalLiveAlerts
            : stats.alerts;
    const modeAwareAlertsFiltered = filters.simulation === 'simulated'
        ? filteredSimulationAlertsCount
        : filters.simulation === 'live'
            ? filteredTotals.alerts
            : filteredTotals.alerts;
    const modeAwareDecisionsTotal = filters.simulation === 'simulated'
        ? stats.simulatedDecisions
        : filters.simulation === 'live'
            ? stats.decisions
            : totalAllDecisions;
    const modeAwareDecisionsFiltered = filters.simulation === 'simulated'
        ? filteredSimulationDecisionsCount
        : filters.simulation === 'live'
            ? filteredTotals.decisions
            : filteredAllDecisions;
    const showSimulationBreakout = simulationsEnabled && filters.simulation === 'all';

    const hasActiveFilters = Object.values(persistedQuickFilters.selections).some((selection) => (
        Boolean(selection && (selection.included.length > 0 || selection.excluded.length > 0))
    )) ||
        filters.dateRange !== null ||
        persistedQuickFilters.simulation !== 'all' ||
        Boolean(dashboardCustomSearch);
    const selectedCountryValues = getStoredQuickFilterSelection(persistedQuickFilters, 'country').included;
    const selectedScenarioValues = getStoredQuickFilterSelection(persistedQuickFilters, 'scenario').included;
    const selectedAsValues = getStoredQuickFilterSelection(persistedQuickFilters, 'as').included;
    const selectedTargetValues = getStoredQuickFilterSelection(persistedQuickFilters, 'target').included;
    const dashboardFacetFilters = buildDashboardStatsFilters();
    const dashboardRefreshing = backgroundRefreshing || dashboardStatsPending || filterApplying;

    if (initialLoading) {
        return <div className="text-center p-8 text-gray-500">{t('common.loadingDashboard')}</div>;
    }

    return (
        <div className="space-y-8">
            {/* Summary Cards */}
            <div className="grid grid-cols-3 gap-3 sm:gap-4 lg:gap-6">
                <Link to={alertsLink} className="block h-full transition-transform hover:scale-105">
                    <Card className="h-full cursor-pointer hover:shadow-lg transition-shadow">
                        <CardContent className="flex flex-col items-center gap-2 p-3 text-center sm:flex-row sm:items-center sm:gap-3 sm:p-4 sm:text-left lg:gap-4 lg:p-6">
                            <div className="rounded-full bg-red-100 p-2 text-red-600 dark:bg-red-900/20 dark:text-red-400 sm:p-3 lg:p-4">
                                <ShieldAlert className="h-5 w-5 sm:h-6 sm:w-6 lg:h-8 lg:w-8" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-[11px] font-medium leading-tight text-gray-500 dark:text-gray-400 sm:text-sm">{t('pages.dashboard.totalAlerts')}</p>
                                <div className="flex items-baseline justify-center gap-1 sm:justify-start sm:gap-2">
                                    <h3 className="text-lg font-bold text-gray-900 dark:text-white sm:text-2xl">{modeAwareAlertsTotal}</h3>
                                    {hasActiveFilters && (
                                        <span className="text-xs text-gray-500 dark:text-gray-400 sm:text-sm">
                                            {modeAwareAlertsFiltered}
                                        </span>
                                    )}
                                </div>
                                {showSimulationBreakout && stats.simulatedAlerts > 0 && (
                                    <div className="mt-2 sm:mt-3">
                                        <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-gray-500 dark:text-gray-400 sm:text-[11px]">
                                            {t('pages.dashboard.simulation')}
                                        </p>
                                        <div className="flex items-baseline justify-center gap-1 sm:justify-start sm:gap-2">
                                            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 sm:text-lg">
                                                {stats.simulatedAlerts}
                                            </span>
                                            {hasActiveFilters && (
                                                <span className="text-[10px] text-gray-500 dark:text-gray-400 sm:text-xs">
                                                    {filteredSimulationAlertsCount}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                </Link>

                <Link to={decisionsLink} className="block h-full transition-transform hover:scale-105">
                    <Card className="h-full cursor-pointer hover:shadow-lg transition-shadow">
                        <CardContent className="flex flex-col items-center gap-2 p-3 text-center sm:flex-row sm:items-center sm:gap-3 sm:p-4 sm:text-left lg:gap-4 lg:p-6">
                            <div className="rounded-full bg-blue-100 p-2 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400 sm:p-3 lg:p-4">
                                <Gavel className="h-5 w-5 sm:h-6 sm:w-6 lg:h-8 lg:w-8" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-[11px] font-medium leading-tight text-gray-500 dark:text-gray-400 sm:text-sm">{t('pages.dashboard.activeDecisions')}</p>
                                <div className="flex items-baseline justify-center gap-1 sm:justify-start sm:gap-2">
                                    <h3 className="text-lg font-bold text-gray-900 dark:text-white sm:text-2xl">{modeAwareDecisionsTotal}</h3>
                                    {hasActiveFilters && (
                                        <span className="text-xs text-gray-500 dark:text-gray-400 sm:text-sm">
                                            {modeAwareDecisionsFiltered}
                                        </span>
                                    )}
                                </div>
                                {showSimulationBreakout && stats.simulatedDecisions > 0 && (
                                    <div className="mt-2 sm:mt-3">
                                        <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-gray-500 dark:text-gray-400 sm:text-[11px]">
                                            {t('pages.dashboard.simulation')}
                                        </p>
                                        <div className="flex items-baseline justify-center gap-1 sm:justify-start sm:gap-2">
                                            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 sm:text-lg">
                                                {stats.simulatedDecisions}
                                            </span>
                                            {hasActiveFilters && (
                                                <span className="text-[10px] text-gray-500 dark:text-gray-400 sm:text-xs">
                                                    {filteredSimulationDecisionsCount}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                </Link>

                <Card>
                    <CardContent className="flex flex-col items-center gap-2 p-3 text-center sm:flex-row sm:items-center sm:gap-3 sm:p-4 sm:text-left lg:gap-4 lg:p-6">
                        <div className={`rounded-full p-2 sm:p-3 lg:p-4 ${lapiStatusTone.background}`}>
                            <Activity className={`h-5 w-5 sm:h-6 sm:w-6 lg:h-8 lg:w-8 ${lapiStatusTone.icon}`} />
                        </div>
                        <div className="min-w-0">
                            <p className="text-[11px] font-medium leading-tight text-gray-500 dark:text-gray-400 sm:text-sm">
                                {t(isAllInstancesScope ? 'pages.dashboard.crowdsecLapis' : 'pages.dashboard.crowdsecLapi')}
                            </p>
                            <h3 className={`text-lg font-bold sm:text-2xl ${lapiStatusTone.text}`}>{lapiStatusLabel}</h3>
                            {isAllInstancesScope && (
                                <p className="text-[10px] text-gray-500 dark:text-gray-400 sm:text-xs">
                                    {t('pages.dashboard.lapisOnlineCount', {
                                        online: configRequestFailed ? 0 : onlineInstanceCount,
                                        total: totalInstanceCount,
                                    })}
                                </p>
                            )}
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Statistics Section */}
            <div className="space-y-6">
                <div className="relative space-y-2">
                    <div className="flex flex-col gap-4 md:flex-row md:items-start">
                        <div className="flex min-h-11 shrink-0 items-center gap-2">
                            <TrendingUp className="w-6 h-6 text-primary-600 dark:text-primary-400" />
                            <h3 className="text-2xl font-bold text-gray-900 dark:text-white">
                                {t('pages.dashboard.lastDaysStats', { days: config?.lookback_days ?? 7 })}
                            </h3>
                        </div>
                        <div className="flex w-full min-w-0 flex-1 items-start justify-end gap-2">
                            <CollapsibleSearchControls
                                inputRef={dashboardSearchInputRef}
                                onHelp={() => setShowDashboardSearchSyntax(true)}
                                forceExpanded={Boolean(quickFilterDisabledReason)}
                                footer={(dashboardSearchError || quickFilterDisabledReason) ? (
                                    <div className="space-y-1">
                                        {dashboardSearchError && (
                                            <p id="dashboard-search-error" className="text-xs text-red-600 dark:text-red-400">
                                                {t('common.searchSyntaxError', {
                                                    position: dashboardSearchError.position + 1,
                                                    message: dashboardSearchError.message,
                                                })}
                                            </p>
                                        )}
                                        {quickFilterDisabledReason && (
                                            <QuickFilterDisabledNotice reason={quickFilterDisabledReason} />
                                        )}
                                    </div>
                                ) : undefined}
                            >
                                <HighlightedSearchInput
                                    ref={dashboardSearchInputRef}
                                    searchPage="alerts"
                                    searchFeatures={DASHBOARD_SEARCH_FEATURES}
                                    showSearchIcon={false}
                                    containerClassName="rounded-r-none"
                                    className="rounded-r-none"
                                    placeholder={t('common.search')}
                                    value={dashboardSearchDraft}
                                    error={dashboardSearchError}
                                    onChange={(event) => updateDashboardSearchDraftFromUser(event.target.value)}
                                    aria-invalid={dashboardSearchError ? 'true' : 'false'}
                                    aria-describedby={dashboardSearchError ? 'dashboard-search-error' : undefined}
                                />
                            </CollapsibleSearchControls>
                            <QuickFilters
                                page="alerts"
                                fields={quickFilterFields}
                                sectionOrder={quickFilterSectionOrder}
                                unavailableSectionOrder={DASHBOARD_UNAVAILABLE_QUICK_FILTER_FIELDS}
                                filters={dashboardFacetFilters}
                                searchAst={dashboardAlertSearchAst}
                                onSelectionChange={applyFacetSelection}
                                dateRange={persistedQuickFilters.dateRange}
                                onDateRangeChange={applyQuickFilterDateRange}
                                onClearAll={clearFilters}
                                lookbackHours={config?.lookback_hours ?? 168}
                                simulation={simulationsEnabled
                                    ? { value: simulationFilter, onChange: applyQuickFilterSimulation }
                                    : undefined}
                                getSelection={getDashboardFacetSelection}
                                formatValue={formatFacetValue}
                                getSearchValues={getFacetSearchValues}
                                busy={filterApplying}
                                refreshKey={refreshSignal}
                                disabledReason={quickFilterDisabledReason}
                            />
                        </div>
                    </div>
                    <div className="pointer-events-none absolute left-0 top-full mt-1 text-sm text-gray-500" aria-live="polite">
                        <span className={`inline-flex items-center gap-2 transition-opacity ${dashboardRefreshing ? 'opacity-100' : 'opacity-0'}`}>
                            <span className="h-2 w-2 rounded-full bg-primary-500 animate-pulse" aria-hidden="true" />
                            {t('common.refreshingDashboard')}
                        </span>
                    </div>
                </div>

                {/* Charts Area */}
                <div
                    className="grid gap-8 md:grid-cols-2"
                    aria-busy={dashboardRefreshing}
                    aria-disabled={filterApplying}
                    inert={filterApplying ? true : undefined}
                >
                    {/* Activity Chart - Left */}
                    <div className="h-[450px]">
                        <Suspense fallback={<div className="text-center p-8 text-gray-500">{t('common.loadingChart')}</div>}>
                            <ActivityBarChart
                                alertsData={statistics.alertsHistory}
                                decisionsData={statistics.decisionsHistory}
                                activeDecisionsData={statistics.activeDecisionsHistory}
                                simulatedAlertsData={statistics.simulatedAlertsHistory}
                                simulatedDecisionsData={statistics.simulatedDecisionsHistory}
                                activeSimulatedDecisionsData={statistics.activeSimulatedDecisionsHistory}
                                unfilteredAlertsData={statistics.unfilteredAlertsHistory}
                                unfilteredDecisionsData={statistics.unfilteredDecisionsHistory}
                                unfilteredSimulatedAlertsData={statistics.unfilteredSimulatedAlertsHistory}
                                unfilteredSimulatedDecisionsData={statistics.unfilteredSimulatedDecisionsHistory}
                                simulationsEnabled={simulationsEnabled}
                                onDateRangeSelect={quickFilterInteractionsEnabled
                                    ? handleDateRangeSelect
                                    : undefined}
                                selectedDateRange={filters.dateRange}
                                isSticky={filters.dateRangeSticky}
                                granularity={granularity}
                                setGranularity={handleGranularityChange}
                                scaleMode={scaleMode}
                                setScaleMode={setScaleMode}
                            />
                        </Suspense>
                    </div>

                    {/* World Map - Right */}
                    <div className="h-[450px]">
                        <Suspense fallback={<div className="text-center p-8 text-gray-500">{t('common.loadingMap')}</div>}>
                            <WorldMapCard
                                data={statistics.allCountries}
                                attackLocations={dashboardData.attackLocations}
                                onCountrySelect={handleCountrySelect}
                                selectedCountry={filters.country}
                                simulationsEnabled={simulationsEnabled}
                                selectionDisabledReason={quickFilterDisabledReason}
                            />
                        </Suspense>
                    </div>
                </div>

                {/* Top Statistics Grid */}
                <div
                    className="grid gap-8 md:grid-cols-2 xl:grid-cols-4"
                    aria-busy={dashboardRefreshing}
                    aria-disabled={filterApplying}
                    inert={filterApplying ? true : undefined}
                >
                    <StatCard
                        title={t('pages.dashboard.topCountries')}
                        items={statistics.topCountries}
                        onSelect={(item) => toggleFilter('country', item.countryCode)}
                        selectedValue={filters.country}
                        selectedValues={selectedCountryValues}
                        renderLabel={(item) => (
                            <span className="text-sm truncate font-medium text-gray-900 dark:text-gray-100" title={item.count === 0 && item.label === item.countryCode ? item.label : getCountryName(item.countryCode, language) ?? item.label}>
                                {item.count === 0 && item.label === item.countryCode ? item.label : getCountryName(item.countryCode, language) ?? item.label}
                            </span>
                        )}
                        total={percentageBasis === 'global' ? dashboardData.globalTotal : filteredTotals.alerts}
                        selectionDisabledReason={quickFilterDisabledReason}
                        headerAction={(
                            <div
                                className="flex p-1 bg-gray-100 dark:bg-gray-800 rounded-lg"
                                role="group"
                                aria-label={t('pages.dashboard.percentageBasis')}
                                title={t('pages.dashboard.percentageBasis')}
                            >
                                <span
                                    className="flex items-center px-2 text-xs font-medium text-gray-500 dark:text-gray-400"
                                    aria-hidden="true"
                                >
                                    %
                                </span>
                                {PERCENTAGE_BASES.map((basis) => (
                                    <button
                                        key={basis}
                                        type="button"
                                        onClick={() => setPercentageBasis(basis)}
                                        className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${percentageBasis === basis
                                            ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                                            : 'text-gray-500 hover:text-gray-900 dark:hover:text-gray-300'
                                            }`}
                                        aria-pressed={percentageBasis === basis}
                                    >
                                        {t(`pages.dashboard.${basis}`)}
                                    </button>
                                ))}
                            </div>
                        )}
                    />
                    <StatCard
                        title={t('pages.dashboard.topScenarios')}
                        items={statistics.topScenarios}
                        onSelect={(item) => toggleFilter('scenario', item.label)}
                        selectedValue={filters.scenario}
                        selectedValues={selectedScenarioValues}
                        renderLabel={(item) => (
                            <ScenarioName name={item.label} showLink={true} />
                        )}
                        total={percentageBasis === 'global' ? dashboardData.globalTotal : filteredTotals.alerts}
                        selectionDisabledReason={quickFilterDisabledReason}
                    />
                    <StatCard
                        title={t('pages.dashboard.topAs')}
                        items={statistics.topAS}
                        onSelect={(item) => toggleFilter('as', item.label)}
                        selectedValue={filters.as}
                        selectedValues={selectedAsValues}
                        total={percentageBasis === 'global' ? dashboardData.globalTotal : filteredTotals.alerts}
                        selectionDisabledReason={quickFilterDisabledReason}
                    />
                    <StatCard
                        title={t('pages.dashboard.topTargets')}
                        items={statistics.topTargets}
                        onSelect={(item) => toggleFilter('target', item.label)}
                        selectedValue={filters.target}
                        selectedValues={selectedTargetValues}
                        total={percentageBasis === 'global' ? dashboardData.globalTotal : filteredTotals.alerts}
                        selectionDisabledReason={quickFilterDisabledReason}
                    />
                </div>
            </div>
            <SearchSyntaxModal
                help={dashboardSearchHelp}
                searchFeatures={DASHBOARD_SEARCH_FEATURES}
                isOpen={showDashboardSearchSyntax}
                onClose={() => setShowDashboardSearchSyntax(false)}
                onSelectExample={(query) => {
                    updateDashboardSearchDraftFromUser(query);
                    setShowDashboardSearchSyntax(false);
                }}
                onInsertSnippet={(snippet) => {
                    const input = dashboardSearchInputRef.current;
                    const start = input?.selectionStart ?? dashboardSearchDraft.length;
                    const end = input?.selectionEnd ?? start;
                    const prefix = dashboardSearchDraft.slice(0, start);
                    const needsSpace = prefix.length > 0 && !/\s$/.test(prefix);
                    const nextQuery = `${prefix}${needsSpace ? ' ' : ''}${snippet}${dashboardSearchDraft.slice(end)}`;
                    updateDashboardSearchDraftFromUser(nextQuery);
                    setShowDashboardSearchSyntax(false);
                    window.requestAnimationFrame(() => {
                        const caret = start + (needsSpace ? 1 : 0) + snippet.length;
                        dashboardSearchInputRef.current?.focus();
                        dashboardSearchInputRef.current?.setSelectionRange(caret, caret);
                    });
                }}
            />
        </div>
    );
}
