import { useState, useEffect } from "react";
import { Trash2, Plus, Shield, CheckCircle, AlertTriangle } from "lucide-react";
import { Badge } from "../components/ui/Badge";
import { fetchAllowlist, addToAllowlist, removeFromAllowlist } from "../lib/api";

export function Allowlist() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [newItem, setNewItem] = useState("");
    const [adding, setAdding] = useState(false);
    const [successMessage, setSuccessMessage] = useState(null);

    const loadData = async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await fetchAllowlist();
            setItems(data);
        } catch (err) {
            console.error("Failed to fetch allowlist", err);
            setError("Failed to load allowlist. Ensure Agent is running.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadData();
    }, []);

    const handleAdd = async (e) => {
        e.preventDefault();
        if (!newItem) return;
        setAdding(true);
        setError(null);
        setSuccessMessage(null);

        try {
            const isRange = newItem.includes('/');
            const payload = isRange ? { range: newItem } : { ip: newItem };

            await addToAllowlist(payload);
            setSuccessMessage(`Added ${newItem} to allowlist`);
            setNewItem("");
            loadData();
        } catch (err) {
            setError(err.message || "Failed to add to allowlist");
        } finally {
            setAdding(false);
        }
    };

    const handleDelete = async (value) => {
        if (!confirm(`Remove ${value} from allowlist?`)) return;

        try {
            await removeFromAllowlist(value);
            loadData();
        } catch (err) {
            setError(err.message || "Failed to remove item");
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                        <Shield className="text-primary-600 dark:text-primary-400" />
                        Allowlist
                    </h1>
                    <p className="text-gray-500 dark:text-gray-400 mt-1">
                        Manage IP bypass rules. These IPs will not be banned.
                    </p>
                </div>
            </div>

            {/* Add Form */}
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
                <form onSubmit={handleAdd} className="flex gap-4 items-end">
                    <div className="flex-1">
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            IP Address or CIDR Range
                        </label>
                        <input
                            type="text"
                            value={newItem}
                            onChange={(e) => setNewItem(e.target.value)}
                            placeholder="e.g. 192.168.1.5 or 10.0.0.0/24"
                            className="w-full px-4 py-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none transition-all"
                        />
                    </div>
                    <button
                        type="submit"
                        disabled={adding || !newItem}
                        className="px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-md font-medium transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {adding ? 'Adding...' : <><Plus size={18} /> Add Entry</>}
                    </button>
                </form>
                {successMessage && (
                    <div className="mt-4 p-3 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 rounded-md flex items-center gap-2 text-sm">
                        <CheckCircle size={16} />
                        {successMessage}
                    </div>
                )}
                {error && (
                    <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 rounded-md flex items-center gap-2 text-sm">
                        <AlertTriangle size={16} />
                        {error}
                    </div>
                )}
            </div>

            {/* List */}
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
                    <h3 className="text-lg font-medium text-gray-900 dark:text-white">Active Rules</h3>
                </div>

                {loading ? (
                    <div className="p-8 text-center text-gray-500 dark:text-gray-400">Loading allowlist...</div>
                ) : items.length === 0 ? (
                    <div className="p-8 text-center text-gray-500 dark:text-gray-400">
                        No items in allowlist.
                    </div>
                ) : (
                    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                        <thead className="bg-gray-50 dark:bg-gray-900/50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Value</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Type</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {items.map((item, idx) => (
                                <tr key={`${item.value}-${idx}`} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-white font-mono">
                                        {item.value}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                                        <Badge variant="outline" className="uppercase text-xs">
                                            {item.type}
                                        </Badge>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                                        <button
                                            onClick={() => handleDelete(item.value)}
                                            className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 transition-colors"
                                            title="Delete"
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}
