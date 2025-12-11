import { useMemo, useState, useEffect, useRef } from 'react';
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
export function ActivityBarChart({ alertsData, decisionsData, onDateSelect, selectedDate, granularity, setGranularity }) {
    const [zoomState, setZoomState] = useState(null);
    const lastZoomRef = useRef(null);

    // Reset zoom state when granularity changes
    useEffect(() => {
        setZoomState(null);
        lastZoomRef.current = null;
    }, [granularity]);

    // Merge data by date
    const data = useMemo(() => {
        const merged = {};
        // Use a set of all keys from both datasets to ensure complete coverage
        // although getAggregatedData should already handle this.

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

    // Default View logic
    const brushStartIndex = useMemo(() => {
        if (!data || data.length === 0) return 0;
        if (granularity === 'hour') return Math.max(0, data.length - 12);
        return 0;
    }, [data, granularity]);

    // Calculate effective brush props
    let brushStart = zoomState ? zoomState.startIndex : brushStartIndex;
    let brushEnd = zoomState && zoomState.endIndex !== undefined ? zoomState.endIndex : (data ? data.length - 1 : 0);

    // Calculate a data signature to force re-render when values change
    // This is necessary to prevent Recharts from resetting the Brush state locally
    // when data updates (e.g. filtering), ensuring our controlled zoomState takes precedence.
    const dataHash = useMemo(() => {
        if (!data) return '';
        const totalAlerts = data.reduce((acc, item) => acc + (item.alerts || 0), 0);
        const totalDecisions = data.reduce((acc, item) => acc + (item.decisions || 0), 0);
        return `${totalAlerts}-${totalDecisions}`;
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
                                dataKey="date"
                                height={30}
                                stroke="#888888"
                                fill="transparent"
                                startIndex={brushStart}
                                endIndex={brushEnd}
                                onChange={(e) => {
                                    if (!e) return;
                                    setZoomState(e);
                                }}
                                tickFormatter={(date) => {
                                    // Make brush ticks readable based on granularity
                                    if (!date) return '';
                                    const d = new Date(date);
                                    if (granularity === 'hour') {
                                        return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit' });
                                    }
                                    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
                                }}
                            />
                            <Bar
                                dataKey="alerts"
                                name="Alerts"
                                fill="#dc2626"
                                stroke="none"
                                radius={[4, 4, 0, 0]}
                                opacity={selectedDate ? (d => d.date === selectedDate ? 1 : 0.3) : 1}
                                cursor="pointer"
                                onClick={(data) => {
                                    console.log('Alerts bar clicked, data:', data);
                                    if (data && data.bucketKey) {
                                        onDateSelect(data.bucketKey);
                                    }
                                }}
                            />
                            <Bar
                                dataKey="decisions"
                                name="Decisions"
                                fill="#2563eb"
                                stroke="none"
                                radius={[4, 4, 0, 0]}
                                opacity={selectedDate ? (d => d.date === selectedDate ? 1 : 0.3) : 1}
                                cursor="pointer"
                                onClick={(data) => {
                                    console.log('Decisions bar clicked, data:', data);
                                    if (data && data.bucketKey) {
                                        onDateSelect(data.bucketKey);
                                    }
                                }}
                            />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </CardContent>
        </Card >
    );
}
