import { lazy, Suspense, useEffect, useState, useMemo, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";

import { fetchAlertsForStats, fetchDecisionsForStats, fetchConfig } from "../lib/api";
import { matchesSimulationFilter } from "../lib/simulation";
import { useRefresh } from "../contexts/useRefresh";
import { Card, CardContent } from "../components/ui/Card";
import { StatCard } from "../components/StatCard";
import { ScenarioName } from "../components/ScenarioName";
import {
    filterLastNDays,
    getTopTargets,
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
    TrendingUp,
    FilterX,

    Filter,
    Percent
} from "lucide-react";
import { Switch } from "../components/ui/Switch";
import { DASHBOARD_COLORS } from "../lib/dashboardColors";
import type {
    ConfigResponse,
    DashboardFilters,
    SimulationFilter,
    StatsAlert,
    StatsDecision,
} from '../types';

type Granularity = 'day' | 'hour';
type PercentageBasis = 'filtered' | 'global';
type FilterKey = 'country' | 'scenario' | 'as' | 'ip' | 'target' | 'simulation';

interface DashboardCountState {
    alerts: number;
    decisions: number;
    simulatedAlerts: number;
    simulatedDecisions: number;
}

interface RawDataState {
    alertsForStats: StatsAlert[];
    decisionsForStats: StatsDecision[];
}

interface FilteredDashboardData {
    alerts: StatsAlert[];
    liveAlerts: StatsAlert[];
    simulatedAlerts: StatsAlert[];
    decisions: StatsDecision[];
    simulatedDecisions: StatsDecision[];
    chartLiveAlerts: StatsAlert[];
    chartSimulatedAlerts: StatsAlert[];
    chartLiveDecisions: StatsDecision[];
    chartSimulatedDecisions: StatsDecision[];
    chartAlerts: StatsAlert[];
    chartDecisions: StatsDecision[];
    sliderLiveAlerts: StatsAlert[];
    sliderSimulatedAlerts: StatsAlert[];
    sliderLiveDecisions: StatsDecision[];
    sliderSimulatedDecisions: StatsDecision[];
    sliderAlerts: StatsAlert[];
    sliderDecisions: StatsDecision[];
    globalTotal: number;
}

const ActivityBarChart = lazy(async () => ({ default: (await import('../components/DashboardCharts')).ActivityBarChart }));
const WorldMapCard = lazy(async () => ({ default: (await import('../components/WorldMapCard')).WorldMapCard }));

const EMPTY_FILTERS: DashboardFilters = {
    dateRange: null,
    dateRangeSticky: false,
    country: null,
    scenario: null,
    as: null,
    ip: null,
    target: null,
    simulation: 'all',
};

function parseStoredGranularity(value: string | null): Granularity {
    return value === 'hour' ? 'hour' : 'day';
}

function parseStoredPercentageBasis(value: string | null): PercentageBasis {
    return value === 'filtered' ? 'filtered' : 'global';
}

function parseStoredFilters(value: string | null): DashboardFilters {
    if (!value) {
        return EMPTY_FILTERS;
    }

    try {
        return {
            ...EMPTY_FILTERS,
            ...(JSON.parse(value) as Partial<DashboardFilters>),
        };
    } catch (error) {
        console.error("Failed to parse saved filters", error);
        return EMPTY_FILTERS;
    }
}

function getDateRangeItemKey(isoString: string, includeHour: boolean): string {
    const date = new Date(isoString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    if (includeHour) {
        const hour = String(date.getHours()).padStart(2, '0');
        return `${year}-${month}-${day}T${hour}`;
    }

    return `${year}-${month}-${day}`;
}

export function Dashboard() {
    const navigate = useNavigate();
    const { refreshSignal, setLastUpdated } = useRefresh();
    const [stats, setStats] = useState<DashboardCountState>({ alerts: 0, decisions: 0, simulatedAlerts: 0, simulatedDecisions: 0 });
    const [loading, setLoading] = useState(true);
    const [statsLoading, setStatsLoading] = useState(true);
    const [config, setConfig] = useState<ConfigResponse | null>(null);

    // Initialize state from local storage or defaults
    const [granularity, setGranularity] = useState<Granularity>(() => parseStoredGranularity(localStorage.getItem('dashboard_granularity')));

    // Percentage Basis: 'filtered' or 'global'
    const [percentageBasis, setPercentageBasis] = useState<PercentageBasis>(() => parseStoredPercentageBasis(localStorage.getItem('dashboard_percentage_basis')));

    const [isOnline, setIsOnline] = useState(true);

    // Raw data (stats endpoints only)
    const [rawData, setRawData] = useState<RawDataState>({
        alertsForStats: [],
        decisionsForStats: []
    });

    // Active filters
    const [filters, setFilters] = useState<DashboardFilters>(() => parseStoredFilters(localStorage.getItem('dashboard_filters')));

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
    const handleGranularityChange = (newGranularity: Granularity) => {
        setGranularity(newGranularity);
        setFilters(prev => ({ ...prev, dateRange: null }));
    };

    const loadData = useCallback(async (isBackground = false) => {
        try {
            // Only set loading spinners on initial load
            // (loading=true is default state)

            const configData = await fetchConfig();
            setConfig(configData);

            // Use optimized stats endpoints only
            const [alertsForStats, decisionsForStats] = await Promise.all([
                fetchAlertsForStats(),
                fetchDecisionsForStats()
            ]);

            setRawData({ alertsForStats, decisionsForStats });

            // Calculate active decisions count (stop_at > now)
            const now = new Date();
            const activeDecisionsCount = decisionsForStats.filter(d =>
                d.simulated !== true && d.stop_at && new Date(d.stop_at) > now
            ).length;
            const simulatedAlertsCount = alertsForStats.filter(a => a.simulated === true).length;
            const simulatedDecisionsCount = decisionsForStats.filter(d =>
                d.simulated === true && d.stop_at && new Date(d.stop_at) > now
            ).length;

            setStats({
                alerts: alertsForStats.length,
                decisions: activeDecisionsCount,
                simulatedAlerts: simulatedAlertsCount,
                simulatedDecisions: simulatedDecisionsCount,
            });

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
    const filteredData = useMemo<FilteredDashboardData>(() => {
        const lookbackDays = config?.lookback_days || 7;
        const now = new Date();
        const simulationFilter = filters.simulation;

        // Use alertsForStats for all alert-related filtering and stats
        let filteredAlerts = filterLastNDays(rawData.alertsForStats, lookbackDays)
            .filter(a => matchesSimulationFilter({ simulated: a.simulated }, simulationFilter));

        // Calculate active decisions (stop_at > now) for card display and filtering
        let activeDecisions = filterLastNDays(rawData.decisionsForStats, lookbackDays)
            .filter(d => d.simulated !== true && d.stop_at && new Date(d.stop_at) > now);

        let simulatedDecisions = filterLastNDays(rawData.decisionsForStats, lookbackDays)
            .filter(d => d.simulated === true && d.stop_at && new Date(d.stop_at) > now);

        // Filter ALL decisions (including expired) for historical charts
        const chartDecisions = filterLastNDays(rawData.decisionsForStats, lookbackDays)
            .filter(d => matchesSimulationFilter({ simulated: d.simulated }, simulationFilter));

        // Create separate datasets for charts (no date range filter to avoid zoom feedback loop)
        let chartAlerts = [...filteredAlerts];
        let chartDecisionsData = [...chartDecisions];

        // Create datasets for the Slider/Brush (Context-aware but Time-ignorant)
        // We start with the lookback-filtered data (Global scope)
        let sliderAlerts = filterLastNDays(rawData.alertsForStats, lookbackDays)
            .filter(a => matchesSimulationFilter({ simulated: a.simulated }, simulationFilter));
        let sliderDecisions = filterLastNDays(rawData.decisionsForStats, lookbackDays)
            .filter(d => matchesSimulationFilter({ simulated: d.simulated }, simulationFilter));

        // Apply Cross-Filtering to cards and lists (including dateRange)
        if (filters.dateRange) {
            const dateRange = filters.dateRange;
            // Helper function to extract date/time key from ISO timestamp
            const includeHour = dateRange.start.includes('T');

            // Filter by date range
            filteredAlerts = filteredAlerts.filter(a => {
                const itemKey = getDateRangeItemKey(a.created_at, includeHour);
                return itemKey >= dateRange.start && itemKey <= dateRange.end;
            });
            activeDecisions = activeDecisions.filter(d => {
                const itemKey = getDateRangeItemKey(d.created_at, includeHour);
                return itemKey >= dateRange.start && itemKey <= dateRange.end;
            });
            simulatedDecisions = simulatedDecisions.filter(d => {
                const itemKey = getDateRangeItemKey(d.created_at, includeHour);
                return itemKey >= dateRange.start && itemKey <= dateRange.end;
            });

            // ALSO filter chart data by date range so the main chart reflects the selection
            chartAlerts = chartAlerts.filter(a => {
                const itemKey = getDateRangeItemKey(a.created_at, includeHour);
                return itemKey >= dateRange.start && itemKey <= dateRange.end;
            });
            chartDecisionsData = chartDecisionsData.filter(d => {
                const itemKey = getDateRangeItemKey(d.created_at, includeHour);
                return itemKey >= dateRange.start && itemKey <= dateRange.end;
            });
        }


        if (filters.country) {
            filteredAlerts = filteredAlerts.filter(a => {
                // Match by CN (2-letter country code)
                return a.source?.cn === filters.country;
            });
            // Filter decisions by country - match IPs from filtered alerts
            const ipsInCountry = new Set(
                filteredAlerts.map(a => a.source?.ip).filter(ip => ip)
            );
            activeDecisions = activeDecisions.filter(d => ipsInCountry.has(d.value));
            simulatedDecisions = simulatedDecisions.filter(d => ipsInCountry.has(d.value));

            // Also filter chart data by country
            chartAlerts = chartAlerts.filter(a => a.source?.cn === filters.country);
            const chartIpsInCountry = new Set(
                chartAlerts.map(a => a.source?.ip).filter(ip => ip)
            );
            chartDecisionsData = chartDecisionsData.filter(d => chartIpsInCountry.has(d.value));

            // Also filter Slider data by country
            sliderAlerts = sliderAlerts.filter(a => a.source?.cn === filters.country);
            const sliderIpsInCountry = new Set(
                sliderAlerts.map(a => a.source?.ip).filter(ip => ip)
            );
            sliderDecisions = sliderDecisions.filter(d => sliderIpsInCountry.has(d.value));
        }

        if (filters.scenario) {
            filteredAlerts = filteredAlerts.filter(a => a.scenario === filters.scenario);
            // Filter decisions by scenario - match decisions whose value (IP) appears in alerts with this scenario
            const ipsInScenario = new Set(
                filteredAlerts.map(a => a.source?.ip).filter(ip => ip)
            );
            activeDecisions = activeDecisions.filter(d => ipsInScenario.has(d.value));
            simulatedDecisions = simulatedDecisions.filter(d => ipsInScenario.has(d.value));

            // Also filter chart data
            chartAlerts = chartAlerts.filter(a => a.scenario === filters.scenario);
            const chartIpsInScenario = new Set(
                chartAlerts.map(a => a.source?.ip).filter(ip => ip)
            );
            chartDecisionsData = chartDecisionsData.filter(d => chartIpsInScenario.has(d.value));

            // Also filter Slider data
            sliderAlerts = sliderAlerts.filter(a => a.scenario === filters.scenario);
            const sliderIpsInScenario = new Set(
                sliderAlerts.map(a => a.source?.ip).filter(ip => ip)
            );
            sliderDecisions = sliderDecisions.filter(d => sliderIpsInScenario.has(d.value));
        }

        if (filters.as) {
            filteredAlerts = filteredAlerts.filter(a => a.source?.as_name === filters.as);
            // Filter decisions by AS - match decisions whose value (IP) appears in alerts with this AS
            const ipsInAS = new Set(
                filteredAlerts.map(a => a.source?.ip).filter(ip => ip)
            );
            activeDecisions = activeDecisions.filter(d => ipsInAS.has(d.value));
            simulatedDecisions = simulatedDecisions.filter(d => ipsInAS.has(d.value));

            // Also filter chart data
            chartAlerts = chartAlerts.filter(a => a.source?.as_name === filters.as);
            const chartIpsInAS = new Set(
                chartAlerts.map(a => a.source?.ip).filter(ip => ip)
            );
            chartDecisionsData = chartDecisionsData.filter(d => chartIpsInAS.has(d.value));

            // Also filter Slider data
            sliderAlerts = sliderAlerts.filter(a => a.source?.as_name === filters.as);
            const sliderIpsInAS = new Set(
                sliderAlerts.map(a => a.source?.ip).filter(ip => ip)
            );
            sliderDecisions = sliderDecisions.filter(d => sliderIpsInAS.has(d.value));
        }

        if (filters.ip) {
            filteredAlerts = filteredAlerts.filter(a => a.source?.ip === filters.ip);
            // Filter decisions by IP - direct match on the value field
            activeDecisions = activeDecisions.filter(d => d.value === filters.ip);
            simulatedDecisions = simulatedDecisions.filter(d => d.value === filters.ip);

            // Also filter chart data
            chartAlerts = chartAlerts.filter(a => a.source?.ip === filters.ip);
            chartDecisionsData = chartDecisionsData.filter(d => d.value === filters.ip);

            // Also filter Slider data
            sliderAlerts = sliderAlerts.filter(a => a.source?.ip === filters.ip);
            sliderDecisions = sliderDecisions.filter(d => d.value === filters.ip);
        }

        if (filters.target) {
            // Use pre-computed target field from stats endpoint
            filteredAlerts = filteredAlerts.filter(a => a.target === filters.target);
            // Filter decisions by target - match IPs from filtered alerts
            const ipsOnTarget = new Set(
                filteredAlerts.map(a => a.source?.ip).filter(ip => ip)
            );
            activeDecisions = activeDecisions.filter(d => ipsOnTarget.has(d.value));
            simulatedDecisions = simulatedDecisions.filter(d => ipsOnTarget.has(d.value));

            // Charts - use pre-computed target
            chartAlerts = chartAlerts.filter(a => a.target === filters.target);
            const chartIpsOnTarget = new Set(
                chartAlerts.map(a => a.source?.ip).filter(ip => ip)
            );
            chartDecisionsData = chartDecisionsData.filter(d => chartIpsOnTarget.has(d.value));

            // Slider - use pre-computed target
            sliderAlerts = sliderAlerts.filter(a => a.target === filters.target);
            const sliderIpsOnTarget = new Set(
                sliderAlerts.map(a => a.source?.ip).filter(ip => ip)
            );
            sliderDecisions = sliderDecisions.filter(d => sliderIpsOnTarget.has(d.value));
        }

        const liveAlerts = filteredAlerts.filter((alert) => alert.simulated !== true);
        const simulatedAlerts = filteredAlerts.filter((alert) => alert.simulated === true);
        const chartLiveAlerts = chartAlerts.filter((alert) => alert.simulated !== true);
        const chartSimulatedAlerts = chartAlerts.filter((alert) => alert.simulated === true);
        const chartLiveDecisions = chartDecisionsData.filter((decision) => decision.simulated !== true);
        const chartSimulatedDecisions = chartDecisionsData.filter((decision) => decision.simulated === true);
        const sliderLiveAlerts = sliderAlerts.filter((alert) => alert.simulated !== true);
        const sliderSimulatedAlerts = sliderAlerts.filter((alert) => alert.simulated === true);
        const sliderLiveDecisions = sliderDecisions.filter((decision) => decision.simulated !== true);
        const sliderSimulatedDecisions = sliderDecisions.filter((decision) => decision.simulated === true);

        return {
            liveAlerts,
            simulatedAlerts,
            alerts: filteredAlerts,
            decisions: activeDecisions,
            simulatedDecisions,
            chartLiveAlerts,
            chartSimulatedAlerts,
            chartLiveDecisions,
            chartSimulatedDecisions,
            chartAlerts: chartAlerts,
            chartDecisions: chartDecisionsData,
            sliderLiveAlerts,
            sliderSimulatedAlerts,
            sliderLiveDecisions,
            sliderSimulatedDecisions,
            sliderAlerts: sliderAlerts,
            sliderDecisions: sliderDecisions,
            // Global total (filtered by Lookback ONLY, ignoring sidebar filters)
            globalTotal: filterLastNDays(rawData.alertsForStats, lookbackDays)
                .filter(a => matchesSimulationFilter({ simulated: a.simulated }, simulationFilter)).length
        };
    }, [rawData, config?.lookback_days, filters]);



    // Derived Statistics
    const statistics = useMemo(() => {
        const lookbackDays = config?.lookback_days || 7;

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
            alertsHistory: getAggregatedData(filteredData.chartLiveAlerts, lookbackDays, granularity, filters.dateRange),
            simulatedAlertsHistory: getAggregatedData(filteredData.chartSimulatedAlerts, lookbackDays, granularity, filters.dateRange),
            decisionsHistory: getAggregatedData(filteredData.chartLiveDecisions, lookbackDays, granularity, filters.dateRange),
            simulatedDecisionsHistory: getAggregatedData(filteredData.chartSimulatedDecisions, lookbackDays, granularity, filters.dateRange),
            // Unfiltered history for the TimeRangeSlider (Global context + Sidebar Filters)
            unfilteredAlertsHistory: getAggregatedData(filteredData.sliderLiveAlerts, lookbackDays, granularity),
            unfilteredSimulatedAlertsHistory: getAggregatedData(filteredData.sliderSimulatedAlerts, lookbackDays, granularity),
            unfilteredDecisionsHistory: getAggregatedData(filteredData.sliderLiveDecisions, lookbackDays, granularity),
            unfilteredSimulatedDecisionsHistory: getAggregatedData(filteredData.sliderSimulatedDecisions, lookbackDays, granularity),
        };
    }, [filteredData, config?.lookback_days, granularity, filters.dateRange]);
    

    // Handle Filters
    const toggleFilter = (type: FilterKey, value: string | null | undefined) => {
        if (!value) {
            return;
        }

        if (type === 'simulation') {
            setFilters(prev => ({
                ...prev,
                simulation: prev.simulation === value ? 'all' : value as SimulationFilter,
            }));
            return;
        }

        setFilters(prev => ({
            ...prev,
            [type]: prev[type] === value ? null : value
        }));
    };

    const clearFilters = () => {
        setFilters(EMPTY_FILTERS);
    };

    const buildDrilldownParams = (includeExpired = false) => {
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
        if ((config?.simulations_enabled ?? false) && filters.simulation !== 'all') {
            params.set('simulation', filters.simulation);
        }
        if (includeExpired) {
            params.set('include_expired', 'true');
        }
        return params.toString();
    };

    const alertsLink = `/alerts${buildDrilldownParams() ? `?${buildDrilldownParams()}` : ''}`;
    const decisionsLink = `/decisions${buildDrilldownParams(true) ? `?${buildDrilldownParams(true)}` : ''}`;
    const simulationsEnabled = config?.simulations_enabled === true;
    const filteredSimulationAlertsCount = filteredData.simulatedAlerts.length;
    const filteredSimulationDecisionsCount = filteredData.simulatedDecisions.length;
    const totalLiveAlerts = stats.alerts - stats.simulatedAlerts;
    const totalAllDecisions = stats.decisions + stats.simulatedDecisions;
    const filteredAllDecisions = filteredData.decisions.length + filteredSimulationDecisionsCount;
    const modeAwareAlertsTotal = filters.simulation === 'simulated'
        ? stats.simulatedAlerts
        : filters.simulation === 'live'
            ? totalLiveAlerts
            : stats.alerts;
    const modeAwareAlertsFiltered = filters.simulation === 'simulated'
        ? filteredSimulationAlertsCount
        : filters.simulation === 'live'
            ? filteredData.liveAlerts.length
            : filteredData.alerts.length;
    const modeAwareDecisionsTotal = filters.simulation === 'simulated'
        ? stats.simulatedDecisions
        : filters.simulation === 'live'
            ? stats.decisions
            : totalAllDecisions;
    const modeAwareDecisionsFiltered = filters.simulation === 'simulated'
        ? filteredSimulationDecisionsCount
        : filters.simulation === 'live'
            ? filteredData.decisions.length
            : filteredAllDecisions;
    const showSimulationBreakout = simulationsEnabled && filters.simulation === 'all';

    const hasActiveFilters = filters.dateRange !== null ||
        filters.country !== null ||
        filters.scenario !== null ||
        filters.as !== null ||
        filters.ip !== null ||
        filters.target !== null ||
        filters.simulation !== 'all';

    if (loading) {
        return <div className="text-center p-8 text-gray-500">Loading dashboard...</div>;
    }

    return (
        <div className="space-y-8">
            {/* Summary Cards */}
            <div className="grid gap-8 md:grid-cols-3">
                <Link to={alertsLink} className="block transition-transform hover:scale-105">
                    <Card className="h-full cursor-pointer hover:shadow-lg transition-shadow">
                        <CardContent className="flex items-center p-6">
                            <div className="p-4 bg-red-100 dark:bg-red-900/20 rounded-full mr-4">
                                <ShieldAlert className="w-8 h-8 text-red-600 dark:text-red-400" />
                            </div>
                            <div>
                                <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Alerts</p>
                                <div className="flex items-baseline gap-2">
                                    <h3 className="text-2xl font-bold text-gray-900 dark:text-white">{modeAwareAlertsTotal}</h3>
                                    {hasActiveFilters && (
                                        <span className="text-sm text-gray-500 dark:text-gray-400">
                                            {modeAwareAlertsFiltered}
                                        </span>
                                    )}
                                </div>
                                {showSimulationBreakout && stats.simulatedAlerts > 0 && (
                                    <div className="mt-3">
                                        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-gray-500 dark:text-gray-400">
                                            Simulation
                                        </p>
                                        <div className="flex items-baseline gap-2">
                                            <span className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                                                {stats.simulatedAlerts}
                                            </span>
                                            {hasActiveFilters && (
                                                <span className="text-xs text-gray-500 dark:text-gray-400">
                                                    {filteredSimulationAlertsCount}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                </Link>

                <Link to={decisionsLink} className="block transition-transform hover:scale-105">
                    <Card className="h-full cursor-pointer hover:shadow-lg transition-shadow">
                        <CardContent className="flex items-center p-6">
                            <div className="p-4 bg-blue-100 dark:bg-blue-900/20 rounded-full mr-4">
                                <Gavel className="w-8 h-8 text-blue-600 dark:text-blue-400" />
                            </div>
                            <div>
                                <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Active Decisions</p>
                                <div className="flex items-baseline gap-2">
                                    <h3 className="text-2xl font-bold text-gray-900 dark:text-white">{modeAwareDecisionsTotal}</h3>
                                    {hasActiveFilters && (
                                        <span className="text-sm text-gray-500 dark:text-gray-400">
                                            {modeAwareDecisionsFiltered}
                                        </span>
                                    )}
                                </div>
                                {showSimulationBreakout && stats.simulatedDecisions > 0 && (
                                    <div className="mt-3">
                                        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-gray-500 dark:text-gray-400">
                                            Simulation
                                        </p>
                                        <div className="flex items-baseline gap-2">
                                            <span className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                                                {stats.simulatedDecisions}
                                            </span>
                                            {hasActiveFilters && (
                                                <span className="text-xs text-gray-500 dark:text-gray-400">
                                                    {filteredSimulationDecisionsCount}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                )}
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
                            Last {config?.lookback_days ?? 7} Days Statistics
                        </h3>
                    </div>

                    <div className="flex flex-col md:flex-row items-center gap-4">
                        {hasActiveFilters && (
                            <div className="flex flex-row items-center gap-2">
                                <button
                                    onClick={() => navigate(alertsLink)}
                                    className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                                >
                                    <Filter className="w-4 h-4" />
                                    <span className="hidden sm:inline">View Alerts</span>
                                    <span className="sm:hidden">Alerts</span>
                                </button>
                                <button
                                    onClick={() => navigate(decisionsLink)}
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
                        )}

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

                        {simulationsEnabled && (
                            <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-sm dark:border-gray-700 dark:bg-gray-800">
                                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Mode</span>
                                {(['all', 'live', 'simulated'] as SimulationFilter[]).map((value) => (
                                    <button
                                        key={value}
                                        onClick={() => toggleFilter('simulation', value)}
                                        className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${filters.simulation === value
                                            ? 'bg-primary-600 text-white'
                                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
                                            }`}
                                    >
                                        {value === 'all' ? 'All' : value === 'live' ? 'Live' : 'Simulation'}
                                    </button>
                                ))}
                            </div>
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
                                <Suspense fallback={<div className="text-center p-8 text-gray-500">Loading chart...</div>}>
                                    <ActivityBarChart
                                        alertsData={statistics.alertsHistory}
                                        decisionsData={statistics.decisionsHistory}
                                        simulatedAlertsData={statistics.simulatedAlertsHistory}
                                        simulatedDecisionsData={statistics.simulatedDecisionsHistory}
                                        unfilteredAlertsData={statistics.unfilteredAlertsHistory}
                                        unfilteredDecisionsData={statistics.unfilteredDecisionsHistory}
                                        unfilteredSimulatedAlertsData={statistics.unfilteredSimulatedAlertsHistory}
                                        unfilteredSimulatedDecisionsData={statistics.unfilteredSimulatedDecisionsHistory}
                                        simulationsEnabled={simulationsEnabled}
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
                                </Suspense>
                            </div>

                            {/* World Map - Right */}
                            <div className="h-[450px]">
                                <Suspense fallback={<div className="text-center p-8 text-gray-500">Loading map...</div>}>
                                    <WorldMapCard
                                        data={statistics.allCountries}
                                        onCountrySelect={(code) => toggleFilter('country', code)}
                                        selectedCountry={filters.country}
                                        simulationsEnabled={simulationsEnabled}
                                    />
                                </Suspense>
                            </div>
                        </div>

                        {/* Top Statistics Grid */}
                        <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-4">
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
