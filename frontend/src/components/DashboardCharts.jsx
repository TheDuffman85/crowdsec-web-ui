import { useMemo, useState, useEffect, useRef, useLayoutEffect } from 'react';
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
import { BarChart3 } from 'lucide-react';

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
export function ActivityBarChart({ alertsData, decisionsData, onDateRangeSelect, selectedDateRange, granularity, setGranularity }) {
    // Debounce timeout ref to only update filter when user stops dragging
    const debounceTimeoutRef = useRef(null);
    // Merge data by date
    const data = useMemo(() => {
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

    const granularities = ['day', 'hour'];

    // Calculate Brush position based on selectedDateRange from parent
    const { startIndex, endIndex } = useMemo(() => {
        if (!data || data.length === 0) return { startIndex: 0, endIndex: data.length - 1 };

        // If no date range filter is active, show full range
        if (!selectedDateRange) {
            return { startIndex: 0, endIndex: data.length - 1 };
        }

        // Find indices for the selected date range
        let start = data.findIndex(d => d.bucketKey >= selectedDateRange.start);
        let end = -1;
        for (let i = data.length - 1; i >= 0; i--) {
            if (data[i].bucketKey <= selectedDateRange.end) {
                end = i;
                break;
            }
        }

        // Fallbacks
        if (start === -1) start = 0;
        if (end === -1) end = data.length - 1;

        // Ensure validity
        start = Math.max(0, Math.min(start, data.length - 1));
        end = Math.max(0, Math.min(end, data.length - 1));
        if (start > end) {
            return { startIndex: 0, endIndex: data.length - 1 };
        }

        return { startIndex: start, endIndex: end };
    }, [data, selectedDateRange]);

    // Calculate hash to force re-render when data changes
    const dataHash = useMemo(() => {
        if (!data || data.length === 0) return '';
        const totalAlerts = data.reduce((acc, item) => acc + (item.alerts || 0), 0);
        const totalDecisions = data.reduce((acc, item) => acc + (item.decisions || 0), 0);
        const start = data[0]?.date || '';
        const end = data[data.length - 1]?.date || '';
        return `${totalAlerts}-${totalDecisions}-${start}-${end}`;
    }, [data]);

    return (
        <Card className="h-full outline-none">
            <CardHeader>
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
            <CardContent>
                <div className="h-[300px] w-full outline-none">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                            // Force re-render when granularity OR data content changes (filtering)
                            // This ensures Brush initializes with the correct [zoomState] rather than resetting
                            key={`${granularity}-${dataHash}`}
                            data={data}
                            margin={{ top: 20, right: 30, left: 20, bottom: 50 }}
                        >
                            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                            <XAxis dataKey="label" stroke="#888888" fontSize={12} tickLine={false} axisLine={false} />
                            <YAxis stroke="#888888" fontSize={12} tickLine={false} axisLine={false} />
                            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'transparent' }} />
                            <Legend verticalAlign="top" height={36} />
                            <Brush
                                key={`${dataHash}`}
                                dataKey="date"
                                height={30}
                                stroke="#888888"
                                fill="transparent"
                                startIndex={startIndex}
                                endIndex={endIndex}
                                onChange={(e) => {
                                    if (!e || e.startIndex === undefined || e.endIndex === undefined) return;

                                    const isStartReset = e.startIndex === 0;
                                    const isEndReset = e.endIndex >= data.length - 1;
                                    const isFullRange = isStartReset && isEndReset;

                                    const startItem = data[e.startIndex];
                                    const endItem = data[e.endIndex];

                                    if (startItem && endItem && onDateRangeSelect) {
                                        // Clear any pending timeout
                                        if (debounceTimeoutRef.current) {
                                            clearTimeout(debounceTimeoutRef.current);
                                        }

                                        // Emit date range for filtering (null if full range selected)
                                        const dateRange = isFullRange ? null : {
                                            start: startItem.bucketKey,
                                            end: endItem.bucketKey
                                        };

                                        // Debounce: only update filter 500ms after user stops dragging
                                        debounceTimeoutRef.current = setTimeout(() => {
                                            onDateRangeSelect(dateRange);
                                        }, 500);
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
                            <Bar
                                isAnimationActive={false} // Disable animation to reduce visual noise on refresh
                                dataKey="alerts"
                                name="Alerts"
                                fill="#dc2626"
                                stroke="none"
                                radius={[4, 4, 0, 0]}
                            />
                            <Bar
                                isAnimationActive={false} // Disable animation to reduce visual noise on refresh
                                dataKey="decisions"
                                name="Decisions"
                                fill="#2563eb"
                                stroke="none"
                                radius={[4, 4, 0, 0]}
                            />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </CardContent>
        </Card >
    );
}
