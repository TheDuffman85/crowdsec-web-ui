import { useEffect, useState, useMemo, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";

import { fetchAlerts, fetchDecisions, fetchDecisionsForStats, fetchConfig } from "../lib/api";
import { getHubUrl } from "../lib/utils";
import { useRefresh } from "../contexts/RefreshContext";
import { Card, CardContent } from "../components/ui/Card";
import { StatCard } from "../components/StatCard";
import { ActivityBarChart } from "../components/DashboardCharts";
import { WorldMapCard } from "../components/WorldMapCard";
import { ScenarioName } from "../components/ScenarioName";
import {
    filterLastNDays,

    getTopTargets,
    getAlertTarget,
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

    Filter,
    Percent
} from "lucide-react";
import { Switch } from "../components/ui/Switch";

export function Dashboard() {
    const navigate = useNavigate();
    const { refreshSignal, setLastUpdated } = useRefresh();
    const [stats, setStats] = useState({ alerts: 0, decisions: 0 });
    const [loading, setLoading] = useState(true);
    const [statsLoading, setStatsLoading] = useState(true);
    const [config, setConfig] = useState({ lookback_days: 7 });

    // Initialize state from local storage or defaults
    const [granularity, setGranularity] = useState(() => {
        return localStorage.getItem('dashboard_granularity') || 'day';
    });

    // Percentage Basis: 'filtered' or 'global'
    const [percentageBasis, setPercentageBasis] = useState(() => {
        return localStorage.getItem('dashboard_percentage_basis') || 'global';
    });

    const [isOnline, setIsOnline] = useState(true);

    // Raw data
    const [rawData, setRawData] = useState({
        alerts: [],
        decisions: [],
        decisionsForStats: []
    });

    // Active filters
    // Active filters
    const [filters, setFilters] = useState(() => {
        const saved = localStorage.getItem('dashboard_filters');
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                console.error("Failed to parse saved filters", e);
            }
        }
        return {
            dateRange: null,
            dateRangeSticky: false,
            country: null,
            scenario: null,
            scenario: null,
            as: null,
            ip: null,
            target: null
        };
    });

    // Clear dateRange filter when granularity changes
    // Persist filters and granularity
    useEffect(() => {
        localStorage.setItem('dashboard_filters', JSON.stringify(filters));
    }, [filters]);

    useEffect(() => {
        localStorage.setItem('dashboard_granularity', granularity);
    }, [granularity]);

    useEffect(() => {
        localStorage.setItem('dashboard_percentage_basis', percentageBasis);
    }, [percentageBasis]);

    // Handler to change granularity and clear date range simultaneously (explicit user action)
    const handleGranularityChange = (newGranularity) => {
        setGranularity(newGranularity);
        setFilters(prev => ({ ...prev, dateRange: null }));
    };

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

            // Check LAPI status from config
            if (configData.lapi_status) {
                setIsOnline(configData.lapi_status.isConnected);
            } else {
                // Fallback for older backend versions
                setIsOnline(true);
            }

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

        // Create separate datasets for charts (no date range filter to avoid zoom feedback loop)
        let chartAlerts = [...filteredAlerts];
        let chartDecisionsData = [...chartDecisions];

        // Create datasets for the Slider/Brush (Context-aware but Time-ignorant)
        // We start with the lookback-filtered data (Global scope)
        let sliderAlerts = filterLastNDays(rawData.alerts, lookbackDays);
        let sliderDecisions = filterLastNDays(rawData.decisionsForStats, lookbackDays);

        // Apply Cross-Filtering to cards and lists (including dateRange)
        if (filters.dateRange) {
            // Helper function to extract date/time key from ISO timestamp
            const getItemKey = (isoString) => {
                if (!isoString) return null;
                const date = new Date(isoString);
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');

                // If filter range includes time (has 'T' separator), use hourly precision
                if (filters.dateRange.start.includes('T')) {
                    const hour = String(date.getHours()).padStart(2, '0');
                    return `${year}-${month}-${day}T${hour}`;
                }
                return `${year}-${month}-${day}`;
            };

            // Filter by date range
            filteredAlerts = filteredAlerts.filter(a => {
                const itemKey = getItemKey(a.created_at);
                if (!itemKey) return false;
                return itemKey >= filters.dateRange.start && itemKey <= filters.dateRange.end;
            });
            activeDecisions = activeDecisions.filter(d => {
                const itemKey = getItemKey(d.created_at);
                if (!itemKey) return false;
                return itemKey >= filters.dateRange.start && itemKey <= filters.dateRange.end;
            });

            // ALSO filter chart data by date range so the main chart reflects the selection
            chartAlerts = chartAlerts.filter(a => {
                const itemKey = getItemKey(a.created_at);
                if (!itemKey) return false;
                return itemKey >= filters.dateRange.start && itemKey <= filters.dateRange.end;
            });
            chartDecisionsData = chartDecisionsData.filter(d => {
                const itemKey = getItemKey(d.created_at);
                if (!itemKey) return false;
                return itemKey >= filters.dateRange.start && itemKey <= filters.dateRange.end;
            });
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

            // Also filter chart data by country
            chartAlerts = chartAlerts.filter(a => a.source.cn === filters.country);
            const chartIpsInCountry = new Set(
                chartAlerts.map(a => a.source.ip).filter(ip => ip)
            );
            chartDecisionsData = chartDecisionsData.filter(d => chartIpsInCountry.has(d.value));

            // Also filter Slider data by country
            sliderAlerts = sliderAlerts.filter(a => a.source.cn === filters.country);
            const sliderIpsInCountry = new Set(
                sliderAlerts.map(a => a.source.ip).filter(ip => ip)
            );
            sliderDecisions = sliderDecisions.filter(d => sliderIpsInCountry.has(d.value));
        }

        if (filters.scenario) {
            filteredAlerts = filteredAlerts.filter(a => a.scenario === filters.scenario);
            // Filter decisions by scenario - match decisions whose value (IP) appears in alerts with this scenario
            const ipsInScenario = new Set(
                filteredAlerts.map(a => a.source.ip).filter(ip => ip)
            );
            activeDecisions = activeDecisions.filter(d => ipsInScenario.has(d.value));

            // Also filter chart data
            chartAlerts = chartAlerts.filter(a => a.scenario === filters.scenario);
            const chartIpsInScenario = new Set(
                chartAlerts.map(a => a.source.ip).filter(ip => ip)
            );
            chartDecisionsData = chartDecisionsData.filter(d => chartIpsInScenario.has(d.value));

            // Also filter Slider data
            sliderAlerts = sliderAlerts.filter(a => a.scenario === filters.scenario);
            const sliderIpsInScenario = new Set(
                sliderAlerts.map(a => a.source.ip).filter(ip => ip)
            );
            sliderDecisions = sliderDecisions.filter(d => sliderIpsInScenario.has(d.value));
        }

        if (filters.as) {
            filteredAlerts = filteredAlerts.filter(a => a.source.as_name === filters.as);
            // Filter decisions by AS - match decisions whose value (IP) appears in alerts with this AS
            const ipsInAS = new Set(
                filteredAlerts.map(a => a.source.ip).filter(ip => ip)
            );
            activeDecisions = activeDecisions.filter(d => ipsInAS.has(d.value));

            // Also filter chart data
            chartAlerts = chartAlerts.filter(a => a.source.as_name === filters.as);
            const chartIpsInAS = new Set(
                chartAlerts.map(a => a.source.ip).filter(ip => ip)
            );
            chartDecisionsData = chartDecisionsData.filter(d => chartIpsInAS.has(d.value));

            // Also filter Slider data
            sliderAlerts = sliderAlerts.filter(a => a.source.as_name === filters.as);
            const sliderIpsInAS = new Set(
                sliderAlerts.map(a => a.source.ip).filter(ip => ip)
            );
            sliderDecisions = sliderDecisions.filter(d => sliderIpsInAS.has(d.value));
        }

        if (filters.ip) {
            filteredAlerts = filteredAlerts.filter(a => a.source.ip === filters.ip);
            // Filter decisions by IP - direct match on the value field
            activeDecisions = activeDecisions.filter(d => d.value === filters.ip);

            // Also filter chart data
            chartAlerts = chartAlerts.filter(a => a.source.ip === filters.ip);
            chartDecisionsData = chartDecisionsData.filter(d => d.value === filters.ip);

            // Also filter Slider data
            sliderAlerts = sliderAlerts.filter(a => a.source.ip === filters.ip);
            sliderDecisions = sliderDecisions.filter(d => d.value === filters.ip);
        }

        if (filters.target) {
            filteredAlerts = filteredAlerts.filter(a => getAlertTarget(a) === filters.target);
            // Decisions don't inherently have a "target" field compatible with getAlertTarget (which looks at events)
            // But we can filter decisions by seeing if they are associated with alerts that match the target.
            // However, decisions are often standalone or the link is weak. 
            // BUT, if we view "Decisions" as "Decisions made on this Target", we need to filter decisions.
            // Since we don't have a direct link in the decision object to the target (machine_id is origin, but not target per se?),
            // let's try to match by alerts again.
            const ipsOnTarget = new Set(
                filteredAlerts.map(a => a.source.ip).filter(ip => ip)
            );
            activeDecisions = activeDecisions.filter(d => ipsOnTarget.has(d.value));

            // Charts
            chartAlerts = chartAlerts.filter(a => getAlertTarget(a) === filters.target);
            const chartIpsOnTarget = new Set(
                chartAlerts.map(a => a.source.ip).filter(ip => ip)
            );
            chartDecisionsData = chartDecisionsData.filter(d => chartIpsOnTarget.has(d.value));

            // Slider
            sliderAlerts = sliderAlerts.filter(a => getAlertTarget(a) === filters.target);
            const sliderIpsOnTarget = new Set(
                sliderAlerts.map(a => a.source.ip).filter(ip => ip)
            );
            sliderDecisions = sliderDecisions.filter(d => sliderIpsOnTarget.has(d.value));
        }

        return {
            alerts: filteredAlerts,
            decisions: activeDecisions,  // Active decisions for card/lists
            chartAlerts: chartAlerts,  // Alerts for charts (no dateRange filter)
            chartDecisions: chartDecisionsData,  // All decisions for charts (no dateRange filter)
            sliderAlerts: sliderAlerts, // Alerts for slider (context filtered, time unfiltered)
            sliderDecisions: sliderDecisions, // Decisions for slider (context filtered, time unfiltered)
            // Global total (filtered by Lookback ONLY, ignoring sidebar filters)
            // Note: filterLastNDays is already done on rawData.alerts
            // But we want to ensure we get the count consistent with the chart's context if no other filters applied.
            // If we use 'filtered' mode -> total is filteredData.alerts.length.
            // If we use 'global' mode -> total is filterLastNDays(rawData.alerts).length.
            globalTotal: filterLastNDays(rawData.alerts, lookbackDays).length
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
            topTargets: getTopTargets(filteredData.alerts, 10),
            // Top Countries list is removed per requirements, but we calculate it for the Pie Chart
            topCountries: getTopCountries(filteredData.alerts, 10), // Get more for the pie chart
            allCountries: getAllCountries(filteredData.alerts),  // For map display
            topScenarios: getTopScenarios(filteredData.alerts, 10),
            topAS: getTopAS(filteredData.alerts, 10),
            alertsHistory: getAggregatedData(filteredData.chartAlerts, lookbackDays, granularity, filters.dateRange), // Match zoomed range
            decisionsHistory: getAggregatedData(filteredData.chartDecisions, lookbackDays, granularity, filters.dateRange), // Match zoomed range
            // Unfiltered history for the TimeRangeSlider (Global context + Sidebar Filters)
            unfilteredAlertsHistory: getAggregatedData(filteredData.sliderAlerts, lookbackDays, granularity),
            unfilteredDecisionsHistory: getAggregatedData(filteredData.sliderDecisions, lookbackDays, granularity)
        };
    }, [filteredData, config.lookback_days, granularity, filters.dateRange]);

    // Handle Filters
    const toggleFilter = (type, value) => {
        setFilters(prev => ({
            ...prev,
            [type]: prev[type] === value ? null : value
        }));
    };

    const clearFilters = () => {
        setFilters({
            dateRange: null,
            dateRangeSticky: false,
            country: null,
            scenario: null,
            as: null,
            ip: null,
            target: null
        });
    };

    const hasActiveFilters = filters.dateRange !== null ||
        filters.country !== null ||
        filters.scenario !== null ||
        filters.as !== null ||
        filters.ip !== null ||
        filters.target !== null;

    if (loading) {
        return <div className="text-center p-8 text-gray-500">Loading dashboard...</div>;
    }

    return (
        <div className="space-y-8">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <h2 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">Dashboard</h2>

                {/* Controls moved to Statistics Header */}
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
                            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">CrowdSec LAPI</p>
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
                <div className="flex flex-col md:flex-row items-center justify-between mb-4 gap-4 md:min-h-[3rem]">
                    <div className="flex items-center gap-2">
                        <TrendingUp className="w-6 h-6 text-primary-600 dark:text-primary-400" />
                        <h3 className="text-2xl font-bold text-gray-900 dark:text-white">
                            Last {config.lookback_days} Days Statistics
                        </h3>
                    </div>

                    <div className="flex flex-col md:flex-row items-center gap-4">
                        {hasActiveFilters && (
                            <>
                                <div className="flex flex-row items-center gap-2">
                                    <button
                                        onClick={() => {
                                            // Build query parameters from active filters
                                            const params = new URLSearchParams();
                                            if (filters.country) params.set('country', filters.country);
                                            if (filters.scenario) params.set('scenario', filters.scenario);
                                            if (filters.as) params.set('as', filters.as);
                                            if (filters.ip) params.set('ip', filters.ip);
                                            if (filters.target) params.set('target', filters.target);
                                            if (filters.dateRange) {
                                                params.set('dateStart', filters.dateRange.start);
                                                params.set('dateEnd', filters.dateRange.end);
                                            }
                                            navigate(`/alerts?${params.toString()}`);
                                        }}
                                        className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                                    >
                                        <Filter className="w-4 h-4" />
                                        <span className="hidden sm:inline">View Alerts</span>
                                        <span className="sm:hidden">Alerts</span>
                                    </button>
                                    <button
                                        onClick={() => {
                                            // Build query parameters from active filters
                                            const params = new URLSearchParams();
                                            if (filters.country) params.set('country', filters.country);
                                            // Decisions uses 'reason' but mapped from scenario usually, let's pass scenario and handle it in Decisions
                                            if (filters.scenario) params.set('scenario', filters.scenario);
                                            if (filters.as) params.set('as', filters.as);
                                            if (filters.ip) params.set('ip', filters.ip);
                                            // No direct target support in decisions yet, but let's pass it
                                            if (filters.target) params.set('target', filters.target);
                                            if (filters.dateRange) {
                                                params.set('dateStart', filters.dateRange.start);
                                                params.set('dateEnd', filters.dateRange.end);
                                            }
                                            // Ensure we include expired decisions when navigating from Dashboard
                                            params.set('include_expired', 'true');
                                            navigate(`/decisions?${params.toString()}`);
                                        }}
                                        className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                                    >
                                        <Filter className="w-4 h-4" />
                                        <span className="hidden sm:inline">View Decisions</span>
                                        <span className="sm:hidden">Decisions</span>
                                    </button>
                                    <button
                                        onClick={clearFilters}
                                        className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                                    >
                                        <FilterX className="w-4 h-4" />
                                        <span className="hidden sm:inline">Reset Filters</span>
                                        <span className="sm:hidden">Reset</span>
                                    </button>
                                </div>

                                <div className="flex items-center gap-3 bg-white dark:bg-gray-800 px-3 py-1.5 rounded-lg border border-gray-100 dark:border-gray-700 shadow-sm h-[38px] box-border">
                                    <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                                        <Percent className="w-4 h-4" />
                                    </div>

                                    <div className="flex items-center gap-2">
                                        <span className={`text-xs font-medium ${percentageBasis === 'filtered' ? 'text-primary-600' : 'text-gray-500'}`}>Filtered</span>
                                        <Switch
                                            id="percentage-basis"
                                            checked={percentageBasis === 'global'}
                                            onCheckedChange={(checked) => setPercentageBasis(checked ? 'global' : 'filtered')}
                                        />
                                        <span className={`text-xs font-medium ${percentageBasis === 'global' ? 'text-primary-600' : 'text-gray-500'}`}>Global</span>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {statsLoading ? (
                    <div className="text-center p-8 text-gray-500">Loading statistics...</div>
                ) : (
                    <>
                        {/* Charts Area */}
                        <div className="grid gap-8 md:grid-cols-2">
                            {/* Activity Chart - Left */}
                            <div className="h-[450px]">
                                <ActivityBarChart
                                    alertsData={statistics.alertsHistory}
                                    decisionsData={statistics.decisionsHistory}
                                    unfilteredAlertsData={statistics.unfilteredAlertsHistory}
                                    unfilteredDecisionsData={statistics.unfilteredDecisionsHistory}
                                    onDateRangeSelect={(dateRange, isAtEnd) => setFilters(prev => ({
                                        ...prev,
                                        dateRange,
                                        dateRangeSticky: isAtEnd && dateRange !== null
                                    }))}
                                    selectedDateRange={filters.dateRange}
                                    isSticky={filters.dateRangeSticky}
                                    granularity={granularity}
                                    setGranularity={handleGranularityChange}
                                />
                            </div>

                            {/* World Map - Right */}
                            <div className="h-[450px]">
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
                                total={percentageBasis === 'global' ? filteredData.globalTotal : filteredData.alerts.length}
                            />
                            <StatCard
                                title="Top Scenarios"
                                items={statistics.topScenarios}
                                onSelect={(item) => toggleFilter('scenario', item.label)}
                                selectedValue={filters.scenario}
                                renderLabel={(item) => (
                                    <ScenarioName name={item.label} showLink={true} />
                                )}
                                total={percentageBasis === 'global' ? filteredData.globalTotal : filteredData.alerts.length}
                            />
                            <StatCard
                                title="Top AS"
                                items={statistics.topAS}
                                onSelect={(item) => toggleFilter('as', item.label)}
                                selectedValue={filters.as}
                                total={percentageBasis === 'global' ? filteredData.globalTotal : filteredData.alerts.length}
                            />
                            <StatCard
                                title="Top Targets"
                                items={statistics.topTargets}
                                onSelect={(item) => toggleFilter('target', item.label)}
                                selectedValue={filters.target}
                                total={percentageBasis === 'global' ? filteredData.globalTotal : filteredData.alerts.length}
                            />
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
