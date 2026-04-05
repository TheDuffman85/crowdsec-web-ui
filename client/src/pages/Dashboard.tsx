import { lazy, Suspense, useEffect, useState, useMemo, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";

import { fetchDashboardStats, fetchConfig } from "../lib/api";
import type { DashboardStatsFilters } from "../lib/api";
import { useRefresh } from "../contexts/useRefresh";
import { Card, CardContent } from "../components/ui/Card";
import { StatCard } from "../components/StatCard";
import { ScenarioName } from "../components/ScenarioName";
import { getCountryName } from "../lib/utils";
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
    AggregatedChartPoint,
    ConfigResponse,
    DashboardFilters,
    DashboardStatsResponse,
    SimulationFilter,
    StatListItem,
    WorldMapDatum,
} from '../types';

type Granularity = 'day' | 'hour';
type ScaleMode = 'linear' | 'symlog';
type PercentageBasis = 'filtered' | 'global';
type FilterKey = 'country' | 'scenario' | 'as' | 'ip' | 'target' | 'simulation';

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

/**
 * Convert server time-series buckets to chart data points.
 * Server returns dates as 'YYYY-MM-DD' or 'YYYY-MM-DDTHH'.
 * Chart expects { date, count, label, fullDate }.
 */
function bucketsToChartPoints(
    buckets: Array<{ date: string; count: number }>,
    granularity: Granularity,
): AggregatedChartPoint[] {
    return buckets.map(b => {
        let label: string;
        let fullDate: string;

        if (granularity === 'hour' && b.date.includes('T')) {
            // Format: YYYY-MM-DDTHH
            const [datePart, hourPart] = b.date.split('T');
            const [y, m, d] = datePart.split('-').map(Number);
            const h = Number(hourPart);
            const dt = new Date(y, m - 1, d, h, 0, 0);
            label = dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + String(h).padStart(2, '0') + ':00';
            fullDate = dt.toISOString();
        } else {
            const [y, m, d] = b.date.split('-').map(Number);
            const dt = new Date(y, m - 1, d, 0, 0, 0);
            label = dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
            fullDate = dt.toISOString();
        }

        return {
            date: b.date,
            count: b.count,
            label,
            fullDate,
        };
    });
}

/**
 * Fill time-series gaps so the chart shows continuous bars.
 * This generates all bucket keys between the server data boundaries,
 * matching what the old getAggregatedData did.
 */
function fillTimeSeries(
    points: AggregatedChartPoint[],
    lookbackDays: number,
    granularity: Granularity,
    dateRange: { start: string; end: string } | null,
): AggregatedChartPoint[] {
    const dataMap: Record<string, AggregatedChartPoint> = {};
    const now = new Date();

    let start: Date;
    let end = now;

    if (dateRange && dateRange.start && dateRange.end) {
        const parseDateKey = (key: string): Date => {
            if (key.includes('T')) {
                const [datePart, timePart] = key.split('T');
                const [y, m, d] = datePart.split('-').map(Number);
                const h = Number(timePart);
                return new Date(y, m - 1, d, h, 0, 0);
            }
            const [y, m, d] = key.split('-').map(Number);
            return new Date(y, m - 1, d, 0, 0, 0);
        };
        start = parseDateKey(dateRange.start);
        end = parseDateKey(dateRange.end);
    } else {
        start = new Date(now);
        start.setDate(start.getDate() - (lookbackDays - 1));
        start.setHours(0, 0, 0, 0);
    }

    const getKey = (date: Date): string => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        if (granularity === 'hour') {
            const hour = String(date.getHours()).padStart(2, '0');
            return `${year}-${month}-${day}T${hour}`;
        }
        return `${year}-${month}-${day}`;
    };

    const getLabel = (date: Date): string => {
        const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        if (granularity === 'hour') {
            return dateStr + ', ' + date.getHours().toString().padStart(2, '0') + ':00';
        }
        return dateStr;
    };

    // Initialize all empty slots
    const current = new Date(start);
    while (current <= end) {
        const key = getKey(current);
        dataMap[key] = {
            date: key,
            count: 0,
            label: getLabel(current),
            fullDate: new Date(current).toISOString(),
        };
        if (granularity === 'hour') current.setHours(current.getHours() + 1);
        else current.setDate(current.getDate() + 1);
    }

    // Fill in actual data
    for (const p of points) {
        if (dataMap[p.date]) {
            dataMap[p.date].count = p.count;
        }
    }

    return Object.values(dataMap).sort((a, b) => a.date.localeCompare(b.date));
}

export function Dashboard() {
    const navigate = useNavigate();
    const { refreshSignal, setLastUpdated } = useRefresh();
    const [loading, setLoading] = useState(true);
    const [statsLoading, setStatsLoading] = useState(true);
    const [config, setConfig] = useState<ConfigResponse | null>(null);

    const [granularity, setGranularity] = useState<Granularity>(() => parseStoredGranularity(localStorage.getItem('dashboard_granularity')));
    const [scaleMode, setScaleMode] = useState<ScaleMode>(() => parseStoredScaleMode(localStorage.getItem('dashboard_scale_mode')));
    const [percentageBasis, setPercentageBasis] = useState<PercentageBasis>(() => parseStoredPercentageBasis(localStorage.getItem('dashboard_percentage_basis')));
    const [isOnline, setIsOnline] = useState(true);

    // Pre-aggregated data from server
    const [dashboardData, setDashboardData] = useState<DashboardStatsResponse | null>(null);

    // Active filters
    const [filters, setFilters] = useState<DashboardFilters>(() => parseStoredFilters(localStorage.getItem('dashboard_filters')));

    // Persist filters and settings
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

    const handleGranularityChange = (newGranularity: Granularity) => {
        setGranularity(newGranularity);
        setFilters(prev => ({ ...prev, dateRange: null }));
    };

    // Build server-side filters from client filter state
    const serverFilters = useMemo<DashboardStatsFilters | undefined>(() => {
        const f: DashboardStatsFilters = {};
        let hasAny = false;
        if (filters.country) { f.country = filters.country; hasAny = true; }
        if (filters.scenario) { f.scenario = filters.scenario; hasAny = true; }
        if (filters.as) { f.as_name = filters.as; hasAny = true; }
        if (filters.ip) { f.ip = filters.ip; hasAny = true; }
        if (filters.target) { f.target = filters.target; hasAny = true; }
        if (filters.simulation === 'live') { f.simulated = false; hasAny = true; }
        if (filters.simulation === 'simulated') { f.simulated = true; hasAny = true; }
        return hasAny ? f : undefined;
    }, [filters.country, filters.scenario, filters.as, filters.ip, filters.target, filters.simulation]);

    const loadData = useCallback(async (isBackground = false) => {
        try {
            const configData = await fetchConfig();
            setConfig(configData);

            const data = await fetchDashboardStats(granularity, serverFilters);
            setDashboardData(data);

            if (configData.lapi_status) {
                setIsOnline(configData.lapi_status.isConnected);
            } else {
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
    }, [setLastUpdated, granularity, serverFilters]);

    // Initial Load + reload on filter/granularity change
    useEffect(() => {
        loadData(false);
    }, [loadData]);

    // Background Refresh
    useEffect(() => {
        if (refreshSignal > 0) {
            loadData(true);
        }
    }, [refreshSignal, loadData]);

    // Derived chart data from server response
    const statistics = useMemo(() => {
        if (!dashboardData) return null;

        const lookbackDays = config?.lookback_days || 7;
        const ts = dashboardData.time_series;

        const alertPoints = bucketsToChartPoints(ts.alert_buckets, granularity);
        const decisionPoints = bucketsToChartPoints(ts.decision_buckets, granularity);
        const simAlertPoints = bucketsToChartPoints(ts.simulated_alert_buckets, granularity);
        const simDecisionPoints = bucketsToChartPoints(ts.simulated_decision_buckets, granularity);

        // Fill gaps for the chart range
        const alertsHistory = fillTimeSeries(alertPoints, lookbackDays, granularity, filters.dateRange);
        const decisionsHistory = fillTimeSeries(decisionPoints, lookbackDays, granularity, filters.dateRange);
        const simulatedAlertsHistory = fillTimeSeries(simAlertPoints, lookbackDays, granularity, filters.dateRange);
        const simulatedDecisionsHistory = fillTimeSeries(simDecisionPoints, lookbackDays, granularity, filters.dateRange);

        // Unfiltered for slider (same as filtered since server handles filters)
        const unfilteredAlertsHistory = fillTimeSeries(alertPoints, lookbackDays, granularity, null);
        const unfilteredDecisionsHistory = fillTimeSeries(decisionPoints, lookbackDays, granularity, null);
        const unfilteredSimulatedAlertsHistory = fillTimeSeries(simAlertPoints, lookbackDays, granularity, null);
        const unfilteredSimulatedDecisionsHistory = fillTimeSeries(simDecisionPoints, lookbackDays, granularity, null);

        // Top countries for stat cards
        const topCountries: StatListItem[] = dashboardData.top_countries.map(c => ({
            label: getCountryName(c.code) || c.code,
            value: c.code,
            count: c.count,
            countryCode: c.code,
        }));

        // All countries for world map
        const allCountries: WorldMapDatum[] = dashboardData.all_countries.map(c => ({
            label: getCountryName(c.code) || c.code,
            count: c.count,
            countryCode: c.code,
            simulatedCount: c.simulated_count,
            liveCount: c.live_count,
        }));

        const topScenarios: StatListItem[] = dashboardData.top_scenarios.map(s => ({
            label: s.name,
            count: s.count,
        }));

        const topAS: StatListItem[] = dashboardData.top_as.map(a => ({
            label: a.name,
            count: a.count,
        }));

        const topTargets: StatListItem[] = dashboardData.top_targets.map(t => ({
            label: t.name,
            count: t.count,
        }));

        return {
            alertsHistory,
            decisionsHistory,
            simulatedAlertsHistory,
            simulatedDecisionsHistory,
            unfilteredAlertsHistory,
            unfilteredDecisionsHistory,
            unfilteredSimulatedAlertsHistory,
            unfilteredSimulatedDecisionsHistory,
            topCountries,
            allCountries,
            topScenarios,
            topAS,
            topTargets,
        };
    }, [dashboardData, config?.lookback_days, granularity, filters.dateRange]);

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

    // Totals from server
    const totalAlerts = dashboardData?.totals.alerts ?? 0;
    const totalDecisions = dashboardData?.totals.decisions ?? 0;
    const simulatedAlertsCount = dashboardData?.totals.simulated_alerts ?? 0;
    const liveAlertsCount = totalAlerts - simulatedAlertsCount;

    const simulationsEnabled = config?.simulations_enabled === true;
    const hasActiveFilters = filters.dateRange !== null ||
        filters.country !== null ||
        filters.scenario !== null ||
        filters.as !== null ||
        filters.ip !== null ||
        filters.target !== null ||
        filters.simulation !== 'all';

    const alertsLink = `/alerts${buildDrilldownParams() ? `?${buildDrilldownParams()}` : ''}`;
    const decisionsLink = `/decisions${buildDrilldownParams(true) ? `?${buildDrilldownParams(true)}` : ''}`;
    const showSimulationBreakout = simulationsEnabled && filters.simulation === 'all';

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
                                    <h3 className="text-2xl font-bold text-gray-900 dark:text-white">{totalAlerts}</h3>
                                </div>
                                {showSimulationBreakout && simulatedAlertsCount > 0 && (
                                    <div className="mt-3">
                                        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-gray-500 dark:text-gray-400">
                                            Simulation
                                        </p>
                                        <div className="flex items-baseline gap-2">
                                            <span className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                                                {simulatedAlertsCount}
                                            </span>
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
                                    <h3 className="text-2xl font-bold text-gray-900 dark:text-white">{totalDecisions}</h3>
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
                ) : statistics ? (
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
                                total={totalAlerts}
                            />
                            <StatCard
                                title="Top Scenarios"
                                items={statistics.topScenarios}
                                onSelect={(item) => toggleFilter('scenario', item.label)}
                                selectedValue={filters.scenario}
                                renderLabel={(item) => (
                                    <ScenarioName name={item.label} showLink={true} />
                                )}
                                total={totalAlerts}
                            />
                            <StatCard
                                title="Top AS"
                                items={statistics.topAS}
                                onSelect={(item) => toggleFilter('as', item.label)}
                                selectedValue={filters.as}
                                total={totalAlerts}
                            />
                            <StatCard
                                title="Top Targets"
                                items={statistics.topTargets}
                                onSelect={(item) => toggleFilter('target', item.label)}
                                selectedValue={filters.target}
                                total={totalAlerts}
                            />
                        </div>
                    </>
                ) : null}
            </div>
        </div>
    );
}
