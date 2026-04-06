import { useEffect, useState, useRef, useCallback, type FormEvent } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { deleteDecision, bulkDeleteDecisions, cleanupByIp, addDecision, fetchConfig } from "../lib/api";
import { apiUrl } from "../lib/basePath";
import { isSimulatedDecision, matchesSimulationFilter, parseSimulationFilter } from "../lib/simulation";
import { useRefresh } from "../contexts/useRefresh";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { ScenarioName } from "../components/ScenarioName";
import { TimeDisplay } from "../components/TimeDisplay";
import { getCountryName } from "../lib/utils";
import { Trash2, Gavel, X, ExternalLink, Shield, ShieldBan, Search, AlertCircle } from "lucide-react";
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

function getDecisionDateFilterKey(isoString: string, includeHour: boolean): string {
    const date = new Date(isoString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    if (includeHour) {
        const hour = String(date.getHours()).padStart(2, '0');
        return `${year}-${month}-${day}T${hour}`;
    }

    return `${year}-${month}-${day}`;
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
    const [loading, setLoading] = useState(true);
    const [showAddModal, setShowAddModal] = useState(false);
    const [filter, setFilter] = useState("");
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

    const [displayedCount, setDisplayedCount] = useState(50);

    // Intersection Observer for infinite scroll
    const observer = useRef<IntersectionObserver | null>(null);
    const selectAllDecisionsRef = useRef<HTMLInputElement | null>(null);
    const lastDecisionElementRef = useCallback((node: HTMLTableRowElement | null) => {
        if (loading) return;
        if (observer.current) observer.current.disconnect();
        observer.current = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                setDisplayedCount((prev) => prev + 50);
            }
        });
        if (node) observer.current.observe(node);
    }, [loading]);

    const loadDecisions = useCallback(async (isBackground = false) => {
        if (!isBackground) setLoading(true);
        try {
            const url = includeExpiredParam ? apiUrl('/api/decisions?include_expired=true') : apiUrl('/api/decisions');

            const [res, configData] = await Promise.all([
                fetch(url, { cache: "no-store" }),
                fetchConfig(),
            ]);
            if (!res.ok) throw new Error('Failed to fetch decisions');
            const data = await res.json() as DecisionListItem[];

            setDecisions(data);
            setSimulationsEnabled(configData.simulations_enabled === true);
            setMachineFeaturesEnabled(configData.machine_features_enabled === true);

            setLastUpdated(new Date());
        } catch (error) {
            console.error(error);
        } finally {
            if (!isBackground) setLoading(false);
        }
    }, [includeExpiredParam, setLastUpdated]);

    // Sync "q" param to filter state
    useEffect(() => {
        const queryParam = searchParams.get("q");
        if (queryParam) {
            setFilter(queryParam);
        }
    }, [searchParams]);

    useEffect(() => {
        loadDecisions(false);
    }, [loadDecisions]);

    useEffect(() => {
        if (refreshSignal > 0) loadDecisions(true);
    }, [refreshSignal, loadDecisions]);

    const handleAddDecision = async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const decisionData = { ...newDecision };
        setShowAddModal(false);
        setNewDecision({ ip: "", duration: "4h", reason: "manual" });
        setErrorInfo(null);
        try {
            await addDecision(decisionData);
            await loadDecisions();
            setDisplayedCount(50); // Reset to show new decision at top
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
            await loadDecisions();
            setDisplayedCount(50);
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

    const clearFilter = () => {
        setSearchParams({});
    };

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

    const filteredDecisions = decisions.filter((decision) => {
        // 0. Duplicate Filter (applied first, default: hide duplicates)
        if (!showDuplicates && decision.is_duplicate) return false;

        // 1. Alert ID Filter
        if (alertIdFilter && String(decision.detail.alert_id) !== alertIdFilter) return false;
        if (!matchesSimulationFilter({ simulated: isSimulatedDecision(decision) }, simulationFilter)) return false;

        // 2. Exact Field Filters (from Dashboard)
        if (countryFilter && decision.detail.country !== countryFilter) return false;
        if (scenarioFilter && decision.detail.reason !== scenarioFilter) return false;
        if (asFilter && decision.detail.as !== asFilter) return false;
        if (asFilter && decision.detail.as !== asFilter) return false;
        if (ipFilter && decision.value !== ipFilter) return false;
        if (targetFilter) {
            const decisionTarget = (decision.value || "").toLowerCase();
            const targetFromDetail = (decision.detail.target || "").toLowerCase();
            const filterValue = targetFilter.toLowerCase();

            if (!decisionTarget.includes(filterValue) && !targetFromDetail.includes(filterValue)) {
                return false;
            }
        }

        // 3. Date Range Filter
        if (dateStartFilter || dateEndFilter) {
            if (!decision.created_at) return false;

            // Helper to extract date/time key from ISO timestamp (Matches Alerts.jsx logic)
            // This ensures we compare "apples to apples" with the dashboard local-time based filters
            const itemKey = getDecisionDateFilterKey(
                decision.created_at,
                Boolean((dateStartFilter && dateStartFilter.includes('T')) || (dateEndFilter && dateEndFilter.includes('T'))),
            );

            if (dateStartFilter && itemKey < dateStartFilter) return false;
            if (dateEndFilter && itemKey > dateEndFilter) return false;
        }



        // 4. Generic Text Search (existing)
        const search = filter.toLowerCase();
        if (!search) return true;

        const ip = (decision.value || "").toLowerCase();
        const reason = (decision.detail.reason || "").toLowerCase();
        const countryCode = (decision.detail.country || "").toLowerCase();
        const countryName = (getCountryName(decision.detail.country) || "").toLowerCase();
        const as = (decision.detail.as || "").toLowerCase();
        const machine = machineFeaturesEnabled ? (decision.machine || "").toLowerCase() : "";
        const type = (decision.detail.type || "").toLowerCase();
        const action = (decision.detail.action || "").toLowerCase();
        const simulationSearch = isSimulatedDecision(decision) ? 'simulation simulated' : 'live';

        return ip.includes(search) ||
            reason.includes(search) ||
            countryCode.includes(search) ||
            countryName.includes(search) ||
            as.includes(search) ||
            (machineFeaturesEnabled && machine.includes(search)) ||
            type.includes(search) ||
            action.includes(search) ||
            simulationSearch.includes(search);
    });

    const eligibleFilteredDecisionIds = filteredDecisions
        .filter((decision) => !isDecisionExpired(decision))
        .map((decision) => String(decision.id));
    const eligibleFilteredDecisionIdsKey = eligibleFilteredDecisionIds.join("|");
    const selectedFilteredDecisionIds = eligibleFilteredDecisionIds.filter((id) => selectedDecisionIds.includes(id));
    const allFilteredDecisionsSelected = eligibleFilteredDecisionIds.length > 0 && selectedFilteredDecisionIds.length === eligibleFilteredDecisionIds.length;
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
                return prev.filter((id) => !eligibleFilteredDecisionIds.includes(id));
            }

            return Array.from(new Set([...prev, ...eligibleFilteredDecisionIds]));
        });
    };

    const visibleDecisions = filteredDecisions.slice(0, displayedCount);
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

    return (
        <div className="space-y-6">
            {/* Only show count when non-default filters are applied */}
            {(alertIdFilter || countryFilter || scenarioFilter || asFilter || ipFilter || targetFilter || dateStartFilter || dateEndFilter || includeExpiredParam || showDuplicates || (simulationsEnabled && simulationFilter !== 'all')) && filteredDecisions.length !== decisions.length && (
                <div className="text-sm text-gray-500">
                    Showing {filteredDecisions.length} of {decisions.length} decisions
                </div>
            )}
            
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
            {(includeExpiredParam || !includeExpiredParam || alertIdFilter || countryFilter || scenarioFilter || asFilter || ipFilter || targetFilter || dateStartFilter || dateEndFilter || (simulationsEnabled && simulationFilter !== 'all')) && (
                <div className="flex flex-wrap gap-2">
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
                    {(alertIdFilter || countryFilter || scenarioFilter || asFilter || ipFilter || targetFilter || dateStartFilter || dateEndFilter || includeExpiredParam || showDuplicates || (simulationsEnabled && simulationFilter !== 'all')) && (
                        <button
                            onClick={clearFilter}
                            className="text-xs text-gray-500 hover:text-gray-900 dark:hover:text-gray-300 underline"
                        >
                            Reset all filters
                        </button>
                    )}
                </div>
            )}




            <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Search className="h-5 w-5 text-gray-400" />
                </div>
                <input
                    type="text"
                    placeholder="Filter decisions..."
                    className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md leading-5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                />
            </div>


            <div className="bg-white dark:bg-gray-800 shadow-sm rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
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
                                        disabled={eligibleFilteredDecisionIds.length === 0}
                                        onChange={toggleAllFilteredDecisions}
                                        className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                                    />
                                </th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Time</th>
                                {machineFeaturesEnabled && (
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Machine</th>
                                )}
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Scenario</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Country</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">AS</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">IP / Range</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Action</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Expiration</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Alert</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {loading ? (
                                <tr><td colSpan={machineFeaturesEnabled ? 11 : 10} className="px-6 py-4 text-center text-sm text-gray-500">Loading decisions...</td></tr>
                            ) : visibleDecisions.length === 0 ? (
                                <tr><td colSpan={machineFeaturesEnabled ? 11 : 10} className="px-6 py-4 text-center text-sm text-gray-500">{alertIdFilter ? "No decisions for this alert" : "No decisions found"}</td></tr>
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
                                            {machineFeaturesEnabled && (
                                                <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400 max-w-[120px] truncate" title={decision.machine}>
                                                    {decision.machine || "-"}
                                                </td>
                                            )}
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
        </div >
    );
}
