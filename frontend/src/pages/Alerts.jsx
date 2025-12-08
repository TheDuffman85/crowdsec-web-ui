import { useEffect, useState, useRef, useCallback } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { fetchAlerts, fetchAlert } from "../lib/api";
import { Badge } from "../components/ui/Badge";
import { Search, Info, ExternalLink, Shield } from "lucide-react";
import "flag-icons/css/flag-icons.min.css";

export function Alerts() {
    const [alerts, setAlerts] = useState([]);
    const [filter, setFilter] = useState("");
    const [loading, setLoading] = useState(true);
    const [selectedAlert, setSelectedAlert] = useState(null);
    const [displayedCount, setDisplayedCount] = useState(50);
    const [searchParams, setSearchParams] = useSearchParams();

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

    useEffect(() => {
        const loadAlerts = async () => {
            try {
                const alertsData = await fetchAlerts();
                setAlerts(alertsData);

                // Check if there's an alert ID in the URL
                const alertIdParam = searchParams.get("id");
                if (alertIdParam) {
                    const existingAlert = alertsData.find(a => String(a.id) === alertIdParam);
                    if (existingAlert) {
                        setSelectedAlert(existingAlert);
                    } else {
                        // Fetch the specific alert if not in the list
                        try {
                            const alertData = await fetchAlert(alertIdParam);
                            setSelectedAlert(alertData);
                        } catch (err) {
                            console.error("Alert not found", err);
                        }
                    }
                }

                // Check for generic search query param
                const queryParam = searchParams.get("q");
                if (queryParam) {
                    setFilter(queryParam);
                }

            } catch (err) {
                console.error(err);
            } finally {
                setLoading(false);
            }
        };
        loadAlerts();
    }, [searchParams, setSearchParams]);

    const filteredAlerts = alerts.filter(alert => {
        const search = filter.toLowerCase();

        // Specific query params
        const paramIp = (searchParams.get("ip") || "").toLowerCase();
        const paramCountry = (searchParams.get("country") || "").toLowerCase();
        const paramScenario = (searchParams.get("scenario") || "").toLowerCase();
        const paramAs = (searchParams.get("as") || "").toLowerCase();

        const scenario = (alert.scenario || "").toLowerCase();
        const message = (alert.message || "").toLowerCase();
        const ip = (alert.source?.ip || alert.source?.value || "").toLowerCase();
        const cn = (alert.source?.cn || "").toLowerCase();
        const asName = (alert.source?.as_name || "").toLowerCase();

        // Check specific filters if present
        if (paramIp && !ip.includes(paramIp)) return false;
        if (paramCountry && !cn.includes(paramCountry)) return false;
        if (paramScenario && !scenario.includes(paramScenario)) return false;
        if (paramAs && !asName.includes(paramAs)) return false;

        // Check generic search
        if (search) {
            return scenario.includes(search) ||
                message.includes(search) ||
                ip.includes(search) ||
                cn.includes(search) ||
                asName.includes(search);
        }

        return true;
    });

    const visibleAlerts = filteredAlerts.slice(0, displayedCount);

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <h2 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">Alerts</h2>
                {(filteredAlerts.length !== alerts.length) && (
                    <div className="text-sm text-gray-500">
                        Showing {filteredAlerts.length} of {alerts.length} alerts
                    </div>
                )}
            </div>

            {/* Show active filters */}
            {(searchParams.get("ip") || searchParams.get("country") || searchParams.get("scenario") || searchParams.get("as")) && (
                <div className="flex flex-wrap gap-2">
                    {["ip", "country", "scenario", "as"].map(key => {
                        const val = searchParams.get(key);
                        if (!val) return null;
                        return (
                            <Badge key={key} variant="secondary" className="flex items-center gap-1">
                                <span className="font-semibold uppercase">{key}:</span> {val}
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
                        Clear all filters
                    </button>
                </div>
            )}

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
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">ID</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Time</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">IP</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Country</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Scenario</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Message</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Decisions</th>
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
                                            onClick={() => setSelectedAlert(alert)}
                                            className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors cursor-pointer"
                                        >
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                                                #{alert.id}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                                                {new Date(alert.created_at).toLocaleString()}
                                            </td>
                                            <td className="px-6 py-4 text-sm font-mono text-gray-900 dark:text-gray-100 max-w-[200px] truncate" title={alert.source?.ip || alert.source?.value}>
                                                {alert.source?.ip || alert.source?.value || "N/A"}
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 flex items-center gap-2">
                                                {alert.source?.cn ? (
                                                    <>
                                                        <span className={`fi fi-${alert.source.cn.toLowerCase()}`}></span>
                                                        <span>{alert.source.cn}</span>
                                                    </>
                                                ) : (
                                                    "Unknown"
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 max-w-[200px] truncate" title={alert.scenario}>
                                                <Badge variant="warning" className="truncate block w-full">{alert.scenario}</Badge>
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400 max-w-xs truncate" title={alert.message}>
                                                {alert.message}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm" onClick={(e) => e.stopPropagation()}>
                                                {alert.decisions && alert.decisions.length > 0 ? (() => {
                                                    // Check if there are any active (non-expired) decisions
                                                    const activeDecisions = alert.decisions.filter(d => {
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
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {selectedAlert && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => setSelectedAlert(null)}>
                    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto flex flex-col" onClick={e => e.stopPropagation()}>

                        {/* Header */}
                        <div className="flex justify-between items-center p-6 border-b border-gray-100 dark:border-gray-700">
                            <div>
                                <h3 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                                    Alert Details <span className="text-gray-400">#{selectedAlert.id}</span>
                                </h3>
                                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                                    Captured at {new Date(selectedAlert.created_at).toLocaleString()}
                                </p>
                            </div>
                            <button onClick={() => setSelectedAlert(null)} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors text-gray-500 dark:text-gray-400">
                                ✕
                            </button>
                        </div>

                        {/* Content */}
                        <div className="p-6 space-y-6">

                            {/* Summary Cards */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div className="p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-100 dark:border-gray-700/50">
                                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Scenario</h4>
                                    <div className="font-medium text-gray-900 dark:text-gray-100 break-words">
                                        <Badge variant="warning">{selectedAlert.scenario}</Badge>
                                    </div>
                                </div>
                                <div className="p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-100 dark:border-gray-700/50">
                                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Attacker IP</h4>
                                    <div className="flex items-center gap-2">
                                        <span className="font-mono text-lg font-bold text-gray-900 dark:text-white">
                                            {selectedAlert.source?.ip || selectedAlert.source?.value || "N/A"}
                                        </span>
                                    </div>
                                    <div className="text-sm text-gray-500 mt-1">
                                        {selectedAlert.source?.as_name} ({selectedAlert.source?.as_number})
                                    </div>
                                </div>
                                <div className="p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-100 dark:border-gray-700/50">
                                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Location</h4>
                                    <div className="text-lg text-gray-900 dark:text-gray-100 font-medium">
                                        {selectedAlert.source?.cn}
                                    </div>
                                    <div className="text-xs text-gray-400 font-mono mt-1">
                                        Lat: {selectedAlert.source?.latitude}, Long: {selectedAlert.source?.longitude}
                                    </div>
                                </div>
                            </div>

                            {/* AppSec / WAF Context */}
                            {(() => {
                                // Find an event with AppSec data
                                const appSecEvent = selectedAlert.events?.find(e =>
                                    e.meta?.some(m => m.key === 'waf_rule_id' || m.key === 'rule_type' && m.value === 'appsec_rule')
                                );

                                if (!appSecEvent) return null;

                                const getMeta = (key) => appSecEvent.meta?.find(m => m.key === key)?.value;
                                const wafRuleId = getMeta('waf_rule_id');
                                const matchedZone = getMeta('matched_zone');
                                const match = getMeta('match');
                                const ruleType = getMeta('rule_type');

                                return (
                                    <div className="p-5 bg-red-50 dark:bg-red-900/10 rounded-lg border border-red-100 dark:border-red-900/30">
                                        <h4 className="text-lg font-bold text-red-700 dark:text-red-400 mb-4 flex items-center gap-2">
                                            <Shield size={20} /> AppSec Violation
                                        </h4>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                            <div>
                                                <h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Rule ID</h5>
                                                <div className="font-mono text-sm text-gray-900 dark:text-gray-100 font-medium">{wafRuleId || "N/A"}</div>
                                            </div>
                                            <div>
                                                <h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Matched Zone</h5>
                                                <div className="font-mono text-sm text-gray-900 dark:text-gray-100">
                                                    <Badge variant="outline">{matchedZone || "N/A"}</Badge>
                                                </div>
                                            </div>
                                            {match && (
                                                <div className="col-span-1 md:col-span-2">
                                                    <h5 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Malicious Payload (Match)</h5>
                                                    <div className="font-mono text-xs bg-white dark:bg-gray-950 p-3 rounded border border-gray-200 dark:border-gray-800 break-all text-red-600 dark:text-red-400">
                                                        {match}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })()}

                            {/* Decisions */}
                            {selectedAlert.decisions && selectedAlert.decisions.length > 0 && (
                                <div>
                                    <div className="flex justify-between items-center mb-3">
                                        <h4 className="text-lg font-semibold text-gray-900 dark:text-white">Decisions Taken</h4>
                                        <Link
                                            to={`/decisions?alert_id=${selectedAlert.id}`}
                                            className="p-2 rounded-full text-primary-600 hover:text-primary-800 dark:text-primary-400 dark:hover:text-primary-200 hover:bg-primary-50 dark:hover:bg-primary-900/20 transition-colors"
                                            title="View in Decisions"
                                        >
                                            <ExternalLink size={18} />
                                        </Link>
                                    </div>
                                    <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
                                        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                                            <thead className="bg-gray-50 dark:bg-gray-900">
                                                <tr>
                                                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                                                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Value</th>
                                                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Duration</th>
                                                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Origin</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-800">
                                                {selectedAlert.decisions.map((decision, idx) => (
                                                    <tr key={idx}>
                                                        <td className="px-4 py-2 text-sm"><Badge variant="danger">{decision.type}</Badge></td>
                                                        <td className="px-4 py-2 text-sm font-mono">{decision.value}</td>
                                                        <td className="px-4 py-2 text-sm">{decision.duration}</td>
                                                        <td className="px-4 py-2 text-sm">{decision.origin}</td>
                                                    </tr>
                                                ))}
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
                                        const getMeta = (key) => event.meta?.find(m => m.key === key)?.value || "-";

                                        return (
                                            <div key={idx} className="p-3 bg-gray-50 dark:bg-gray-900/30 rounded border border-gray-100 dark:border-gray-800 text-sm">
                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                                    <div>
                                                        <span className="text-gray-500">Timestamp:</span> <span className="font-mono text-xs">{event.timestamp}</span>
                                                    </div>
                                                    <div>
                                                        <span className="text-gray-500">Service:</span> {getMeta('service')}
                                                    </div>
                                                    <div className="col-span-1 md:col-span-2 font-mono text-xs break-all bg-white dark:bg-gray-950 p-2 rounded border border-gray-200 dark:border-gray-800 mt-1">
                                                        <span className="text-blue-600 dark:text-blue-400 font-bold">{getMeta('http_verb')}</span> {getMeta('http_path') || getMeta('target_fqdn')}
                                                        <div className="text-gray-400 mt-1">Status: {getMeta('http_status')} | UA: {getMeta('http_user_agent')}</div>
                                                    </div>
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
                    </div>
                </div>
            )}
        </div>
    );
}
