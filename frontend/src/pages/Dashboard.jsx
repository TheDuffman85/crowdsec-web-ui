import { useEffect, useState } from "react";
import { fetchAlerts, fetchDecisions } from "../lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { ShieldAlert, Gavel, Activity } from "lucide-react";

export function Dashboard() {
    const [stats, setStats] = useState({ alerts: 0, decisions: 0 });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function loadData() {
            try {
                const [alerts, decisions] = await Promise.all([fetchAlerts(), fetchDecisions()]);
                setStats({ alerts: alerts.length, decisions: decisions.length });
            } catch (error) {
                console.error("Failed to load dashboard data", error);
            } finally {
                setLoading(false);
            }
        }
        loadData();
    }, []);

    if (loading) {
        return <div className="text-center p-8 text-gray-500">Loading dashboard...</div>;
    }

    return (
        <div className="space-y-6">
            <h2 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">Dashboard</h2>

            <div className="grid gap-6 md:grid-cols-3">
                <Card>
                    <CardContent className="flex items-center p-6">
                        <div className="p-4 bg-red-100 dark:bg-red-900/20 rounded-full mr-4">
                            <ShieldAlert className="w-8 h-8 text-red-600 dark:text-red-400" />
                        </div>
                        <div>
                            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Alerts</p>
                            <h3 className="text-2xl font-bold text-gray-900 dark:text-white">{stats.alerts}</h3>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardContent className="flex items-center p-6">
                        <div className="p-4 bg-blue-100 dark:bg-blue-900/20 rounded-full mr-4">
                            <Gavel className="w-8 h-8 text-blue-600 dark:text-blue-400" />
                        </div>
                        <div>
                            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Active Decisions</p>
                            <h3 className="text-2xl font-bold text-gray-900 dark:text-white">{stats.decisions}</h3>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardContent className="flex items-center p-6">
                        <div className="p-4 bg-green-100 dark:bg-green-900/20 rounded-full mr-4">
                            <Activity className="w-8 h-8 text-green-600 dark:text-green-400" />
                        </div>
                        <div>
                            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">System Status</p>
                            <h3 className="text-2xl font-bold text-gray-900 dark:text-white">Online</h3>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
