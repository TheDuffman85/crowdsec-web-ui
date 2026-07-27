import {
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
    ChevronDown,
    Filter,
    RefreshCw,
    Search,
    X,
} from 'lucide-react';
import { fetchFacet } from '../lib/api';
import { useI18n } from '../lib/i18n';
import {
    getSearchFacetSelection,
    type SearchDateRange,
    type SearchFacetSelection,
    type SearchNode,
} from '../../../shared/search';
import type { FacetField, FacetValue } from '../types';
import type { QuickFilterSimulationValue } from '../lib/quickFilters';

export interface QuickFilterDefinition {
    field: FacetField;
    label: string;
    defaultSelection?: SearchFacetSelection;
    applicable?: boolean;
}

export type QuickFilterSectionId = FacetField | 'date' | 'simulation';

interface QuickFilterSimulation {
    value: QuickFilterSimulationValue;
    onChange: (value: QuickFilterSimulationValue) => void;
}

interface QuickFiltersProps {
    page: 'alerts' | 'decisions';
    fields: QuickFilterDefinition[];
    sectionOrder?: QuickFilterSectionId[];
    hiddenSectionOrder?: QuickFilterSectionId[];
    unavailableSectionOrder?: QuickFilterSectionId[];
    filters: Record<string, string>;
    searchAst: SearchNode | null;
    onSelectionChange: (field: FacetField, selection: SearchFacetSelection) => void;
    dateRange: SearchDateRange;
    onDateRangeChange: (range: SearchDateRange) => void;
    onClearAll: () => void;
    simulation?: QuickFilterSimulation;
    getSelection?: (field: FacetField, selection: SearchFacetSelection) => SearchFacetSelection;
    formatValue?: (field: FacetField, value: string) => string;
    getSearchValues?: (field: FacetField, search: string) => string[];
    busy?: boolean;
    refreshKey?: number | string;
    triggerClassName?: string;
}

export function QuickFilters({
    page,
    fields,
    sectionOrder,
    hiddenSectionOrder,
    unavailableSectionOrder,
    filters,
    searchAst,
    onSelectionChange,
    dateRange,
    onDateRangeChange,
    onClearAll,
    simulation,
    getSelection,
    formatValue,
    getSearchValues,
    busy = false,
    refreshKey = 0,
    triggerClassName,
}: QuickFiltersProps) {
    const { t } = useI18n();
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [openFields, setOpenFields] = useState<Set<QuickFilterSectionId>>(() => new Set());
    const triggerRef = useRef<HTMLButtonElement>(null);
    const drawerRef = useRef<HTMLDivElement>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const enabled = drawerOpen;
    const activeCount = useMemo(() => fields.reduce((count, definition) => {
        const selection = getSelection?.(
            definition.field,
            getSearchFacetSelection(searchAst, definition.field),
        ) ?? getSearchFacetSelection(searchAst, definition.field);
        return count + getActiveSelectionCount(definition, selection);
    }, Number(Boolean(dateRange.start))
        + Number(Boolean(dateRange.end))
        + getSimulationActiveCount(simulation?.value)), [
        dateRange.end,
        dateRange.start,
        fields,
        getSelection,
        searchAst,
        simulation?.value,
    ]);

    useEffect(() => {
        if (!drawerOpen) return;
        const trigger = triggerRef.current;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        closeButtonRef.current?.focus();

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setDrawerOpen(false);
                return;
            }
            if (event.key !== 'Tab' || !drawerRef.current) return;
            const focusable = Array.from(drawerRef.current.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
            ));
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.body.style.overflow = previousOverflow;
            document.removeEventListener('keydown', handleKeyDown);
            trigger?.focus();
        };
    }, [drawerOpen]);

    const toggleField = (field: QuickFilterSectionId) => {
        setOpenFields((current) => {
            const next = new Set(current);
            if (next.has(field)) next.delete(field);
            else next.add(field);
            return next;
        });
    };

    const content = (
        <FacetGroups
            page={page}
            fields={fields}
            sectionOrder={sectionOrder}
            hiddenSectionOrder={hiddenSectionOrder}
            unavailableSectionOrder={unavailableSectionOrder}
            filters={filters}
            searchAst={searchAst}
            dateRange={dateRange}
            onDateRangeChange={onDateRangeChange}
            simulation={simulation}
            openFields={openFields}
            enabled={enabled && !busy}
            onToggleField={toggleField}
            onSelectionChange={onSelectionChange}
            getSelection={getSelection}
            formatValue={formatValue}
            getSearchValues={getSearchValues}
            refreshKey={refreshKey}
        />
    );

    const trigger = (
        <button
            ref={triggerRef}
            type="button"
            onClick={() => setDrawerOpen(true)}
            className={`inline-flex items-center justify-center gap-2 border bg-white text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 ${
                triggerClassName
                    ?? 'min-h-11 rounded-md border-gray-300 px-3 dark:border-gray-700'
            }`}
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            aria-label={t('components.quickFilters.filters')}
        >
            <Filter size={18} aria-hidden="true" />
            {activeCount > 0 && (
                <>
                    <span className="min-w-5 rounded-full bg-primary-600 px-1.5 text-xs text-white">
                        {activeCount}
                    </span>
                    <span className="h-5 w-2 shrink-0" aria-hidden="true" />
                </>
            )}
        </button>
    );

    return (
        <>
            <div className="relative inline-flex shrink-0">
                {trigger}
                {activeCount > 0 && (
                    <button
                        type="button"
                        onClick={onClearAll}
                        className="absolute inset-y-0 right-0 inline-flex w-7 items-center justify-center rounded-r-[inherit] text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:z-10 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-gray-100"
                        aria-label={t('components.quickFilters.clearAll')}
                        title={t('components.quickFilters.clearAll')}
                    >
                        <X size={16} aria-hidden="true" />
                    </button>
                )}
            </div>
            {drawerOpen && createPortal(
                <div className="fixed inset-0 z-[10000]">
                    <button
                        type="button"
                        className="absolute inset-0 bg-black/50"
                        onClick={() => setDrawerOpen(false)}
                        aria-label={t('components.quickFilters.close')}
                    />
                    <div
                        ref={drawerRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="quick-filters-drawer-title"
                        className="absolute inset-y-0 right-0 flex w-[min(100vw,24rem)] flex-col bg-white pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] shadow-2xl dark:bg-gray-800"
                    >
                        <div className="flex min-h-16 shrink-0 items-center justify-between gap-2 border-b border-gray-200 px-4 dark:border-gray-700">
                            <h2 id="quick-filters-drawer-title" className="truncate text-lg font-semibold">
                                {t('components.quickFilters.title')}
                            </h2>
                            <button
                                ref={closeButtonRef}
                                type="button"
                                onClick={() => setDrawerOpen(false)}
                                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                                aria-label={t('components.quickFilters.close')}
                            >
                                <X size={20} />
                            </button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                            {content}
                        </div>
                    </div>
                </div>,
                document.body,
            )}
        </>
    );
}

interface FacetGroupsProps extends Omit<QuickFiltersProps, 'busy' | 'onClearAll'> {
    openFields: Set<QuickFilterSectionId>;
    enabled: boolean;
    onToggleField: (field: QuickFilterSectionId) => void;
}

function FacetGroups({
    page,
    fields,
    sectionOrder,
    hiddenSectionOrder = [],
    unavailableSectionOrder = [],
    filters,
    searchAst,
    dateRange,
    onDateRangeChange,
    simulation,
    openFields,
    enabled,
    onToggleField,
    onSelectionChange,
    getSelection,
    formatValue,
    getSearchValues,
    refreshKey,
}: FacetGroupsProps) {
    const { t } = useI18n();
    const definitions = new Map(fields.map((definition) => [definition.field, definition]));
    const orderedSections = addSimulationAfterScenario(
        sectionOrder ?? ['date', ...fields.map((definition) => definition.field)],
        Boolean(simulation),
    );
    const orderedHiddenSections = addSimulationAfterScenario(
        hiddenSectionOrder,
        Boolean(simulation),
    );

    return (
        <div>
            <div className="divide-y divide-gray-200 dark:divide-gray-700">
                {renderFilterGroups(orderedSections, definitions, {
                    page,
                    filters,
                    searchAst,
                    dateRange,
                    onDateRangeChange,
                    simulation,
                    openFields,
                    enabled,
                    onToggleField,
                    onSelectionChange,
                    getSelection,
                    formatValue,
                    getSearchValues,
                    refreshKey,
                })}
            </div>
            {orderedHiddenSections.length > 0 && (
                <section
                    className="mt-4 border-t border-gray-300 pt-4 dark:border-gray-600"
                    aria-labelledby="quick-filters-hidden-columns-title"
                >
                    <h3
                        id="quick-filters-hidden-columns-title"
                        className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
                    >
                        {t('components.quickFilters.hiddenColumns')}
                    </h3>
                    <div className="divide-y divide-gray-200 dark:divide-gray-700">
                        {renderFilterGroups(orderedHiddenSections, definitions, {
                            page,
                            filters,
                            searchAst,
                            dateRange,
                            onDateRangeChange,
                            simulation,
                            openFields,
                            enabled,
                            onToggleField,
                            onSelectionChange,
                            getSelection,
                            formatValue,
                            getSearchValues,
                            refreshKey,
                        })}
                    </div>
                </section>
            )}
            {unavailableSectionOrder.length > 0 && (
                <section
                    className="mt-4 border-t border-gray-300 pt-4 dark:border-gray-600"
                    aria-labelledby="quick-filters-unavailable-title"
                >
                    <h3
                        id="quick-filters-unavailable-title"
                        className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
                    >
                        {t('components.quickFilters.unavailable')}
                    </h3>
                    <div className="divide-y divide-gray-200 dark:divide-gray-700">
                        {renderFilterGroups(unavailableSectionOrder, definitions, {
                            page,
                            filters,
                            searchAst,
                            dateRange,
                            onDateRangeChange,
                            simulation,
                            openFields,
                            enabled,
                            onToggleField,
                            onSelectionChange,
                            getSelection,
                            formatValue,
                            getSearchValues,
                            refreshKey,
                        })}
                    </div>
                </section>
            )}
        </div>
    );
}

interface FilterGroupRenderOptions {
    page: QuickFiltersProps['page'];
    filters: QuickFiltersProps['filters'];
    searchAst: QuickFiltersProps['searchAst'];
    dateRange: QuickFiltersProps['dateRange'];
    onDateRangeChange: QuickFiltersProps['onDateRangeChange'];
    simulation?: QuickFiltersProps['simulation'];
    openFields: FacetGroupsProps['openFields'];
    enabled: boolean;
    onToggleField: FacetGroupsProps['onToggleField'];
    onSelectionChange: QuickFiltersProps['onSelectionChange'];
    getSelection?: QuickFiltersProps['getSelection'];
    formatValue?: QuickFiltersProps['formatValue'];
    getSearchValues?: QuickFiltersProps['getSearchValues'];
    refreshKey?: QuickFiltersProps['refreshKey'];
}

function renderFilterGroups(
    sections: QuickFilterSectionId[],
    definitions: Map<FacetField, QuickFilterDefinition>,
    options: FilterGroupRenderOptions,
) {
    return sections.map((section) => {
        if (section === 'date') {
            return (
                <DateTimeFilterGroup
                    key="date"
                    open={options.openFields.has('date')}
                    onToggle={() => options.onToggleField('date')}
                    range={options.dateRange}
                    onChange={options.onDateRangeChange}
                />
            );
        }
        if (section === 'simulation') {
            if (!options.simulation) return null;
            return (
                <SimulationFilterGroup
                    key="simulation"
                    open={options.openFields.has('simulation')}
                    enabled={options.enabled}
                    value={options.simulation.value}
                    onToggle={() => options.onToggleField('simulation')}
                    onChange={options.simulation.onChange}
                />
            );
        }

        const definition = definitions.get(section);
        if (!definition) return null;
        return (
            <FacetGroup
                key={definition.field}
                page={options.page}
                definition={definition}
                filters={options.filters}
                searchAst={options.searchAst}
                open={options.openFields.has(definition.field)}
                enabled={options.enabled}
                onToggle={() => options.onToggleField(definition.field)}
                onSelectionChange={options.onSelectionChange}
                getSelection={options.getSelection}
                formatValue={options.formatValue}
                getSearchValues={options.getSearchValues}
                refreshKey={options.refreshKey}
            />
        );
    });
}

function addSimulationAfterScenario(
    sections: QuickFilterSectionId[],
    enabled: boolean,
): QuickFilterSectionId[] {
    if (!enabled || sections.includes('simulation')) return sections;
    const scenarioIndex = sections.indexOf('scenario');
    if (scenarioIndex < 0) return sections;
    return [
        ...sections.slice(0, scenarioIndex + 1),
        'simulation',
        ...sections.slice(scenarioIndex + 1),
    ];
}

interface SimulationFilterGroupProps {
    open: boolean;
    enabled: boolean;
    value: QuickFilterSimulationValue;
    onToggle: () => void;
    onChange: (value: QuickFilterSimulationValue) => void;
}

function SimulationFilterGroup({
    open,
    enabled,
    value,
    onToggle,
    onChange,
}: SimulationFilterGroupProps) {
    const { t } = useI18n();
    const options: Array<{ value: 'live' | 'simulated'; label: string }> = [
        { value: 'live', label: t('common.live') },
        { value: 'simulated', label: t('pages.dashboard.simulation') },
    ];
    const isChecked = (option: 'live' | 'simulated') => (
        value === 'all' || value === option
    );
    const toggleOption = (option: 'live' | 'simulated') => {
        const liveChecked = isChecked('live');
        const simulatedChecked = isChecked('simulated');
        const nextLiveChecked = option === 'live' ? !liveChecked : liveChecked;
        const nextSimulatedChecked = option === 'simulated' ? !simulatedChecked : simulatedChecked;
        if (nextLiveChecked && nextSimulatedChecked) onChange('all');
        else if (nextLiveChecked) onChange('live');
        else if (nextSimulatedChecked) onChange('simulated');
        else onChange('none');
    };

    return (
        <section className="py-1">
            <div className="flex min-h-11 items-center gap-1">
                <button
                    type="button"
                    onClick={onToggle}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm font-semibold hover:bg-gray-50 dark:hover:bg-gray-700"
                    aria-expanded={open}
                >
                    <ChevronDown
                        size={16}
                        className={`shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
                        aria-hidden="true"
                    />
                    <span className="truncate">{t('pages.dashboard.mode')}</span>
                </button>
                <ActiveFilterControls
                    count={getSimulationActiveCount(value)}
                    clearLabel={t('components.quickFilters.clearSection', {
                        field: t('pages.dashboard.mode'),
                    })}
                    onClear={() => onChange('all')}
                />
            </div>
            {open && (
                <div className="pb-2 pl-2">
                    {options.map((option) => (
                        <div
                            key={option.value}
                            className="flex min-h-11 items-center rounded-md hover:bg-gray-50 dark:hover:bg-gray-700/60"
                        >
                            <label className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center">
                                <input
                                    type="checkbox"
                                    value={option.value}
                                    checked={isChecked(option.value)}
                                    disabled={!enabled}
                                    onChange={() => toggleOption(option.value)}
                                    aria-label={t('components.quickFilters.toggleValue', {
                                        value: option.label,
                                        field: t('pages.dashboard.mode'),
                                    })}
                                    className="h-5 w-5 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                />
                            </label>
                            <button
                                type="button"
                                disabled={!enabled}
                                onClick={() => onChange(option.value)}
                                className="min-w-0 flex-1 self-stretch truncate text-left text-sm"
                            >
                                {option.label}
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}

function getSimulationActiveCount(value?: QuickFilterSimulationValue): number {
    if (value === 'none') return 2;
    return value && value !== 'all' ? 1 : 0;
}

interface DateTimeFilterGroupProps {
    open: boolean;
    onToggle: () => void;
    range: SearchDateRange;
    onChange: (range: SearchDateRange) => void;
}

function DateTimeFilterGroup({
    open,
    onToggle,
    range,
    onChange,
}: DateTimeFilterGroupProps) {
    const { t } = useI18n();
    const startValue = toDateTimeLocalValue(range.start);
    const endValue = toDateTimeLocalValue(range.end);
    const activeCount = Number(Boolean(range.start)) + Number(Boolean(range.end));

    return (
        <section className="py-1">
            <div className="flex min-h-11 items-center gap-1">
                <button
                    type="button"
                    onClick={onToggle}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm font-semibold hover:bg-gray-50 dark:hover:bg-gray-700"
                    aria-expanded={open}
                >
                    <ChevronDown
                        size={16}
                        className={`shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
                        aria-hidden="true"
                    />
                    <span className="truncate">{t('components.quickFilters.date')}</span>
                </button>
                <ActiveFilterControls
                    count={activeCount}
                    clearLabel={t('components.quickFilters.clearDateTime')}
                    onClear={() => onChange({ start: '', end: '' })}
                />
            </div>
            {open && (
                <div className="space-y-3 px-2 pb-3">
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-300">
                        <span className="mb-1 block">{t('components.quickFilters.from')}</span>
                        <input
                            type="datetime-local"
                            step={3600}
                            value={startValue}
                            max={endValue || undefined}
                            onChange={(event) => onChange({
                                start: toHourPrecision(event.target.value),
                                end: toHourPrecision(range.end),
                            })}
                            className="min-h-11 w-full rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-900"
                        />
                    </label>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-300">
                        <span className="mb-1 block">{t('components.quickFilters.to')}</span>
                        <input
                            type="datetime-local"
                            step={3600}
                            value={endValue}
                            min={startValue || undefined}
                            onChange={(event) => onChange({
                                start: toHourPrecision(range.start),
                                end: toHourPrecision(event.target.value),
                            })}
                            className="min-h-11 w-full rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-900"
                        />
                    </label>
                </div>
            )}
        </section>
    );
}

function toDateTimeLocalValue(value: string): string {
    if (!value) return '';
    const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}))?/);
    if (!match) return '';
    return `${match[1]}T${match[2] || '00'}:00`;
}

function toHourPrecision(value: string): string {
    if (!value) return '';
    const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})/);
    return match ? `${match[1]}T${match[2]}:00` : '';
}

interface FacetGroupProps {
    page: 'alerts' | 'decisions';
    definition: QuickFilterDefinition;
    filters: Record<string, string>;
    searchAst: SearchNode | null;
    open: boolean;
    enabled: boolean;
    onToggle: () => void;
    onSelectionChange: (field: FacetField, selection: SearchFacetSelection) => void;
    getSelection?: QuickFiltersProps['getSelection'];
    formatValue?: QuickFiltersProps['formatValue'];
    getSearchValues?: QuickFiltersProps['getSearchValues'];
    refreshKey?: number | string;
}

function FacetGroup({
    page,
    definition,
    filters,
    searchAst,
    open,
    enabled,
    onToggle,
    onSelectionChange,
    getSelection,
    formatValue,
    getSearchValues,
    refreshKey,
}: FacetGroupProps) {
    const { language, t } = useI18n();
    const [searchOpen, setSearchOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [retryKey, setRetryKey] = useState(0);
    const [pagination, setPagination] = useState({ baseKey: '', offset: 0 });
    const [result, setResult] = useState<{
        baseKey: string;
        requestKey: string;
        values: FacetValue[];
        hasMore: boolean;
        error: boolean;
    }>({
        baseKey: '',
        requestKey: '',
        values: [],
        hasMore: false,
        error: false,
    });
    const requestGenerationRef = useRef(0);
    const numberFormatter = useMemo(() => new Intl.NumberFormat(language), [language]);
    const searchValues = useMemo(
        () => debouncedSearch ? getSearchValues?.(definition.field, debouncedSearch) || [] : [],
        [debouncedSearch, definition.field, getSearchValues],
    );
    const filterKey = JSON.stringify(filters);
    const searchValuesKey = JSON.stringify(searchValues);
    const requestBaseKey = `${filterKey}\u0000${debouncedSearch}\u0000${searchValuesKey}\u0000${String(refreshKey)}`;
    const offset = pagination.baseKey === requestBaseKey ? pagination.offset : 0;
    const requestKey = `${requestBaseKey}\u0000${offset}\u0000${retryKey}`;
    // Keep the last successful values visible while a changed filter waits for the
    // primary list and its replacement facet request to settle. Clearing here
    // makes every checkbox interaction flash an empty/loading state.
    const values = result.values;
    const hasMore = result.baseKey === requestBaseKey && result.hasMore;
    const error = result.requestKey === requestKey && result.error;
    const applicable = definition.applicable !== false;
    const loading = open && enabled && applicable && result.requestKey !== requestKey;
    const selection = getSelection?.(
        definition.field,
        getSearchFacetSelection(searchAst, definition.field),
    ) ?? getSearchFacetSelection(searchAst, definition.field);
    const activeCount = getActiveSelectionCount(definition, selection);

    useEffect(() => {
        const timeout = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
        return () => window.clearTimeout(timeout);
    }, [search]);

    useEffect(() => {
        if (!open || !enabled || !applicable) return;
        const controller = new AbortController();
        const generation = ++requestGenerationRef.current;

        void fetchFacet(page, definition.field, filters, {
            search: debouncedSearch,
            searchValues,
            offset,
            limit: offset === 0 ? 10 : 25,
            signal: controller.signal,
        }).then((response) => {
            if (generation !== requestGenerationRef.current) return;
            setResult((current) => ({
                baseKey: requestBaseKey,
                requestKey,
                values: offset === 0 || current.baseKey !== requestBaseKey
                    ? response.values
                    : mergeFacetValues(current.values, response.values),
                hasMore: response.has_more,
                error: false,
            }));
        }).catch((requestError) => {
            if (controller.signal.aborted) return;
            console.error(`Failed to load ${definition.field} facet`, requestError);
            if (generation === requestGenerationRef.current) {
                setResult((current) => ({
                    baseKey: requestBaseKey,
                    requestKey,
                    values: current.values,
                    hasMore: false,
                    error: true,
                }));
            }
        });

        return () => controller.abort();
    }, [
        debouncedSearch,
        definition.field,
        enabled,
        applicable,
        filterKey,
        filters,
        offset,
        open,
        page,
        requestBaseKey,
        requestKey,
        retryKey,
        searchValues,
    ]);

    const matchesFacetEntry = (candidate: string, value: string, label?: string) => (
        candidate.trim().toLowerCase() === value.trim().toLowerCase()
        || Boolean(label && candidate.trim().toLowerCase() === label.trim().toLowerCase())
    );

    const isChecked = (value: string, label?: string) => {
        if (selection.included.length > 0) {
            return selection.included.some((candidate) => matchesFacetEntry(candidate, value, label));
        }
        return !selection.excluded.some((candidate) => matchesFacetEntry(candidate, value, label));
    };

    const toggleValue = (value: string, label?: string) => {
        if (selection.included.length > 0) {
            if (selection.included.some((candidate) => matchesFacetEntry(candidate, value, label))) {
                const included = selection.included.filter((candidate) => !matchesFacetEntry(candidate, value, label));
                onSelectionChange(definition.field, included.length > 0
                    ? { included, excluded: selection.excluded }
                    : {
                        included: [],
                        excluded: [
                            ...selection.excluded.filter((candidate) => !matchesFacetEntry(candidate, value, label)),
                            value,
                        ],
                    });
            } else {
                onSelectionChange(definition.field, {
                    included: [...selection.included, value],
                    excluded: selection.excluded.filter((candidate) => !matchesFacetEntry(candidate, value, label)),
                });
            }
            return;
        }

        onSelectionChange(definition.field, {
            included: [],
            excluded: selection.excluded.some((candidate) => matchesFacetEntry(candidate, value, label))
                ? selection.excluded.filter((candidate) => !matchesFacetEntry(candidate, value, label))
                : [...selection.excluded, value],
        });
    };

    const displayValue = (value: string, label?: string) => {
        if (value === '') return t('components.quickFilters.empty');
        const formattedValue = formatValue?.(definition.field, value);
        return formattedValue && formattedValue !== value
            ? formattedValue
            : label || formattedValue || value;
    };

    return (
        <section className={`py-1 ${applicable ? '' : 'opacity-50'}`} data-applicable={applicable}>
            <div className="flex min-h-11 items-center gap-1">
                <button
                    type="button"
                    onClick={onToggle}
                    disabled={!applicable}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm font-semibold enabled:hover:bg-gray-50 disabled:cursor-not-allowed dark:enabled:hover:bg-gray-700"
                    aria-expanded={open}
                >
                    <ChevronDown
                        size={16}
                        className={`shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
                        aria-hidden="true"
                    />
                    <span className="truncate">{definition.label}</span>
                </button>
                <ActiveFilterControls
                    count={activeCount}
                    clearLabel={t('components.quickFilters.clearSection', { field: definition.label })}
                    onClear={() => {
                        setSearch('');
                        setSearchOpen(false);
                        onSelectionChange(definition.field, { included: [], excluded: [] });
                    }}
                />
                {open && (
                    <button
                        type="button"
                        onClick={() => setSearchOpen((current) => !current)}
                        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-gray-500 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700"
                        aria-label={t('components.quickFilters.searchField', { field: definition.label })}
                        aria-expanded={searchOpen}
                    >
                        <Search size={16} />
                    </button>
                )}
            </div>
            {open && (
                <div className="pb-2 pl-2">
                    {searchOpen && (
                        <input
                            type="search"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder={t('components.quickFilters.searchPlaceholder')}
                            className="mb-2 min-h-11 w-full rounded-md border border-gray-300 bg-white px-3 text-sm outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:bg-gray-900"
                        />
                    )}
                    {error && values.length === 0 ? (
                        <button
                            type="button"
                            onClick={() => setRetryKey((current) => current + 1)}
                            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                        >
                            <RefreshCw size={15} />
                            {t('components.quickFilters.retry')}
                        </button>
                    ) : values.length === 0 && !loading ? (
                        <p className="px-2 py-3 text-xs text-gray-500">
                            {t('components.quickFilters.noValues')}
                        </p>
                    ) : (
                        <div>
                            {values.map((entry) => (
                                <div key={entry.value} className="flex min-h-11 items-center rounded-md hover:bg-gray-50 dark:hover:bg-gray-700/60">
                                    <label className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center">
                                        <input
                                            type="checkbox"
                                            checked={isChecked(entry.value, entry.label)}
                                            onChange={() => toggleValue(entry.value, entry.label)}
                                            className="h-5 w-5 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                            aria-label={t('components.quickFilters.toggleValue', {
                                                field: definition.label,
                                                value: displayValue(entry.value, entry.label),
                                            })}
                                        />
                                    </label>
                                    <button
                                        type="button"
                                        onClick={() => onSelectionChange(definition.field, {
                                            included: [entry.value],
                                            excluded: [],
                                        })}
                                        className="min-w-0 flex-1 self-stretch truncate text-left text-sm"
                                        title={displayValue(entry.value, entry.label)}
                                    >
                                        {displayValue(entry.value, entry.label)}
                                    </button>
                                    <span className="shrink-0 px-2 text-xs tabular-nums text-gray-500 dark:text-gray-400">
                                        {numberFormatter.format(entry.count)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                    {error && values.length > 0 && (
                        <button
                            type="button"
                            onClick={() => setRetryKey((current) => current + 1)}
                            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                        >
                            <RefreshCw size={15} />
                            {t('components.quickFilters.retry')}
                        </button>
                    )}
                    {loading && values.length === 0 && (
                        <p className="px-2 py-3 text-xs text-gray-500" aria-live="polite">
                            {t('components.quickFilters.loading')}
                        </p>
                    )}
                    {loading && values.length > 0 && (
                        <span className="sr-only" aria-live="polite">
                            {t('components.quickFilters.loading')}
                        </span>
                    )}
                    {hasMore && !loading && !error && (
                        <button
                            type="button"
                            onClick={() => setPagination({
                                baseKey: requestBaseKey,
                                offset: values.length,
                            })}
                            className="min-h-11 w-full rounded-md px-2 text-left text-sm font-medium text-primary-600 hover:bg-primary-50 dark:text-primary-400 dark:hover:bg-primary-900/20"
                        >
                            {t('components.quickFilters.showMore')}
                        </button>
                    )}
                </div>
            )}
        </section>
    );
}

interface ActiveFilterControlsProps {
    count: number;
    clearLabel: string;
    onClear: () => void;
}

function ActiveFilterControls({
    count,
    clearLabel,
    onClear,
}: ActiveFilterControlsProps) {
    if (count === 0) return null;

    return (
        <div className="flex shrink-0 items-center">
            <span
                aria-hidden="true"
                className="min-w-5 rounded-full bg-primary-600 px-1.5 text-center text-xs font-medium text-white"
            >
                {count}
            </span>
            <button
                type="button"
                onClick={onClear}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-gray-500 hover:bg-gray-50 hover:text-gray-700 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-gray-100"
                aria-label={clearLabel}
                title={clearLabel}
            >
                <X size={16} aria-hidden="true" />
            </button>
        </div>
    );
}

function mergeFacetValues(current: FacetValue[], next: FacetValue[]): FacetValue[] {
    const merged = new Map(current.map((entry) => [entry.value, entry]));
    for (const entry of next) merged.set(entry.value, entry);
    return [...merged.values()];
}

function getActiveSelectionCount(
    definition: QuickFilterDefinition,
    selection: SearchFacetSelection,
): number {
    const selectionCount = selection.included.length + selection.excluded.length;
    if (!definition.defaultSelection) return selectionCount;
    if (facetSelectionsEqual(selection, definition.defaultSelection)) return 0;
    return Math.max(1, selectionCount);
}

function facetSelectionsEqual(
    left: SearchFacetSelection,
    right: SearchFacetSelection,
): boolean {
    return facetValueSetsEqual(left.included, right.included)
        && facetValueSetsEqual(left.excluded, right.excluded);
}

function facetValueSetsEqual(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((value) => right.includes(value));
}
