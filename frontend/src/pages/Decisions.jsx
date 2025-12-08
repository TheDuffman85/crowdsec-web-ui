import { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { fetchDecisions, deleteDecision, addDecision } from "../lib/api";
import { Badge } from "../components/ui/Badge";
import { getHubUrl } from "../lib/utils";
import { Trash2, Gavel, X, ExternalLink, Shield } from "lucide-react";
import "flag-icons/css/flag-icons.min.css";

export function Decisions() {
    const [decisions, setDecisions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showAddModal, setShowAddModal] = useState(false);
    const [newDecision, setNewDecision] = useState({ ip: "", duration: "4h", reason: "manual" });
    const [searchParams, setSearchParams] = useSearchParams();
    const alertIdFilter = searchParams.get("alert_id");
    const includeExpiredParam = searchParams.get("include_expired") === "true";
    const [showExpired, setShowExpired] = useState(includeExpiredParam);

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

    const loadDecisions = async () => {
        setLoading(true);
        try {
            const url = showExpired ? '/api/decisions?include_expired=true' : '/api/decisions';
            const res = await fetch(url);
            if (!res.ok) throw new Error('Failed to fetch decisions');
            const data = await res.json();
            setDecisions(data);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadDecisions();
    }, [showExpired]);

    const handleDelete = async (id) => {
        if (!window.confirm("Are you sure you want to delete this decision?")) return;
        try {
            await deleteDecision(id);
            loadDecisions();
        } catch (error) {
            console.error("Failed to delete decision", error);
            alert("Failed to delete decision");
        }
    };

    const clearFilter = () => {
        setSearchParams({});
    };

    const toggleExpired = () => {
        const newValue = !showExpired;
        setShowExpired(newValue);

        // Update URL params
        const newParams = new URLSearchParams(searchParams);
        if (newValue) {
            newParams.set('include_expired', 'true');
        } else {
            newParams.delete('include_expired');
        }
        setSearchParams(newParams);
    };

    const filteredDecisions = alertIdFilter
        ? decisions.filter(d => String(d.detail.alert_id) === alertIdFilter)
        : decisions;

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <div className="flex items-center gap-3">
                    <h2 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">Decisions</h2>
                    {alertIdFilter && (
                        <button
                            onClick={clearFilter}
                            className="flex items-center gap-1 text-sm bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 px-3 py-1 rounded-full hover:bg-primary-200 dark:hover:bg-primary-900/50 transition-colors"
                        >
                            Filtered by Alert #{alertIdFilter}
                            <X size={14} />
                        </button>
                    )}
                    {showExpired && !alertIdFilter && (
                        <button
                            onClick={toggleExpired}
                            className="flex items-center gap-1 text-sm bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 px-3 py-1 rounded-full hover:bg-orange-200 dark:hover:bg-orange-900/50 transition-colors"
                        >
                            Including Expired Decisions
                            <X size={14} />
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    {!showExpired && !alertIdFilter && (
                        <button
                            onClick={toggleExpired}
                            className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 transition-colors"
                        >
                            Show Expired
                        </button>
                    )}
                    <button
                        onClick={() => setShowAddModal(true)}
                        className="bg-primary-600 hover:bg-primary-700 text-white font-medium py-2 px-4 rounded-md transition-colors flex items-center gap-2 text-sm"
                    >
                        <Gavel size={16} />
                        Add Decision
                    </button>
                </div>
            </div>

            <div className="bg-white dark:bg-gray-800 shadow-sm rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                        <thead className="bg-gray-50 dark:bg-gray-900/50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">ID</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Time</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">IP</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Country</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Scenario</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Action</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">AS</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Expiration</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Alert</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {loading ? (
                                <tr><td colSpan="10" className="px-6 py-4 text-center text-sm text-gray-500">Loading decisions...</td></tr>
                            ) : filteredDecisions.length === 0 ? (
                                <tr><td colSpan="10" className="px-6 py-4 text-center text-sm text-gray-500">{alertIdFilter ? "No decisions for this alert" : "No decisions found"}</td></tr>
                            ) : (
                                filteredDecisions.map((decision) => {
                                    const isExpired = decision.expired;
                                    const rowClasses = isExpired
                                        ? "hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors opacity-60 bg-gray-50 dark:bg-gray-900/20"
                                        : "hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors";

                                    return (
                                        <tr key={decision.id} className={rowClasses}>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                                                #{decision.id}
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                                                {new Date(decision.created_at).toLocaleString()}
                                            </td>
                                            <td className="px-6 py-4 text-sm font-mono text-gray-900 dark:text-gray-100 max-w-[200px] truncate" title={decision.value}>
                                                {decision.value}
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 flex items-center gap-2">
                                                {decision.detail.country ? (
                                                    <>
                                                        <span className={`fi fi-${decision.detail.country.toLowerCase()}`}></span>
                                                        <span>{decision.detail.country}</span>
                                                    </>
                                                ) : (
                                                    decision.detail.country || "Unknown"
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 max-w-[200px] truncate" title={decision.detail.reason}>
                                                {(() => {
                                                    const hubUrl = getHubUrl(decision.detail.reason);
                                                    return hubUrl ? (
                                                        <a href={hubUrl} target="_blank" rel="noopener noreferrer" className="hover:underline text-primary-600 dark:text-primary-400">
                                                            <Badge variant="warning" className="truncate block w-full">{decision.detail.reason}</Badge>
                                                        </a>
                                                    ) : (
                                                        <Badge variant="warning" className="truncate block w-full">{decision.detail.reason}</Badge>
                                                    );
                                                })()}
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                                                <Badge variant="danger">{decision.detail.action || "ban"}</Badge>
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100 max-w-[150px] truncate" title={decision.detail.as}>
                                                {decision.detail.as}
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
                                                    onClick={() => !isExpired && handleDelete(decision.id)}
                                                    disabled={isExpired}
                                                    className={`transition-colors ${isExpired ? 'text-gray-400 cursor-not-allowed' : 'text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300'}`}
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

            {showAddModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => setShowAddModal(false)}>
                    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6" onClick={e => e.stopPropagation()}>
                        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-4">Add Manual Decision</h3>
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
                    </div>
                </div>
            )
            }
        </div >
    );
}
