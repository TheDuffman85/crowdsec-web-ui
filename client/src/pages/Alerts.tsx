import { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { fetchAlertsPaginated, fetchAlert, deleteAlert, bulkDeleteAlerts, cleanupByIp, fetchConfig, fetchDecisionsPaginated } from "../lib/api";
import { isSimulatedAlert, isSimulatedDecision, matchesSimulationFilter, parseSimulationFilter } from "../lib/simulation";
import { useRefresh } from "../contexts/useRefresh";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { HighlightedSearchInput } from "../components/HighlightedSearchInput";
import { SearchSyntaxModal } from "../components/SearchSyntaxModal";
import { ScenarioName } from "../components/ScenarioName";
import { TimeDisplay } from "../components/TimeDisplay";
import { EventCard } from "../components/EventCard";
import { getCountryName } from "../lib/utils";
import { resolveMachineName } from "../../../shared/machine";
import { collectDistinctOrigins, getOriginDisplayValue, getOriginTitle } from "../../../shared/origin";
import { compileAlertSearch, getSearchHelpDefinition, type SearchParseError } from "../../../shared/search";
import { Info, ExternalLink, Shield, ShieldBan, Trash2, X, AlertCircle } from "lucide-react";
import type { AlertRecord, AlertSource, ApiPermissionError, BulkDeleteResult, DecisionListItem, SimulationFilter, SlimAlert } from '../types';

type AlertListItem = SlimAlert;
type AlertSelection = AlertListItem | AlertRecord;
type AlertDeleteAction =
    | { kind: "single"; alertId: string | number }
    | { kind: "selected"; ids: string[] }
    | { kind: "ip"; ip: string };

interface ErrorInfo {
    message: string;
    helpLink?: string;
    helpText?: string;
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

function buildDecisionListHref(
    alertId: string | number,
    options: { includeExpired?: boolean; simulation?: SimulationFilter } = {},
) {
    const params = new URLSearchParams({ alert_id: String(alertId) });

    if (options.includeExpired) {
        params.set("include_expired", "true");
    }

    if (options.simulation && options.simulation !== "all") {
        params.set("simulation", options.simulation);
    }

    return `/decisions?${params.toString()}`;
}

function summarizeDeleteResult(result: BulkDeleteResult): string | null {
    if (result.failed.length === 0) {
        return null;
    }

    const deletedParts: string[] = [];
    if (result.deleted_alerts > 0) {
        deletedParts.push(`${result.deleted_alerts} alert${result.deleted_alerts === 1 ? "" : "s"}`);
    }
    if (result.deleted_decisions > 0) {
        deletedParts.push(`${result.deleted_decisions} decision${result.deleted_decisions === 1 ? "" : "s"}`);
    }

    const deletedText = deletedParts.length > 0 ? `Deleted ${deletedParts.join(" and ")}. ` : "";
    return `${deletedText}${result.failed.length} item${result.failed.length === 1 ? "" : "s"} failed to delete.`;
}

export function Alerts() {
    const { refreshSignal, setLastUpdated } = useRefresh();
    const [searchParams, setSearchParams] = useSearchParams();
    const initialQueryParam = searchParams.get("q") ?? "";
    const [alerts, setAlerts] = useState<AlertListItem[]>([]);
    const [simulationsEnabled, setSimulationsEnabled] = useState(false);
    const [machineFeaturesEnabled, setMachineFeaturesEnabled] = useState(false);
    const [originFeaturesEnabled, setOriginFeaturesEnabled] = useState(false);
    const [searchDraft, setSearchDraft] = useState(initialQueryParam);
    const [debouncedSearchDraft, setDebouncedSearchDraft] = useState(initialQueryParam);
    const [appliedQuery, setAppliedQuery] = useState(initialQueryParam.trim());
    const [queryError, setQueryError] = useState<SearchParseError | null>(null);
    const [showSearchSyntaxModal, setShowSearchSyntaxModal] = useState(false);
    const [initialLoading, setInitialLoading] = useState(true);
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
    const [showAllEvents, setShowAllEvents] = useState(false);
    const currentSimulationFilter = simulationsEnabled ? parseSimulationFilter(searchParams.get("simulation")) : 'all';
    const alertIdParam = searchParams.get("id");
    const queryParam = searchParams.get("q");

    // Ref to track selected alert ID for auto-refresh (avoids stale closure issues)
    const selectedAlertIdRef = useRef<string | number | null>(null);

    const PAGE_SIZE = 50;
    const hasMoreAlerts = currentPage < totalPages;
    const observer = useRef<IntersectionObserver | null>(null);
    const decisionContainerRef = useRef<HTMLDivElement | null>(null);
    const modalDecisionObserverRef = useRef<IntersectionObserver | null>(null);
    const selectAllAlertsRef = useRef<HTMLInputElement | null>(null);
    const previousSelectedAlertIdRef = useRef<string | null>(null);
    const modalSelectedAlertIdRef = useRef<string | null>(null);
    const currentPageRef = useRef(1);
    const inFlightLoadKeysRef = useRef(new Set<string>());
    const lastCompletedLoadRef = useRef<{ key: string; completedAt: number } | null>(null);
    const modalDecisionsLoadRef = useRef<{ alertId: string | null; page: number | null }>({ alertId: null, page: null });
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
        machineFeaturesEnabled: boolean;
        originFeaturesEnabled: boolean;
    } | null>(null);
    const hasLoadedAlertsRef = useRef(false);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const searchDraftRef = useRef(searchDraft);
    const searchSelectionRef = useRef({ start: 0, end: 0 });
    const pendingSearchFocusRef = useRef<number | null>(null);
    const skipSearchParamSyncRef = useRef<string | null>(null);
    const searchDebounceTimeoutRef = useRef<number | null>(null);
    const searchValidationFeatures = useMemo(() => (
        configRef.current
            ? { machineEnabled: machineFeaturesEnabled, originEnabled: originFeaturesEnabled }
            : { machineEnabled: true, originEnabled: true }
    ), [machineFeaturesEnabled, originFeaturesEnabled]);
    const searchHelp = useMemo(
        () => getSearchHelpDefinition('alerts', searchValidationFeatures, { alerts }),
        [alerts, searchValidationFeatures],
    );
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
        if (appliedQuery) filters.q = appliedQuery;
        if (simulationFilter !== 'all') {
            filters.simulation = simulationFilter;
        }
        return filters;
    }, [appliedQuery, currentSimulationFilter]);

    const loadConfig = useCallback(async (refresh = false) => {
        if (!refresh && configRef.current) {
            return configRef.current;
        }

        const configData = await fetchConfig();
        const nextConfig = {
            simulationsEnabled: configData.simulations_enabled === true,
            machineFeaturesEnabled: configData.machine_features_enabled === true,
            originFeaturesEnabled: configData.origin_features_enabled === true,
        };

        configRef.current = nextConfig;
        setSimulationsEnabled(nextConfig.simulationsEnabled);
        setMachineFeaturesEnabled(nextConfig.machineFeaturesEnabled);
        setOriginFeaturesEnabled(nextConfig.originFeaturesEnabled);

        return nextConfig;
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
            const alertsResult = await fetchAlertsPaginated(page, PAGE_SIZE, filters);
            let alertsData = alertsResult.data;
            let nextPage = alertsResult.pagination.page;

            if (!append && preserveLoadedPages) {
                const loadedPageCount = Math.max(1, currentPageRef.current);
                const maxPageToRefresh = Math.max(1, Math.min(loadedPageCount, alertsResult.pagination.total_pages || 1));
                if (maxPageToRefresh > 1) {
                    const remainingPages = await Promise.all(
                        Array.from({ length: maxPageToRefresh - 1 }, (_, index) =>
                            fetchAlertsPaginated(index + 2, PAGE_SIZE, filters),
                        ),
                    );
                    alertsData = [alertsResult, ...remainingPages].flatMap((result) => result.data);
                }
                nextPage = maxPageToRefresh;
            }

            setAlerts((current) => append ? [...current, ...alertsData] : alertsData);
            currentPageRef.current = append ? alertsResult.pagination.page : nextPage;
            setCurrentPage(currentPageRef.current);
            setTotalPages(alertsResult.pagination.total_pages);
            setTotalAlerts(alertsResult.pagination.total);
            setTotalUnfilteredAlerts(alertsResult.pagination.unfiltered_total);
            setSelectableAlertIds(alertsResult.selectable_ids.map(String));
            hasLoadedAlertsRef.current = true;

            // Check if there's an alert ID in the URL
            if (alertIdParam) {
                // Always fetch full alert data since list now returns slim payloads
                try {
                    const alertData = await fetchAlert(alertIdParam);
                    setSelectedAlert(alertData);
                    setModalDecisionsRefreshToken((current) => current + 1);
                } catch (err) {
                    console.error("Alert not found", err);
                    // Fallback to slim data from list if fetch fails
                    const existingAlert = alertsData.find((alert) => String(alert.id) === alertIdParam);
                    if (existingAlert) {
                        setSelectedAlert(existingAlert);
                    }
                }
            } else {
                // If a modal is open but no ID param (e.g. clicked row), refresh with full data
                // Use the ref to get current selected alert ID (avoids stale closure)
                if (selectedAlertIdRef.current) {
                    try {
                        const fullAlert = await fetchAlert(selectedAlertIdRef.current);
                        setSelectedAlert(fullAlert);
                        setModalDecisionsRefreshToken((current) => current + 1);
                    } catch (err) {
                        console.error("Failed to refresh alert details", err);
                        // Keep showing current data on error
                    }
                }
            }

            setLastUpdated(new Date());
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
    }, [alertIdParam, appliedQuery, buildServerFilters, loadConfig, searchParams, setLastUpdated]);

    useEffect(() => {
        loadAlertsRef.current = loadAlerts;
    }, [loadAlerts]);

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
        void loadAlerts({ refreshConfig: true });
    }, [loadAlerts]);


    useEffect(() => {
        if (refreshSignal <= lastRefreshSignalRef.current) {
            return;
        }

        lastRefreshSignalRef.current = refreshSignal;
        void loadAlertsRef.current({ isBackground: true, page: 1, preserveLoadedPages: true, refreshConfig: true });
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
        const compiledSearch = compileAlertSearch(debouncedSearchDraft, searchValidationFeatures);
        if (!compiledSearch.ok) {
            setQueryError((current) => (
                current?.message === compiledSearch.error.message &&
                current.position === compiledSearch.error.position &&
                current.length === compiledSearch.error.length
                    ? current
                    : compiledSearch.error
            ));
            return;
        }

        const nextQuery = debouncedSearchDraft.trim();
        setQueryError(null);
        setAppliedQuery((current) => current === nextQuery ? current : nextQuery);

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
    }, [debouncedSearchDraft, queryParam, searchParams, searchValidationFeatures, setSearchParams]);

    // Keep ref in sync with selectedAlert for auto-refresh
    useEffect(() => {
        const nextSelectedAlertId = selectedAlert ? String(selectedAlert.id) : null;
        selectedAlertIdRef.current = selectedAlert?.id || null;
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
            const result = await fetchDecisionsPaginated(page, PAGE_SIZE, {
                alert_id: alertId,
                include_expired: "true",
                tz_offset: String(new Date().getTimezoneOffset()),
            });

            let decisionsData = result.data;
            let nextPage = result.pagination.page;

            if (!append && preserveLoadedPages) {
                const loadedPageCount = Math.max(1, modalDecisionsPage);
                const maxPageToRefresh = Math.max(1, Math.min(loadedPageCount, result.pagination.total_pages || 1));
                if (maxPageToRefresh > 1) {
                    const remainingPages = await Promise.all(
                        Array.from({ length: maxPageToRefresh - 1 }, (_, index) => (
                            fetchDecisionsPaginated(index + 2, PAGE_SIZE, {
                                alert_id: alertId,
                                include_expired: "true",
                                tz_offset: String(new Date().getTimezoneOffset()),
                            })
                        )),
                    );
                    decisionsData = [result, ...remainingPages].flatMap((pageResult) => pageResult.data);
                }
                nextPage = maxPageToRefresh;
            }

            setModalDecisions((current) => append ? [...current, ...result.data] : decisionsData);
            setModalDecisionsPage(nextPage);
            setModalDecisionsTotalPages(result.pagination.total_pages);
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
    }, [modalDecisionsPage]);

    useEffect(() => {
        if (!selectedAlertId) {
            modalDecisionsLoadRef.current = { alertId: null, page: null };
            setModalDecisions([]);
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

        try {
            const fullAlert = await fetchAlert(alert.id);
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
        setAppliedQuery(query.trim());
        setQueryError(null);
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
        setQueryError(null);
        pendingSearchFocusRef.current = nextCaretPosition;
        setShowSearchSyntaxModal(false);
    }, [cancelSearchDebounce, getSearchInsertionRange]);

    const clearAllFilters = useCallback(() => {
        cancelSearchDebounce();
        searchDraftRef.current = "";
        setSearchDraft("");
        setDebouncedSearchDraft("");
        setAppliedQuery("");
        setQueryError(null);
        pendingSearchFocusRef.current = null;
        searchSelectionRef.current = { start: 0, end: 0 };
        skipSearchParamSyncRef.current = "";
        setSearchParams({});
    }, [cancelSearchDebounce, setSearchParams]);

    // Delete handlers
    const requestDelete = (id: string | number, event: ReactMouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        setPendingDeleteAction({ kind: "single", alertId: id });
    };

    const confirmDelete = async () => {
        if (!pendingDeleteAction) return;
        setDeleteInProgress(true);
        setErrorInfo(null);
        try {
            let resultMessage: string | null = null;

            if (pendingDeleteAction.kind === "single") {
                await deleteAlert(pendingDeleteAction.alertId);
                if (selectedAlert && selectedAlert.id === pendingDeleteAction.alertId) {
                    setSelectedAlert(null);
                }
                setSelectedAlertIds((prev) => prev.filter((id) => id !== String(pendingDeleteAction.alertId)));
            } else if (pendingDeleteAction.kind === "selected") {
                const result = await bulkDeleteAlerts(pendingDeleteAction.ids);
                resultMessage = summarizeDeleteResult(result);
                if (selectedAlert && pendingDeleteAction.ids.includes(String(selectedAlert.id))) {
                    setSelectedAlert(null);
                }
                setSelectedAlertIds([]);
            } else {
                const result = await cleanupByIp(pendingDeleteAction.ip);
                resultMessage = summarizeDeleteResult(result);
                if (selectedAlert && getAlertSourceValue(selectedAlert.source) === pendingDeleteAction.ip) {
                    setSelectedAlert(null);
                }
                setSelectedAlertIds([]);
                if (result.deleted_alerts === 0 && result.deleted_decisions === 0 && result.failed.length === 0) {
                    resultMessage = `No alerts or decisions found for ${pendingDeleteAction.ip}.`;
                }
            }

            setPendingDeleteAction(null);
            await loadAlerts({ page: 1, refreshConfig: true });
            if (resultMessage) {
                setErrorInfo({ message: resultMessage });
            }
        } catch (error) {
            const fallbackMessage = pendingDeleteAction.kind === "single"
                ? "Failed to delete alert. Please try again."
                : pendingDeleteAction.kind === "selected"
                    ? "Failed to delete selected alerts. Please try again."
                    : "Failed to delete alerts and decisions for this IP. Please try again.";
            console.error("Failed to delete alert entries", error);
            setErrorInfo(toErrorInfo(error, fallbackMessage));
        } finally {
            setDeleteInProgress(false);
        }
    };

    const toggleAlertSelection = (alertId: string) => {
        setSelectedAlertIds((prev) => (
            prev.includes(alertId)
                ? prev.filter((id) => id !== alertId)
                : [...prev, alertId]
        ));
    };

    const filteredAlerts = alerts;
    const filteredAlertIdsKey = selectableAlertIds.join("|");
    const selectedFilteredAlertIds = selectableAlertIds.filter((id) => selectedAlertIds.includes(id));
    const allFilteredAlertsSelected = selectableAlertIds.length > 0 && selectedFilteredAlertIds.length === selectableAlertIds.length;
    const someFilteredAlertsSelected = selectedFilteredAlertIds.length > 0 && !allFilteredAlertsSelected;

    useEffect(() => {
        const validIds = new Set(filteredAlertIdsKey ? filteredAlertIdsKey.split("|") : []);
        setSelectedAlertIds((prev) => prev.filter((id) => validIds.has(id)));
    }, [filteredAlertIdsKey]);

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
    const selectedAlertIsSimulated = selectedAlert ? isSimulatedAlert(selectedAlert) : false;
    const selectedAlertSourceValue = getAlertSourceValue(selectedAlert?.source);
    const deleteActionTitle = pendingDeleteAction?.kind === "single"
        ? "Delete Alert?"
        : pendingDeleteAction?.kind === "selected"
            ? "Delete Selected Alerts?"
            : pendingDeleteAction?.kind === "ip"
                ? "Delete All for this IP?"
                : "Delete";
    const selectedAlertCount = selectedFilteredAlertIds.length;
    const pendingSingleAlertId = pendingDeleteAction?.kind === "single" ? pendingDeleteAction.alertId : null;
    const pendingIp = pendingDeleteAction?.kind === "ip" ? pendingDeleteAction.ip : null;
    const summaryText = initialLoading && !hasLoadedAlertsRef.current
        ? "Loading alerts..."
        : totalAlerts !== totalUnfilteredAlerts
            ? `Showing ${visibleAlerts.length} of ${totalAlerts} alerts (${totalUnfilteredAlerts} total before filters)`
            : `Showing ${visibleAlerts.length} of ${totalAlerts} alerts`;
    const tableBusy = initialLoading || backgroundLoading || loadingMore;

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
                    Refreshing...
                </span>
            </div>

            <div className="flex items-center gap-3">
                <button
                    onClick={() => setPendingDeleteAction({ kind: "selected", ids: selectedFilteredAlertIds })}
                    disabled={selectedAlertCount === 0}
                    className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    Delete selected
                </button>
            </div>

            {/* Error Message */}
            {errorInfo && (
                <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
                        <AlertCircle size={16} className="flex-shrink-0" />
                        <span className="text-sm">
                            {errorInfo.message}
                            {errorInfo.helpLink && (
                                <>
                                    {' See README: '}
                                    <a
                                        href={errorInfo.helpLink}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="underline hover:text-red-900 dark:hover:text-red-100"
                                    >
                                        {errorInfo.helpText || 'Learn more'}
                                    </a>
                                </>
                            )}
                        </span>
                    </div>
                    <button
                        onClick={() => setErrorInfo(null)}
                        className="text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-200"
                    >
                        <X size={16} />
                    </button>
                </div>
            )}

            {/* Show active filters */}
            {(appliedQuery || (simulationsEnabled && searchParams.get("simulation"))) && (
                <div className="flex flex-wrap gap-2">
                    {appliedQuery && (
                        <Badge variant="secondary" className="flex items-center gap-1 max-w-full">
                            <span className="font-semibold">Search:</span>
                            <span className="font-mono text-xs truncate max-w-[320px]">{appliedQuery}</span>
                            <button
                                onClick={() => {
                                    const nextParams = new URLSearchParams(searchParams);
                                    nextParams.delete("q");
                                    cancelSearchDebounce();
                                    setSearchDraft("");
                                    setDebouncedSearchDraft("");
                                    setAppliedQuery("");
                                    setQueryError(null);
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
                            <span className="font-semibold">Simulation:</span> {searchParams.get("simulation")}
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
                        Reset all filters
                    </button>
                </div>
            )
            }

            <div className="space-y-2">
                <div className="flex items-stretch gap-2">
                    <div className="flex-1">
                        <HighlightedSearchInput
                            ref={searchInputRef}
                            searchPage="alerts"
                            searchFeatures={searchValidationFeatures}
                            placeholder="Filter alerts..."
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
                    </div>
                    <button
                        type="button"
                        onClick={() => setShowSearchSyntaxModal(true)}
                        className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700"
                        aria-label="Search syntax help"
                        title="Search syntax help"
                    >
                        <Info size={18} />
                    </button>
                </div>
                {queryError && (
                    <p id="alerts-search-error" className="text-xs text-red-600 dark:text-red-400">
                        Search syntax error at character {queryError.position + 1}: {queryError.message}
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
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                    <input
                                        ref={selectAllAlertsRef}
                                        type="checkbox"
                                        aria-label="Select all filtered alerts"
                                        checked={allFilteredAlertsSelected}
                                        disabled={selectableAlertIds.length === 0}
                                        onChange={toggleAllFilteredAlerts}
                                        className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                    />
                                </th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Time</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Scenario</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Country</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">AS</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">IP / Range</th>
                                {machineFeaturesEnabled && (
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Machine</th>
                                )}
                                {originFeaturesEnabled && (
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Origin</th>
                                )}
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Decisions</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {initialLoading && visibleAlerts.length === 0 ? (
                                <tr><td colSpan={8 + (machineFeaturesEnabled ? 1 : 0) + (originFeaturesEnabled ? 1 : 0)} className="px-6 py-4 text-center text-sm text-gray-500">Loading alerts...</td></tr>
                            ) : visibleAlerts.length === 0 ? (
                                <tr><td colSpan={8 + (machineFeaturesEnabled ? 1 : 0) + (originFeaturesEnabled ? 1 : 0)} className="px-6 py-4 text-center text-sm text-gray-500">No alerts found</td></tr>
                            ) : (
                                visibleAlerts.map((alert, index) => {
                                    const isLastElement = index === visibleAlerts.length - 1;
                                    const sourceValue = getAlertSourceValue(alert.source);
                                    const alertOrigins = collectDistinctOrigins(alert.decisions);
                                    const alertOriginDisplay = getOriginDisplayValue(alertOrigins);
                                    const alertOriginTitle = getOriginTitle(alertOrigins);
                                    const isSelected = selectedAlertIds.includes(String(alert.id));
                                    return (
                                        <tr
                                            key={alert.id}
                                            ref={isLastElement ? lastAlertElementRef : null}
                                            onClick={() => handleAlertClick(alert)}
                                            className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors cursor-pointer"
                                        >
                                            <td className="px-6 py-4 whitespace-nowrap text-sm" onClick={(e) => e.stopPropagation()}>
                                                <input
                                                    type="checkbox"
                                                    aria-label={`Select alert ${alert.id}`}
                                                    checked={isSelected}
                                                    onChange={() => toggleAlertSelection(String(alert.id))}
                                                    className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                                />
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                                                <TimeDisplay timestamp={alert.created_at} />
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 max-w-[200px]" title={alert.scenario}>
                                                <ScenarioName
                                                    name={alert.scenario}
                                                    reason={alert.reason}
                                                    showLink={true}
                                                    simulated={simulationsEnabled && isSimulatedAlert(alert)}
                                                />
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 align-middle">
                                                {alert.source?.cn && alert.source?.cn !== "Unknown" ? (
                                                    <div className="flex items-center gap-2" title={alert.source.cn}>
                                                        <span className={`fi fi-${alert.source.cn.toLowerCase()} flex-shrink-0`}></span>
                                                        <span className="truncate max-w-[150px]">{getCountryName(alert.source.cn)}</span>
                                                    </div>
                                                ) : (
                                                    "-"
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 max-w-[150px] truncate" title={alert.source?.as_name}>
                                                {alert.source?.as_name || "-"}
                                            </td>
                                            <td className="px-6 py-4 text-sm font-mono text-gray-900 dark:text-gray-100 max-w-[200px] truncate" title={sourceValue}>
                                                {sourceValue || "-"}
                                            </td>
                                            {machineFeaturesEnabled && (
                                                <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400 max-w-[120px] truncate" title={resolveMachineName(alert)}>
                                                    {resolveMachineName(alert) || "-"}
                                                </td>
                                            )}
                                            {originFeaturesEnabled && (
                                                <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400 max-w-[140px] truncate" title={alertOriginTitle}>
                                                    {alertOriginDisplay}
                                                </td>
                                            )}
                                            <td className="px-6 py-4 whitespace-nowrap text-sm" onClick={(e) => e.stopPropagation()}>
                                                {(() => {
                                                    const visibleDecisions = simulationsEnabled && currentSimulationFilter !== 'all'
                                                        ? alert.decisions.filter((decision) => matchesSimulationFilter(
                                                            { simulated: isSimulatedDecision(decision) },
                                                            currentSimulationFilter,
                                                        ))
                                                        : alert.decisions;
                                                    const activeDecisions = visibleDecisions.filter((decision) => decision.expired !== true);
                                                    const expiredDecisions = visibleDecisions.filter((decision) => decision.expired === true);
                                                    const decisionFilter = simulationsEnabled && currentSimulationFilter !== 'all'
                                                        ? currentSimulationFilter
                                                        : undefined;

                                                    if (activeDecisions.length > 0 || expiredDecisions.length > 0) {
                                                        return (
                                                            <div className="flex flex-wrap gap-2">
                                                                {activeDecisions.length > 0 && (
                                                                    <Link
                                                                        to={buildDecisionListHref(alert.id, { simulation: decisionFilter })}
                                                                        className="inline-flex items-center gap-2 px-2 py-1 rounded-full bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300 hover:bg-primary-100 dark:hover:bg-primary-900/30 transition-colors border border-primary-200 dark:border-primary-800"
                                                                        title={`View ${activeDecisions.length} active decisions`}
                                                                    >
                                                                        <Shield size={14} className="fill-current" />
                                                                        <span className="text-xs font-semibold">Active: {activeDecisions.length}</span>
                                                                        <ExternalLink size={12} className="ml-0.5" />
                                                                    </Link>
                                                                )}
                                                                {expiredDecisions.length > 0 && (
                                                                    <Link
                                                                        to={buildDecisionListHref(alert.id, { includeExpired: true, simulation: decisionFilter })}
                                                                        className="inline-flex items-center gap-2 px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                                                                        title={`View ${expiredDecisions.length} expired decisions`}
                                                                    >
                                                                        <Shield size={14} className="opacity-50" />
                                                                        <span className="text-xs font-medium">Inactive: {expiredDecisions.length}</span>
                                                                    </Link>
                                                                )}
                                                            </div>
                                                        );
                                                    }

                                                    return <span className="text-gray-400">-</span>;
                                                })()}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                                <div className="flex items-center justify-end gap-2">
                                                    {sourceValue && (
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setPendingDeleteAction({ kind: "ip", ip: sourceValue });
                                                            }}
                                                            className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors p-2 rounded-full relative z-10 cursor-pointer"
                                                            title={`Delete all alerts and decisions for ${sourceValue}`}
                                                            aria-label={`Delete all alerts and decisions for ${sourceValue}`}
                                                        >
                                                            <ShieldBan size={16} aria-hidden="true" />
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={(e) => requestDelete(alert.id, e)}
                                                        className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors p-2 rounded-full relative z-10 cursor-pointer"
                                                        title="Delete Alert"
                                                    >
                                                        <Trash2 size={16} />
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })
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
                title={selectedAlert ? `Alert Details #${selectedAlert.id}` : "Alert Details"}
                maxWidth="max-w-6xl"
            >
                {selectedAlert && (
                    <div className="space-y-6">
                        <p className="text-sm text-gray-500 dark:text-gray-400 -mt-2 mb-4">
                            Captured at {new Date(selectedAlert.created_at).toLocaleString()}
                        </p>

                        {/* Summary Cards */}
                        <div className={`grid grid-cols-1 ${machineFeaturesEnabled ? 'md:grid-cols-4' : 'md:grid-cols-3'} gap-4`}>
                            {machineFeaturesEnabled && (
                                <div className="p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-100 dark:border-gray-700/50">
                                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Machine</h4>
                                    <div className="text-lg text-gray-900 dark:text-gray-100 font-medium">
                                        {resolveMachineName(selectedAlert) || "-"}
                                    </div>
                                </div>
                            )}
                            <div className="p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-100 dark:border-gray-700/50">
                                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Scenario</h4>
                                <div className="font-medium text-gray-900 dark:text-gray-100 break-words">
                                    <ScenarioName
                                        name={selectedAlert.scenario}
                                        reason={selectedAlert.reason}
                                        showLink={true}
                                        showReason={true}
                                        simulated={simulationsEnabled && selectedAlertIsSimulated}
                                    />
                                </div>
                            </div>
                            <div className="p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-100 dark:border-gray-700/50">
                                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Location</h4>
                                <div className="text-lg text-gray-900 dark:text-gray-100 font-medium flex items-center gap-2">
                                    {selectedAlert.source?.cn && (
                                        <span className={`fi fi-${selectedAlert.source.cn.toLowerCase()} flex-shrink-0`} title={selectedAlert.source.cn}></span>
                                    )}
                                    {getCountryName(selectedAlert.source?.cn) || "-"}
                                </div>
                                {selectedAlert.source?.latitude && selectedAlert.source?.longitude && (
                                    <div className="text-xs text-gray-400 font-mono mt-1">
                                        <a
                                            href={`https://www.google.com/maps?q=${encodeURIComponent(String(selectedAlert.source.latitude))},${encodeURIComponent(String(selectedAlert.source.longitude))}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="hover:text-primary-600 dark:hover:text-primary-400 transition-colors inline-flex items-center gap-1"
                                            title="View on Google Maps"
                                        >
                                            Lat: {selectedAlert.source.latitude}, Long: {selectedAlert.source.longitude}
                                            <ExternalLink size={10} />
                                        </a>
                                    </div>
                                )}
                            </div>
                            <div className="p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-100 dark:border-gray-700/50">
                                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">IP / Range</h4>
                                <div className="flex items-center gap-2">
                                    {selectedAlertSourceValue ? (
                                        <a
                                            href={`https://app.crowdsec.net/cti/${encodeURIComponent(String(selectedAlertSourceValue))}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="font-mono text-lg font-bold text-gray-900 dark:text-white hover:text-primary-600 dark:hover:text-primary-400 transition-colors inline-flex items-center gap-1"
                                            title="View on CrowdSec CTI"
                                        >
                                            {selectedAlertSourceValue}
                                            <ExternalLink size={14} />
                                        </a>
                                    ) : (
                                        <span className="font-mono text-lg font-bold text-gray-900 dark:text-white">-</span>
                                    )}
                                </div>
                                {selectedAlert.source?.range && selectedAlert.source.range !== selectedAlertSourceValue && (
                                    <div className="text-xs text-gray-400 font-mono mt-1">
                                        Range: {selectedAlert.source.range}
                                    </div>
                                )}
                                <div className="text-sm text-gray-500 mt-1">
                                    {selectedAlert.source?.as_number && (
                                        <a
                                            href={`https://bgp.he.net/AS${encodeURIComponent(selectedAlert.source.as_number)}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="hover:text-primary-600 dark:hover:text-primary-400 transition-colors inline-flex items-center gap-1"
                                            title="View AS info on Hurricane Electric"
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
                        {selectedAlert.message && (
                            <div className="p-4 bg-blue-50 dark:bg-blue-900/10 rounded-lg border border-blue-100 dark:border-blue-900/30">
                                <div className="flex items-start gap-2">
                                    <Info size={18} className="text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
                                    <div className="text-sm text-gray-900 dark:text-gray-100">
                                        {selectedAlert.message}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Decisions */}
                        {(modalDecisionsLoading || modalDecisionsTotal > 0) && (
                            <div>
                                <div className="flex items-center justify-between gap-3 mb-3">
                                    <h4 className="text-lg font-semibold text-gray-900 dark:text-white">Decisions Taken</h4>
                                    {(modalDecisionsLoading || modalDecisions.length < modalDecisionsTotal) && (
                                        <span className="text-xs text-gray-500 dark:text-gray-400">
                                            Showing {modalDecisions.length} of {modalDecisionsTotal}
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
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">ID</th>
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Value</th>
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Expiration</th>
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Origin</th>
                                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">View</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-800">
                                            {modalDecisionsLoading && modalDecisions.length === 0 ? (
                                                <tr>
                                                    <td colSpan={6} className="px-4 py-4 text-sm text-center text-gray-500">
                                                        Loading decisions...
                                                    </td>
                                                </tr>
                                            ) : modalDecisions.map((decision, idx) => {
                                                // Check if this specific decision is active or expired
                                                const isActive = (() => {
                                                    if (decision.expired !== undefined) {
                                                        return !decision.expired;
                                                    }

                                                    if (decision.detail.expiration) {
                                                        return new Date(decision.detail.expiration) > new Date();
                                                    }
                                                    // If stop_at is missing, check if duration implies expiration
                                                    if (decision.detail.duration && decision.detail.duration.startsWith('-')) {
                                                        return false;
                                                    }
                                                    return true; // Assume active if no stop_at and not definitely expired
                                                })();
                                                return (
                                                    <tr
                                                        key={`${decision.id}-${decision.detail.duration ?? idx}`}
                                                        ref={idx === modalDecisions.length - 1 ? lastModalDecisionElementRef : null}
                                                    >
                                                        <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400">#{decision.id}</td>
                                                        <td className="px-4 py-2 text-sm"><Badge variant="danger">{decision.detail.type || decision.detail.action || "ban"}</Badge></td>
                                                        <td className="px-4 py-2 text-sm font-mono">{decision.value}</td>
                                                        <td className="px-4 py-2 text-sm">
                                                            {(decision.detail.duration || "").startsWith('-') ? "0s" : decision.detail.duration}
                                                            {!isActive && <span className="ml-2 text-xs text-red-500 dark:text-red-400">(Expired)</span>}
                                                        </td>
                                                        <td className="px-4 py-2 text-sm">{decision.detail.origin || "-"}</td>
                                                        <td className="px-4 py-2 text-sm">
                                                            {isActive ? (
                                                                <Link
                                                                    to={buildDecisionListHref(selectedAlert.id, {
                                                                        simulation: simulationsEnabled
                                                                            ? (isSimulatedDecision(decision) ? 'simulated' : 'live')
                                                                            : undefined,
                                                                    })}
                                                                    className="inline-flex items-center gap-2 px-2 py-1 rounded-full bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300 hover:bg-primary-100 dark:hover:bg-primary-900/30 transition-colors border border-primary-200 dark:border-primary-800"
                                                                    title="View active decision"
                                                                >
                                                                    <Shield size={14} className="fill-current" />
                                                                    <span className="text-xs font-semibold">Active</span>
                                                                    <ExternalLink size={12} className="ml-0.5" />
                                                                </Link>
                                                            ) : (
                                                                <Link
                                                                    to={buildDecisionListHref(selectedAlert.id, {
                                                                        includeExpired: true,
                                                                        simulation: simulationsEnabled
                                                                            ? (isSimulatedDecision(decision) ? 'simulated' : 'live')
                                                                            : undefined,
                                                                    })}
                                                                    className="inline-flex items-center gap-2 px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                                                                    title="View expired decision"
                                                                >
                                                                    <Shield size={14} className="opacity-50" />
                                                                    <span className="text-xs font-medium">Inactive</span>
                                                                </Link>
                                                            )}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                            {modalDecisionsLoadingMore && (
                                                <tr>
                                                    <td colSpan={6} className="px-4 py-4 text-sm text-center text-gray-500">
                                                        Loading more decisions...
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        {/* Events Breakdown */}
                        <div>
                            <h4 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
                                Events ({selectedAlertEvents.length})
                            </h4>
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
                                    Show all {selectedAlertEvents.length} events ({selectedAlertEvents.length - 10} more)
                                </button>
                            )}
                        </div>

                    </div>
                )}
            </Modal>

            {/* Delete Confirmation Modal */}
            <Modal
                isOpen={!!pendingDeleteAction}
                onClose={() => !deleteInProgress && setPendingDeleteAction(null)}
                title={deleteActionTitle}
                maxWidth="max-w-sm"
                showCloseButton={false}
            >
                <p className="text-gray-600 dark:text-gray-300 mb-6">
                    {pendingSingleAlertId ? (
                        <>
                            Are you sure you want to delete alert <span className="font-mono text-sm font-bold">#{pendingSingleAlertId}</span>? This will also delete all associated decisions. This action cannot be undone.
                        </>
                    ) : pendingIp ? (
                        <>
                            Are you sure you want to delete all alerts and decisions for <span className="font-mono text-sm font-bold">{pendingIp}</span>? This action cannot be undone.
                        </>
                    ) : (
                        <>Are you sure you want to delete {selectedFilteredAlertIds.length} selected alert{selectedFilteredAlertIds.length === 1 ? "" : "s"}? This will also remove associated decisions from the cache.</>
                    )}
                </p>
                <div className="flex justify-end gap-3">
                    <button
                        onClick={() => setPendingDeleteAction(null)}
                        disabled={deleteInProgress}
                        className="px-4 py-2 text-sm font-medium text-gray-700 bg-white dark:bg-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={confirmDelete}
                        disabled={deleteInProgress}
                        className="px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {deleteInProgress ? "Deleting..." : "Delete"}
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
        </div >
    );
}
