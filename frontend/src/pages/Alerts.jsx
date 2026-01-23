import { useEffect, useState, useRef, useCallback } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { fetchAlerts, fetchAlert, deleteAlert } from "../lib/api";
import { useRefresh } from "../contexts/RefreshContext";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { ScenarioName } from "../components/ScenarioName";
import { TimeDisplay } from "../components/TimeDisplay";
import { getHubUrl, getCountryName } from "../lib/utils";
import { Search, Info, ExternalLink, Shield, Trash2, X, AlertCircle } from "lucide-react";
import "flag-icons/css/flag-icons.min.css";

export function Alerts() {
    const { refreshSignal, setLastUpdated } = useRefresh();
    const [alerts, setAlerts] = useState([]);
    const [filter, setFilter] = useState("");
    const [loading, setLoading] = useState(true);
    const [selectedAlert, setSelectedAlert] = useState(null);
    const [displayedCount, setDisplayedCount] = useState(50);
    const [searchParams, setSearchParams] = useSearchParams();
    const [alertToDelete, setAlertToDelete] = useState(null);
    const [errorInfo, setErrorInfo] = useState(null); // { message, helpLink?, helpText? }

    // Ref to track selected alert ID for auto-refresh (avoids stale closure issues)
    const selectedAlertIdRef = useRef(null);

    // Intersection Observer for infinite scroll
    const observer = useRef();
    const lastAlertElementRef = useCallback(node => {
        if (loading) return;
        if (observer.current) observer.current.disconnect();
        observer.current = new IntersectionObserver(entries => {
            if (entries[0].isIntersecting) {
                setDisplayedCount(prev => prev + 50);
            }
        });
        if (node) observer.current.observe(node);
    }, [loading]);

    const loadAlerts = useCallback(async (isBackground = false) => {
        try {
            if (!isBackground) setLoading(true);
            const alertsData = await fetchAlerts();
            setAlerts(alertsData);

            // Check if there's an alert ID in the URL
            const alertIdParam = searchParams.get("id");
            if (alertIdParam) {
                // Always fetch full alert data since list now returns slim payloads
                try {
                    const alertData = await fetchAlert(alertIdParam);
                    setSelectedAlert(alertData);
                } catch (err) {
                    console.error("Alert not found", err);
                    // Fallback to slim data from list if fetch fails
                    const existingAlert = alertsData.find(a => String(a.id) === alertIdParam);
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
            const queryParam = searchParams.get("q");
            if (queryParam) {
                setFilter(queryParam);
            }

            setLastUpdated(new Date());

        } catch (err) {
            console.error(err);
        } finally {
            if (!isBackground) setLoading(false);
        }
    }, [searchParams, setLastUpdated]);

    useEffect(() => {
        loadAlerts(false);
    }, [loadAlerts]);


    useEffect(() => {
        if (refreshSignal > 0) loadAlerts(true);
    }, [refreshSignal, loadAlerts]);

    // Keep ref in sync with selectedAlert for auto-refresh
    useEffect(() => {
        selectedAlertIdRef.current = selectedAlert?.id || null;
    }, [selectedAlert]);

    // Handler to fetch full alert data when clicking on a row
    // Since list view now returns slim alerts, we need to fetch full data for the modal
    const handleAlertClick = async (alert) => {
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
    const requestDelete = (id, event) => {
        event.stopPropagation();
        setAlertToDelete(id);
    };

    const confirmDelete = async () => {
        if (!alertToDelete) return;
        const idToDelete = alertToDelete;
        setAlertToDelete(null);
        setErrorInfo(null);
        try {
            await deleteAlert(idToDelete);
            // Close modal if we deleted the currently viewed alert
            if (selectedAlert && selectedAlert.id === idToDelete) {
                setSelectedAlert(null);
            }
            await loadAlerts();
            setDisplayedCount(50);
        } catch (error) {
            console.error("Failed to delete alert", error);
            setErrorInfo({
                message: error.message || "Failed to delete alert. Please try again.",
                helpLink: error.helpLink,
                helpText: error.helpText
            });
        }
    };

    const filteredAlerts = alerts.filter(alert => {
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

        const scenario = (alert.scenario || "").toLowerCase();
        const message = (alert.message || "").toLowerCase();
        const ip = (alert.source?.ip || alert.source?.value || "").toLowerCase();
        const cn = (alert.source?.cn || "").toLowerCase();
        const asName = (alert.source?.as_name || "").toLowerCase();

        // Check specific filters if present
        if (paramIp && !ip.includes(paramIp)) return false;
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
            const getItemKey = (isoString) => {
                const date = new Date(isoString);
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');

                // If filter includes time (has 'T'), use hourly precision
                if (paramDateStart.includes('T') || paramDateEnd.includes('T')) {
                    const hour = String(date.getHours()).padStart(2, '0');
                    return `${year}-${month}-${day}T${hour}`;
                }
                return `${year}-${month}-${day}`;
            };

            const itemKey = getItemKey(alert.created_at);

            if (paramDateStart && itemKey < paramDateStart) return false;
            if (paramDateEnd && itemKey > paramDateEnd) return false;
        }

        // Check generic search
        if (search) {
            return scenario.includes(search) ||
                message.includes(search) ||
                ip.includes(search) ||
                cn.includes(search) ||
                asName.includes(search) ||
                (alert.target || "").toLowerCase().includes(search);
        }

        return true;
    });

    const visibleAlerts = filteredAlerts.slice(0, displayedCount);

    return (
        <div className="space-y-6">
            {(filteredAlerts.length !== alerts.length) && (
                <div className="text-sm text-gray-500">
                    Showing {filteredAlerts.length} of {alerts.length} alerts
                </div>
            )}

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
            {(searchParams.get("ip") || searchParams.get("country") || searchParams.get("scenario") || searchParams.get("as") || searchParams.get("target") || searchParams.get("date") || searchParams.get("dateStart") || searchParams.get("dateEnd")) && (
                <div className="flex flex-wrap gap-2">
                    {["ip", "country", "scenario", "as", "target", "date", "dateStart", "dateEnd"].map(key => {
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
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Time</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Scenario</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Country</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">AS</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">IP</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Decisions</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {loading ? (
                                <tr><td colSpan="7" className="px-6 py-4 text-center text-sm text-gray-500">Loading alerts...</td></tr>
                            ) : visibleAlerts.length === 0 ? (
                                <tr><td colSpan="7" className="px-6 py-4 text-center text-sm text-gray-500">No alerts found</td></tr>
                            ) : (
                                visibleAlerts.map((alert, index) => {
                                    const isLastElement = index === visibleAlerts.length - 1;
                                    return (
                                        <tr
                                            key={alert.id}
                                            ref={isLastElement ? lastAlertElementRef : null}
                                            onClick={() => handleAlertClick(alert)}
                                            className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors cursor-pointer"
                                        >
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                                                <TimeDisplay timestamp={alert.created_at} />
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 max-w-[200px]" title={alert.scenario}>
                                                <ScenarioName name={alert.scenario} showLink={true} />
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
                                            <td className="px-6 py-4 text-sm font-mono text-gray-900 dark:text-gray-100 max-w-[200px] truncate" title={alert.source?.ip || alert.source?.value}>
                                                {alert.source?.ip || alert.source?.value || "N/A"}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm" onClick={(e) => e.stopPropagation()}>
                                                {alert.decisions && alert.decisions.length > 0 ? (() => {
                                                    // Check if there are any active (non-expired) decisions
                                                    const activeDecisions = alert.decisions.filter(d => {
                                                        // If we have explicit status from backend (hydrated), trust it
                                                        if (d.expired !== undefined) {
                                                            return !d.expired;
                                                        }

                                                        if (d.stop_at) {
                                                            return new Date(d.stop_at) > new Date();
                                                        }
                                                        // If stop_at is missing, check if duration implies expiration
                                                        if (d.duration && d.duration.startsWith('-')) {
                                                            return false;
                                                        }
                                                        return true; // Assume active if no stop_at and not definitely expired
                                                    });

                                                    const hasActiveDecisions = activeDecisions.length > 0;

                                                    if (hasActiveDecisions) {
                                                        return (
                                                            <Link
                                                                to={`/decisions?alert_id=${alert.id}`}
                                                                className="inline-flex items-center gap-2 px-2 py-1 rounded-full bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300 hover:bg-primary-100 dark:hover:bg-primary-900/30 transition-colors border border-primary-200 dark:border-primary-800"
                                                                title={`View ${activeDecisions.length} active decisions`}
                                                            >
                                                                <Shield size={14} className="fill-current" />
                                                                <span className="text-xs font-semibold">Active: {activeDecisions.length}</span>
                                                                <ExternalLink size={12} className="ml-0.5" />
                                                            </Link>
                                                        );
                                                    } else {
                                                        return (
                                                            <Link
                                                                to={`/decisions?alert_id=${alert.id}&include_expired=true`}
                                                                className="inline-flex items-center gap-2 px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                                                                title={`View ${alert.decisions.length} expired decisions`}
                                                            >
                                                                <Shield size={14} className="opacity-50" />
                                                                <span className="text-xs font-medium">Inactive: {alert.decisions.length}</span>
                                                            </Link>
                                                        );
                                                    }
                                                })() : (
                                                    <span className="text-gray-400">-</span>
                                                )}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                                <button
                                                    onClick={(e) => requestDelete(alert.id, e)}
                                                    className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors p-2 rounded-full relative z-10 cursor-pointer"
                                                    title="Delete Alert"
                                                >
                                                    <Trash2 size={16} />
                                                </button>
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
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div className="p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-100 dark:border-gray-700/50">
                                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Scenario</h4>
                                <div className="font-medium text-gray-900 dark:text-gray-100 break-words">
                                    <ScenarioName name={selectedAlert.scenario} showLink={true} />
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
                                            href={`https://www.google.com/maps?q=${selectedAlert.source.latitude},${selectedAlert.source.longitude}`}
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
                                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">IP</h4>
                                <div className="flex items-center gap-2">
                                    <span className="font-mono text-lg font-bold text-gray-900 dark:text-white">
                                        {selectedAlert.source?.ip || selectedAlert.source?.value || "N/A"}
                                    </span>
                                </div>
                                {selectedAlert.source?.range && (
                                    <div className="text-xs text-gray-400 font-mono mt-1">
                                        Range: {selectedAlert.source.range}
                                    </div>
                                )}
                                <div className="text-sm text-gray-500 mt-1">
                                    {selectedAlert.source?.as_number && (
                                        <a
                                            href={`https://bgp.he.net/AS${selectedAlert.source.as_number}`}
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
                        {selectedAlert.decisions && selectedAlert.decisions.length > 0 && (
                            <div>
                                <h4 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">Decisions Taken</h4>
                                <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
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
                                            {selectedAlert.decisions.map((decision, idx) => {
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
                                                    <tr key={idx}>
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
                                                                    to={`/decisions?alert_id=${selectedAlert.id}`}
                                                                    className="inline-flex items-center gap-2 px-2 py-1 rounded-full bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300 hover:bg-primary-100 dark:hover:bg-primary-900/30 transition-colors border border-primary-200 dark:border-primary-800"
                                                                    title="View active decision"
                                                                >
                                                                    <Shield size={14} className="fill-current" />
                                                                    <span className="text-xs font-semibold">Active</span>
                                                                    <ExternalLink size={12} className="ml-0.5" />
                                                                </Link>
                                                            ) : (
                                                                <Link
                                                                    to={`/decisions?alert_id=${selectedAlert.id}&include_expired=true`}
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
                            </div>
                        )}

                        {/* Events Breakdown */}
                        <div>
                            <h4 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
                                Events ({selectedAlert.events_count})
                            </h4>
                            <div className="space-y-2">
                                {selectedAlert.events?.slice(0, 10).map((event, idx) => {
                                    // Helper to extract meta value
                                    const getMeta = (key) => event.meta?.find(m => m.key === key)?.value;

                                    // Check if this is an AppSec event
                                    const isAppSecEvent = event.meta?.some(m =>
                                        m.key === 'matched_zones' || m.key === 'rule_name' || m.key === 'appsec_action'
                                    );

                                    // AppSec-specific fields
                                    const ruleName = getMeta('rule_name');
                                    const matchedZones = getMeta('matched_zones');
                                    const ruleIds = getMeta('rule_ids');
                                    const message = getMeta('msg') || getMeta('message');

                                    // Common fields
                                    const targetFqdn = getMeta('target_fqdn');
                                    const targetHost = getMeta('target_host');
                                    const targetUri = getMeta('target_uri') || getMeta('uri');
                                    const traefikRouter = getMeta('traefik_router_name');
                                    const httpVerb = getMeta('http_verb');
                                    const httpPath = getMeta('http_path');
                                    const httpStatus = getMeta('http_status');
                                    const httpUserAgent = getMeta('http_user_agent');
                                    const service = getMeta('service');

                                    return (
                                        <div key={idx} className={`p-3 rounded border text-sm ${isAppSecEvent
                                            ? 'bg-red-50 dark:bg-red-900/10 border-red-100 dark:border-red-900/30'
                                            : 'bg-gray-50 dark:bg-gray-900/30 border-gray-100 dark:border-gray-800'
                                            }`}>
                                            {/* AppSec Badge */}
                                            {isAppSecEvent && (
                                                <div className="mb-2 flex items-center gap-2">
                                                    <Badge variant="danger" className="flex items-center gap-1">
                                                        <Shield size={12} />
                                                        AppSec / WAF
                                                    </Badge>
                                                </div>
                                            )}

                                            <div className="space-y-2">
                                                {/* Timestamp and Service */}
                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                                    <div>
                                                        <span className="text-gray-500">Timestamp:</span> <span className="font-mono text-xs">{event.timestamp}</span>
                                                    </div>
                                                    {service && (
                                                        <div>
                                                            <span className="text-gray-500">Service:</span> {service}
                                                        </div>
                                                    )}
                                                </div>

                                                {/* Target FQDN/Host */}
                                                {(targetFqdn || targetHost) && (
                                                    <div>
                                                        <span className="text-gray-500">Target:</span> <span className="font-mono text-xs">{targetFqdn || targetHost}</span>
                                                    </div>
                                                )}

                                                {/* Traefik Router */}
                                                {traefikRouter && (
                                                    <div>
                                                        <span className="text-gray-500">Router:</span> <span className="font-mono text-xs">{traefikRouter}</span>
                                                    </div>
                                                )}

                                                {/* AppSec Rule Info */}
                                                {isAppSecEvent && ruleName && (
                                                    <div>
                                                        <span className="text-gray-500">Rule:</span>{' '}
                                                        {(() => {
                                                            const hubUrl = getHubUrl(ruleName);
                                                            return hubUrl ? (
                                                                <a
                                                                    href={hubUrl}
                                                                    target="_blank"
                                                                    rel="noopener noreferrer"
                                                                    className="font-mono text-xs hover:text-primary-600 dark:hover:text-primary-400 transition-colors inline-flex items-center gap-1"
                                                                >
                                                                    {ruleName}
                                                                    <ExternalLink size={10} />
                                                                </a>
                                                            ) : (
                                                                <span className="font-mono text-xs">{ruleName}</span>
                                                            );
                                                        })()}
                                                    </div>
                                                )}

                                                {/* AppSec Details */}
                                                {isAppSecEvent && (
                                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                                        {matchedZones && (
                                                            <div>
                                                                <span className="text-gray-500">Matched Zone:</span> <Badge variant="outline" className="ml-1">{matchedZones}</Badge>
                                                            </div>
                                                        )}
                                                        {ruleIds && (
                                                            <div>
                                                                <span className="text-gray-500">Rule ID:</span> <span className="font-mono text-xs">{ruleIds}</span>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}

                                                {/* Message/Description */}
                                                {isAppSecEvent && message && (
                                                    <div className="text-xs text-gray-600 dark:text-gray-300 italic">
                                                        {message}
                                                    </div>
                                                )}

                                                {/* HTTP Request Details */}
                                                {(httpVerb || httpPath || targetUri) && (
                                                    <div className="font-mono text-xs break-all bg-white dark:bg-gray-950 p-2 rounded border border-gray-200 dark:border-gray-800">
                                                        <span className="text-blue-600 dark:text-blue-400 font-bold">{httpVerb || 'GET'}</span> {httpPath || targetUri || '/'}
                                                        {(httpStatus || httpUserAgent) && (
                                                            <div className="text-gray-400 mt-1">
                                                                {httpStatus && `Status: ${httpStatus}`}
                                                                {httpStatus && httpUserAgent && ' | '}
                                                                {httpUserAgent && `UA: ${httpUserAgent}`}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                                {selectedAlert.events?.length > 10 && (
                                    <div className="text-center text-sm text-gray-500">
                                        + {selectedAlert.events.length - 10} more events
                                    </div>
                                )}
                            </div>
                        </div>

                    </div>
                )}
            </Modal>

            {/* Delete Confirmation Modal */}
            <Modal
                isOpen={!!alertToDelete}
                onClose={() => setAlertToDelete(null)}
                title="Delete Alert?"
                maxWidth="max-w-sm"
                showCloseButton={false}
            >
                <p className="text-gray-600 dark:text-gray-300 mb-6">
                    Are you sure you want to delete alert <span className="font-mono text-sm font-bold">#{alertToDelete}</span>? This will also delete all associated decisions. This action cannot be undone.
                </p>
                <div className="flex justify-end gap-3">
                    <button
                        onClick={() => setAlertToDelete(null)}
                        className="px-4 py-2 text-sm font-medium text-gray-700 bg-white dark:bg-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={confirmDelete}
                        className="px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                    >
                        Delete
                    </button>
                </div>
            </Modal>
        </div >
    );
}
