import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";

import { fetchAlerts, fetchDecisions, fetchDecisionsForStats, fetchConfig } from "../lib/api";
import { getHubUrl } from "../lib/utils";
import { Card, CardContent } from "../components/ui/Card";
import { StatCard } from "../components/StatCard";
import { ActivityBarChart } from "../components/DashboardCharts";
import { WorldMapCard } from "../components/WorldMapCard";
import {
    filterLastNDays,
    getTopIPs,
    getTopCountries,
    getAllCountries,
    getTopScenarios,
    getTopAS,
    getAlertsPerDay,
    getDecisionsPerDay
} from "../lib/stats";
import {
    ShieldAlert,
    Gavel,
    Activity,
    Network,
    TrendingUp,
    AlertTriangle,
    FilterX,
    Globe
} from "lucide-react";

export function Dashboard() {
    const [stats, setStats] = useState({ alerts: 0, decisions: 0 });
    const [loading, setLoading] = useState(true);
    const [statsLoading, setStatsLoading] = useState(true);
    const [config, setConfig] = useState({ lookback_days: 7 });
    const [isOnline, setIsOnline] = useState(true);

    // Raw data
    const [rawData, setRawData] = useState({
        alerts: [],
        decisions: [],
        decisionsForStats: []
    });

    // Active filters
    const [filters, setFilters] = useState({
        date: null,
        country: null,
        scenario: null,
        as: null,
        ip: null
    });

    useEffect(() => {
        async function loadData() {
            try {
                // Fetch config first to know how many days to filter
                const configData = await fetchConfig();
                setConfig(configData);

                const [alerts, decisions, decisionsForStats] = await Promise.all([
                    fetchAlerts(),
                    fetchDecisions(),
                    fetchDecisionsForStats()
                ]);

                setRawData({ alerts, decisions, decisionsForStats });
                setStats({ alerts: alerts.length, decisions: decisions.length });
                setIsOnline(true);

            } catch (error) {
                console.error("Failed to load dashboard data", error);
                setIsOnline(false);
            } finally {
                setLoading(false);
                setStatsLoading(false);
            }
        }
        loadData();
    }, []);

    // Filter Logic
    const filteredData = useMemo(() => {
        const lookbackDays = config.lookback_days || 7;

        let filteredAlerts = filterLastNDays(rawData.alerts, lookbackDays);
        let filteredDecisions = filterLastNDays(rawData.decisionsForStats, lookbackDays);

        // Apply Cross-Filtering
        if (filters.date) {
            // Safe date matching (handles potentially different formats if needed, but strict 'startsWith' matches YYYY-MM-DD)
            filteredAlerts = filteredAlerts.filter(a => a.created_at && a.created_at.startsWith(filters.date));
            filteredDecisions = filteredDecisions.filter(d => d.created_at && d.created_at.startsWith(filters.date));
        }

        if (filters.country) {
            filteredAlerts = filteredAlerts.filter(a => {
                // Match by CN (2-letter country code)
                return a.source.cn === filters.country;
            });
            // Filter decisions by country - match IPs from filtered alerts
            const ipsInCountry = new Set(
                filteredAlerts.map(a => a.source.ip).filter(ip => ip)
            );
            filteredDecisions = filteredDecisions.filter(d => ipsInCountry.has(d.value));
        }

        if (filters.scenario) {
            filteredAlerts = filteredAlerts.filter(a => a.scenario === filters.scenario);
            // Filter decisions by scenario - match decisions whose value (IP) appears in alerts with this scenario
            const ipsInScenario = new Set(
                filteredAlerts.map(a => a.source.ip).filter(ip => ip)
            );
            filteredDecisions = filteredDecisions.filter(d => ipsInScenario.has(d.value));
        }

        if (filters.as) {
            filteredAlerts = filteredAlerts.filter(a => a.source.as_name === filters.as);
            // Filter decisions by AS - match decisions whose value (IP) appears in alerts with this AS
            const ipsInAS = new Set(
                filteredAlerts.map(a => a.source.ip).filter(ip => ip)
            );
            filteredDecisions = filteredDecisions.filter(d => ipsInAS.has(d.value));
        }

        if (filters.ip) {
            filteredAlerts = filteredAlerts.filter(a => a.source.ip === filters.ip);
            // Filter decisions by IP - direct match on the value field
            filteredDecisions = filteredDecisions.filter(d => d.value === filters.ip);
        }

        return { alerts: filteredAlerts, decisions: filteredDecisions };
    }, [rawData, config.lookback_days, filters]);


    // Derived Statistics
    const statistics = useMemo(() => {
        const lookbackDays = config.lookback_days || 7;

        // For lists, we use the filtered data
        // For charts, we effectively want to show the context of the WHOLE dataset (or subset) 
        // depending on UX. 
        // User Requirement: "charts will filter each other". 
        // Usually visual filtering means the chart highlights the selection but keeps context, OR it drills down.
        // Given "Power BI Report", usually clicking a bar filters the other charts. 
        // So the pie chart should reflect the date selection. The bar chart should reflect the country selection.

        return {
            topIPs: getTopIPs(filteredData.alerts, 10),
            // Top Countries list is removed per requirements, but we calculate it for the Pie Chart
            topCountries: getTopCountries(filteredData.alerts, 10), // Get more for the pie chart
            allCountries: getAllCountries(filteredData.alerts),  // For map display
            topScenarios: getTopScenarios(filteredData.alerts, 10),
            topAS: getTopAS(filteredData.alerts, 10),
            alertsPerDay: getAlertsPerDay(filteredData.alerts, lookbackDays),
            decisionsPerDay: getDecisionsPerDay(filteredData.decisions, lookbackDays)
        };
    }, [filteredData, config.lookback_days]);

    // Handle Filters
    const toggleFilter = (type, value) => {
        setFilters(prev => ({
            ...prev,
            [type]: prev[type] === value ? null : value
        }));
    };

    const clearFilters = () => {
        setFilters({
            date: null,
            country: null,
            scenario: null,
            as: null,
            ip: null
        });
    };

    const hasActiveFilters = Object.values(filters).some(v => v !== null);

    if (loading) {
        return <div className="text-center p-8 text-gray-500">Loading dashboard...</div>;
    }

    return (
        <div className="space-y-8">
            <div className="flex items-center justify-between">
                <h2 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">Dashboard</h2>
                {hasActiveFilters && (
                    <button
                        onClick={clearFilters}
                        className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                    >
                        <FilterX className="w-4 h-4" />
                        Clear Filters
                    </button>
                )}
            </div>

            {/* Summary Cards - These show TOTALS regardless of view filters usually, or should they filter? 
                Let's make them show GLOBAL status as they link effectively to other pages. 
                But updating them to show "Filtered Count" is a nice touch. Let's keep them global for now.
            */}
            <div className="grid gap-8 md:grid-cols-3">
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
                        <div className={`p-4 rounded-full mr-4 ${isOnline
                            ? 'bg-green-100 dark:bg-green-900/20'
                            : 'bg-red-100 dark:bg-red-900/20'
                            }`}>
                            <Activity className={`w-8 h-8 ${isOnline
                                ? 'text-green-600 dark:text-green-400'
                                : 'text-red-600 dark:text-red-400'
                                }`} />
                        </div>
                        <div>
                            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">System Status</p>
                            <h3 className={`text-2xl font-bold ${isOnline
                                ? 'text-gray-900 dark:text-white'
                                : 'text-red-600 dark:text-red-400'
                                }`}>{isOnline ? 'Online' : 'Offline'}</h3>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Statistics Section */}
            <div className="space-y-4">
                <div className="flex items-center gap-2">
                    <TrendingUp className="w-6 h-6 text-primary-600 dark:text-primary-400" />
                    <h3 className="text-2xl font-bold text-gray-900 dark:text-white">
                        Last {config.lookback_days} Days Statistics
                    </h3>
                </div>

                {statsLoading ? (
                    <div className="text-center p-8 text-gray-500">Loading statistics...</div>
                ) : (
                    <>
                        {/* Charts Area */}
                        <div className="grid gap-8 md:grid-cols-2">
                            {/* Activity Chart - Left */}
                            <div className="h-[280px]">
                                <ActivityBarChart
                                    alertsData={statistics.alertsPerDay}
                                    decisionsData={statistics.decisionsPerDay}
                                    onDateSelect={(date) => toggleFilter('date', date)}
                                    selectedDate={filters.date}
                                />
                            </div>

                            {/* World Map - Right */}
                            <div className="h-[280px]">
                                <WorldMapCard
                                    data={statistics.allCountries}
                                    onCountrySelect={(code) => toggleFilter('country', code)}
                                    selectedCountry={filters.country}
                                />
                            </div>
                        </div>

                        {/* Top Statistics Grid */}
                        <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
                            <StatCard
                                title="Top Countries"
                                items={statistics.topCountries}
                                onSelect={(item) => toggleFilter('country', item.countryCode)}
                                selectedValue={filters.country}
                            />
                            <StatCard
                                title="Top IPs"
                                items={statistics.topIPs}
                                onSelect={(item) => toggleFilter('ip', item.label)}
                                selectedValue={filters.ip}
                            />
                            <StatCard
                                title="Top Scenarios"
                                items={statistics.topScenarios}
                                onSelect={(item) => toggleFilter('scenario', item.label)}
                                selectedValue={filters.scenario}
                                getExternalLink={(item) => getHubUrl(item.label)}
                            />
                            <StatCard
                                title="Top AS"
                                items={statistics.topAS}
                                onSelect={(item) => toggleFilter('as', item.label)}
                                selectedValue={filters.as}
                            />
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
