import { useEffect, useState } from "react";
import { fetchAlerts } from "../lib/api";
import { Badge } from "../components/ui/Badge";
import { Search, Info } from "lucide-react";

export function Alerts() {
    const [alerts, setAlerts] = useState([]);
    const [filter, setFilter] = useState("");
    const [loading, setLoading] = useState(true);
    const [selectedAlert, setSelectedAlert] = useState(null);

    useEffect(() => {
        fetchAlerts().then(setAlerts).catch(console.error).finally(() => setLoading(false));
    }, []);

    const filteredAlerts = alerts.filter(alert =>
        (alert.scenario || "").toLowerCase().includes(filter.toLowerCase()) ||
        (alert.message || "").toLowerCase().includes(filter.toLowerCase())
    );

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <h2 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">Alerts</h2>
            </div>

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
                    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                        <thead className="bg-gray-50 dark:bg-gray-900/50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">ID</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Time</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Scenario</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Message</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {loading ? (
                                <tr><td colSpan="5" className="px-6 py-4 text-center text-sm text-gray-500">Loading alerts...</td></tr>
                            ) : filteredAlerts.length === 0 ? (
                                <tr><td colSpan="5" className="px-6 py-4 text-center text-sm text-gray-500">No alerts found</td></tr>
                            ) : (
                                filteredAlerts.map((alert) => (
                                    <tr key={alert.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                                            #{alert.id}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                                            {new Date(alert.created_at).toLocaleString()}
                                        </td>
                                        <td className="px-6 py-4 text-sm text-gray-900 dark:text-gray-100">
                                            <Badge variant="warning">{alert.scenario}</Badge>
                                        </td>
                                        <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400 max-w-xs truncate" title={alert.message}>
                                            {alert.message}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                            <button
                                                onClick={() => setSelectedAlert(alert)}
                                                className="text-primary-600 hover:text-primary-900 dark:text-primary-400 dark:hover:text-primary-300"
                                            >
                                                <Info size={18} />
                                            </button>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {selectedAlert && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => setSelectedAlert(null)}>
                    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
                        <div className="flex justify-between items-start mb-4">
                            <h3 className="text-xl font-bold text-gray-900 dark:text-white">Alert Details #{selectedAlert.id}</h3>
                            <button onClick={() => setSelectedAlert(null)} className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                                ✕
                            </button>
                        </div>
                        <pre className="bg-gray-100 dark:bg-gray-900 p-4 rounded-md overflow-x-auto text-sm text-gray-800 dark:text-gray-200">
                            {JSON.stringify(selectedAlert, null, 2)}
                        </pre>
                    </div>
                </div>
            )}
        </div>
    );
}
