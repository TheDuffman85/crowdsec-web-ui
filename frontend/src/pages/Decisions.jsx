import { useEffect, useState, useRef, useCallback } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { fetchDecisions, deleteDecision, addDecision } from "../lib/api";
import { useRefresh } from "../contexts/RefreshContext";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { ScenarioName } from "../components/ScenarioName";
import { TimeDisplay } from "../components/TimeDisplay";
import { getHubUrl, getCountryName } from "../lib/utils";
import { getAlertTarget } from "../lib/stats";
import { Trash2, Gavel, X, ExternalLink, Shield, Search } from "lucide-react";
import "flag-icons/css/flag-icons.min.css";

export function Decisions() {
    const { refreshSignal, setLastUpdated } = useRefresh();
    const [decisions, setDecisions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showAddModal, setShowAddModal] = useState(false);
    const [filter, setFilter] = useState("");
    const [decisionToDelete, setDecisionToDelete] = useState(null);
    const [newDecision, setNewDecision] = useState({ ip: "", duration: "4h", reason: "manual" });
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

    const [displayedCount, setDisplayedCount] = useState(50);

    // Intersection Observer for infinite scroll
    const observer = useRef();
    const lastDecisionElementRef = useCallback(node => {
        if (loading) return;
        if (observer.current) observer.current.disconnect();
        observer.current = new IntersectionObserver(entries => {
            if (entries[0].isIntersecting) {
                setDisplayedCount(prev => prev + 50);
            }
        });
        if (node) observer.current.observe(node);
    }, [loading]);

    const loadDecisions = useCallback(async (isBackground = false) => {
        if (!isBackground) setLoading(true);
        try {
            const url = includeExpiredParam ? '/api/decisions?include_expired=true' : '/api/decisions';
            const res = await fetch(url);
            if (!res.ok) throw new Error('Failed to fetch decisions');
            const data = await res.json();
            setDecisions(data);

            // Check for generic search query param
            const queryParam = searchParams.get("q");
            if (queryParam) {
                setFilter(queryParam);
            }

            setLastUpdated(new Date());
        } catch (error) {
            console.error(error);
        } finally {
            if (!isBackground) setLoading(false);
        }
    }, [includeExpiredParam, setLastUpdated, searchParams]); // Added searchParams dependency

    useEffect(() => {
        loadDecisions(false);
    }, [loadDecisions]);

    useEffect(() => {
        if (refreshSignal > 0) loadDecisions(true);
    }, [refreshSignal, loadDecisions]);

    const handleAddDecision = async (e) => {
        e.preventDefault();
        try {
            await addDecision(newDecision);
            setShowAddModal(false);
            setNewDecision({ ip: "", duration: "4h", reason: "manual" });
            loadDecisions();
        } catch (error) {
            console.error("Failed to add decision", error);
            alert("Failed to add decision");
        }
    };


    // Trigger modal instead of window.confirm
    const requestDelete = (id) => {
        setDecisionToDelete(id);
    };

    const confirmDelete = async () => {
        if (!decisionToDelete) return;
        try {
            await deleteDecision(decisionToDelete);
            setDecisionToDelete(null);
            loadDecisions();
        } catch (error) {
            console.error("Failed to delete decision", error);
            alert("Failed to delete decision");
        }
    };

    const clearFilter = () => {
        setSearchParams({});
    };

    const removeParam = (key) => {
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

    const filteredDecisions = decisions.filter(decision => {
        // Debug logging
        // console.log("Filtering decision:", decision.value, "Target Filter:", targetFilter);

        // 1. Alert ID Filter
        if (alertIdFilter && String(decision.detail.alert_id) !== alertIdFilter) return false;

        // 2. Exact Field Filters (from Dashboard)
        if (countryFilter && decision.detail.country !== countryFilter) return false;
        if (scenarioFilter && decision.detail.reason !== scenarioFilter) return false;
        if (asFilter && decision.detail.as !== asFilter) return false;
        if (asFilter && decision.detail.as !== asFilter) return false;
        if (ipFilter && decision.value !== ipFilter) return false;
        if (targetFilter) {
            const decisionTarget = (decision.value || "").toLowerCase();
            const alertTarget = (getAlertTarget(decision.detail) || "").toLowerCase();
            const filterValue = targetFilter.toLowerCase();

            if (!decisionTarget.includes(filterValue) && !alertTarget.includes(filterValue)) {
                return false;
            }
        }

        // 3. Date Range Filter
        if (dateStartFilter || dateEndFilter) {
            if (!decision.created_at) return false;

            // Helper to extract date/time key from ISO timestamp (Matches Alerts.jsx logic)
            // This ensures we compare "apples to apples" with the dashboard local-time based filters
            const getItemKey = (isoString) => {
                const date = new Date(isoString);
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');

                // If filter includes time (has 'T'), use hourly precision
                if ((dateStartFilter && dateStartFilter.includes('T')) || (dateEndFilter && dateEndFilter.includes('T'))) {
                    const hour = String(date.getHours()).padStart(2, '0');
                    return `${year}-${month}-${day}T${hour}`;
                }
                return `${year}-${month}-${day}`;
            };

            const itemKey = getItemKey(decision.created_at);

            if (dateStartFilter && itemKey < dateStartFilter) return false;
            if (dateEndFilter && itemKey > dateEndFilter) return false;
        }



        // 4. Generic Text Search (existing)
        const search = filter.toLowerCase();
        if (!search) return true;

        const ip = (decision.value || "").toLowerCase();
        const reason = (decision.detail.reason || "").toLowerCase();
        const country = (getCountryName(decision.detail.country) || "").toLowerCase();
        const as = (decision.detail.as || "").toLowerCase();
        const type = (decision.type || "").toLowerCase();
        const action = (decision.detail.action || "").toLowerCase();

        return ip.includes(search) ||
            reason.includes(search) ||
            country.includes(search) ||
            as.includes(search) ||
            type.includes(search) ||
            action.includes(search);
    });

    const visibleDecisions = filteredDecisions.slice(0, displayedCount);

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <div className="flex items-center gap-3">
                    <h2 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">Decisions</h2>
                    {(filteredDecisions.length !== decisions.length) && (
                        <div className="text-sm text-gray-500">
                            Showing {filteredDecisions.length} of {decisions.length} decisions
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-3">

                    <button
                        onClick={() => setShowAddModal(true)}
                        className="bg-primary-600 hover:bg-primary-700 text-white font-medium py-2 px-4 rounded-md transition-colors flex items-center gap-2 text-sm"
                    >
                        <Gavel size={16} />
                        Add Decision
                    </button>
                </div>
            </div>

            {/* Show active filters */}
            {(includeExpiredParam || !includeExpiredParam || alertIdFilter || countryFilter || scenarioFilter || asFilter || ipFilter || targetFilter || dateStartFilter || dateEndFilter) && (
                <div className="flex flex-wrap gap-2">
                    {!includeExpiredParam && (
                        <Badge variant="secondary" className="flex items-center gap-1">
                            <span className="font-semibold uppercase">STATUS:</span> ACTIVE
                            <button
                                onClick={toggleExpired}
                                className="ml-1 hover:text-red-500"
                            >
                                &times;
                            </button>
                        </Badge>
                    )}
                    {alertIdFilter && (
                        <Badge variant="secondary" className="flex items-center gap-1">
                            <span className="font-semibold uppercase">ALERT:</span> #{alertIdFilter}
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
                            <span className="font-semibold uppercase">COUNTRY:</span> {countryFilter}
                            <button
                                onClick={() => removeParam("country")}
                                className="ml-1 hover:text-red-500"
                            >
                                &times;
                            </button>
                        </Badge>
                    )}
                    {searchParams.get("scenario") && (
                        <Badge variant="secondary" className="flex items-center gap-1 max-w-[300px] truncate" title={scenarioFilter}>
                            <span className="font-semibold uppercase">SCENARIO:</span> {scenarioFilter}
                            <button
                                onClick={() => removeParam("scenario")}
                                className="ml-1 hover:text-red-500"
                            >
                                &times;
                            </button>
                        </Badge>
                    )}
                    {searchParams.get("as") && (
                        <Badge variant="secondary" className="flex items-center gap-1 max-w-[300px] truncate" title={asFilter}>
                            <span className="font-semibold uppercase">AS:</span> {asFilter}
                            <button
                                onClick={() => removeParam("as")}
                                className="ml-1 hover:text-red-500"
                            >
                                &times;
                            </button>
                        </Badge>
                    )}
                    {searchParams.get("ip") && (
                        <Badge variant="secondary" className="flex items-center gap-1">
                            <span className="font-semibold uppercase">IP:</span> {ipFilter}
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
                            <span className="font-semibold uppercase">TARGET:</span> {targetFilter}
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
                            <span className="font-semibold uppercase">DATESTART:</span> {dateStartFilter}
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
                            <span className="font-semibold uppercase">DATEEND:</span> {dateEndFilter}
                            <button
                                onClick={() => removeParam("dateEnd")}
                                className="ml-1 hover:text-red-500"
                            >
                                &times;
                            </button>
                        </Badge>
                    )}

                    {/* Show Reset button if we have any active filters OR if we are showing expired (non-default state) */}
                    {(alertIdFilter || countryFilter || scenarioFilter || asFilter || ipFilter || targetFilter || dateStartFilter || dateEndFilter || includeExpiredParam) && (
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
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Time</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Scenario</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Country</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">AS</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">IP</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Action</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Expiration</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Alert</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {loading ? (
                                <tr><td colSpan="9" className="px-6 py-4 text-center text-sm text-gray-500">Loading decisions...</td></tr>
                            ) : visibleDecisions.length === 0 ? (
                                <tr><td colSpan="9" className="px-6 py-4 text-center text-sm text-gray-500">{alertIdFilter ? "No decisions for this alert" : "No decisions found"}</td></tr>
                            ) : (
                                visibleDecisions.map((decision, index) => {
                                    const isExpired = decision.expired || (decision.detail.duration && decision.detail.duration.startsWith("-"));
                                    const rowClasses = isExpired
                                        ? "hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors opacity-60 bg-gray-50 dark:bg-gray-900/20"
                                        : "hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors";

                                    const isLastElement = index === visibleDecisions.length - 1;

                                    return (
                                        <tr
                                            key={decision.id}
                                            className={rowClasses}
                                            ref={isLastElement ? lastDecisionElementRef : null}
                                        >
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                                                <TimeDisplay timestamp={decision.created_at} />
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 max-w-[200px]" title={decision.detail.reason}>
                                                <ScenarioName name={decision.detail.reason} showLink={true} />
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 align-middle">
                                                {decision.detail.country ? (
                                                    <div className="flex items-center gap-2" title={decision.detail.country}>
                                                        <span className={`fi fi-${decision.detail.country.toLowerCase()} flex-shrink-0`}></span>
                                                        <span>{getCountryName(decision.detail.country)}</span>
                                                    </div>
                                                ) : (
                                                    "Unknown"
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 max-w-[150px] truncate" title={decision.detail.as}>
                                                {decision.detail.as}
                                            </td>
                                            <td className="px-6 py-4 text-sm font-mono text-gray-900 dark:text-gray-100 max-w-[200px] truncate" title={decision.value}>
                                                {decision.value}
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                                                <Badge variant="danger">{decision.detail.action || "ban"}</Badge>
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 whitespace-nowrap">
                                                {decision.detail.duration}
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
                isOpen={!!decisionToDelete}
                onClose={() => setDecisionToDelete(null)}
                title="Delete Decision?"
                maxWidth="max-w-sm"
                showCloseButton={false}
            >
                <p className="text-gray-600 dark:text-gray-300 mb-6">
                    Are you sure you want to delete decision <span className="font-mono text-sm font-bold">#{decisionToDelete}</span>? This action cannot be undone.
                </p>
                <div className="flex justify-end gap-3">
                    <button
                        onClick={() => setDecisionToDelete(null)}
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

            {/* Add Decision Modal */}
            <Modal
                isOpen={showAddModal}
                onClose={() => setShowAddModal(false)}
                title="Add Manual Decision"
                maxWidth="max-w-md"
            >
                <form onSubmit={handleAddDecision} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">IP Address</label>
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
