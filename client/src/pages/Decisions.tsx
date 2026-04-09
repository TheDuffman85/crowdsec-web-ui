import { useEffect, useState, useRef, useCallback, useMemo, type FormEvent } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { deleteDecision, bulkDeleteDecisions, cleanupByIp, addDecision, fetchConfig, fetchDecisionsPaginated } from "../lib/api";
import { isSimulatedDecision, parseSimulationFilter } from "../lib/simulation";
import { useRefresh } from "../contexts/useRefresh";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { SearchSyntaxModal } from "../components/SearchSyntaxModal";
import { ScenarioName } from "../components/ScenarioName";
import { TimeDisplay } from "../components/TimeDisplay";
import { getCountryName } from "../lib/utils";
import { compileDecisionSearch, getSearchHelpDefinition, type SearchParseError } from "../../../shared/search";
import { Trash2, Gavel, X, ExternalLink, Shield, ShieldBan, Search, AlertCircle, Info } from "lucide-react";
import type { AddDecisionRequest, ApiPermissionError, BulkDeleteResult, DecisionListItem } from '../types';

type DecisionDeleteAction =
    | { kind: "single"; decisionId: string | number }
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

function isDecisionExpired(decision: DecisionListItem): boolean {
    const decisionDuration = decision.detail.duration ?? '';
    return Boolean(decision.expired || decisionDuration.startsWith("-"));
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

export function Decisions() {
    const { refreshSignal, setLastUpdated } = useRefresh();
    const [decisions, setDecisions] = useState<DecisionListItem[]>([]);
    const [simulationsEnabled, setSimulationsEnabled] = useState(false);
    const [machineFeaturesEnabled, setMachineFeaturesEnabled] = useState(false);
    const [originFeaturesEnabled, setOriginFeaturesEnabled] = useState(false);
    const [searchDraft, setSearchDraft] = useState("");
    const [debouncedSearchDraft, setDebouncedSearchDraft] = useState("");
    const [appliedQuery, setAppliedQuery] = useState("");
    const [queryError, setQueryError] = useState<SearchParseError | null>(null);
    const [showSearchSyntaxModal, setShowSearchSyntaxModal] = useState(false);
    const [initialLoading, setInitialLoading] = useState(true);
    const [backgroundLoading, setBackgroundLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [showAddModal, setShowAddModal] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [totalDecisions, setTotalDecisions] = useState(0);
    const [totalUnfilteredDecisions, setTotalUnfilteredDecisions] = useState(0);
    const [selectableDecisionIds, setSelectableDecisionIds] = useState<string[]>([]);
    const [pendingDeleteAction, setPendingDeleteAction] = useState<DecisionDeleteAction | null>(null);
    const [selectedDecisionIds, setSelectedDecisionIds] = useState<string[]>([]);
    const [deleteInProgress, setDeleteInProgress] = useState(false);
    const [newDecision, setNewDecision] = useState<AddDecisionRequest>({ ip: "", duration: "4h", reason: "manual" });
    const [errorInfo, setErrorInfo] = useState<ErrorInfo | null>(null);
    const [searchParams, setSearchParams] = useSearchParams();
    const alertIdFilter = searchParams.get("alert_id");
    const includeExpiredParam = searchParams.get("include_expired") === "true";

    // New Filters from URL
    const countryFilter = searchParams.get("country");
    const scenarioFilter = searchParams.get("scenario");
    const asFilter = searchParams.get("as");
    const ipFilter = searchParams.get("ip");
    const targetFilter = searchParams.get("target");
    const dateStartFilter = searchParams.get("dateStart");
    const dateEndFilter = searchParams.get("dateEnd");
    const simulationFilter = simulationsEnabled ? parseSimulationFilter(searchParams.get("simulation")) : 'all';
    // Default: hide duplicates unless explicitly set to false OR viewing a specific alert's decisions
    const showDuplicates = searchParams.get("hide_duplicates") === "false" || !!alertIdFilter;

    const PAGE_SIZE = 50;
    const hasMoreDecisions = currentPage < totalPages;
    // Intersection Observer for infinite scroll
    const observer = useRef<IntersectionObserver | null>(null);
    const selectAllDecisionsRef = useRef<HTMLInputElement | null>(null);
    const currentPageRef = useRef(1);
    const inFlightLoadKeysRef = useRef(new Set<string>());
    const lastCompletedLoadRef = useRef<{ key: string; completedAt: number } | null>(null);
    const loadDecisionsRef = useRef<(options?: {
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
    const hasLoadedDecisionsRef = useRef(false);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const searchValidationFeatures = useMemo(() => (
        configRef.current
            ? { machineEnabled: machineFeaturesEnabled, originEnabled: originFeaturesEnabled }
            : { machineEnabled: true, originEnabled: true }
    ), [machineFeaturesEnabled, originFeaturesEnabled]);
    const searchHelp = useMemo(
        () => getSearchHelpDefinition('decisions', searchValidationFeatures),
        [searchValidationFeatures],
    );

    const buildServerFilters = useCallback((requestedSimulationFilter = simulationFilter): Record<string, string> => {
        const filters: Record<string, string> = {
            tz_offset: String(new Date().getTimezoneOffset()),
        };
        if (appliedQuery) filters.q = appliedQuery;
        if (alertIdFilter) filters.alert_id = alertIdFilter;
        if (includeExpiredParam) filters.include_expired = 'true';
        if (countryFilter) filters.country = countryFilter;
        if (scenarioFilter) filters.scenario = scenarioFilter;
        if (asFilter) filters.as = asFilter;
        if (ipFilter) filters.ip = ipFilter;
        if (targetFilter) filters.target = targetFilter;
        if (dateStartFilter) filters.dateStart = dateStartFilter;
        if (dateEndFilter) filters.dateEnd = dateEndFilter;
        if (requestedSimulationFilter !== 'all') filters.simulation = requestedSimulationFilter;
        if (showDuplicates) filters.hide_duplicates = 'false';
        return filters;
    }, [alertIdFilter, appliedQuery, asFilter, countryFilter, dateEndFilter, dateStartFilter, includeExpiredParam, ipFilter, scenarioFilter, showDuplicates, simulationFilter, targetFilter]);

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

    const loadDecisions = useCallback(async ({
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
        const shouldBlockWithInitialLoading = !append && !isBackground && !hasLoadedDecisionsRef.current;
        if (append) {
            setLoadingMore(true);
        } else if (shouldBlockWithInitialLoading) {
            setInitialLoading(true);
        } else {
            setBackgroundLoading(true);
        }
        try {
            const configData = await loadConfig(refreshConfig || !configRef.current);
            const requestedSimulationFilter = configData.simulationsEnabled === true
                ? parseSimulationFilter(searchParams.get("simulation"))
                : 'all';
            const filters = buildServerFilters(requestedSimulationFilter);
            const decisionsResult = await fetchDecisionsPaginated(page, PAGE_SIZE, filters);
            let decisionsData = decisionsResult.data;
            let nextPage = decisionsResult.pagination.page;

            if (!append && preserveLoadedPages) {
                const loadedPageCount = Math.max(1, currentPageRef.current);
                const maxPageToRefresh = Math.max(1, Math.min(loadedPageCount, decisionsResult.pagination.total_pages || 1));
                if (maxPageToRefresh > 1) {
                    const remainingPages = await Promise.all(
                        Array.from({ length: maxPageToRefresh - 1 }, (_, index) =>
                            fetchDecisionsPaginated(index + 2, PAGE_SIZE, filters),
                        ),
                    );
                    decisionsData = [decisionsResult, ...remainingPages].flatMap((result) => result.data);
                }
                nextPage = maxPageToRefresh;
            }

            setDecisions((current) => append ? [...current, ...decisionsData] : decisionsData);
            currentPageRef.current = append ? decisionsResult.pagination.page : nextPage;
            setCurrentPage(currentPageRef.current);
            setTotalPages(decisionsResult.pagination.total_pages);
            setTotalDecisions(decisionsResult.pagination.total);
            setTotalUnfilteredDecisions(decisionsResult.pagination.unfiltered_total);
            setSelectableDecisionIds(decisionsResult.selectable_ids.map(String));
            hasLoadedDecisionsRef.current = true;

            setLastUpdated(new Date());
            completedSuccessfully = true;
        } catch (error) {
            console.error(error);
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
    }, [appliedQuery, buildServerFilters, loadConfig, searchParams, setLastUpdated]);

    useEffect(() => {
        loadDecisionsRef.current = loadDecisions;
    }, [loadDecisions]);

    const lastDecisionElementRef = useCallback((node: HTMLTableRowElement | null) => {
        if (initialLoading || backgroundLoading || loadingMore || !hasMoreDecisions) return;
        if (observer.current) observer.current.disconnect();
        observer.current = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                void loadDecisions({ isBackground: true, page: currentPage + 1, append: true });
            }
        });
        if (node) observer.current.observe(node);
    }, [backgroundLoading, currentPage, hasMoreDecisions, initialLoading, loadDecisions, loadingMore]);

    // Sync "q" param to filter state
    useEffect(() => {
        const queryParam = searchParams.get("q");
        const nextQuery = queryParam ?? "";
        setSearchDraft((current) => current === nextQuery ? current : nextQuery);
        setDebouncedSearchDraft((current) => current === nextQuery ? current : nextQuery);
    }, [searchParams]);

    useEffect(() => {
        void loadDecisions({ refreshConfig: true });
    }, [loadDecisions]);

    useEffect(() => {
        if (refreshSignal <= lastRefreshSignalRef.current) {
            return;
        }

        lastRefreshSignalRef.current = refreshSignal;
        void loadDecisionsRef.current({ isBackground: true, page: 1, preserveLoadedPages: true, refreshConfig: true });
    }, [refreshSignal]);

    useEffect(() => {
        if (searchDraft === debouncedSearchDraft) {
            return;
        }

        const timeoutId = window.setTimeout(() => {
            setDebouncedSearchDraft(searchDraft);
        }, 300);

        return () => window.clearTimeout(timeoutId);
    }, [debouncedSearchDraft, searchDraft]);

    useEffect(() => {
        const compiledSearch = compileDecisionSearch(debouncedSearchDraft, searchValidationFeatures);
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
        const currentQuery = searchParams.get("q") ?? "";
        setQueryError(null);
        setAppliedQuery((current) => current === nextQuery ? current : nextQuery);

        if (currentQuery === nextQuery) {
            return;
        }

        const nextParams = new URLSearchParams(searchParams);
        if (nextQuery) {
            nextParams.set("q", nextQuery);
        } else {
            nextParams.delete("q");
        }
        if (nextParams.toString() !== searchParams.toString()) {
            setSearchParams(nextParams);
        }
    }, [debouncedSearchDraft, searchParams, searchValidationFeatures, setSearchParams]);

    const handleAddDecision = async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const decisionData = { ...newDecision };
        setShowAddModal(false);
        setNewDecision({ ip: "", duration: "4h", reason: "manual" });
        setErrorInfo(null);
        try {
            await addDecision(decisionData);
            await loadDecisions({ page: 1, refreshConfig: true });
        } catch (error) {
            console.error("Failed to add decision", error);
            setErrorInfo(toErrorInfo(error, "Failed to add decision. Please try again."));
        }
    };


    // Trigger modal instead of window.confirm
    const requestDelete = (id: string | number) => {
        setPendingDeleteAction({ kind: "single", decisionId: id });
    };

    const confirmDelete = async () => {
        if (!pendingDeleteAction) return;
        setDeleteInProgress(true);
        setErrorInfo(null);
        try {
            let resultMessage: string | null = null;

            if (pendingDeleteAction.kind === "single") {
                await deleteDecision(pendingDeleteAction.decisionId);
                setSelectedDecisionIds((prev) => prev.filter((id) => id !== String(pendingDeleteAction.decisionId)));
            } else if (pendingDeleteAction.kind === "selected") {
                const result = await bulkDeleteDecisions(pendingDeleteAction.ids);
                resultMessage = summarizeDeleteResult(result);
                setSelectedDecisionIds([]);
            } else {
                const result = await cleanupByIp(pendingDeleteAction.ip);
                resultMessage = summarizeDeleteResult(result);
                setSelectedDecisionIds([]);
                if (result.deleted_alerts === 0 && result.deleted_decisions === 0 && result.failed.length === 0) {
                    resultMessage = `No alerts or decisions found for ${pendingDeleteAction.ip}.`;
                }
            }

            setPendingDeleteAction(null);
            await loadDecisions({ page: 1, refreshConfig: true });
            if (resultMessage) {
                setErrorInfo({ message: resultMessage });
            }
        } catch (error) {
            const fallbackMessage = pendingDeleteAction.kind === "single"
                ? "Failed to delete decision. Please try again."
                : pendingDeleteAction.kind === "selected"
                    ? "Failed to delete selected decisions. Please try again."
                    : "Failed to delete alerts and decisions for this IP. Please try again.";
            console.error("Failed to delete decision entries", error);
            setErrorInfo(toErrorInfo(error, fallbackMessage));
        } finally {
            setDeleteInProgress(false);
        }
    };

    const toggleDecisionSelection = (decisionId: string) => {
        setSelectedDecisionIds((prev) => (
            prev.includes(decisionId)
                ? prev.filter((id) => id !== decisionId)
                : [...prev, decisionId]
        ));
    };

    const applySearchExample = useCallback((query: string) => {
        setSearchDraft(query);
        setDebouncedSearchDraft(query);
        setAppliedQuery(query.trim());
        setQueryError(null);
        setShowSearchSyntaxModal(false);
        window.setTimeout(() => {
            searchInputRef.current?.focus();
        }, 0);
    }, []);

    const insertSearchSnippet = useCallback((snippet: string) => {
        const input = searchInputRef.current;
        const currentValue = input?.value ?? searchDraft;
        const selectionStart = input?.selectionStart ?? currentValue.length;
        const selectionEnd = input?.selectionEnd ?? currentValue.length;
        const nextQuery = `${currentValue.slice(0, selectionStart)}${snippet}${currentValue.slice(selectionEnd)}`;
        const nextCaretPosition = selectionStart + snippet.length;

        setSearchDraft(nextQuery);
        setQueryError(null);

        window.setTimeout(() => {
            searchInputRef.current?.focus();
            searchInputRef.current?.setSelectionRange(nextCaretPosition, nextCaretPosition);
        }, 0);
    }, [searchDraft]);

    const clearFilter = useCallback(() => {
        setSearchDraft("");
        setDebouncedSearchDraft("");
        setAppliedQuery("");
        setQueryError(null);
        setSearchParams({});
    }, [setSearchParams]);

    const removeParam = (key: string) => {
        const newParams = new URLSearchParams(searchParams);
        newParams.delete(key);
        setSearchParams(newParams);
    }

    const toggleExpired = () => {
        const newValue = !includeExpiredParam;

        // Update URL params
        const newParams = new URLSearchParams(searchParams);
        if (newValue) {
            newParams.set('include_expired', 'true');
        } else {
            newParams.delete('include_expired');
        }
        setSearchParams(newParams);
    };

    const filteredDecisions = decisions;
    const eligibleFilteredDecisionIdsKey = selectableDecisionIds.join("|");
    const selectedFilteredDecisionIds = selectableDecisionIds.filter((id) => selectedDecisionIds.includes(id));
    const allFilteredDecisionsSelected = selectableDecisionIds.length > 0 && selectedFilteredDecisionIds.length === selectableDecisionIds.length;
    const someFilteredDecisionsSelected = selectedFilteredDecisionIds.length > 0 && !allFilteredDecisionsSelected;

    useEffect(() => {
        const validIds = new Set(eligibleFilteredDecisionIdsKey ? eligibleFilteredDecisionIdsKey.split("|") : []);
        setSelectedDecisionIds((prev) => prev.filter((id) => validIds.has(id)));
    }, [eligibleFilteredDecisionIdsKey]);

    useEffect(() => {
        if (selectAllDecisionsRef.current) {
            selectAllDecisionsRef.current.indeterminate = someFilteredDecisionsSelected;
        }
    }, [someFilteredDecisionsSelected]);

    const toggleAllFilteredDecisions = () => {
        setSelectedDecisionIds((prev) => {
            if (allFilteredDecisionsSelected) {
                return prev.filter((id) => !selectableDecisionIds.includes(id));
            }

            return Array.from(new Set([...prev, ...selectableDecisionIds]));
        });
    };

    const visibleDecisions = filteredDecisions;
    const selectedDecisionCount = selectedFilteredDecisionIds.length;
    const deleteActionTitle = pendingDeleteAction?.kind === "single"
        ? "Delete Decision?"
        : pendingDeleteAction?.kind === "selected"
            ? "Delete Selected Decisions?"
            : pendingDeleteAction?.kind === "ip"
                ? "Delete All for this IP?"
                : "Delete";
    const pendingDecisionId = pendingDeleteAction?.kind === "single" ? pendingDeleteAction.decisionId : null;
    const pendingIp = pendingDeleteAction?.kind === "ip" ? pendingDeleteAction.ip : null;
    const summaryText = initialLoading && !hasLoadedDecisionsRef.current
        ? "Loading decisions..."
        : totalDecisions !== totalUnfilteredDecisions
            ? `Showing ${visibleDecisions.length} of ${totalDecisions} decisions (${totalUnfilteredDecisions} total before filters)`
            : `Showing ${visibleDecisions.length} of ${totalDecisions} decisions`;
    const tableBusy = initialLoading || backgroundLoading || loadingMore;

    return (
        <div className="space-y-6">
            <div
                data-testid="decisions-summary"
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
                    onClick={() => setShowAddModal(true)}
                    className="bg-primary-600 hover:bg-primary-700 text-white font-medium py-2 px-4 rounded-md transition-colors flex items-center gap-2 text-sm"
                >
                    <Gavel size={16} />
                    Add Decision
                </button>
                <button
                    onClick={() => setPendingDeleteAction({ kind: "selected", ids: selectedFilteredDecisionIds })}
                    disabled={selectedDecisionCount === 0}
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
            {(includeExpiredParam || !includeExpiredParam || appliedQuery || alertIdFilter || countryFilter || scenarioFilter || asFilter || ipFilter || targetFilter || dateStartFilter || dateEndFilter || (simulationsEnabled && simulationFilter !== 'all')) && (
                <div className="flex flex-wrap gap-2">
                    {appliedQuery && (
                        <Badge variant="secondary" className="flex items-center gap-1 max-w-full">
                            <span className="font-semibold">Search:</span>
                            <span className="font-mono text-xs truncate max-w-[320px]">{appliedQuery}</span>
                            <button
                                onClick={() => {
                                    const nextParams = new URLSearchParams(searchParams);
                                    nextParams.delete("q");
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
                    {!includeExpiredParam && (
                        <Badge variant="secondary" className="flex items-center gap-1">
                            <span className="font-semibold">Hide:</span> Inactive
                            <button
                                onClick={toggleExpired}
                                className="ml-1 hover:text-red-500"
                            >
                                &times;
                            </button>
                        </Badge>
                    )}
                    {!showDuplicates && (
                        <Badge variant="secondary" className="flex items-center gap-1">
                            <span className="font-semibold">Hide:</span> Duplicates
                            <button
                                onClick={() => {
                                    const newParams = new URLSearchParams(searchParams);
                                    newParams.set('hide_duplicates', 'false');
                                    setSearchParams(newParams);
                                }}
                                className="ml-1 hover:text-red-500"
                            >
                                &times;
                            </button>
                        </Badge>
                    )}
                    {alertIdFilter && (
                        <Badge variant="secondary" className="flex items-center gap-1">
                            <span className="font-semibold">Alert:</span> #{alertIdFilter}
                            <button
                                onClick={() => removeParam("alert_id")}
                                className="ml-1 hover:text-red-500"
                            >
                                &times;
                            </button>
                        </Badge>
                    )}
                    {/* Iterate over other filters to cleaner code, or keep explicit for now to match exactly what we have but styled better */}
                    {searchParams.get("country") && (
                        <Badge variant="secondary" className="flex items-center gap-1">
                            <span className="font-semibold">Country:</span> {countryFilter}
                            <button
                                onClick={() => removeParam("country")}
                                className="ml-1 hover:text-red-500"
                            >
                                &times;
                            </button>
                        </Badge>
                    )}
                    {searchParams.get("scenario") && (
                        <div title={scenarioFilter || undefined}>
                            <Badge variant="secondary" className="flex items-center gap-1 max-w-[300px] truncate">
                                <span className="font-semibold">Scenario:</span> {scenarioFilter}
                                <button
                                    onClick={() => removeParam("scenario")}
                                    className="ml-1 hover:text-red-500"
                                >
                                    &times;
                                </button>
                            </Badge>
                        </div>
                    )}
                    {searchParams.get("as") && (
                        <div title={asFilter || undefined}>
                            <Badge variant="secondary" className="flex items-center gap-1 max-w-[300px] truncate">
                                <span className="font-semibold">AS:</span> {asFilter}
                                <button
                                    onClick={() => removeParam("as")}
                                    className="ml-1 hover:text-red-500"
                                >
                                    &times;
                                </button>
                            </Badge>
                        </div>
                    )}
                    {searchParams.get("ip") && (
                        <Badge variant="secondary" className="flex items-center gap-1">
                            <span className="font-semibold">IP / Range:</span> {ipFilter}
                            <button
                                onClick={() => removeParam("ip")}
                                className="ml-1 hover:text-red-500"
                            >
                                &times;
                            </button>
                        </Badge>
                    )}
                    {targetFilter && (
                        <Badge variant="secondary" className="flex items-center gap-1">
                            <span className="font-semibold">Target:</span> {targetFilter}
                            <button
                                onClick={() => removeParam("target")}
                                className="ml-1 hover:text-red-500"
                            >
                                &times;
                            </button>
                        </Badge>
                    )}
                    {dateStartFilter && (
                        <Badge variant="secondary" className="flex items-center gap-1">
                            <span className="font-semibold">Date Start:</span> {dateStartFilter}
                            <button
                                onClick={() => removeParam("dateStart")}
                                className="ml-1 hover:text-red-500"
                            >
                                &times;
                            </button>
                        </Badge>
                    )}
                    {dateEndFilter && (
                        <Badge variant="secondary" className="flex items-center gap-1">
                            <span className="font-semibold">Date End:</span> {dateEndFilter}
                            <button
                                onClick={() => removeParam("dateEnd")}
                                className="ml-1 hover:text-red-500"
                            >
                                &times;
                            </button>
                        </Badge>
                    )}
                    {simulationsEnabled && simulationFilter !== 'all' && (
                        <Badge variant="secondary" className="flex items-center gap-1">
                            <span className="font-semibold">Simulation:</span> {simulationFilter}
                            <button
                                onClick={() => removeParam("simulation")}
                                className="ml-1 hover:text-red-500"
                            >
                                &times;
                            </button>
                        </Badge>
                    )}

                    {/* Show Reset button if we have any active filters OR if we are showing expired/duplicates (non-default state) */}
                    {(appliedQuery || alertIdFilter || countryFilter || scenarioFilter || asFilter || ipFilter || targetFilter || dateStartFilter || dateEndFilter || includeExpiredParam || showDuplicates || (simulationsEnabled && simulationFilter !== 'all')) && (
                        <button
                            onClick={clearFilter}
                            className="text-xs text-gray-500 hover:text-gray-900 dark:hover:text-gray-300 underline"
                        >
                            Reset all filters
                        </button>
                    )}
                </div>
            )}

            <div className="space-y-2">
                <div className="flex items-stretch gap-2">
                    <div className="relative flex-1">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                            <Search className="h-5 w-5 text-gray-400" />
                        </div>
                        <input
                            ref={searchInputRef}
                            type="text"
                            placeholder="Filter decisions..."
                            className={`block w-full pl-10 pr-3 py-2 border rounded-md leading-5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-1 sm:text-sm ${queryError ? 'border-red-300 dark:border-red-700 focus:ring-red-500 focus:border-red-500' : 'border-gray-300 dark:border-gray-700 focus:ring-primary-500 focus:border-primary-500'}`}
                            value={searchDraft}
                            onChange={(e) => setSearchDraft(e.target.value)}
                            aria-invalid={queryError ? 'true' : 'false'}
                            aria-describedby={queryError ? 'decisions-search-error' : undefined}
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
                    <p id="decisions-search-error" className="text-xs text-red-600 dark:text-red-400">
                        Search syntax error at character {queryError.position + 1}: {queryError.message}
                    </p>
                )}
            </div>


            <div
                className="bg-white dark:bg-gray-800 shadow-sm rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700"
                aria-busy={tableBusy}
            >
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                        <thead className="bg-gray-50 dark:bg-gray-900/50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                    <input
                                        ref={selectAllDecisionsRef}
                                        type="checkbox"
                                        aria-label="Select all filtered decisions"
                                        checked={allFilteredDecisionsSelected}
                                        disabled={selectableDecisionIds.length === 0}
                                        onChange={toggleAllFilteredDecisions}
                                        className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                    />
                                </th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Time</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Scenario</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Country</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">AS</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">IP / Range</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Action</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Expiration</th>
                                {machineFeaturesEnabled && (
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Machine</th>
                                )}
                                {originFeaturesEnabled && (
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Origin</th>
                                )}
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Alert</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {initialLoading && visibleDecisions.length === 0 ? (
                                <tr><td colSpan={10 + (machineFeaturesEnabled ? 1 : 0) + (originFeaturesEnabled ? 1 : 0)} className="px-6 py-4 text-center text-sm text-gray-500">Loading decisions...</td></tr>
                            ) : visibleDecisions.length === 0 ? (
                                <tr><td colSpan={10 + (machineFeaturesEnabled ? 1 : 0) + (originFeaturesEnabled ? 1 : 0)} className="px-6 py-4 text-center text-sm text-gray-500">{alertIdFilter ? "No decisions for this alert" : "No decisions found"}</td></tr>
                            ) : (
                                visibleDecisions.map((decision, index) => {
                                    const decisionDuration = decision.detail.duration ?? '';
                                    const isExpired = isDecisionExpired(decision);
                                    const rowClasses = isExpired
                                        ? "hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors opacity-60 bg-gray-50 dark:bg-gray-900/20"
                                        : "hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors";

                                    const isLastElement = index === visibleDecisions.length - 1;
                                    const isSelected = selectedDecisionIds.includes(String(decision.id));

                                    return (
                                        <tr
                                            key={`${decision.id}-${decision.detail.duration}`}
                                            className={rowClasses}
                                            ref={isLastElement ? lastDecisionElementRef : null}
                                        >
                                            <td className="px-6 py-4 whitespace-nowrap text-sm">
                                                <input
                                                    type="checkbox"
                                                    aria-label={`Select decision ${decision.id}`}
                                                    checked={isSelected}
                                                    disabled={isExpired}
                                                    onChange={() => toggleDecisionSelection(String(decision.id))}
                                                    className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50"
                                                />
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                                                <TimeDisplay timestamp={decision.created_at} />
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 max-w-[200px]" title={decision.detail.reason}>
                                                <ScenarioName
                                                    name={decision.detail.reason}
                                                    showLink={true}
                                                    simulated={simulationsEnabled && isSimulatedDecision(decision)}
                                                />
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 align-middle">
                                                {decision.detail.country && decision.detail.country !== "Unknown" ? (
                                                    <div className="flex items-center gap-2" title={decision.detail.country}>
                                                        <span className={`fi fi-${decision.detail.country.toLowerCase()} flex-shrink-0`}></span>
                                                        <span>{getCountryName(decision.detail.country)}</span>
                                                    </div>
                                                ) : (
                                                    "-"
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 max-w-[150px] truncate" title={decision.detail.as}>
                                                {decision.detail.as && decision.detail.as !== "Unknown" ? decision.detail.as : "-"}
                                            </td>
                                            <td className="px-6 py-4 text-sm font-mono text-gray-900 dark:text-gray-100 max-w-[200px] truncate" title={decision.value}>
                                                {decision.value}
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                                                <Badge variant="danger">{decision.detail.action || "ban"}</Badge>
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 whitespace-nowrap">
                                                {decisionDuration.startsWith("-") ? "0s" : decisionDuration}
                                                {isExpired && <span className="ml-2 text-xs text-red-500 dark:text-red-400">(Expired)</span>}
                                            </td>
                                            {machineFeaturesEnabled && (
                                                <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400 max-w-[120px] truncate" title={decision.machine}>
                                                    {decision.machine || "-"}
                                                </td>
                                            )}
                                            {originFeaturesEnabled && (
                                                <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400 max-w-[120px] truncate" title={decision.detail.origin}>
                                                    {decision.detail.origin || "-"}
                                                </td>
                                            )}
                                            <td className="px-6 py-4 whitespace-nowrap text-sm">
                                                {decision.detail.alert_id ? (
                                                    <Link
                                                        to={`/alerts?id=${decision.detail.alert_id}`}
                                                        className="inline-flex items-center gap-2 px-2 py-1 rounded-full bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300 hover:bg-primary-100 dark:hover:bg-primary-900/30 transition-colors border border-primary-200 dark:border-primary-800"
                                                        title={`View Alert #${decision.detail.alert_id}`}
                                                    >
                                                        <Shield size={14} className="fill-current" />
                                                        <span className="text-xs font-semibold">Alert</span>
                                                        <ExternalLink size={12} className="ml-0.5" />
                                                    </Link>
                                                ) : (
                                                    <span className="text-gray-400">-</span>
                                                )}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                                <div className="flex items-center justify-end gap-2">
                                                    {decision.value && (
                                                        <button
                                                            onClick={() => setPendingDeleteAction({ kind: "ip", ip: decision.value || "" })}
                                                            className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors p-2 rounded-full relative z-10 cursor-pointer"
                                                            title={`Delete all alerts and decisions for ${decision.value}`}
                                                            aria-label={`Delete all alerts and decisions for ${decision.value}`}
                                                        >
                                                            <ShieldBan size={16} aria-hidden="true" />
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            requestDelete(decision.id);
                                                        }}
                                                        disabled={isExpired}
                                                        className={`transition-colors p-2 rounded-full relative z-10 cursor-pointer ${isExpired ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed bg-gray-100 dark:bg-gray-800' : 'text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20'}`}
                                                        title={isExpired ? "Decision already expired" : "Delete Decision"}
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

            {/* Delete Confirmation Modal */}
            <Modal
                isOpen={!!pendingDeleteAction}
                onClose={() => !deleteInProgress && setPendingDeleteAction(null)}
                title={deleteActionTitle}
                maxWidth="max-w-sm"
                showCloseButton={false}
            >
                <p className="text-gray-600 dark:text-gray-300 mb-6">
                    {pendingDecisionId ? (
                        <>
                            Are you sure you want to delete decision <span className="font-mono text-sm font-bold">#{pendingDecisionId}</span>? This action cannot be undone.
                        </>
                    ) : pendingIp ? (
                        <>
                            Are you sure you want to delete all alerts and decisions for <span className="font-mono text-sm font-bold">{pendingIp}</span>? This action cannot be undone.
                        </>
                    ) : (
                        <>Are you sure you want to delete {selectedFilteredDecisionIds.length} selected decision{selectedFilteredDecisionIds.length === 1 ? "" : "s"}? This action cannot be undone.</>
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

            {/* Add Decision Modal */}
            <Modal
                isOpen={showAddModal}
                onClose={() => setShowAddModal(false)}
                title="Add Manual Decision"
                maxWidth="max-w-md"
            >
                <form onSubmit={handleAddDecision} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">IP / Range</label>
                        <input
                            type="text"
                            required
                            className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                            placeholder="1.2.3.4"
                            value={newDecision.ip}
                            onChange={e => setNewDecision({ ...newDecision, ip: e.target.value })}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Duration</label>
                        <input
                            type="text"
                            className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                            placeholder="4h"
                            value={newDecision.duration}
                            onChange={e => setNewDecision({ ...newDecision, duration: e.target.value })}
                        />
                        <p className="text-xs text-gray-500 mt-1">e.g. 4h, 1d, 30m</p>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Reason</label>
                        <input
                            type="text"
                            className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                            placeholder="Manual ban"
                            value={newDecision.reason}
                            onChange={e => setNewDecision({ ...newDecision, reason: e.target.value })}
                        />
                    </div>
                    <div className="flex justify-end gap-3 mt-6">
                        <button
                            type="button"
                            onClick={() => setShowAddModal(false)}
                            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white dark:bg-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            className="px-4 py-2 text-sm font-medium text-white bg-primary-600 border border-transparent rounded-md hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                        >
                            Add Decision
                        </button>
                    </div>
                </form>
            </Modal>
            <SearchSyntaxModal
                help={searchHelp}
                isOpen={showSearchSyntaxModal}
                onClose={() => setShowSearchSyntaxModal(false)}
                onSelectExample={applySearchExample}
                onInsertSnippet={insertSearchSnippet}
            />
        </div >
    );
}
