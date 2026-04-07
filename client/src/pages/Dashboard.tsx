import { lazy, Suspense, useEffect, useState, useMemo, useCallback, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";

import { fetchDashboardStats, fetchConfig } from "../lib/api";
import { useRefresh } from "../contexts/useRefresh";
import { Card, CardContent } from "../components/ui/Card";
import { StatCard } from "../components/StatCard";
import { ScenarioName } from "../components/ScenarioName";
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
    DashboardStatsBucket,
    DashboardStatsResponse,
    SimulationFilter,
} from '../types';

type Granularity = 'day' | 'hour';
type ScaleMode = 'linear' | 'symlog';
type PercentageBasis = 'filtered' | 'global';
type FilterKey = 'country' | 'scenario' | 'as' | 'ip' | 'target' | 'simulation';

interface DashboardCountState {
    alerts: number;
    decisions: number;
    simulatedAlerts: number;
    simulatedDecisions: number;
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

const EMPTY_TOTALS: DashboardCountState = {
    alerts: 0,
    decisions: 0,
    simulatedAlerts: 0,
    simulatedDecisions: 0,
};

const EMPTY_DASHBOARD_STATS: DashboardStatsResponse = {
    totals: EMPTY_TOTALS,
    filteredTotals: EMPTY_TOTALS,
    globalTotal: 0,
    topTargets: [],
    topCountries: [],
    allCountries: [],
    topScenarios: [],
    topAS: [],
    series: {
        alertsHistory: [],
        simulatedAlertsHistory: [],
        decisionsHistory: [],
        simulatedDecisionsHistory: [],
        unfilteredAlertsHistory: [],
        unfilteredSimulatedAlertsHistory: [],
        unfilteredDecisionsHistory: [],
        unfilteredSimulatedDecisionsHistory: [],
    },
};

function parseStoredGranularity(value: string | null): Granularity {
    return value === 'hour' ? 'hour' : 'day';
}

function parseStoredScaleMode(value: string | null): ScaleMode {
    return value === 'symlog' ? 'symlog' : 'linear';
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

function formatDashboardBucketLabel(bucketKey: string): string {
    const [datePart, hourPart] = bucketKey.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const date = new Date(year, month - 1, day, hourPart === undefined ? 0 : Number(hourPart));
    const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

    if (hourPart !== undefined) {
        return `${dateStr}, ${String(date.getHours()).padStart(2, '0')}:00`;
    }

    return dateStr;
}

function toActivitySeries(buckets: DashboardStatsBucket[]) {
    return buckets.map((bucket) => ({
        date: bucket.date,
        count: bucket.count,
        label: formatDashboardBucketLabel(bucket.date),
        fullDate: bucket.fullDate,
    }));
}

export function Dashboard() {
    const navigate = useNavigate();
    const { refreshSignal, setLastUpdated } = useRefresh();
    const [loading, setLoading] = useState(true);
    const [statsLoading, setStatsLoading] = useState(true);
    const [config, setConfig] = useState<ConfigResponse | null>(null);

    // Initialize state from local storage or defaults
    const [granularity, setGranularity] = useState<Granularity>(() => parseStoredGranularity(localStorage.getItem('dashboard_granularity')));
    const [scaleMode, setScaleMode] = useState<ScaleMode>(() => parseStoredScaleMode(localStorage.getItem('dashboard_scale_mode')));

    // Percentage Basis: 'filtered' or 'global'
    const [percentageBasis, setPercentageBasis] = useState<PercentageBasis>(() => parseStoredPercentageBasis(localStorage.getItem('dashboard_percentage_basis')));

    const [isOnline, setIsOnline] = useState(true);
    const [dashboardStats, setDashboardStats] = useState<DashboardStatsResponse | null>(null);
    const dashboardStatsRef = useRef<DashboardStatsResponse | null>(null);

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
        localStorage.setItem('dashboard_scale_mode', scaleMode);
    }, [scaleMode]);

    useEffect(() => {
        localStorage.setItem('dashboard_percentage_basis', percentageBasis);
    }, [percentageBasis]);

    // Handler to change granularity and clear date range simultaneously (explicit user action)
    const handleGranularityChange = (newGranularity: Granularity) => {
        setGranularity(newGranularity);
        setFilters(prev => ({ ...prev, dateRange: null }));
    };

    const buildDashboardStatsFilters = useCallback((): Record<string, string> => {
        const requestFilters: Record<string, string> = {
            granularity,
            tz_offset: String(new Date().getTimezoneOffset()),
        };

        if (filters.country) requestFilters.country = filters.country;
        if (filters.scenario) requestFilters.scenario = filters.scenario;
        if (filters.as) requestFilters.as = filters.as;
        if (filters.ip) requestFilters.ip = filters.ip;
        if (filters.target) requestFilters.target = filters.target;
        if (filters.dateRange) {
            requestFilters.dateStart = filters.dateRange.start;
            requestFilters.dateEnd = filters.dateRange.end;
        }
        if (filters.simulation !== 'all') {
            requestFilters.simulation = filters.simulation;
        }

        return requestFilters;
    }, [filters, granularity]);

    const loadData = useCallback(async (isBackground = false, signal?: AbortSignal) => {
        if (!dashboardStatsRef.current && !isBackground) {
            setStatsLoading(true);
        }

        try {
            const [configData, dashboardStatsData] = await Promise.all([
                fetchConfig(),
                fetchDashboardStats(buildDashboardStatsFilters(), { signal }),
            ]);
            if (signal?.aborted) {
                return;
            }

            setConfig(configData);
            dashboardStatsRef.current = dashboardStatsData;
            setDashboardStats(dashboardStatsData);

            // Check LAPI status from config
            if (configData.lapi_status) {
                setIsOnline(configData.lapi_status.isConnected);
            } else {
                // Fallback for older backend versions
                setIsOnline(true);
            }

            setLastUpdated(new Date());

        } catch (error) {
            if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
                return;
            }
            console.error("Failed to load dashboard data", error);
            setIsOnline(false);
        } finally {
            if (!signal?.aborted) {
                setLoading(false);
                setStatsLoading(false);
            }
        }
    }, [buildDashboardStatsFilters, setLastUpdated]);

    useEffect(() => {
        const controller = new AbortController();
        loadData(false, controller.signal);
        return () => controller.abort();
    }, [loadData]);

    // Background Refresh
    useEffect(() => {
        if (refreshSignal > 0) {
            const controller = new AbortController();
            loadData(true, controller.signal);
            return () => controller.abort();
        }
    }, [refreshSignal, loadData]);

    const dashboardData = dashboardStats ?? EMPTY_DASHBOARD_STATS;
    const stats = dashboardData.totals;

    const statistics = useMemo(() => {
        return {
            topTargets: dashboardData.topTargets,
            topCountries: dashboardData.topCountries,
            allCountries: dashboardData.allCountries,
            topScenarios: dashboardData.topScenarios,
            topAS: dashboardData.topAS,
            alertsHistory: toActivitySeries(dashboardData.series.alertsHistory),
            simulatedAlertsHistory: toActivitySeries(dashboardData.series.simulatedAlertsHistory),
            decisionsHistory: toActivitySeries(dashboardData.series.decisionsHistory),
            simulatedDecisionsHistory: toActivitySeries(dashboardData.series.simulatedDecisionsHistory),
            unfilteredAlertsHistory: toActivitySeries(dashboardData.series.unfilteredAlertsHistory),
            unfilteredSimulatedAlertsHistory: toActivitySeries(dashboardData.series.unfilteredSimulatedAlertsHistory),
            unfilteredDecisionsHistory: toActivitySeries(dashboardData.series.unfilteredDecisionsHistory),
            unfilteredSimulatedDecisionsHistory: toActivitySeries(dashboardData.series.unfilteredSimulatedDecisionsHistory),
        };
    }, [dashboardData]);
    

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

    const buildDrilldownParams = () => {
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
        return params.toString();
    };

    const alertsLink = `/alerts${buildDrilldownParams() ? `?${buildDrilldownParams()}` : ''}`;
    const decisionsLink = `/decisions${buildDrilldownParams() ? `?${buildDrilldownParams()}` : ''}`;
    const simulationsEnabled = config?.simulations_enabled === true;
    const filteredTotals = dashboardData.filteredTotals;
    const filteredSimulationAlertsCount = filteredTotals.simulatedAlerts;
    const filteredSimulationDecisionsCount = filteredTotals.simulatedDecisions;
    const totalLiveAlerts = stats.alerts - stats.simulatedAlerts;
    const totalAllDecisions = stats.decisions + stats.simulatedDecisions;
    const filteredAllDecisions = filteredTotals.decisions + filteredSimulationDecisionsCount;
    const modeAwareAlertsTotal = filters.simulation === 'simulated'
        ? stats.simulatedAlerts
        : filters.simulation === 'live'
            ? totalLiveAlerts
            : stats.alerts;
    const modeAwareAlertsFiltered = filters.simulation === 'simulated'
        ? filteredSimulationAlertsCount
        : filters.simulation === 'live'
            ? filteredTotals.alerts
            : filteredTotals.alerts;
    const modeAwareDecisionsTotal = filters.simulation === 'simulated'
        ? stats.simulatedDecisions
        : filters.simulation === 'live'
            ? stats.decisions
            : totalAllDecisions;
    const modeAwareDecisionsFiltered = filters.simulation === 'simulated'
        ? filteredSimulationDecisionsCount
        : filters.simulation === 'live'
            ? filteredTotals.decisions
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
                                        scaleMode={scaleMode}
                                        setScaleMode={setScaleMode}
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
                                total={percentageBasis === 'global' ? dashboardData.globalTotal : filteredTotals.alerts}
                            />
                            <StatCard
                                title="Top Scenarios"
                                items={statistics.topScenarios}
                                onSelect={(item) => toggleFilter('scenario', item.label)}
                                selectedValue={filters.scenario}
                                renderLabel={(item) => (
                                    <ScenarioName name={item.label} showLink={true} />
                                )}
                                total={percentageBasis === 'global' ? dashboardData.globalTotal : filteredTotals.alerts}
                            />
                            <StatCard
                                title="Top AS"
                                items={statistics.topAS}
                                onSelect={(item) => toggleFilter('as', item.label)}
                                selectedValue={filters.as}
                                total={percentageBasis === 'global' ? dashboardData.globalTotal : filteredTotals.alerts}
                            />
                            <StatCard
                                title="Top Targets"
                                items={statistics.topTargets}
                                onSelect={(item) => toggleFilter('target', item.label)}
                                selectedValue={filters.target}
                                total={percentageBasis === 'global' ? dashboardData.globalTotal : filteredTotals.alerts}
                            />
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
