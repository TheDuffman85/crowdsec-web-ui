import { useMemo, useRef } from 'react';
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer,
    Brush
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { BarChart3, Clock } from 'lucide-react';


/**
 * Custom Tooltip Component for better dark mode support
 */
const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
        return (
            <div className="bg-white dark:bg-gray-800 p-3 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">{label}</p>
                {payload.map((entry, index) => (
                    <p key={index} className="text-sm" style={{ color: entry.color }}>
                        {entry.name}: {entry.value}
                    </p>
                ))}
            </div>
        );
    }
    return null;
};

/**
 * Combined Bar Chart for Alerts and Decisions
 */
export function ActivityBarChart({ alertsData, decisionsData, unfilteredAlertsData, unfilteredDecisionsData, granularity, setGranularity, onDateRangeSelect, selectedDateRange }) {
    // -------------------------------------------------------------------------
    // 1. Process Filtered Data (Main Chart)
    // -------------------------------------------------------------------------
    const filteredData = useMemo(() => {
        const merged = {};

        // Process alerts
        alertsData.forEach(item => {
            merged[item.date] = {
                date: item.fullDate || item.date,
                bucketKey: item.date, // Store the bucket key for filtering
                alerts: item.count,
                decisions: 0,
                label: item.label
            };
        });

        // Process decisions
        decisionsData.forEach(item => {
            if (!merged[item.date]) merged[item.date] = {
                date: item.fullDate || item.date,
                bucketKey: item.date, // Store the bucket key for filtering
                alerts: 0,
                decisions: 0,
                label: item.label
            };
            merged[item.date].decisions = item.count;
        });

        return Object.values(merged).sort((a, b) => a.date.localeCompare(b.date));
    }, [alertsData, decisionsData]);


    // -------------------------------------------------------------------------
    // 2. Process Unfiltered Data (Slider)
    // -------------------------------------------------------------------------
    const sliderData = useMemo(() => {
        const merged = {};
        if (unfilteredAlertsData) {
            unfilteredAlertsData.forEach(item => {
                merged[item.date] = {
                    date: item.fullDate || item.date,
                    bucketKey: item.date,
                    label: item.label
                    // We don't need counts for visual bars if we are hiding them
                };
            });
        }
        if (unfilteredDecisionsData) {
            unfilteredDecisionsData.forEach(item => {
                if (!merged[item.date]) merged[item.date] = {
                    date: item.fullDate || item.date,
                    bucketKey: item.date,
                    label: item.label
                };
            });
        }
        return Object.values(merged).sort((a, b) => a.date.localeCompare(b.date));
    }, [unfilteredAlertsData, unfilteredDecisionsData]);

    // Slider Brush Logic
    const debounceTimeoutRef = useRef(null);
    const brushKey = useMemo(() => {
        // Generate a unique key whenever the data reference changes to force proper re-initialization
        // of the Brush component. This prevents it from losing the selection state on auto-refresh.
        return `brush-${Date.now()}`;
    }, [sliderData]);

    const { startIndex, endIndex } = useMemo(() => {
        if (!sliderData || sliderData.length === 0) return { startIndex: 0, endIndex: 0 };
        if (!selectedDateRange) return { startIndex: 0, endIndex: sliderData.length - 1 };

        let start = sliderData.findIndex(d => d.bucketKey >= selectedDateRange.start);
        let end = -1;
        for (let i = sliderData.length - 1; i >= 0; i--) {
            if (sliderData[i].bucketKey <= selectedDateRange.end) {
                end = i;
                break;
            }
        }
        if (start === -1) start = 0;
        if (end === -1) end = sliderData.length - 1;
        return { startIndex: start, endIndex: end };
    }, [sliderData, selectedDateRange]);


    const granularities = ['day', 'hour'];

    return (
        <Card className="h-full outline-none flex flex-col">
            <CardHeader className="flex-none">
                <div className="flex items-center justify-between w-full">
                    <CardTitle className="flex items-center gap-2">
                        <BarChart3 className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                        Activity History
                    </CardTitle>
                    <div className="flex p-1 bg-gray-100 dark:bg-gray-800 rounded-lg">
                        {granularities.map((g) => (
                            <button
                                key={g}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (setGranularity) setGranularity(g);
                                }}
                                className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${granularity === g
                                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                                    : 'text-gray-500 hover:text-gray-900 dark:hover:text-gray-300'
                                    }`}
                            >
                                {g.charAt(0).toUpperCase() + g.slice(1)}
                            </button>
                        ))}
                    </div>
                </div>
            </CardHeader>
            <CardContent className="flex-1 min-h-0 flex flex-col gap-4">
                {/* Main Chart Section */}
                <div className="flex-1 min-h-0">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                            data={filteredData}
                            margin={{ top: 20, right: 30, left: 20, bottom: 20 }}
                        >
                            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                            <XAxis dataKey="label" stroke="#888888" fontSize={12} tickLine={false} axisLine={false} />
                            <YAxis stroke="#888888" fontSize={12} tickLine={false} axisLine={false} />
                            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'transparent' }} />
                            <Legend verticalAlign="top" height={36} />
                            <Bar
                                isAnimationActive={false}
                                dataKey="alerts"
                                name="Alerts"
                                fill="#dc2626"
                                stroke="none"
                                radius={[4, 4, 0, 0]}
                            />
                            <Bar
                                isAnimationActive={false}
                                dataKey="decisions"
                                name="Decisions"
                                fill="#2563eb"
                                stroke="none"
                                radius={[4, 4, 0, 0]}
                            />
                        </BarChart>
                    </ResponsiveContainer>
                </div>

                {/* Slider Section */}
                <div className="h-[40px] shrink-0">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                            data={sliderData}
                            margin={{ top: 0, right: 30, left: 20, bottom: 0 }}
                        >
                            <Brush
                                key={`${granularity}-${brushKey}`}
                                dataKey="date"
                                height={40}
                                stroke="#888888"
                                fill="transparent"
                                startIndex={startIndex}
                                endIndex={endIndex}
                                onChange={(e) => {
                                    if (!e || e.startIndex === undefined || e.endIndex === undefined) return;

                                    const isStartReset = e.startIndex === 0;
                                    const isEndReset = e.endIndex >= sliderData.length - 1;
                                    const isFullRange = isStartReset && isEndReset;

                                    const startItem = sliderData[e.startIndex];
                                    const endItem = sliderData[e.endIndex];

                                    if (startItem && endItem && onDateRangeSelect) {
                                        if (debounceTimeoutRef.current) {
                                            clearTimeout(debounceTimeoutRef.current);
                                        }

                                        const dateRange = isFullRange ? null : {
                                            start: startItem.bucketKey,
                                            end: endItem.bucketKey
                                        };

                                        debounceTimeoutRef.current = setTimeout(() => {
                                            onDateRangeSelect(dateRange);
                                        }, 300);
                                    }
                                }}
                                tickFormatter={(date) => {
                                    if (!date) return '';
                                    const d = new Date(date);
                                    if (granularity === 'hour') {
                                        return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit' });
                                    }
                                    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
                                }}
                            />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </CardContent>
        </Card >
    );
}

