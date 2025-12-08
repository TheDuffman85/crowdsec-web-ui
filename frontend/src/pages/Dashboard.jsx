import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { fetchAlerts, fetchDecisions, fetchDecisionsForStats } from "../lib/api";
import { getHubUrl } from "../lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card";
import { StatCard } from "../components/StatCard";
import { TimeSeriesChart } from "../components/TimeSeriesChart";
import {
    filterLastNDays,
    getTopIPs,
    getTopCountries,
    getTopScenarios,
    getTopAS,
    getAlertsPerDay,
    getDecisionsPerDay
} from "../lib/stats";
import {
    ShieldAlert,
    Gavel,
    Activity,
    Globe,
    MapPin,
    AlertTriangle,
    Network,
    TrendingUp,
    BarChart3
} from "lucide-react";

export function Dashboard() {
    const [stats, setStats] = useState({ alerts: 0, decisions: 0 });
    const [loading, setLoading] = useState(true);
    const [statsLoading, setStatsLoading] = useState(true);
    const [statistics, setStatistics] = useState({
        topIPs: [],
        topCountries: [],
        topScenarios: [],
        topAS: [],
        alertsPerDay: [],
        decisionsPerDay: []
    });

    useEffect(() => {
        async function loadData() {
            try {
                const [alerts, decisions, decisionsForStats] = await Promise.all([
                    fetchAlerts(),
                    fetchDecisions(),
                    fetchDecisionsForStats()
                ]);
                setStats({ alerts: alerts.length, decisions: decisions.length });

                // Calculate statistics for last 7 days
                const last7DaysAlerts = filterLastNDays(alerts, 7);
                const last7DaysDecisions = filterLastNDays(decisionsForStats, 7);

                setStatistics({
                    topIPs: getTopIPs(last7DaysAlerts, 10),
                    topCountries: getTopCountries(last7DaysAlerts, 10),
                    topScenarios: getTopScenarios(last7DaysAlerts, 10),
                    topAS: getTopAS(last7DaysAlerts, 10),
                    alertsPerDay: getAlertsPerDay(last7DaysAlerts, 7),
                    decisionsPerDay: getDecisionsPerDay(last7DaysDecisions, 7)
                });
            } catch (error) {
                console.error("Failed to load dashboard data", error);
            } finally {
                setLoading(false);
                setStatsLoading(false);
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

            {/* Summary Cards */}
            <div className="grid gap-6 md:grid-cols-3">
                <Link to="/alerts" className="block transition-transform hover:scale-105">
                    <Card className="h-full cursor-pointer hover:shadow-lg transition-shadow">
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
                </Link>

                <Link to="/decisions" className="block transition-transform hover:scale-105">
                    <Card className="h-full cursor-pointer hover:shadow-lg transition-shadow">
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
                </Link>

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

            {/* Statistics Section */}
            <div className="space-y-4">
                <div className="flex items-center gap-2">
                    <TrendingUp className="w-6 h-6 text-primary-600 dark:text-primary-400" />
                    <h3 className="text-2xl font-bold text-gray-900 dark:text-white">Last 7 Days Statistics</h3>
                </div>

                {statsLoading ? (
                    <div className="text-center p-8 text-gray-500">Loading statistics...</div>
                ) : (
                    <>
                        {/* Charts */}
                        <div className="grid gap-6 md:grid-cols-2">
                            <TimeSeriesChart
                                title="Alerts Per Day"
                                icon={ShieldAlert}
                                data={statistics.alertsPerDay}
                                color="#dc2626"
                            />
                            <TimeSeriesChart
                                title="Decisions Per Day"
                                icon={Gavel}
                                data={statistics.decisionsPerDay}
                                color="#2563eb"
                            />
                        </div>

                        {/* Top Statistics Grid */}
                        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
                            <StatCard
                                title="Top IPs"
                                icon={Globe}
                                items={statistics.topIPs}
                                emptyMessage="No alerts in the last 7 days"
                                getLink={(item) => `/alerts?ip=${encodeURIComponent(item.label)}`}
                            />
                            <StatCard
                                title="Top AS"
                                icon={Network}
                                items={statistics.topAS}
                                emptyMessage="No alerts in the last 7 days"
                                getLink={(item) => `/alerts?as=${encodeURIComponent(item.label)}`}
                            />
                            <StatCard
                                title="Top Countries"
                                icon={MapPin}
                                items={statistics.topCountries}
                                emptyMessage="No alerts in the last 7 days"
                                getLink={(item) => `/alerts?country=${encodeURIComponent(item.label)}`}
                            />
                            <StatCard
                                title="Top Scenarios"
                                icon={AlertTriangle}
                                items={statistics.topScenarios}
                                emptyMessage="No alerts in the last 7 days"
                                getLink={(item) => `/alerts?scenario=${encodeURIComponent(item.label)}`}
                                getExternalLink={(item) => getHubUrl(item.label)}
                            />
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
