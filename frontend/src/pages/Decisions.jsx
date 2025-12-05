import { useEffect, useState } from "react";
import { fetchDecisions, deleteDecision } from "../lib/api";
import { Badge } from "../components/ui/Badge";
import { Trash2 } from "lucide-react";

export function Decisions() {
    const [decisions, setDecisions] = useState([]);
    const [loading, setLoading] = useState(true);

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
            </div>

            <div className="bg-white dark:bg-gray-800 shadow-sm rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                        <thead className="bg-gray-50 dark:bg-gray-900/50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">ID</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Source</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Scenario</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Value</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Type</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {loading ? (
                                <tr><td colSpan="6" className="px-6 py-4 text-center text-sm text-gray-500">Loading decisions...</td></tr>
                            ) : decisions.length === 0 ? (
                                <tr><td colSpan="6" className="px-6 py-4 text-center text-sm text-gray-500">No active decisions</td></tr>
                            ) : (
                                decisions.map((decision) => (
                                    <tr key={decision.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                                            #{decision.id}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                                            {decision.detail.origin || "Unknown"}
                                        </td>
                                        <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                                            <span className="font-mono text-xs">{decision.scenario}</span>
                                        </td>
                                        <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                                            <span className="font-mono">{decision.value}</span>
                                        </td>
                                        <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                                            <Badge variant="danger">{decision.detail.type || "ban"}</Badge>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                            <button
                                                onClick={() => handleDelete(decision.id)}
                                                className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 transition-colors"
                                                title="Delete Decision"
                                            >
                                                <Trash2 size={18} />
                                            </button>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
