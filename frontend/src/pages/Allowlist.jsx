import { useState, useEffect } from "react";
import { Trash2, Plus, Shield, CheckCircle, AlertTriangle } from "lucide-react";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { fetchAllowlist, addToAllowlist, removeFromAllowlist } from "../lib/api";

export function Allowlist() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [newItem, setNewItem] = useState("");
    const [adding, setAdding] = useState(false);


    // Modal states
    const [showAddModal, setShowAddModal] = useState(false);
    const [itemToDelete, setItemToDelete] = useState(null);

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


        try {
            const isRange = newItem.includes('/');
            const payload = isRange ? { range: newItem } : { ip: newItem };

            await addToAllowlist(payload);

            setNewItem("");
            setShowAddModal(false); // Close modal on success
            loadData();
        } catch (err) {
            setError(err.message || "Failed to add to allowlist");
        } finally {
            setAdding(false);
        }
    };

    // Open add modal and reset states
    const openAddModal = () => {
        setError(null);

        setNewItem("");
        setShowAddModal(true);
    };

    const handleDeleteClick = (value) => {
        setItemToDelete(value);
    };

    const confirmDelete = async () => {
        if (!itemToDelete) return;

        try {
            await removeFromAllowlist(itemToDelete);
            setItemToDelete(null); // Close modal
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
                <button
                    onClick={openAddModal}
                    className="bg-primary-600 hover:bg-primary-700 text-white font-medium py-2 px-4 rounded-md transition-colors flex items-center gap-2 text-sm self-start md:self-auto"
                >
                    <Plus size={16} />
                    Add Entry
                </button>
            </div>

            {/* Error/Success Messages (keep global visual feedback if needed, mainly for non-modal errors) */}
            {error && !showAddModal && !itemToDelete && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 rounded-md flex items-center gap-2 text-sm">
                    <AlertTriangle size={16} />
                    {error}
                </div>
            )}


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
                                            onClick={() => handleDeleteClick(item.value)}
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

            {/* Add Modal */}
            <Modal
                isOpen={showAddModal}
                onClose={() => setShowAddModal(false)}
                title="Add to Allowlist"
                maxWidth="max-w-md"
            >
                <form onSubmit={handleAdd} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            IP Address or CIDR Range
                        </label>
                        <input
                            type="text"
                            value={newItem}
                            onChange={(e) => setNewItem(e.target.value)}
                            placeholder="e.g. 192.168.1.5 or 10.0.0.0/24"
                            className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                            autoFocus
                        />
                    </div>

                    {error && (
                        <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 rounded-md flex items-center gap-2 text-sm">
                            <AlertTriangle size={16} />
                            {error}
                        </div>
                    )}

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
                            disabled={adding || !newItem}
                            className="px-4 py-2 text-sm font-medium text-white bg-primary-600 border border-transparent rounded-md hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {adding ? 'Adding...' : 'Add Entry'}
                        </button>
                    </div>
                </form>
            </Modal>

            {/* Delete Modal */}
            <Modal
                isOpen={!!itemToDelete}
                onClose={() => setItemToDelete(null)}
                title="Remove from Allowlist?"
                maxWidth="max-w-sm"
                showCloseButton={false}
            >
                <p className="text-gray-600 dark:text-gray-300 mb-6">
                    Are you sure you want to remove <span className="font-mono text-sm font-bold">{itemToDelete}</span> from the allowlist?
                </p>
                <div className="flex justify-end gap-3">
                    <button
                        onClick={() => setItemToDelete(null)}
                        className="px-4 py-2 text-sm font-medium text-gray-700 bg-white dark:bg-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={confirmDelete}
                        className="px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                    >
                        Remove
                    </button>
                </div>
            </Modal>
        </div>
    );
}
