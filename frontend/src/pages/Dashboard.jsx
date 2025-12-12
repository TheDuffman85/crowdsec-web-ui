import { useEffect, useState, useMemo, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";

import { fetchAlerts, fetchDecisions, fetchDecisionsForStats, fetchConfig } from "../lib/api";
import { getHubUrl } from "../lib/utils";
import { useRefresh } from "../contexts/RefreshContext";
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
    getAggregatedData
} from "../lib/stats";
import {
    ShieldAlert,
    Gavel,
    Activity,
    Network,
    TrendingUp,
    AlertTriangle,
    FilterX,
    Globe,
    Filter
} from "lucide-react";

export function Dashboard() {
    const navigate = useNavigate();
    const { refreshSignal, setLastUpdated } = useRefresh();
    const [stats, setStats] = useState({ alerts: 0, decisions: 0 });
    const [loading, setLoading] = useState(true);
    const [statsLoading, setStatsLoading] = useState(true);
    const [config, setConfig] = useState({ lookback_days: 7 });
    const [granularity, setGranularity] = useState('day');
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

    const loadData = useCallback(async (isBackground = false) => {
        try {
            // Only fetch config on initial load (or if we want to support dynamic config changes, but rarely changs)
            // Let's re-fetch config only if not background, or just always fetch it (it's fast)
            // To be safe, let's just fetch everything.

            // Only set loading spinners on initial load
            if (!isBackground) {
                // We don't necessarily reset loading to true if we are just re-mounting? 
                // Actually loading=true is default.
            }

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
            setLastUpdated(new Date());

        } catch (error) {
            console.error("Failed to load dashboard data", error);
            setIsOnline(false);
        } finally {
            if (!isBackground) {
                setLoading(false);
                setStatsLoading(false);
            }
        }
    }, [setLastUpdated]);

    // Initial Load
    useEffect(() => {
        loadData(false);
    }, [loadData]);

    // Background Refresh
    useEffect(() => {
        if (refreshSignal > 0) {
            loadData(true);
        }
    }, [refreshSignal, loadData]);

    // Filter Logic
    const filteredData = useMemo(() => {
        const lookbackDays = config.lookback_days || 7;

        let filteredAlerts = filterLastNDays(rawData.alerts, lookbackDays);

        // Filter ACTIVE decisions for card display and top lists
        let activeDecisions = filterLastNDays(rawData.decisions, lookbackDays);

        // Filter ALL decisions (including expired) for historical charts
        let chartDecisions = filterLastNDays(rawData.decisionsForStats, lookbackDays);

        // Apply Cross-Filtering to both datasets
        if (filters.date) {
            // Safe date matching (handles potentially different formats if needed, but strict 'startsWith' matches YYYY-MM-DD)
            filteredAlerts = filteredAlerts.filter(a => a.created_at && a.created_at.startsWith(filters.date));
            activeDecisions = activeDecisions.filter(d => d.created_at && d.created_at.startsWith(filters.date));
            chartDecisions = chartDecisions.filter(d => d.created_at && d.created_at.startsWith(filters.date));
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
            activeDecisions = activeDecisions.filter(d => ipsInCountry.has(d.value));
            chartDecisions = chartDecisions.filter(d => ipsInCountry.has(d.value));
        }

        if (filters.scenario) {
            filteredAlerts = filteredAlerts.filter(a => a.scenario === filters.scenario);
            // Filter decisions by scenario - match decisions whose value (IP) appears in alerts with this scenario
            const ipsInScenario = new Set(
                filteredAlerts.map(a => a.source.ip).filter(ip => ip)
            );
            activeDecisions = activeDecisions.filter(d => ipsInScenario.has(d.value));
            chartDecisions = chartDecisions.filter(d => ipsInScenario.has(d.value));
        }

        if (filters.as) {
            filteredAlerts = filteredAlerts.filter(a => a.source.as_name === filters.as);
            // Filter decisions by AS - match decisions whose value (IP) appears in alerts with this AS
            const ipsInAS = new Set(
                filteredAlerts.map(a => a.source.ip).filter(ip => ip)
            );
            activeDecisions = activeDecisions.filter(d => ipsInAS.has(d.value));
            chartDecisions = chartDecisions.filter(d => ipsInAS.has(d.value));
        }

        if (filters.ip) {
            filteredAlerts = filteredAlerts.filter(a => a.source.ip === filters.ip);
            // Filter decisions by IP - direct match on the value field
            activeDecisions = activeDecisions.filter(d => d.value === filters.ip);
            chartDecisions = chartDecisions.filter(d => d.value === filters.ip);
        }

        return {
            alerts: filteredAlerts,
            decisions: activeDecisions,  // Active decisions for card/lists
            chartDecisions: chartDecisions  // All decisions for charts
        };
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
            alertsHistory: getAggregatedData(filteredData.alerts, lookbackDays, granularity),
            decisionsHistory: getAggregatedData(filteredData.chartDecisions, lookbackDays, granularity)
        };
    }, [filteredData, config.lookback_days, granularity]);

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
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => {
                                // Build query parameters from active filters
                                const params = new URLSearchParams();
                                if (filters.date) params.set('date', filters.date);
                                if (filters.country) params.set('country', filters.country);
                                if (filters.scenario) params.set('scenario', filters.scenario);
                                if (filters.as) params.set('as', filters.as);
                                if (filters.ip) params.set('ip', filters.ip);
                                navigate(`/alerts?${params.toString()}`);
                            }}
                            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                        >
                            <Filter className="w-4 h-4" />
                            View Alerts
                        </button>
                        <button
                            onClick={clearFilters}
                            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                        >
                            <FilterX className="w-4 h-4" />
                            Clear Filters
                        </button>
                    </div>
                )}
            </div>

            {/* Summary Cards */}
            <div className="grid gap-8 md:grid-cols-3">
                <Link to="/alerts" className="block transition-transform hover:scale-105">
                    <Card className="h-full cursor-pointer hover:shadow-lg transition-shadow">
                        <CardContent className="flex items-center p-6">
                            <div className="p-4 bg-red-100 dark:bg-red-900/20 rounded-full mr-4">
                                <ShieldAlert className="w-8 h-8 text-red-600 dark:text-red-400" />
                            </div>
                            <div>
                                <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Alerts</p>
                                <div className="flex items-baseline gap-2">
                                    <h3 className="text-2xl font-bold text-gray-900 dark:text-white">{stats.alerts}</h3>
                                    {hasActiveFilters && (
                                        <span className="text-sm text-gray-500 dark:text-gray-400">
                                            {filteredData.alerts.length}
                                        </span>
                                    )}
                                </div>
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
                                <div className="flex items-baseline gap-2">
                                    <h3 className="text-2xl font-bold text-gray-900 dark:text-white">{stats.decisions}</h3>
                                    {hasActiveFilters && (
                                        <span className="text-sm text-gray-500 dark:text-gray-400">
                                            {filteredData.decisions.length}
                                        </span>
                                    )}
                                </div>
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
                            <div className="h-[350px]">
                                <ActivityBarChart
                                    alertsData={statistics.alertsHistory}
                                    decisionsData={statistics.decisionsHistory}
                                    onDateSelect={(date) => toggleFilter('date', date)}
                                    selectedDate={filters.date}
                                    granularity={granularity}
                                    setGranularity={setGranularity}
                                />
                            </div>

                            {/* World Map - Right */}
                            <div className="h-[350px]">
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
                                title="Top IPs"
                                items={statistics.topIPs}
                                onSelect={(item) => toggleFilter('ip', item.label)}
                                selectedValue={filters.ip}
                            />
                            <StatCard
                                title="Top AS"
                                items={statistics.topAS}
                                onSelect={(item) => toggleFilter('as', item.label)}
                                selectedValue={filters.as}
                            />
                            <StatCard
                                title="Top Countries"
                                items={statistics.topCountries}
                                onSelect={(item) => toggleFilter('country', item.countryCode)}
                                selectedValue={filters.country}
                            />
                            <StatCard
                                title="Top Scenarios"
                                items={statistics.topScenarios}
                                onSelect={(item) => toggleFilter('scenario', item.label)}
                                selectedValue={filters.scenario}
                                getExternalLink={(item) => getHubUrl(item.label)}
                            />
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
