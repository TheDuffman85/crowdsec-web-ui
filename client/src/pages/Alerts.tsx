import { useEffect, useState, useRef, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { fetchAlerts, fetchAlert, deleteAlert, bulkDeleteAlerts, cleanupByIp, fetchConfig } from "../lib/api";
import { isSimulatedAlert, isSimulatedDecision, matchesSimulationFilter, parseSimulationFilter } from "../lib/simulation";
import { useRefresh } from "../contexts/useRefresh";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { ScenarioName } from "../components/ScenarioName";
import { TimeDisplay } from "../components/TimeDisplay";
import { EventCard } from "../components/EventCard";
import { getCountryName } from "../lib/utils";
import { resolveMachineName } from "../../../shared/machine";
import { Search, Info, ExternalLink, Shield, ShieldBan, Trash2, X, AlertCircle } from "lucide-react";
import type { AlertRecord, AlertSource, ApiPermissionError, BulkDeleteResult, SimulationFilter, SlimAlert } from '../types';

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

function getDateFilterKey(isoString: string, includeHour: boolean): string {
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
    const [alerts, setAlerts] = useState<AlertListItem[]>([]);
    const [simulationsEnabled, setSimulationsEnabled] = useState(false);
    const [machineFeaturesEnabled, setMachineFeaturesEnabled] = useState(false);
    const [filter, setFilter] = useState("");
    const [loading, setLoading] = useState(true);
    const [selectedAlert, setSelectedAlert] = useState<AlertSelection | null>(null);
    const [displayedCount, setDisplayedCount] = useState(50);
    const [displayedDecisionCount, setDisplayedDecisionCount] = useState(50);
    const [searchParams, setSearchParams] = useSearchParams();
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

    // Intersection Observer for infinite scroll
    const observer = useRef<IntersectionObserver | null>(null);
    const lastAlertElementRef = useCallback((node: HTMLTableRowElement | null) => {
        if (loading) return;
        if (observer.current) observer.current.disconnect();
        observer.current = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                setDisplayedCount((prev) => prev + 50);
            }
        });
        if (node) observer.current.observe(node);
    }, [loading]);

    const decisionContainerRef = useRef<HTMLDivElement | null>(null);
    const selectAllAlertsRef = useRef<HTMLInputElement | null>(null);

    const loadAlerts = useCallback(async (isBackground = false) => {
        try {
            if (!isBackground) setLoading(true);
            const [alertsData, configData] = await Promise.all([
                fetchAlerts(),
                fetchConfig(),
            ]);
            setAlerts(alertsData);
            setSimulationsEnabled(configData.simulations_enabled === true);
            setMachineFeaturesEnabled(configData.machine_features_enabled === true);

            // Check if there's an alert ID in the URL
            if (alertIdParam) {
                // Always fetch full alert data since list now returns slim payloads
                try {
                    const alertData = await fetchAlert(alertIdParam);
                    setSelectedAlert(alertData);
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
                    } catch (err) {
                        console.error("Failed to refresh alert details", err);
                        // Keep showing current data on error
                    }
                }
            }

            // Check for generic search query param
            if (queryParam) {
                setFilter(queryParam);
            }

            setLastUpdated(new Date());

        } catch (err) {
            console.error(err);
        } finally {
            if (!isBackground) setLoading(false);
        }
    }, [alertIdParam, queryParam, setLastUpdated]);

    useEffect(() => {
        loadAlerts(false);
    }, [loadAlerts]);


    useEffect(() => {
        if (refreshSignal > 0) loadAlerts(true);
    }, [refreshSignal, loadAlerts]);

    // Keep ref in sync with selectedAlert for auto-refresh
    useEffect(() => {
        selectedAlertIdRef.current = selectedAlert?.id || null;
        setShowAllEvents(false);
        setDisplayedDecisionCount(50);
    }, [selectedAlert]);

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
            await loadAlerts();
            setDisplayedCount(50);
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

    const filteredAlerts = alerts.filter((alert) => {
        const search = filter.toLowerCase();

        // Specific query params
        const paramIp = (searchParams.get("ip") || "").toLowerCase();
        const paramCountry = (searchParams.get("country") || "").toLowerCase();
        const paramScenario = (searchParams.get("scenario") || "").toLowerCase();
        const paramAs = (searchParams.get("as") || "").toLowerCase();
        const paramDate = searchParams.get("date") || "";
        const paramDateStart = searchParams.get("dateStart") || "";

        const paramDateEnd = searchParams.get("dateEnd") || "";
        const paramTarget = (searchParams.get("target") || "").toLowerCase();

        if (!matchesSimulationFilter({ simulated: isSimulatedAlert(alert) }, currentSimulationFilter)) return false;

        const scenario = (alert.scenario || "").toLowerCase();
        const message = (alert.message || "").toLowerCase();
        const sourceValue = (getAlertSourceValue(alert.source) || "").toLowerCase();
        const cn = (alert.source?.cn || "").toLowerCase();
        const asName = (alert.source?.as_name || "").toLowerCase();
        const machine = machineFeaturesEnabled ? (resolveMachineName(alert) || "").toLowerCase() : "";

        // Check specific filters if present
        if (paramIp && !sourceValue.includes(paramIp)) return false;
        if (paramCountry && !cn.includes(paramCountry)) return false;
        if (paramScenario && !scenario.includes(paramScenario)) return false;
        if (paramScenario && !scenario.includes(paramScenario)) return false;
        if (paramAs && !asName.includes(paramAs)) return false;
        if (paramTarget && !(alert.target || "").toLowerCase().includes(paramTarget)) return false;

        // Single date filter (legacy support)
        if (paramDate && !(alert.created_at && alert.created_at.startsWith(paramDate))) return false;

        // Date range filter (dateStart/dateEnd)
        if (paramDateStart || paramDateEnd) {
            if (!alert.created_at) return false;

            // Helper to extract date/time key from ISO timestamp
            const itemKey = getDateFilterKey(alert.created_at, paramDateStart.includes('T') || paramDateEnd.includes('T'));

            if (paramDateStart && itemKey < paramDateStart) return false;
            if (paramDateEnd && itemKey > paramDateEnd) return false;
        }

        // Check generic search
        if (search) {
            const countryName = (getCountryName(alert.source?.cn) || "").toLowerCase();
            return scenario.includes(search) ||
                message.includes(search) ||
                sourceValue.includes(search) ||
                cn.includes(search) ||
                countryName.includes(search) ||
                asName.includes(search) ||
                (machineFeaturesEnabled && machine.includes(search)) ||
                (alert.target || "").toLowerCase().includes(search) ||
                (alert.meta_search || "").toLowerCase().includes(search) ||
                (isSimulatedAlert(alert) ? 'simulation simulated' : 'live').includes(search);
        }

        return true;
    });

    const filteredAlertIds = filteredAlerts.map((alert) => String(alert.id));
    const filteredAlertIdsKey = filteredAlertIds.join("|");
    const selectedFilteredAlertIds = filteredAlertIds.filter((id) => selectedAlertIds.includes(id));
    const allFilteredAlertsSelected = filteredAlertIds.length > 0 && selectedFilteredAlertIds.length === filteredAlertIds.length;
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
                return prev.filter((id) => !filteredAlertIds.includes(id));
            }

            return Array.from(new Set([...prev, ...filteredAlertIds]));
        });
    };

    const visibleAlerts = filteredAlerts.slice(0, displayedCount);
    const selectedAlertDecisions = selectedAlert?.decisions ?? [];
    const visibleSelectedAlertDecisions = selectedAlertDecisions.slice(0, displayedDecisionCount);
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

    return (
        <div className="space-y-6">
            {(filteredAlerts.length !== alerts.length) && (
                <div className="text-sm text-gray-500">
                    Showing {filteredAlerts.length} of {alerts.length} alerts
                </div>
            )}

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
            {(searchParams.get("ip") || searchParams.get("country") || searchParams.get("scenario") || searchParams.get("as") || searchParams.get("target") || searchParams.get("date") || searchParams.get("dateStart") || searchParams.get("dateEnd") || (simulationsEnabled && searchParams.get("simulation"))) && (
                <div className="flex flex-wrap gap-2">
                    {[
                        "ip",
                        "country",
                        "scenario",
                        "as",
                        "target",
                        "date",
                        "dateStart",
                        "dateEnd",
                        ...(simulationsEnabled ? ["simulation"] : []),
                    ].map(key => {
                        const val = searchParams.get(key);
                        if (!val) return null;
                        return (
                            <Badge key={key} variant="secondary" className="flex items-center gap-1">
                                <span className="font-semibold">{key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1')}:</span> {val}
                                <button
                                    onClick={() => {
                                        const newParams = new URLSearchParams(searchParams);
                                        newParams.delete(key);
                                        setSearchParams(newParams);
                                    }}
                                    className="ml-1 hover:text-red-500"
                                >
                                    &times;
                                </button>
                            </Badge>
                        );
                    })}
                    <button
                        onClick={() => setSearchParams({})}
                        className="text-xs text-gray-500 hover:text-gray-900 dark:hover:text-gray-300 underline"
                    >
                        Reset all filters
                    </button>
                </div>
            )
            }

            <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Search className="h-5 w-5 text-gray-400" />
                </div>
                <input
                    type="text"
                    placeholder="Filter alerts..."
                    className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md leading-5 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                />
            </div>

            <div className="bg-white dark:bg-gray-800 shadow-sm rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
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
                                        disabled={filteredAlertIds.length === 0}
                                        onChange={toggleAllFilteredAlerts}
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
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Decisions</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {loading ? (
                                <tr><td colSpan={machineFeaturesEnabled ? 9 : 8} className="px-6 py-4 text-center text-sm text-gray-500">Loading alerts...</td></tr>
                            ) : visibleAlerts.length === 0 ? (
                                <tr><td colSpan={machineFeaturesEnabled ? 9 : 8} className="px-6 py-4 text-center text-sm text-gray-500">No alerts found</td></tr>
                            ) : (
                                visibleAlerts.map((alert, index) => {
                                    const isLastElement = index === visibleAlerts.length - 1;
                                    const sourceValue = getAlertSourceValue(alert.source);
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
                                            {machineFeaturesEnabled && (
                                                <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400 max-w-[120px] truncate" title={resolveMachineName(alert)}>
                                                    {resolveMachineName(alert) || "-"}
                                                </td>
                                            )}
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
                        {selectedAlertDecisions.length > 0 && (
                            <div>
                                <div className="flex items-center justify-between gap-3 mb-3">
                                    <h4 className="text-lg font-semibold text-gray-900 dark:text-white">Decisions Taken</h4>
                                    {selectedAlertDecisions.length > visibleSelectedAlertDecisions.length && (
                                        <span className="text-xs text-gray-500 dark:text-gray-400">
                                            Showing {visibleSelectedAlertDecisions.length} of {selectedAlertDecisions.length}
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
                                            {visibleSelectedAlertDecisions.map((decision, idx) => {
                                                // Check if this specific decision is active or expired
                                                const isActive = (() => {
                                                    if (decision.expired !== undefined) {
                                                        return !decision.expired;
                                                    }

                                                    if (decision.stop_at) {
                                                        return new Date(decision.stop_at) > new Date();
                                                    }
                                                    // If stop_at is missing, check if duration implies expiration
                                                    if (decision.duration && decision.duration.startsWith('-')) {
                                                        return false;
                                                    }
                                                    return true; // Assume active if no stop_at and not definitely expired
                                                })();
                                                return (
                                                    <tr key={`${decision.id}-${decision.duration ?? idx}`}>
                                                        <td className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400">#{decision.id}</td>
                                                        <td className="px-4 py-2 text-sm"><Badge variant="danger">{decision.type}</Badge></td>
                                                        <td className="px-4 py-2 text-sm font-mono">{decision.value}</td>
                                                        <td className="px-4 py-2 text-sm">
                                                            {decision.duration && decision.duration.startsWith('-') ? "0s" : decision.duration}
                                                            {!isActive && <span className="ml-2 text-xs text-red-500 dark:text-red-400">(Expired)</span>}
                                                        </td>
                                                        <td className="px-4 py-2 text-sm">{decision.origin}</td>
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
                                        </tbody>
                                    </table>
                                </div>
                                {selectedAlertDecisions.length > visibleSelectedAlertDecisions.length && (
                                    <button
                                        onClick={() => setDisplayedDecisionCount((prev) => Math.min(prev + 50, selectedAlertDecisions.length))}
                                        className="mt-3 w-full py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 bg-gray-50 dark:bg-gray-900/30 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors cursor-pointer"
                                    >
                                        Load 50 more decisions ({selectedAlertDecisions.length - visibleSelectedAlertDecisions.length} remaining)
                                    </button>
                                )}
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
        </div >
    );
}
