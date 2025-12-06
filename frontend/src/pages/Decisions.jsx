import { useEffect, useState } from "react";
import { fetchDecisions, deleteDecision, addDecision } from "../lib/api";
import { Badge } from "../components/ui/Badge";
import { Trash2, Gavel } from "lucide-react";

export function Decisions() {
    const [decisions, setDecisions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showAddModal, setShowAddModal] = useState(false);
    const [newDecision, setNewDecision] = useState({ ip: "", duration: "4h", reason: "manual" });

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

    const loadDecisions = () => {
        setLoading(true);
        fetchDecisions()
            .then(setDecisions)
            .catch(console.error)
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        loadDecisions();
    }, []);

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

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <h2 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">Decisions</h2>
                <button
                    onClick={() => setShowAddModal(true)}
                    className="bg-primary-600 hover:bg-primary-700 text-white font-medium py-2 px-4 rounded-md transition-colors flex items-center gap-2 text-sm"
                >
                    <Gavel size={16} />
                    Add Decision
                </button>
            </div>

            <div className="bg-white dark:bg-gray-800 shadow-sm rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                        <thead className="bg-gray-50 dark:bg-gray-900/50">
                            <tr>
                                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">ID</th>
                                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Source</th>
                                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Scope:Value</th>
                                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Reason</th>
                                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Action</th>
                                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Country</th>
                                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">AS</th>
                                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Events</th>
                                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Expiration</th>
                                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Alert ID</th>
                                <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {loading ? (
                                <tr><td colSpan="11" className="px-6 py-4 text-center text-sm text-gray-500">Loading decisions...</td></tr>
                            ) : decisions.length === 0 ? (
                                <tr><td colSpan="11" className="px-6 py-4 text-center text-sm text-gray-500">No active decisions</td></tr>
                            ) : (
                                decisions.map((decision) => (
                                    <tr key={decision.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                                        <td className="px-3 py-4 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
                                            #{decision.id}
                                        </td>
                                        <td className="px-3 py-4 whitespace-nowrap text-xs text-gray-900 dark:text-gray-100">
                                            {decision.detail.origin || "Unknown"}
                                        </td>
                                        <td className="px-3 py-4 text-xs font-mono text-gray-900 dark:text-gray-100">
                                            ip:{decision.value}
                                        </td>
                                        <td className="px-3 py-4 text-xs text-gray-900 dark:text-gray-100 max-w-[200px] truncate" title={decision.detail.reason}>
                                            {decision.detail.reason}
                                        </td>
                                        <td className="px-3 py-4 text-xs text-gray-900 dark:text-gray-100">
                                            <Badge variant="danger">{decision.detail.action || "ban"}</Badge>
                                        </td>
                                        <td className="px-3 py-4 text-xs text-gray-900 dark:text-gray-100">
                                            {decision.detail.country}
                                        </td>
                                        <td className="px-3 py-4 text-xs text-gray-900 dark:text-gray-100 max-w-[150px] truncate" title={decision.detail.as}>
                                            {decision.detail.as}
                                        </td>
                                        <td className="px-3 py-4 text-xs text-gray-900 dark:text-gray-100">
                                            {decision.detail.events_count}
                                        </td>
                                        <td className="px-3 py-4 text-xs text-gray-900 dark:text-gray-100">
                                            {new Date(decision.detail.expiration).toLocaleString()}
                                        </td>
                                        <td className="px-3 py-4 text-xs text-gray-500 dark:text-gray-400">
                                            {decision.detail.alert_id}
                                        </td>
                                        <td className="px-3 py-4 whitespace-nowrap text-right text-sm font-medium">
                                            <button
                                                onClick={() => handleDelete(decision.id)}
                                                className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 transition-colors"
                                                title="Delete Decision"
                                            >
                                                <Trash2 size={16} />
                                            </button>
                                        </td>
                                    </tr>
                                ))
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
            )}
        </div>
    );
}
