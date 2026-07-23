import { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { fetchAlertsPaginated, fetchAlert, deleteAlert, bulkDeleteAlerts, cleanupByIp, fetchConfig, fetchDecisionsPaginated } from "../lib/api";
import { isSimulatedAlert, isSimulatedDecision, parseSimulationFilter } from "../lib/simulation";
import { useRefresh } from "../contexts/useRefresh";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { HighlightedSearchInput } from "../components/HighlightedSearchInput";
import { CollapsibleSearchControls } from "../components/CollapsibleSearchControls";
import { SearchSyntaxModal } from "../components/SearchSyntaxModal";
import { TableColumnsModal } from "../components/TableColumnsModal";
import { QuickFilters, type QuickFilterDefinition, type QuickFilterSectionId } from "../components/QuickFilters";
import { CountryFlag } from "../components/CountryFlag";
import { ScenarioName } from "../components/ScenarioName";
import { TimeDisplay } from "../components/TimeDisplay";
import { EventCard } from "../components/EventCard";
import { ContextSummary } from "../components/ContextSummary";
import { Collapsible } from "../components/ui/Collapsible";
import { getDisplayMetadata, isAppSecEvent } from "../lib/alertMetadata";
import { getCountryName } from "../lib/utils";
import { getDecisionExpirationState } from "../lib/decisionExpiration";
import { loadStoredTableColumnPreferences, saveStoredTableColumnPreferences } from "../lib/tableColumns";
import { TABLE_COLUMN_DEFINITIONS } from "../../../shared/contracts";
import { resolveMachineName } from "../../../shared/machine";
import { collectDistinctOrigins, getOriginDisplayValue, getOriginTitle } from "../../../shared/origin";
import {
    compileAlertSearch,
    getSearchDateRange,
    getSearchHelpDefinition,
    replaceSearchDateRange,
    replaceSearchFacetSelection,
    serializeSearchNode,
    type SearchFacetSelection,
    type SearchDateRange,
    type SearchParseError,
} from "../../../shared/search";
import { Info, ExternalLink, Shield, ShieldBan, Trash2, X, AlertCircle, Columns3, Loader2 } from "lucide-react";
import type { AlertRecord, AlertSource, ApiPermissionError, BulkDeleteResult, DecisionListItem, FacetField, InstanceEntityRef, InstanceOperationResult, SimulationFilter, SlimAlert, TableColumnId, TableColumnPreferences } from '../types';
import { useI18n, type I18nContextValue } from "../lib/i18n";
import { getBrowserTimeZone, useDateTime } from "../lib/dateTime";

type AlertListItem = SlimAlert;
type AlertSelection = AlertListItem | AlertRecord;
type AlertDeleteAction =
    | { kind: "single"; ref: InstanceEntityRef }
    | { kind: "selected"; refs: InstanceEntityRef[] }
    | { kind: "ip"; ip: string };

const ALERT_DETAIL_CARD_CLASS_NAME = "p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-100 dark:border-gray-700/50";
const ALERT_DETAIL_LABEL_CLASS_NAME = "text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2";
const ALERT_DETAIL_PRIMARY_CLASS_NAME = "text-lg font-medium text-gray-900 dark:text-gray-100";
const ALERT_DETAIL_SECONDARY_CLASS_NAME = "text-sm text-gray-500 dark:text-gray-400";

function alertKey(alert: Pick<AlertListItem, 'id' | 'instance_id'>): string {
    return `${alert.instance_id || 'default'}\u0000${String(alert.id)}`;
}

function alertRef(alert: Pick<AlertListItem, 'id' | 'instance_id'>): InstanceEntityRef {
    return { instance_id: alert.instance_id || 'default', id: String(alert.id) };
}

interface ErrorInfo {
    message: string;
    helpLink?: string;
    helpText?: string;
}

function ErrorBanner({ errorInfo, onDismiss }: { errorInfo: ErrorInfo; onDismiss?: () => void }) {
    const { t } = useI18n();

    return (
        <div role="alert" className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
                <AlertCircle size={16} className="flex-shrink-0" />
                <span className="text-sm">
                    {errorInfo.message}
                    {errorInfo.helpLink && (
                        <>
                            {' '}{t('common.seeReadme')}{' '}
                            <a
                                href={errorInfo.helpLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline hover:text-red-900 dark:hover:text-red-100"
                            >
                                {errorInfo.helpText || t('common.learnMore')}
                            </a>
                        </>
                    )}
                </span>
            </div>
            {onDismiss && (
                <button
                    onClick={onDismiss}
                    className="text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-200"
                    aria-label={t('common.dismissError')}
                >
                    <X size={16} />
                </button>
            )}
        </div>
    );
}

function TableLoadingRow({ colSpan, label }: { colSpan: number; label: string }) {
    return (
        <tr>
            <td colSpan={colSpan} className="bg-primary-50/60 dark:bg-primary-900/10 px-6 py-4 text-center">
                <span className="inline-flex items-center justify-center gap-2 text-sm font-medium text-primary-700 dark:text-primary-300" aria-live="polite">
                    <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                    {label}
                </span>
            </td>
        </tr>
    );
}

function toErrorInfo(error: unknown, fallbackMessage: string): ErrorInfo {
    const apiError = error as Partial<ApiPermissionError> | undefined;

    return {
        message: typeof apiError?.message === 'string' ? apiError.message : fallbackMessage,
        helpLink: typeof apiError?.helpLink === 'string' ? apiError.helpLink : undefined,
        helpText: typeof apiError?.helpText === 'string' ? apiError.helpText : undefined,
    };
}

function hasAlertEvents(alert: AlertSelection): alert is AlertRecord {
    return 'events' in alert;
}

function getAlertSourceValue(source: AlertSource | null | undefined): string | undefined {
    const values = [source?.ip, source?.value, source?.range];
    return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function getAlertOrigins(alert: AlertListItem): string[] {
    return alert.decision_summary?.origins ?? collectDistinctOrigins(alert.decisions);
}

function getAlertDecisionCounts(
    alert: AlertListItem,
    simulationsEnabled: boolean,
    simulationFilter: SimulationFilter,
): { active: number; expired: number } {
    const summary = alert.decision_summary;
    if (summary) {
        if (simulationsEnabled && simulationFilter === 'simulated') {
            return {
                active: summary.simulated_active_count,
                expired: summary.simulated_expired_count,
            };
        }
        if (simulationsEnabled && simulationFilter === 'live') {
            return {
                active: summary.active_count - summary.simulated_active_count,
                expired: summary.expired_count - summary.simulated_expired_count,
            };
        }
        return { active: summary.active_count, expired: summary.expired_count };
    }

    const visibleDecisions = simulationsEnabled && simulationFilter !== 'all'
        ? alert.decisions.filter((decision) => simulationFilter === 'simulated'
            ? isSimulatedDecision(decision)
            : !isSimulatedDecision(decision))
        : alert.decisions;
    return {
        active: visibleDecisions.filter((decision) => decision.expired !== true).length,
        expired: visibleDecisions.filter((decision) => decision.expired === true).length,
    };
}

function buildDecisionListHref(
    alertId: string | number,
    options: { includeExpired?: boolean; simulation?: SimulationFilter; instanceId?: string } = {},
) {
    const params = new URLSearchParams({ alert_id: String(alertId) });

    if (options.instanceId) params.set('instance', options.instanceId);

    if (options.includeExpired) {
        params.set("include_expired", "true");
    }

    if (options.simulation && options.simulation !== "all") {
        params.set("simulation", options.simulation);
    }

    return `/decisions?${params.toString()}`;
}

function summarizeDeleteResult(result: BulkDeleteResult, t: I18nContextValue['t']): string | null {
    if (result.failed.length === 0) {
        return null;
    }

    const deletedParts: string[] = [];
    if (result.deleted_alerts > 0) {
        deletedParts.push(t('pages.alerts.deletedAlerts', { count: result.deleted_alerts }));
    }
    if (result.deleted_decisions > 0) {
        deletedParts.push(t('pages.alerts.deletedDecisions', { count: result.deleted_decisions }));
    }

    const deletedText = deletedParts.length > 0 ? t('pages.alerts.deletedSummaryPrefix', { items: deletedParts.join(` ${t('common.and')} `) }) : "";
    return `${deletedText}${t('pages.alerts.itemsFailedToDelete', { count: result.failed.length })}`;
}

function combineDeleteResults(results: BulkDeleteResult[]): BulkDeleteResult {
    return results.reduce<BulkDeleteResult>((combined, result) => ({
        requested_alerts: combined.requested_alerts + result.requested_alerts,
        requested_decisions: combined.requested_decisions + result.requested_decisions,
        deleted_alerts: combined.deleted_alerts + result.deleted_alerts,
        deleted_decisions: combined.deleted_decisions + result.deleted_decisions,
        failed: [...combined.failed, ...result.failed],
        instance_results: [...(combined.instance_results || []), ...(result.instance_results || [])],
        ip: combined.ip || result.ip,
    }), { requested_alerts: 0, requested_decisions: 0, deleted_alerts: 0, deleted_decisions: 0, failed: [] });
}

export function Alerts() {
    const { language, t } = useI18n();
    const { formatDateTime, timeZone } = useDateTime();
    const { refreshSignal } = useRefresh();
    const [facetRefreshKey, setFacetRefreshKey] = useState(refreshSignal);
    const [searchParams, setSearchParams] = useSearchParams();
    const initialQueryParam = searchParams.get("q") ?? "";
    const [alerts, setAlerts] = useState<AlertListItem[]>([]);
    const [simulationsEnabled, setSimulationsEnabled] = useState(false);
    const [canManageEnforcement, setCanManageEnforcement] = useState(false);
    const [multipleInstances, setMultipleInstances] = useState(false);
    const [tableColumnPreferences, setTableColumnPreferences] = useState<TableColumnPreferences>(() => loadStoredTableColumnPreferences());
    const [showColumnsModal, setShowColumnsModal] = useState(false);
    const [searchDraft, setSearchDraft] = useState(initialQueryParam);
    const [debouncedSearchDraft, setDebouncedSearchDraft] = useState(initialQueryParam);
    const [nowMs, setNowMs] = useState(() => Date.now());
    const [showSearchSyntaxModal, setShowSearchSyntaxModal] = useState(false);
    const [initialLoading, setInitialLoading] = useState(true);
    const [hasLoadedAlerts, setHasLoadedAlerts] = useState(false);
    const [backgroundLoading, setBackgroundLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [selectedAlert, setSelectedAlert] = useState<AlertSelection | null>(null);
    const [modalDecisions, setModalDecisions] = useState<DecisionListItem[]>([]);
    const [modalDecisionsLoading, setModalDecisionsLoading] = useState(false);
    const [modalDecisionsLoadingMore, setModalDecisionsLoadingMore] = useState(false);
    const [modalDecisionsPage, setModalDecisionsPage] = useState(1);
    const [modalDecisionsTotalPages, setModalDecisionsTotalPages] = useState(1);
    const [modalDecisionsTotal, setModalDecisionsTotal] = useState(0);
    const [modalDecisionsRefreshToken, setModalDecisionsRefreshToken] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [totalAlerts, setTotalAlerts] = useState(0);
    const [totalUnfilteredAlerts, setTotalUnfilteredAlerts] = useState(0);
    const [selectableAlertIds, setSelectableAlertIds] = useState<string[]>([]);
    const [pendingDeleteAction, setPendingDeleteAction] = useState<AlertDeleteAction | null>(null);
    const [selectedAlertIds, setSelectedAlertIds] = useState<string[]>([]);
    const [deleteInProgress, setDeleteInProgress] = useState(false);
    const [errorInfo, setErrorInfo] = useState<ErrorInfo | null>(null);
    const [pendingDeleteErrorInfo, setPendingDeleteErrorInfo] = useState<ErrorInfo | null>(null);
    const [retryCleanupInstances, setRetryCleanupInstances] = useState<InstanceOperationResult[]>([]);
    const [showAllEvents, setShowAllEvents] = useState(false);
    const currentSimulationFilter = simulationsEnabled ? parseSimulationFilter(searchParams.get("simulation")) : 'all';
    const alertIdParam = searchParams.get("id");
    const queryParam = searchParams.get("q");
    const appliedQuery = queryParam?.trim() ?? "";
    const dateStartParam = searchParams.get("dateStart") ?? "";
    const dateEndParam = searchParams.get("dateEnd") ?? "";

    // Ref to track selected alert ID for auto-refresh (avoids stale closure issues)
    const selectedAlertIdRef = useRef<string | number | null>(null);
    const selectedAlertInstanceIdRef = useRef<string | undefined>(undefined);

    const PAGE_SIZE = 50;
    const MAX_ALERT_REFRESH_SIZE = 200;
    const MAX_MODAL_DECISION_REFRESH_SIZE = 200;
    const hasMoreAlerts = currentPage < totalPages;
    const observer = useRef<IntersectionObserver | null>(null);
    const decisionContainerRef = useRef<HTMLDivElement | null>(null);
    const modalDecisionObserverRef = useRef<IntersectionObserver | null>(null);
    const selectAllAlertsRef = useRef<HTMLInputElement | null>(null);
    const previousSelectedAlertIdRef = useRef<string | null>(null);
    const modalSelectedAlertIdRef = useRef<string | null>(null);
    const alertsRef = useRef<AlertListItem[]>([]);
    const currentPageRef = useRef(1);
    const inFlightLoadKeysRef = useRef(new Set<string>());
    const lastCompletedLoadRef = useRef<{ key: string; completedAt: number } | null>(null);
    const modalDecisionsLoadRef = useRef<{ alertId: string | null; page: number | null }>({ alertId: null, page: null });
    const modalDecisionsPageRef = useRef(1);
    const loadAlertsRef = useRef<(options?: {
        isBackground?: boolean;
        page?: number;
        append?: boolean;
        preserveLoadedPages?: boolean;
        refreshConfig?: boolean;
    }) => Promise<void>>(async () => {});
    const lastRefreshSignalRef = useRef(refreshSignal);
    const configRef = useRef<{
        simulationsEnabled: boolean;
        canManageEnforcement: boolean;
        multipleInstances: boolean;
    } | null>(null);
    const hasLoadedAlertsRef = useRef(false);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const searchDraftRef = useRef(searchDraft);
    const searchSelectionRef = useRef({ start: 0, end: 0 });
    const pendingSearchFocusRef = useRef<number | null>(null);
    const skipSearchParamSyncRef = useRef<string | null>(null);
    const searchDebounceTimeoutRef = useRef<number | null>(null);
    const searchValidationFeatures = useMemo(() => ({ machineEnabled: true, originEnabled: true }), []);
    const searchDateOptions = useMemo(() => ({
        timezoneOffsetMinutes: new Date().getTimezoneOffset(),
        timeZone: timeZone || getBrowserTimeZone(),
    }), [timeZone]);
    const compiledSearch = useMemo(
        () => compileAlertSearch(debouncedSearchDraft, searchValidationFeatures, searchDateOptions),
        [debouncedSearchDraft, searchDateOptions, searchValidationFeatures],
    );
    const queryError: SearchParseError | null = compiledSearch.ok ? null : compiledSearch.error;
    const searchHelp = useMemo(
        () => getSearchHelpDefinition('alerts', searchValidationFeatures, { alerts }),
        [alerts, searchValidationFeatures],
    );
    const combinedScope = (searchParams.get('instance') || 'all') === 'all' && multipleInstances;
    const visibleAlertColumns = useMemo(() => {
        const configured = tableColumnPreferences.alerts;
        return combinedScope && !configured.includes('instance')
            ? ['instance' as TableColumnId, ...configured]
            : configured;
    }, [combinedScope, tableColumnPreferences.alerts]);
    const alertColumnDefinitionById = useMemo(
        () => new Map<TableColumnId, (typeof TABLE_COLUMN_DEFINITIONS.alerts)[number]>(
            TABLE_COLUMN_DEFINITIONS.alerts.map((column) => [column.id, column]),
        ),
        [],
    );
    const visibleAlertColumnCount = visibleAlertColumns.length;
    const alertTableColSpan = visibleAlertColumnCount + (canManageEnforcement ? 2 : 0);
    const isAlertColumnVisible = useCallback((columnId: TableColumnId) => (
        visibleAlertColumns.includes(columnId)
    ), [visibleAlertColumns]);
    const cancelSearchDebounce = useCallback(() => {
        if (searchDebounceTimeoutRef.current !== null) {
            window.clearTimeout(searchDebounceTimeoutRef.current);
            searchDebounceTimeoutRef.current = null;
        }
    }, []);

    const buildServerFilters = useCallback((simulationFilter = currentSimulationFilter): Record<string, string> => {
        const filters: Record<string, string> = {
            tz_offset: String(new Date().getTimezoneOffset()),
        };
        const browserTimeZone = getBrowserTimeZone();
        if (browserTimeZone) filters.browser_tz = browserTimeZone;
        filters.instance = searchParams.get('instance') || 'all';
        if (appliedQuery) filters.q = appliedQuery;
        if (dateStartParam) filters.dateStart = dateStartParam;
        if (dateEndParam) filters.dateEnd = dateEndParam;
        if (simulationFilter !== 'all') {
            filters.simulation = simulationFilter;
        }
        return filters;
    }, [appliedQuery, currentSimulationFilter, dateEndParam, dateStartParam, searchParams]);
    const facetFilters = useMemo(
        () => buildServerFilters(currentSimulationFilter),
        [buildServerFilters, currentSimulationFilter],
    );
    const quickFilterConfig = useMemo<{
        fields: QuickFilterDefinition[];
        sectionOrder: QuickFilterSectionId[];
    }>(() => {
        const fieldByColumn: Partial<Record<TableColumnId, FacetField>> = {
            id: 'id',
            instance: 'instance',
            scenario: 'scenario',
            country: 'country',
            region: 'region',
            city: 'city',
            as: 'as',
            source: 'ip',
            machine: 'machine',
            origin: 'origin',
            decisions: 'decision',
        };
        const fields: QuickFilterDefinition[] = [];
        const sectionOrder: QuickFilterSectionId[] = [];
        for (const column of visibleAlertColumns) {
            if (column === 'time') {
                sectionOrder.push('date');
                continue;
            }
            const field = fieldByColumn[column];
            if (!field) continue;
            fields.push({ field, label: t(`tableColumns.${column}`) });
            sectionOrder.push(field);
        }
        fields.push({ field: 'target', label: t('components.eventCard.target') });
        sectionOrder.push('target');
        return { fields, sectionOrder };
    }, [t, visibleAlertColumns]);
    const quickFilterDateRange = useMemo(() => {
        const range = compiledSearch.ok ? getSearchDateRange(compiledSearch.ast) : { start: '', end: '' };
        return {
            start: range.start || dateStartParam,
            end: range.end || dateEndParam,
        };
    }, [compiledSearch, dateEndParam, dateStartParam]);
    const applyFacetSelection = useCallback((field: FacetField, selection: SearchFacetSelection) => {
        const currentQuery = searchParams.get('q') ?? '';
        const currentSearch = compileAlertSearch(currentQuery, searchValidationFeatures, searchDateOptions);
        if (!currentSearch.ok) return;

        const nextQuery = serializeSearchNode(replaceSearchFacetSelection(
            currentSearch.ast,
            field,
            selection,
        ));
        const nextParams = new URLSearchParams(searchParams);
        if (nextQuery) nextParams.set('q', nextQuery);
        else nextParams.delete('q');

        cancelSearchDebounce();
        searchDraftRef.current = nextQuery;
        searchSelectionRef.current = { start: nextQuery.length, end: nextQuery.length };
        skipSearchParamSyncRef.current = nextQuery;
        setSearchDraft(nextQuery);
        setDebouncedSearchDraft(nextQuery);
        setSearchParams(nextParams);
    }, [
        cancelSearchDebounce,
        searchDateOptions,
        searchParams,
        searchValidationFeatures,
        setSearchParams,
    ]);
    const applyDateRange = useCallback((range: SearchDateRange) => {
        const currentQuery = searchParams.get('q') ?? '';
        const currentSearch = compileAlertSearch(currentQuery, searchValidationFeatures, searchDateOptions);
        if (!currentSearch.ok) return;

        const nextQuery = serializeSearchNode(replaceSearchDateRange(currentSearch.ast, range));
        const nextParams = new URLSearchParams(searchParams);
        nextParams.delete('dateStart');
        nextParams.delete('dateEnd');
        if (nextQuery) nextParams.set('q', nextQuery);
        else nextParams.delete('q');

        cancelSearchDebounce();
        searchDraftRef.current = nextQuery;
        searchSelectionRef.current = { start: nextQuery.length, end: nextQuery.length };
        skipSearchParamSyncRef.current = nextQuery;
        setSearchDraft(nextQuery);
        setDebouncedSearchDraft(nextQuery);
        setSearchParams(nextParams);
    }, [
        cancelSearchDebounce,
        searchDateOptions,
        searchParams,
        searchValidationFeatures,
        setSearchParams,
    ]);
    const formatFacetValue = useCallback((field: FacetField, value: string) => {
        if (field === 'country') return getCountryName(value, language) || value;
        if (field === 'decision') {
            return value === 'active' ? t('common.active') : t('common.inactive');
        }
        return value;
    }, [language, t]);

    const loadConfig = useCallback(async (refresh = false) => {
        if (!refresh && configRef.current) {
            return configRef.current;
        }

        const configData = await fetchConfig();
        const nextConfig = {
            simulationsEnabled: configData.simulations_enabled === true,
            canManageEnforcement: configData.permissions?.can_manage_enforcement !== false,
            multipleInstances: (configData.instances?.length || 0) > 1,
        };

        configRef.current = nextConfig;
        setSimulationsEnabled(nextConfig.simulationsEnabled);
        setCanManageEnforcement(nextConfig.canManageEnforcement);
        setMultipleInstances(nextConfig.multipleInstances);

        return nextConfig;
    }, []);

    const saveAlertColumns = useCallback((visiblePreferences: TableColumnId[]) => {
        setTableColumnPreferences((currentPreferences) => {
            const nextPreferences = {
                ...currentPreferences,
                alerts: visiblePreferences,
            };
            saveStoredTableColumnPreferences(nextPreferences);
            return nextPreferences;
        });
        setShowColumnsModal(false);
    }, []);

    const loadAlerts = useCallback(async ({
        isBackground = false,
        page = 1,
        append = false,
        preserveLoadedPages = false,
        refreshConfig = false,
    }: {
        isBackground?: boolean;
        page?: number;
        append?: boolean;
        preserveLoadedPages?: boolean;
        refreshConfig?: boolean;
    } = {}) => {
        const loadKey = JSON.stringify({
            page,
            append,
            preserveLoadedPages,
            loadedPage: preserveLoadedPages ? currentPageRef.current : undefined,
            filter: appliedQuery,
            search: searchParams.toString(),
            refreshConfig,
        });
        const lastCompletedLoad = lastCompletedLoadRef.current;
        if (
            inFlightLoadKeysRef.current.has(loadKey) ||
            (lastCompletedLoad?.key === loadKey && Date.now() - lastCompletedLoad.completedAt < 250)
        ) {
            return;
        }

        inFlightLoadKeysRef.current.add(loadKey);
        let completedSuccessfully = false;
        const shouldBlockWithInitialLoading = !append && !isBackground && !hasLoadedAlertsRef.current;

        try {
            if (append) {
                setLoadingMore(true);
            } else if (shouldBlockWithInitialLoading) {
                setInitialLoading(true);
            } else {
                setBackgroundLoading(true);
            }
            const configData = await loadConfig(refreshConfig || !configRef.current);
            const requestedSimulationFilter = configData.simulationsEnabled === true
                ? parseSimulationFilter(searchParams.get("simulation"))
                : 'all';
            const filters = buildServerFilters(requestedSimulationFilter);
            const loadedPageCount = Math.max(1, currentPageRef.current);
            const requestedPageSize = !append && preserveLoadedPages
                ? Math.min(MAX_ALERT_REFRESH_SIZE, loadedPageCount * PAGE_SIZE)
                : PAGE_SIZE;
            const alertsResult = await fetchAlertsPaginated(page, requestedPageSize, filters);
            let alertsData = alertsResult.data;
            let nextPage = alertsResult.pagination.page;
            const totalPagesAtDefaultSize = Math.ceil(alertsResult.pagination.total / PAGE_SIZE);

            if (!append && preserveLoadedPages) {
                nextPage = Math.max(1, Math.min(loadedPageCount, totalPagesAtDefaultSize || 1));
                const refreshedAlertKeys = new Set(alertsData.map(alertKey));
                const visibleAlertCount = Math.min(
                    alertsResult.pagination.total,
                    nextPage * PAGE_SIZE,
                );
                alertsData = [
                    ...alertsData,
                    ...alertsRef.current.filter((alert) => !refreshedAlertKeys.has(alertKey(alert))),
                ].slice(0, visibleAlertCount);
            } else if (append) {
                alertsData = [...alertsRef.current, ...alertsData];
            }

            alertsRef.current = alertsData;
            setAlerts(alertsData);
            currentPageRef.current = append ? alertsResult.pagination.page : nextPage;
            setCurrentPage(currentPageRef.current);
            setTotalPages(totalPagesAtDefaultSize);
            setTotalAlerts(alertsResult.pagination.total);
            setTotalUnfilteredAlerts(alertsResult.pagination.unfiltered_total);
            const nextSelectableIds = alertsData.map(alertKey);
            setSelectableAlertIds(nextSelectableIds);
            if (!append) {
                setSelectedAlertIds((current) => current.filter((id) => nextSelectableIds.includes(id)));
            }
            hasLoadedAlertsRef.current = true;
            setHasLoadedAlerts(true);

            // Check if there's an alert ID in the URL
            if (alertIdParam) {
                // Always fetch full alert data since list now returns slim payloads
                try {
                    const alertData = await fetchAlert(alertIdParam, searchParams.get('instance') === 'all' ? undefined : searchParams.get('instance') || undefined);
                    setSelectedAlert(alertData);
                    setModalDecisionsRefreshToken((current) => current + 1);
                } catch (err) {
                    console.error("Alert not found", err);
                    // Fallback to slim data from list if fetch fails
                    const requestedInstance = searchParams.get('instance');
                    const existingAlert = alertsData.find((alert) => String(alert.id) === alertIdParam
                        && (!requestedInstance || requestedInstance === 'all' || alert.instance_id === requestedInstance));
                    if (existingAlert) {
                        setSelectedAlert(existingAlert);
                    }
                }
            } else {
                // If a modal is open but no ID param (e.g. clicked row), refresh with full data
                // Use the ref to get current selected alert ID (avoids stale closure)
                if (selectedAlertIdRef.current) {
                    try {
                        const fullAlert = await fetchAlert(selectedAlertIdRef.current, selectedAlertInstanceIdRef.current);
                        setSelectedAlert(fullAlert);
                        setModalDecisionsRefreshToken((current) => current + 1);
                    } catch (err) {
                        console.error("Failed to refresh alert details", err);
                        // Keep showing current data on error
                    }
                }
            }

            completedSuccessfully = true;

        } catch (err) {
            console.error(err);
        } finally {
            inFlightLoadKeysRef.current.delete(loadKey);
            if (completedSuccessfully) {
                lastCompletedLoadRef.current = { key: loadKey, completedAt: Date.now() };
            }
            if (append) setLoadingMore(false);
            if (shouldBlockWithInitialLoading) {
                setInitialLoading(false);
            } else {
                setBackgroundLoading(false);
            }
        }
    }, [alertIdParam, appliedQuery, buildServerFilters, loadConfig, searchParams]);

    useEffect(() => {
        loadAlertsRef.current = loadAlerts;
    }, [loadAlerts]);

    useEffect(() => {
        const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000);
        return () => window.clearInterval(intervalId);
    }, []);

    const lastAlertElementRef = useCallback((node: HTMLTableRowElement | null) => {
        if (initialLoading || backgroundLoading || loadingMore || !hasMoreAlerts) return;
        if (observer.current) observer.current.disconnect();
        observer.current = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                void loadAlerts({ isBackground: true, page: currentPage + 1, append: true });
            }
        });
        if (node) observer.current.observe(node);
    }, [backgroundLoading, currentPage, hasMoreAlerts, initialLoading, loadAlerts, loadingMore]);

    useEffect(() => {
        const timeoutId = window.setTimeout(() => {
            void loadAlerts({ refreshConfig: true });
        }, 0);

        return () => window.clearTimeout(timeoutId);
    }, [loadAlerts]);


    useEffect(() => {
        if (refreshSignal <= lastRefreshSignalRef.current) {
            return;
        }

        lastRefreshSignalRef.current = refreshSignal;
        void loadAlertsRef.current({
            isBackground: true,
            page: 1,
            preserveLoadedPages: true,
            refreshConfig: true,
        }).finally(() => setFacetRefreshKey(refreshSignal));
    }, [refreshSignal]);

    useEffect(() => {
        const nextQuery = queryParam ?? "";
        if (skipSearchParamSyncRef.current === nextQuery) {
            skipSearchParamSyncRef.current = null;
            return;
        }
        cancelSearchDebounce();
        searchDraftRef.current = nextQuery;
        setSearchDraft((current) => current === nextQuery ? current : nextQuery);
        setDebouncedSearchDraft((current) => current === nextQuery ? current : nextQuery);
        searchSelectionRef.current = { start: nextQuery.length, end: nextQuery.length };
    }, [cancelSearchDebounce, queryParam]);

    useEffect(() => {
        searchDraftRef.current = searchDraft;
    }, [searchDraft]);

    useLayoutEffect(() => {
        if (showSearchSyntaxModal) {
            return;
        }

        const caretPosition = pendingSearchFocusRef.current;
        if (caretPosition === null) {
            return;
        }

        const input = searchInputRef.current;
        if (!input) {
            return;
        }

        input.focus();
        input.setSelectionRange(caretPosition, caretPosition);
        searchSelectionRef.current = { start: caretPosition, end: caretPosition };
        pendingSearchFocusRef.current = null;
    }, [searchDraft, showSearchSyntaxModal]);

    const updateSearchSelection = useCallback((start: number | null, end: number | null, fallbackLength: number) => {
        const nextStart = Math.min(start ?? fallbackLength, fallbackLength);
        const nextEnd = Math.min(end ?? nextStart, fallbackLength);
        searchSelectionRef.current = { start: nextStart, end: nextEnd };
    }, []);

    const updateSearchSelectionFromInput = useCallback((input: HTMLInputElement) => {
        updateSearchSelection(input.selectionStart, input.selectionEnd, input.value.length);
    }, [updateSearchSelection]);

    const getSearchInsertionRange = useCallback((currentValue: string) => {
        const input = searchInputRef.current;
        if (input && document.activeElement === input && input.selectionStart !== null && input.selectionEnd !== null) {
            updateSearchSelection(input.selectionStart, input.selectionEnd, currentValue.length);
        }

        const { start, end } = searchSelectionRef.current;
        return {
            start: Math.min(start, currentValue.length),
            end: Math.min(end, currentValue.length),
        };
    }, [updateSearchSelection]);

    useEffect(() => {
        if (searchDraft === debouncedSearchDraft) {
            cancelSearchDebounce();
            return;
        }

        const timeoutId = window.setTimeout(() => {
            searchDebounceTimeoutRef.current = null;
            setDebouncedSearchDraft(searchDraft);
        }, 300);
        searchDebounceTimeoutRef.current = timeoutId;

        return () => {
            if (searchDebounceTimeoutRef.current === timeoutId) {
                window.clearTimeout(timeoutId);
                searchDebounceTimeoutRef.current = null;
            }
        };
    }, [cancelSearchDebounce, debouncedSearchDraft, searchDraft]);

    useEffect(() => {
        if (!compiledSearch.ok) {
            return;
        }

        const nextQuery = debouncedSearchDraft.trim();
        if (queryParam === nextQuery) {
            return;
        }

        const nextParams = new URLSearchParams(searchParams);
        if (nextQuery) {
            nextParams.set("q", nextQuery);
        } else {
            nextParams.delete("q");
        }
        if (nextParams.toString() !== searchParams.toString()) {
            skipSearchParamSyncRef.current = nextQuery;
            setSearchParams(nextParams);
        }
    }, [compiledSearch, debouncedSearchDraft, queryParam, searchParams, setSearchParams]);

    // Keep ref in sync with selectedAlert for auto-refresh
    useEffect(() => {
        const nextSelectedAlertId = selectedAlert ? String(selectedAlert.id) : null;
        selectedAlertIdRef.current = selectedAlert?.id || null;
        selectedAlertInstanceIdRef.current = selectedAlert?.instance_id;
        if (previousSelectedAlertIdRef.current !== nextSelectedAlertId) {
            setShowAllEvents(false);
        }
        previousSelectedAlertIdRef.current = nextSelectedAlertId;
    }, [selectedAlert]);

    const selectedAlertId = selectedAlert ? String(selectedAlert.id) : null;
    const hasMoreModalDecisions = modalDecisionsPage < modalDecisionsTotalPages;

    const loadModalDecisions = useCallback(async (
        alertId: string,
        page = 1,
        {
            append = false,
            preserveLoadedPages = false,
            forceRefresh = false,
        }: {
            append?: boolean;
            preserveLoadedPages?: boolean;
            forceRefresh?: boolean;
        } = {},
    ) => {
        const previousLoad = modalDecisionsLoadRef.current;
        if (!forceRefresh && previousLoad.alertId === alertId && previousLoad.page === page) {
            return;
        }

        modalDecisionsLoadRef.current = { alertId, page };

        if (append) {
            setModalDecisionsLoadingMore(true);
        } else {
            setModalDecisionsLoading(true);
        }

        try {
            const requestedPageSize = !append && preserveLoadedPages
                ? Math.min(MAX_MODAL_DECISION_REFRESH_SIZE, Math.max(PAGE_SIZE, modalDecisionsPageRef.current * PAGE_SIZE))
                : PAGE_SIZE;
            const result = await fetchDecisionsPaginated(page, requestedPageSize, {
                alert_id: alertId,
                instance: selectedAlertInstanceIdRef.current || searchParams.get('instance') || 'all',
                include_expired: "true",
                tz_offset: String(new Date().getTimezoneOffset()),
            });

            let nextPage = result.pagination.page;
            const modalTotalPages = Math.ceil(result.pagination.total / PAGE_SIZE);

            if (!append && preserveLoadedPages) {
                const loadedPageCount = Math.max(1, modalDecisionsPageRef.current);
                nextPage = Math.max(1, Math.min(loadedPageCount, modalTotalPages || 1));
            }

            setModalDecisions((current) => {
                if (append) {
                    const existingIds = new Set(current.map((decision) => String(decision.id)));
                    return [
                        ...current,
                        ...result.data.filter((decision) => !existingIds.has(String(decision.id))),
                    ];
                }

                if (preserveLoadedPages) {
                    // Refresh as much of the visible range as one bounded request permits, then
                    // retain the older tail. Re-fetching every loaded page creates a request burst
                    // that grows every time the user scrolls farther into a large blocklist.
                    const refreshedIds = new Set(result.data.map((decision) => String(decision.id)));
                    const refreshed = [
                        ...result.data,
                        ...current.filter((decision) => !refreshedIds.has(String(decision.id))),
                    ];
                    const loadedDecisionCount = Math.max(current.length, nextPage * PAGE_SIZE);
                    return refreshed.slice(0, Math.min(result.pagination.total, loadedDecisionCount));
                }

                return result.data;
            });
            modalDecisionsPageRef.current = nextPage;
            setModalDecisionsPage(nextPage);
            setModalDecisionsTotalPages(modalTotalPages);
            setModalDecisionsTotal(result.pagination.total);
        } catch (error) {
            console.error("Failed to load alert decisions", error);
        } finally {
            if (append) {
                setModalDecisionsLoadingMore(false);
            } else {
                setModalDecisionsLoading(false);
            }
        }
    }, [searchParams]);

    useEffect(() => {
        const timeoutId = window.setTimeout(() => {
            if (!selectedAlertId) {
                modalDecisionsLoadRef.current = { alertId: null, page: null };
                setModalDecisions([]);
                modalDecisionsPageRef.current = 1;
                setModalDecisionsPage(1);
                setModalDecisionsTotalPages(1);
                setModalDecisionsTotal(0);
                modalSelectedAlertIdRef.current = null;
                return;
            }

            const selectedAlertChanged = modalSelectedAlertIdRef.current !== selectedAlertId;
            modalSelectedAlertIdRef.current = selectedAlertId;
            if (selectedAlertChanged) {
                modalDecisionsLoadRef.current = { alertId: null, page: null };
                setModalDecisions([]);
                modalDecisionsPageRef.current = 1;
                setModalDecisionsPage(1);
                setModalDecisionsTotalPages(1);
                setModalDecisionsTotal(0);
                void loadModalDecisions(selectedAlertId, 1, { forceRefresh: true });
                return;
            }

            void loadModalDecisions(selectedAlertId, 1, {
                preserveLoadedPages: true,
                forceRefresh: true,
            });
        }, 0);

        return () => window.clearTimeout(timeoutId);
    }, [loadModalDecisions, modalDecisionsRefreshToken, selectedAlertId]);

    const lastModalDecisionElementRef = useCallback((node: HTMLTableRowElement | null) => {
        if (!selectedAlertId || modalDecisionsLoading || modalDecisionsLoadingMore || !hasMoreModalDecisions) return;
        if (modalDecisionObserverRef.current) modalDecisionObserverRef.current.disconnect();
        modalDecisionObserverRef.current = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                void loadModalDecisions(selectedAlertId, modalDecisionsPage + 1, { append: true });
            }
        }, {
            root: decisionContainerRef.current,
        });
        if (node) modalDecisionObserverRef.current.observe(node);
    }, [hasMoreModalDecisions, loadModalDecisions, modalDecisionsLoading, modalDecisionsLoadingMore, modalDecisionsPage, selectedAlertId]);

    // Handler to fetch full alert data when clicking on a row
    // Since list view now returns slim alerts, we need to fetch full data for the modal
    const handleAlertClick = async (alert: AlertListItem) => {
        // Show slim data immediately while loading
        setSelectedAlert(alert);
        selectedAlertIdRef.current = alert.id;
        selectedAlertInstanceIdRef.current = alert.instance_id;

        try {
            const fullAlert = await fetchAlert(alert.id, alert.instance_id);
            setSelectedAlert(fullAlert);
        } catch (err) {
            console.error("Failed to fetch full alert details", err);
            // Keep showing slim data as fallback
        }
    };

    const applySearchExample = useCallback((query: string) => {
        cancelSearchDebounce();
        searchDraftRef.current = query;
        setSearchDraft(query);
        setDebouncedSearchDraft(query);
        pendingSearchFocusRef.current = query.length;
        setShowSearchSyntaxModal(false);
    }, [cancelSearchDebounce]);

    const insertSearchSnippet = useCallback((snippet: string) => {
        const currentValue = searchInputRef.current?.value ?? searchDraftRef.current;
        const { start, end } = getSearchInsertionRange(currentValue);
        const nextCaretPosition = start + snippet.length;
        const nextQuery = `${currentValue.slice(0, start)}${snippet}${currentValue.slice(end)}`;

        cancelSearchDebounce();
        searchDraftRef.current = nextQuery;
        searchSelectionRef.current = { start: nextCaretPosition, end: nextCaretPosition };
        setSearchDraft(nextQuery);
        setDebouncedSearchDraft(nextQuery);
        pendingSearchFocusRef.current = nextCaretPosition;
        setShowSearchSyntaxModal(false);
    }, [cancelSearchDebounce, getSearchInsertionRange]);

    const clearAllFilters = useCallback(() => {
        cancelSearchDebounce();
        searchDraftRef.current = "";
        setSearchDraft("");
        setDebouncedSearchDraft("");
        pendingSearchFocusRef.current = null;
        searchSelectionRef.current = { start: 0, end: 0 };
        skipSearchParamSyncRef.current = "";
        const instance = searchParams.get('instance');
        setSearchParams(instance ? { instance } : {});
    }, [cancelSearchDebounce, searchParams, setSearchParams]);

    // Delete handlers
    const requestDelete = (alert: AlertListItem, event: ReactMouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        setPendingDeleteErrorInfo(null);
        setPendingDeleteAction({ kind: "single", ref: alertRef(alert) });
    };

    const confirmDelete = async () => {
        if (!pendingDeleteAction) return;
        setDeleteInProgress(true);
        setErrorInfo(null);
        setPendingDeleteErrorInfo(null);
        try {
            let resultMessage: string | null = null;

            if (pendingDeleteAction.kind === "single") {
                const instanceScope = searchParams.get('instance');
                const result = await deleteAlert(
                    pendingDeleteAction.ref.id,
                    multipleInstances || (instanceScope && instanceScope !== 'all')
                        ? pendingDeleteAction.ref.instance_id
                        : undefined,
                );
                resultMessage = result ? summarizeDeleteResult(result, t) : null;
                if (selectedAlert && alertKey(selectedAlert) === `${pendingDeleteAction.ref.instance_id}\u0000${pendingDeleteAction.ref.id}`) {
                    setSelectedAlert(null);
                }
                setSelectedAlertIds((prev) => prev.filter((id) => id !== `${pendingDeleteAction.ref.instance_id}\u0000${pendingDeleteAction.ref.id}`));
            } else if (pendingDeleteAction.kind === "selected") {
                const result = await bulkDeleteAlerts(multipleInstances
                    ? pendingDeleteAction.refs
                    : pendingDeleteAction.refs.map((ref) => ref.id));
                resultMessage = summarizeDeleteResult(result, t);
                if (selectedAlert && pendingDeleteAction.refs.some((ref) => `${ref.instance_id}\u0000${ref.id}` === alertKey(selectedAlert))) {
                    setSelectedAlert(null);
                }
                setSelectedAlertIds([]);
            } else {
                const instanceScope = searchParams.get('instance');
                const result = retryCleanupInstances.length > 0
                    ? combineDeleteResults(await Promise.all(retryCleanupInstances.map((instance) => cleanupByIp({
                        ip: pendingDeleteAction.ip,
                        scope: 'instance',
                        instance_id: instance.instance_id,
                    }))))
                    : await cleanupByIp(!instanceScope && !multipleInstances
                        ? pendingDeleteAction.ip
                        : instanceScope === 'all' || !instanceScope
                        ? { ip: pendingDeleteAction.ip, scope: 'all' }
                        : { ip: pendingDeleteAction.ip, scope: 'instance', instance_id: instanceScope });
                resultMessage = summarizeDeleteResult(result, t);
                if (selectedAlert && getAlertSourceValue(selectedAlert.source) === pendingDeleteAction.ip) {
                    setSelectedAlert(null);
                }
                setSelectedAlertIds([]);
                if (result.deleted_alerts === 0 && result.deleted_decisions === 0 && result.failed.length === 0) {
                    resultMessage = t('pages.alerts.noAlertsOrDecisionsForIp', { ip: pendingDeleteAction.ip });
                }
                const failedInstances = result.instance_results?.filter((instance) => !instance.success) || [];
                if (failedInstances.length > 0) {
                    const succeededNames = result.instance_results?.filter((instance) => instance.success).map((instance) => instance.instance_name) || [];
                    setRetryCleanupInstances(failedInstances);
                    setPendingDeleteErrorInfo({
                        message: `${succeededNames.length > 0 ? `Succeeded: ${succeededNames.join(', ')}. ` : ''}Failed: ${failedInstances.map((instance) => instance.instance_name).join(', ')}.`,
                    });
                    await loadAlerts({ page: 1, refreshConfig: true });
                    return;
                }
                setRetryCleanupInstances([]);
            }

            setPendingDeleteAction(null);
            setPendingDeleteErrorInfo(null);
            await loadAlerts({ page: 1, refreshConfig: true });
            if (resultMessage) {
                setErrorInfo({ message: resultMessage });
            }
        } catch (error) {
            const fallbackMessage = pendingDeleteAction.kind === "single"
                ? t('pages.alerts.deleteFailed')
                : pendingDeleteAction.kind === "selected"
                    ? t('pages.alerts.deleteSelectedFailed')
                    : t('pages.alerts.deleteIpFailed');
            console.error("Failed to delete alert entries", error);
            setPendingDeleteErrorInfo(toErrorInfo(error, fallbackMessage));
        } finally {
            setDeleteInProgress(false);
        }
    };

    const cancelPendingDelete = () => {
        setPendingDeleteAction(null);
        setPendingDeleteErrorInfo(null);
        setRetryCleanupInstances([]);
    };

    const toggleAlertSelection = (alertId: string) => {
        setSelectedAlertIds((prev) => (
            prev.includes(alertId)
                ? prev.filter((id) => id !== alertId)
                : [...prev, alertId]
        ));
    };

    const filteredAlerts = alerts;
    const selectedFilteredAlertIds = selectableAlertIds.filter((id) => selectedAlertIds.includes(id));
    const selectedFilteredAlertRefs = filteredAlerts
        .filter((alert) => selectedFilteredAlertIds.includes(alertKey(alert)))
        .map(alertRef);
    const allFilteredAlertsSelected = selectableAlertIds.length > 0 && selectedFilteredAlertIds.length === selectableAlertIds.length;
    const someFilteredAlertsSelected = selectedFilteredAlertIds.length > 0 && !allFilteredAlertsSelected;

    useEffect(() => {
        if (selectAllAlertsRef.current) {
            selectAllAlertsRef.current.indeterminate = someFilteredAlertsSelected;
        }
    }, [someFilteredAlertsSelected]);

    const toggleAllFilteredAlerts = () => {
        setSelectedAlertIds((prev) => {
            if (allFilteredAlertsSelected) {
                return prev.filter((id) => !selectableAlertIds.includes(id));
            }

            return Array.from(new Set([...prev, ...selectableAlertIds]));
        });
    };

    const visibleAlerts = filteredAlerts;
    const selectedAlertEvents = selectedAlert && hasAlertEvents(selectedAlert) ? selectedAlert.events ?? [] : [];
    const selectedAlertContext = selectedAlert && 'meta' in selectedAlert
        ? getDisplayMetadata(selectedAlert.meta)
        : [];
    const selectedAlertIsAppSec = selectedAlertEvents.some(isAppSecEvent);
    const selectedAlertIsSimulated = selectedAlert ? isSimulatedAlert(selectedAlert) : false;
    const selectedAlertSourceValue = getAlertSourceValue(selectedAlert?.source);
    const alertSummaryGridColumns = multipleInstances
        ? (isAlertColumnVisible('machine') ? 'md:grid-cols-5' : 'md:grid-cols-4')
        : (isAlertColumnVisible('machine') ? 'md:grid-cols-4' : 'md:grid-cols-3');
    const deleteActionTitle = pendingDeleteAction?.kind === "single"
        ? t('pages.alerts.deleteAlertTitle')
        : pendingDeleteAction?.kind === "selected"
            ? t('pages.alerts.deleteSelectedTitle')
            : pendingDeleteAction?.kind === "ip"
                ? t('pages.alerts.deleteAllIpTitle')
                : t('common.delete');
    const selectedAlertCount = selectedFilteredAlertIds.length;
    const pendingSingleAlertId = pendingDeleteAction?.kind === "single" ? pendingDeleteAction.ref.id : null;
    const pendingIp = pendingDeleteAction?.kind === "ip" ? pendingDeleteAction.ip : null;
    const summaryText = initialLoading && !hasLoadedAlerts
        ? t('pages.alerts.loading')
        : totalAlerts !== totalUnfilteredAlerts
            ? t('pages.alerts.summaryFiltered', { count: visibleAlerts.length, total: totalAlerts, unfiltered: totalUnfilteredAlerts })
            : t('pages.alerts.summary', { count: visibleAlerts.length, total: totalAlerts });
    const tableBusy = initialLoading || backgroundLoading || loadingMore;

    const quickFilterProps = {
        page: 'alerts' as const,
        fields: quickFilterConfig.fields,
        sectionOrder: quickFilterConfig.sectionOrder,
        filters: facetFilters,
        searchAst: compiledSearch.ok ? compiledSearch.ast : null,
        onSelectionChange: applyFacetSelection,
        dateRange: quickFilterDateRange,
        onDateRangeChange: applyDateRange,
        formatValue: formatFacetValue,
        busy: tableBusy,
        refreshKey: facetRefreshKey,
    };

    return (
        <div className="space-y-6">
            <div
                data-testid="alerts-summary"
                className="flex min-h-[1.5rem] items-center justify-between gap-3 text-sm text-gray-500"
            >
                <span>{summaryText}</span>
                <span
                    className={`inline-flex items-center gap-2 text-xs transition-opacity ${backgroundLoading ? 'opacity-100' : 'opacity-0'}`}
                    aria-live="polite"
                >
                    <span className="h-2 w-2 rounded-full bg-primary-500 animate-pulse" aria-hidden="true" />
                    {t('common.refreshing')}
                </span>
            </div>

            {canManageEnforcement && (
                <div className="flex items-center gap-3">
                    <button
                        onClick={() => {
                            setPendingDeleteErrorInfo(null);
                            setPendingDeleteAction({ kind: "selected", refs: selectedFilteredAlertRefs });
                        }}
                        disabled={selectedAlertCount === 0}
                        className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {t('pages.alerts.deleteSelected')}
                    </button>
                </div>
            )}

            {/* Error Message */}
            {errorInfo && (
                <ErrorBanner errorInfo={errorInfo} onDismiss={() => setErrorInfo(null)} />
            )}

            {/* Show active filters */}
            {(appliedQuery || (simulationsEnabled && searchParams.get("simulation"))) && (
                <div className="flex flex-wrap gap-2">
                    {appliedQuery && (
                        <Badge variant="secondary" className="flex items-center gap-1 max-w-full">
                            <span className="font-semibold">{t('common.search')}:</span>
                            <span className="font-mono text-xs truncate max-w-[320px]">{appliedQuery}</span>
                            <button
                                onClick={() => {
                                    const nextParams = new URLSearchParams(searchParams);
                                    nextParams.delete("q");
                                    cancelSearchDebounce();
                                    setSearchDraft("");
                                    setDebouncedSearchDraft("");
                                    setSearchParams(nextParams);
                                }}
                                className="ml-1 hover:text-red-500"
                            >
                                &times;
                            </button>
                        </Badge>
                    )}
                    {simulationsEnabled && searchParams.get("simulation") && (
                        <Badge variant="secondary" className="flex items-center gap-1">
                            <span className="font-semibold">{t('pages.dashboard.simulation')}:</span> {searchParams.get("simulation")}
                            <button
                                onClick={() => {
                                    const newParams = new URLSearchParams(searchParams);
                                    newParams.delete("simulation");
                                    setSearchParams(newParams);
                                }}
                                className="ml-1 hover:text-red-500"
                            >
                                &times;
                            </button>
                        </Badge>
                    )}
                    <button
                        onClick={clearAllFilters}
                        className="text-xs text-gray-500 hover:text-gray-900 dark:hover:text-gray-300 underline"
                    >
                        {t('common.resetAllFilters')}
                    </button>
                </div>
            )
            }

            <div className="space-y-2">
                <div className="flex items-stretch gap-2">
                    <button
                        type="button"
                        onClick={() => setShowColumnsModal(true)}
                        className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700"
                        aria-label={t('components.tableColumns.chooseAlertColumns')}
                        title={t('components.tableColumns.chooseColumns')}
                    >
                        <Columns3 size={18} />
                    </button>
                    <QuickFilters {...quickFilterProps} />
                    <CollapsibleSearchControls
                        inputRef={searchInputRef}
                        onHelp={() => setShowSearchSyntaxModal(true)}
                    >
                        <HighlightedSearchInput
                            ref={searchInputRef}
                            searchPage="alerts"
                            showSearchIcon={false}
                            containerClassName="rounded-l-none"
                            className="rounded-l-none"
                            searchFeatures={searchValidationFeatures}
                            placeholder={t('pages.alerts.filterPlaceholder')}
                            value={searchDraft}
                            error={queryError}
                            onChange={(e) => {
                                searchDraftRef.current = e.target.value;
                                setSearchDraft(e.target.value);
                                updateSearchSelectionFromInput(e.target);
                            }}
                            onClick={(e) => updateSearchSelectionFromInput(e.currentTarget)}
                            onKeyUp={(e) => updateSearchSelectionFromInput(e.currentTarget)}
                            onSelect={(e) => updateSearchSelectionFromInput(e.currentTarget)}
                            aria-invalid={queryError ? 'true' : 'false'}
                            aria-describedby={queryError ? 'alerts-search-error' : undefined}
                        />
                    </CollapsibleSearchControls>
                </div>
                {queryError && (
                    <p id="alerts-search-error" className="text-xs text-red-600 dark:text-red-400">
                        {t('common.searchSyntaxError', { position: queryError.position + 1, message: queryError.message })}
                    </p>
                )}
            </div>

            <div
                className="bg-white dark:bg-gray-800 shadow-sm rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700"
                aria-busy={tableBusy}
            >
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 transition-opacity duration-200">
                        <thead className="bg-gray-50 dark:bg-gray-900/50">
                            <tr>
                                {canManageEnforcement && (
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                        <input
                                            ref={selectAllAlertsRef}
                                            type="checkbox"
                                            aria-label={t('pages.alerts.selectAllFiltered')}
                                            checked={allFilteredAlertsSelected}
                                            disabled={selectableAlertIds.length === 0}
                                            onChange={toggleAllFilteredAlerts}
                                            className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                        />
                                    </th>
                                )}
                                {visibleAlertColumns.map((columnId) => {
                                    const column = alertColumnDefinitionById.get(columnId);
                                    if (!column) {
                                        return null;
                                    }

                                    return (
                                        <th key={columnId} className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                            {t(`tableColumns.${column.id}`, { defaultValue: column.label })}
                                        </th>
                                    );
                                })}
                                {canManageEnforcement && (
                                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">{t('tableColumns.actions')}</th>
                                )}
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {initialLoading && visibleAlerts.length === 0 ? (
                                <tr><td colSpan={alertTableColSpan} className="px-6 py-4 text-center text-sm text-gray-500">{t('pages.alerts.loading')}</td></tr>
                            ) : visibleAlerts.length === 0 ? (
                                <tr><td colSpan={alertTableColSpan} className="px-6 py-4 text-center text-sm text-gray-500">{t('pages.alerts.noAlerts')}</td></tr>
                            ) : (
                                visibleAlerts.map((alert, index) => {
                                    const isLastElement = index === visibleAlerts.length - 1;
                                    const sourceValue = getAlertSourceValue(alert.source);
                                    const alertOrigins = getAlertOrigins(alert);
                                    const alertOriginDisplay = getOriginDisplayValue(alertOrigins);
                                    const alertOriginTitle = getOriginTitle(alertOrigins);
                                    const rowKey = alertKey(alert);
                                    const isSelected = selectedAlertIds.includes(rowKey);
                                    return (
                                        <tr
                                            key={rowKey}
                                            ref={isLastElement ? lastAlertElementRef : null}
                                            onClick={() => handleAlertClick(alert)}
                                            className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors cursor-pointer"
                                        >
                                            {canManageEnforcement && (
                                                <td className="px-6 py-4 whitespace-nowrap text-sm" onClick={(e) => e.stopPropagation()}>
                                                    <input
                                                        type="checkbox"
                                                        aria-label={t('pages.alerts.selectAlert', { id: alert.id })}
                                                        checked={isSelected}
                                                        onChange={() => toggleAlertSelection(rowKey)}
                                                        className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                                    />
                                                </td>
                                            )}
                                            {visibleAlertColumns.map((columnId) => {
                                                switch (columnId) {
                                                    case 'instance':
                                                        return (
                                                            <td key={columnId} className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                                                                <Badge variant="secondary">{alert.instance_name || alert.instance_id || 'default'}</Badge>
                                                            </td>
                                                        );
                                                    case 'id':
                                                        return (
                                                            <td key={columnId} className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-900 dark:text-gray-100">
                                                                #{alert.id}
                                                            </td>
                                                        );
                                                    case 'time':
                                                        return (
                                                            <td key={columnId} className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                                                                <TimeDisplay timestamp={alert.created_at} />
                                                            </td>
                                                        );
                                                    case 'scenario':
                                                        return (
                                                            <td key={columnId} className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 max-w-[200px]" title={alert.scenario}>
                                                                <ScenarioName
                                                                    name={alert.scenario}
                                                                    reason={alert.reason}
                                                                    showLink={true}
                                                                    simulated={simulationsEnabled && isSimulatedAlert(alert)}
                                                                />
                                                            </td>
                                                        );
                                                    case 'country':
                                                        return (
                                                            <td key={columnId} className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 align-middle">
                                                                {alert.source?.cn && alert.source?.cn !== "Unknown" ? (
                                                                    <div className="flex items-center gap-2" title={alert.source.cn}>
                                                                        <CountryFlag code={alert.source.cn} />
                                                                        <span className="truncate max-w-[150px]">{getCountryName(alert.source.cn, language)}</span>
                                                                    </div>
                                                                ) : (
                                                                    "-"
                                                                )}
                                                            </td>
                                                        );
                                                    case 'city':
                                                        return (
                                                            <td key={columnId} className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 max-w-[160px] truncate" title={alert.source?.city}>
                                                                {alert.source?.city || "-"}
                                                            </td>
                                                        );
                                                    case 'region':
                                                        return (
                                                            <td key={columnId} className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 max-w-[180px] truncate" title={alert.source?.region}>
                                                                {alert.source?.region || "-"}
                                                            </td>
                                                        );
                                                    case 'as':
                                                        return (
                                                            <td key={columnId} className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 max-w-[150px] truncate" title={alert.source?.as_name}>
                                                                {alert.source?.as_name || "-"}
                                                            </td>
                                                        );
                                                    case 'source':
                                                        return (
                                                            <td key={columnId} className="px-6 py-4 text-sm font-mono text-gray-900 dark:text-gray-100 max-w-[200px] truncate" title={sourceValue}>
                                                                {sourceValue || "-"}
                                                            </td>
                                                        );
                                                    case 'machine':
                                                        return (
                                                            <td key={columnId} className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400 max-w-[120px] truncate" title={resolveMachineName(alert)}>
                                                                {resolveMachineName(alert) || "-"}
                                                            </td>
                                                        );
                                                    case 'origin':
                                                        return (
                                                            <td key={columnId} className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400 max-w-[140px] truncate" title={alertOriginTitle}>
                                                                {alertOriginDisplay}
                                                            </td>
                                                        );
                                                    case 'decisions':
                                                        return (
                                                            <td key={columnId} className="px-6 py-4 whitespace-nowrap text-sm" onClick={(e) => e.stopPropagation()}>
                                                                {(() => {
                                                                    const decisionCounts = getAlertDecisionCounts(
                                                                        alert,
                                                                        simulationsEnabled,
                                                                        currentSimulationFilter,
                                                                    );
                                                                    const activeDecisionCount = decisionCounts.active;
                                                                    const expiredDecisionCount = decisionCounts.expired;
                                                                    const decisionFilter = simulationsEnabled && currentSimulationFilter !== 'all'
                                                                        ? currentSimulationFilter
                                                                        : undefined;

                                                                    if (activeDecisionCount > 0 || expiredDecisionCount > 0) {
                                                                        return (
                                                                            <div className="flex flex-wrap gap-2">
                                                                                {activeDecisionCount > 0 && (
                                                                                    <Link
                                                                                        to={buildDecisionListHref(alert.id, { simulation: decisionFilter, instanceId: alert.instance_id })}
                                                                                        className="inline-flex items-center gap-2 px-2 py-1 rounded-full bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300 hover:bg-primary-100 dark:hover:bg-primary-900/30 transition-colors border border-primary-200 dark:border-primary-800"
                                                                                        title={t('pages.alerts.viewActiveDecisions', { count: activeDecisionCount })}
                                                                                    >
                                                                                        <Shield size={14} className="fill-current" />
                                                                                        <span className="text-xs font-semibold">{t('common.active')}: {activeDecisionCount}</span>
                                                                                        <ExternalLink size={12} className="ml-0.5" />
                                                                                    </Link>
                                                                                )}
                                                                                {expiredDecisionCount > 0 && (
                                                                                    <Link
                                                                                        to={buildDecisionListHref(alert.id, { includeExpired: true, simulation: decisionFilter, instanceId: alert.instance_id })}
                                                                                        className="inline-flex items-center gap-2 px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                                                                                        title={t('pages.alerts.viewExpiredDecisions', { count: expiredDecisionCount })}
                                                                                    >
                                                                                        <Shield size={14} className="opacity-50" />
                                                                                        <span className="text-xs font-medium">{t('common.inactive')}: {expiredDecisionCount}</span>
                                                                                    </Link>
                                                                                )}
                                                                            </div>
                                                                        );
                                                                    }

                                                                    return <span className="text-gray-400">-</span>;
                                                                })()}
                                                            </td>
                                                        );
                                                    default:
                                                        return null;
                                                }
                                            })}
                                            {canManageEnforcement && (
                                                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                                    <div className="flex items-center justify-end gap-2">
                                                        {sourceValue && (
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    setPendingDeleteErrorInfo(null);
                                                                    setPendingDeleteAction({ kind: "ip", ip: sourceValue });
                                                                }}
                                                                className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors p-2 rounded-full relative z-10 cursor-pointer"
                                                                title={t('common.deleteAllForIp', { value: sourceValue })}
                                                                aria-label={t('common.deleteAllForIp', { value: sourceValue })}
                                                            >
                                                                <ShieldBan size={16} aria-hidden="true" />
                                                            </button>
                                                        )}
                                                        <button
                                                            onClick={(e) => requestDelete(alert, e)}
                                                            className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors p-2 rounded-full relative z-10 cursor-pointer"
                                                            title={t('pages.alerts.deleteAlert')}
                                                            aria-label={t('pages.alerts.deleteAlert')}
                                                        >
                                                            <Trash2 size={16} />
                                                        </button>
                                                    </div>
                                                </td>
                                            )}
                                        </tr>
                                    );
                                })
                            )}
                            {loadingMore && visibleAlerts.length > 0 && (
                                <TableLoadingRow colSpan={alertTableColSpan} label={t('pages.alerts.loadingMore')} />
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Alert Details Modal */}
            <Modal
                isOpen={!!selectedAlert}
                onClose={() => {
                    setSelectedAlert(null);
                    const newParams = new URLSearchParams(searchParams);
                    newParams.delete("id");
                    setSearchParams(newParams);
                }}
                title={selectedAlert ? t('pages.alerts.alertDetailsId', { id: selectedAlert.id }) : t('pages.alerts.alertDetails')}
                maxWidth="max-w-6xl"
            >
                {selectedAlert && (
                    <div className="space-y-6">
                        <p className="text-sm text-gray-500 dark:text-gray-400 -mt-2 mb-4">
                            {t('pages.alerts.capturedAt', { time: formatDateTime(selectedAlert.created_at) })}
                        </p>

                        {/* Summary Cards */}
                        <div className={`grid grid-cols-1 ${alertSummaryGridColumns} gap-4`}>
                            {multipleInstances && (
                                <div className={ALERT_DETAIL_CARD_CLASS_NAME}>
                                    <h4 className={ALERT_DETAIL_LABEL_CLASS_NAME}>
                                        {t('tableColumns.instance', { defaultValue: 'Instance' })}
                                    </h4>
                                    <div className={`${ALERT_DETAIL_PRIMARY_CLASS_NAME} break-words`}>
                                        {selectedAlert.instance_name || selectedAlert.instance_id || '-'}
                                    </div>
                                </div>
                            )}
                            {isAlertColumnVisible('machine') && (
                                <div className={ALERT_DETAIL_CARD_CLASS_NAME}>
                                    <h4 className={ALERT_DETAIL_LABEL_CLASS_NAME}>{t('tableColumns.machine')}</h4>
                                    <div className={ALERT_DETAIL_PRIMARY_CLASS_NAME}>
                                        {resolveMachineName(selectedAlert) || "-"}
                                    </div>
                                </div>
                            )}
                            <div className={ALERT_DETAIL_CARD_CLASS_NAME}>
                                <h4 className={ALERT_DETAIL_LABEL_CLASS_NAME}>{t('tableColumns.scenario')}</h4>
                                <div className="break-words">
                                    <ScenarioName
                                        name={selectedAlert.scenario}
                                        reason={selectedAlert.reason}
                                        showLink={true}
                                        showReason={true}
                                        simulated={simulationsEnabled && selectedAlertIsSimulated}
                                        size="lg"
                                    />
                                </div>
                            </div>
                            <div className={ALERT_DETAIL_CARD_CLASS_NAME}>
                                <h4 className={ALERT_DETAIL_LABEL_CLASS_NAME}>{t('pages.alerts.location')}</h4>
                                <div className={`${ALERT_DETAIL_PRIMARY_CLASS_NAME} flex items-center gap-2`}>
                                    {selectedAlert.source?.cn && (
                                        <CountryFlag code={selectedAlert.source.cn} />
                                    )}
                                    {getCountryName(selectedAlert.source?.cn, language) || "-"}
                                </div>
                                {selectedAlert.source?.latitude && selectedAlert.source?.longitude && (
                                    <div className={`${ALERT_DETAIL_SECONDARY_CLASS_NAME} font-mono mt-1`}>
                                        <a
                                            href={`https://www.google.com/maps?q=${encodeURIComponent(String(selectedAlert.source.latitude))},${encodeURIComponent(String(selectedAlert.source.longitude))}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="hover:text-primary-600 dark:hover:text-primary-400 transition-colors inline-flex items-center gap-1"
                                            title={t('pages.alerts.viewOnGoogleMaps')}
                                        >
                                            {t('pages.alerts.coordinates', { latitude: selectedAlert.source.latitude, longitude: selectedAlert.source.longitude })}
                                            <ExternalLink size={10} />
                                        </a>
                                    </div>
                                )}
                            </div>
                            <div className={ALERT_DETAIL_CARD_CLASS_NAME}>
                                <h4 className={ALERT_DETAIL_LABEL_CLASS_NAME}>{t('tableColumns.source')}</h4>
                                <div className="flex items-center gap-2">
                                    {selectedAlertSourceValue ? (
                                        <a
                                            href={`https://app.crowdsec.net/cti/${encodeURIComponent(String(selectedAlertSourceValue))}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className={`${ALERT_DETAIL_PRIMARY_CLASS_NAME} font-mono hover:text-primary-600 dark:hover:text-primary-400 transition-colors inline-flex items-center gap-1`}
                                            title={t('pages.alerts.viewOnCti')}
                                        >
                                            {selectedAlertSourceValue}
                                            <ExternalLink size={14} />
                                        </a>
                                    ) : (
                                        <span className={`${ALERT_DETAIL_PRIMARY_CLASS_NAME} font-mono`}>-</span>
                                    )}
                                </div>
                                {selectedAlert.source?.range && selectedAlert.source.range !== selectedAlertSourceValue && (
                                    <div className={`${ALERT_DETAIL_SECONDARY_CLASS_NAME} font-mono mt-1`}>
                                        {t('pages.alerts.range', { range: selectedAlert.source.range })}
                                    </div>
                                )}
                                <div className={`${ALERT_DETAIL_SECONDARY_CLASS_NAME} mt-1`}>
                                    {selectedAlert.source?.as_number && (
                                        <a
                                            href={`https://bgp.he.net/AS${encodeURIComponent(selectedAlert.source.as_number)}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="hover:text-primary-600 dark:hover:text-primary-400 transition-colors inline-flex items-center gap-1"
                                            title={t('pages.alerts.viewAsInfo')}
                                        >
                                            {selectedAlert.source?.as_name} (AS{selectedAlert.source.as_number})
                                            <ExternalLink size={12} />
                                        </a>
                                    )}
                                    {!selectedAlert.source?.as_number && selectedAlert.source?.as_name && (
                                        <span>{selectedAlert.source.as_name}</span>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Message */}
                        {(selectedAlert.message || selectedAlertIsAppSec) && (
                            <div className={`rounded-lg border p-4 ${selectedAlertIsAppSec
                                ? 'border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-900/10'
                                : 'border-blue-100 bg-blue-50 dark:border-blue-900/30 dark:bg-blue-900/10'
                            }`}>
                                <div className="flex items-start gap-2">
                                    {selectedAlertIsAppSec ? (
                                        <Badge variant="danger" className="mt-0.5 shrink-0 gap-1">
                                            <Shield size={12} />
                                            AppSec / WAF
                                        </Badge>
                                    ) : (
                                        <Info size={18} className="text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
                                    )}
                                    {selectedAlert.message && (
                                        <div className="text-sm text-gray-900 dark:text-gray-100">
                                            {selectedAlert.message}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Decisions */}
                        {(modalDecisionsLoading || modalDecisionsTotal > 0) && (
                            <div>
                                <div className="flex items-center justify-between gap-3 mb-3">
                                    <h4 className="text-lg font-semibold text-gray-900 dark:text-white">{t('pages.alerts.decisionsTaken')}</h4>
                                    {(modalDecisionsLoading || modalDecisions.length < modalDecisionsTotal) && (
                                        <span className="text-xs text-gray-500 dark:text-gray-400">
                                            {t('common.showingOf', { count: modalDecisions.length, total: modalDecisionsTotal })}
                                        </span>
                                    )}
                                </div>
                                <div
                                    ref={decisionContainerRef}
                                    className="max-h-[45vh] overflow-auto rounded-lg border border-gray-200 dark:border-gray-700"
                                >
                                    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                                        <thead className="bg-gray-50 dark:bg-gray-900">
                                            <tr>
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">{t('tableColumns.id')}</th>
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">{t('tableColumns.type')}</th>
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">{t('tableColumns.value')}</th>
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">{t('tableColumns.expiration')}</th>
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">{t('tableColumns.origin')}</th>
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">{t('tableColumns.view')}</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-800">
                                            {modalDecisionsLoading && modalDecisions.length === 0 ? (
                                                <tr>
                                                    <td colSpan={6} className="px-4 py-4 text-sm text-center text-gray-500">
                                                        {t('pages.decisions.loading')}
                                                    </td>
                                                </tr>
                                            ) : modalDecisions.map((decision, idx) => {
                                                const expirationState = getDecisionExpirationState(decision, nowMs);
                                                const isActive = !expirationState.isExpired;
                                                return (
                                                    <tr
                                                        key={`${decision.instance_id || selectedAlert.instance_id || 'default'}-${decision.id}-${decision.detail.duration ?? idx}`}
                                                        ref={idx === modalDecisions.length - 1 ? lastModalDecisionElementRef : null}
                                                    >
                                                        <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400">#{decision.id}</td>
                                                        <td className="px-4 py-2 text-sm"><Badge variant="danger">{decision.detail.type || decision.detail.action || "ban"}</Badge></td>
                                                        <td className="px-4 py-2 text-sm font-mono">{decision.value}</td>
                                                        <td className="px-4 py-2 text-sm">
                                                            {expirationState.label}
                                                            {!isActive && <span className="ml-2 text-xs text-red-500 dark:text-red-400">{t('pages.decisions.expired')}</span>}
                                                        </td>
                                                        <td className="px-4 py-2 text-sm">{decision.detail.origin || "-"}</td>
                                                        <td className="px-4 py-2 text-sm">
                                                            {isActive ? (
                                                                <Link
                                                                    to={buildDecisionListHref(selectedAlert.id, {
                                                                        instanceId: selectedAlert.instance_id,
                                                                        simulation: simulationsEnabled
                                                                            ? (isSimulatedDecision(decision) ? 'simulated' : 'live')
                                                                            : undefined,
                                                                    })}
                                                                    className="inline-flex items-center gap-2 px-2 py-1 rounded-full bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300 hover:bg-primary-100 dark:hover:bg-primary-900/30 transition-colors border border-primary-200 dark:border-primary-800"
                                                                    title={t('pages.alerts.viewActiveDecision')}
                                                                >
                                                                    <Shield size={14} className="fill-current" />
                                                                    <span className="text-xs font-semibold">{t('common.active')}</span>
                                                                    <ExternalLink size={12} className="ml-0.5" />
                                                                </Link>
                                                            ) : (
                                                                <Link
                                                                    to={buildDecisionListHref(selectedAlert.id, {
                                                                        instanceId: selectedAlert.instance_id,
                                                                        includeExpired: true,
                                                                        simulation: simulationsEnabled
                                                                            ? (isSimulatedDecision(decision) ? 'simulated' : 'live')
                                                                            : undefined,
                                                                    })}
                                                                    className="inline-flex items-center gap-2 px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                                                                    title={t('pages.alerts.viewExpiredDecision')}
                                                                >
                                                                    <Shield size={14} className="opacity-50" />
                                                                    <span className="text-xs font-medium">{t('common.inactive')}</span>
                                                                </Link>
                                                            )}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                            {modalDecisionsLoadingMore && (
                                                <TableLoadingRow colSpan={6} label={t('pages.decisions.loadingMore')} />
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        {/* Alert Context */}
                        {selectedAlertContext.length > 0 && (
                            <div>
                                <h4 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
                                    {t('pages.alerts.contextSummary')}
                                </h4>
                                <ContextSummary key={alertKey(selectedAlert)} entries={selectedAlertContext} />
                            </div>
                        )}

                        {/* Events Breakdown */}
                        <Collapsible
                            trigger={
                                <h4 className="text-lg font-semibold text-gray-900 dark:text-white">
                                    {t('pages.alerts.eventsTitle', { count: selectedAlertEvents.length })}
                                </h4>
                            }
                            defaultOpen={false}
                        >
                            <div className="mt-3">
                                <div className="space-y-2">
                                    {(showAllEvents
                                        ? selectedAlertEvents
                                        : selectedAlertEvents.slice(0, 10)
                                    )?.map((event, idx) => (
                                        <EventCard
                                            key={idx}
                                            event={event}
                                            index={idx}
                                        />
                                    ))}
                                </div>
                                {!showAllEvents && selectedAlertEvents.length > 10 && (
                                    <button
                                        onClick={() => setShowAllEvents(true)}
                                        className="mt-3 w-full py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 bg-gray-50 dark:bg-gray-900/30 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors cursor-pointer"
                                    >
                                        {t('pages.alerts.showAllEvents', { total: selectedAlertEvents.length, remaining: selectedAlertEvents.length - 10 })}
                                    </button>
                                )}
                            </div>
                        </Collapsible>

                    </div>
                )}
            </Modal>

            {/* Delete Confirmation Modal */}
            <Modal
                isOpen={!!pendingDeleteAction}
                onClose={() => {
                    if (!deleteInProgress) {
                        cancelPendingDelete();
                    }
                }}
                title={deleteActionTitle}
                maxWidth="max-w-sm"
                showCloseButton={false}
            >
                <p className="text-gray-600 dark:text-gray-300 mb-6">
                    {pendingSingleAlertId ? (
                        <>
                            {t('pages.alerts.deleteAlertConfirmPrefix')} <span className="font-mono text-sm font-bold">#{pendingSingleAlertId}</span>? {t('pages.alerts.deleteAlertConfirmSuffix')}
                        </>
                    ) : pendingIp ? (
                        <>
                            {t('common.deleteIpConfirmPrefix')} <span className="font-mono text-sm font-bold">{pendingIp}</span>? {t('common.actionCannotBeUndone')}
                        </>
                    ) : (
                        <>{t('pages.alerts.deleteSelectedConfirm', { count: selectedFilteredAlertIds.length })}</>
                    )}
                </p>
                {pendingDeleteErrorInfo && (
                    <div className="mb-6">
                        <ErrorBanner errorInfo={pendingDeleteErrorInfo} />
                    </div>
                )}
                <div className="flex justify-end gap-3">
                    <button
                        onClick={cancelPendingDelete}
                        disabled={deleteInProgress}
                        className="px-4 py-2 text-sm font-medium text-gray-700 bg-white dark:bg-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        onClick={confirmDelete}
                        disabled={deleteInProgress}
                        className="px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {deleteInProgress
                            ? t('common.deleting')
                            : retryCleanupInstances.length > 0
                                ? 'Retry failed instances'
                                : t('common.delete')}
                    </button>
                </div>
            </Modal>
            <SearchSyntaxModal
                help={searchHelp}
                searchFeatures={searchValidationFeatures}
                isOpen={showSearchSyntaxModal}
                onClose={() => setShowSearchSyntaxModal(false)}
                onSelectExample={applySearchExample}
                onInsertSnippet={insertSearchSnippet}
            />
            <TableColumnsModal
                isOpen={showColumnsModal}
                table="alerts"
                columnPreferences={tableColumnPreferences.alerts}
                onClose={() => setShowColumnsModal(false)}
                onSave={saveAlertColumns}
            />
        </div >
    );
}
