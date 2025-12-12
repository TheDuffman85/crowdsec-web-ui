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
export function ActivityBarChart({ alertsData, decisionsData, onDateSelect, selectedDate, granularity, setGranularity }) {
    // Store zoom state as DATES, not indices
    const [zoomDateRange, setZoomDateRange] = useState(null);

    // Reset zoom state when granularity changes
    useEffect(() => {
        setZoomDateRange(null);
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

    // Calculate effective indices based on stored DATES
    const { startIndex, endIndex } = useMemo(() => {
        if (!data || data.length === 0) return { startIndex: 0, endIndex: 0 };

        // Default: Last 12 hours for 'hour' view, or full range for 'day'
        if (zoomDateRange === null) {
            if (granularity === 'hour') {
                return {
                    startIndex: Math.max(0, data.length - 12),
                    endIndex: data.length - 1
                };
            }
            return { startIndex: 0, endIndex: data.length - 1 };
        }

        // Find indices matching stored dates (or closest available)
        // For Start: Find first item where date >= zoomDateRange.start
        let start = data.findIndex(d => d.date >= zoomDateRange.start);

        // For End: Find last item where date <= zoomDateRange.end
        // Since data is sorted, we can reverse find or just find normal and take last
        // Efficient way: findIndex of first item > end, then go back one? 
        // Or just map/reduce. Let's iterate backwards for 'end'
        let end = -1;
        for (let i = data.length - 1; i >= 0; i--) {
            if (data[i].date <= zoomDateRange.end) {
                end = i;
                break;
            }
        }

        // Fallbacks if user scrolled strictly off-screen
        // If "start" is -1, it means NO item is >= zoomStart. So all items are older? Or all newer?
        // Data is sorted asc. 
        // If all items < zoomStart, findIndex returns -1. Meaning data is "to the left". 
        // If all items > zoomStart, findIndex returns 0. Correct.
        if (start === -1) {
            // Zoom window is in the future compared to data?
            // Should we show empty? Or last few?
            // Let's safe fallback to 0 but it's likely weird.
            start = 0;
        }

        if (end === -1) {
            // No item is <= zoomEnd. All items are > zoomEnd?
            // Data is "to the right".
            end = data.length - 1;
        }

        // Ensure validity
        start = Math.max(0, start);
        end = Math.min(data.length - 1, end);
        if (start > end) {
            // Overlap invalid? Reset to full or keep tight?
            // Maybe default to single point?
            start = 0;
            end = data.length - 1;
        }

        console.log(`[CalcIndices] S:${start} E:${end} (Zoom: ${zoomDateRange.start} - ${zoomDateRange.end})`);
        return { startIndex: start, endIndex: end };
    }, [data, zoomDateRange, granularity]);

    // Calculate a data signature to force re-render when values change
    // This is necessary to prevent Recharts from resetting the Brush state locally
    // when data updates (e.g. filtering), ensuring our controlled zoomState takes precedence.
    const dataHash = useMemo(() => {
        if (!data || data.length === 0) return '';
        const totalAlerts = data.reduce((acc, item) => acc + (item.alerts || 0), 0);
        const totalDecisions = data.reduce((acc, item) => acc + (item.decisions || 0), 0);
        // Include start and end date in hash to detect data shifting even if counts are same
        const start = data[0]?.date || '';
        const end = data[data.length - 1]?.date || '';
        return `${totalAlerts}-${totalDecisions}-${start}-${end}`;
    }, [data]);

    // Flag to ignore the spurious reset that Recharts Brush triggers immediately after mounting
    const ignoreNextResetRef = useRef(false);

    // Extra key to force Brush to remount when we detect it's "stuck" or "desynced"
    const [brushKey, setBrushKey] = useState(0);

    // Set flag when data changes (and Brush remounts via key)
    useLayoutEffect(() => {
        console.log('[Immunity] Activated for', dataHash);
        ignoreNextResetRef.current = true;
    }, [dataHash, brushKey]); // Reset immunity when we rotate key too

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
                                // Keyed Brush: Combines DataHash (Logic) + BrushKey (Enforcement).
                                // If Data changes, we remount.
                                // If Brush misbehaves (resets), we increment brushKey to KILL IT and try again.
                                key={`${dataHash}-${brushKey}`}
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

                                    // Spurious Reset Protection
                                    if (ignoreNextResetRef.current) {
                                        // If we get a reset while immune...
                                        if (isStartReset && zoomDateRange) {
                                            console.debug('[BrushEvent] BLOCKED spurious reset -> Rotating Key to Force Sync');
                                            ignoreNextResetRef.current = false;

                                            // KILL THE DEFECTIVE BRUSH
                                            // It thinks it's at 0. We know it should be at [startIndex].
                                            // Increment key to destroy it and mount a fresh one that obeys.
                                            setBrushKey(k => k + 1);
                                            return;
                                        }
                                        ignoreNextResetRef.current = false;
                                    }

                                    const startItem = data[e.startIndex];
                                    const endItem = data[e.endIndex];

                                    if (startItem && endItem) {
                                        setZoomDateRange({
                                            start: startItem.date,
                                            end: endItem.date
                                        });
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
                                opacity={selectedDate ? (d => d.date === selectedDate ? 1 : 0.3) : 1}
                                cursor="pointer"
                                onClick={(data) => {
                                    if (data && data.bucketKey) {
                                        onDateSelect(data.bucketKey);
                                    }
                                }}
                            />
                            <Bar
                                isAnimationActive={false} // Disable animation to reduce visual noise on refresh
                                dataKey="decisions"
                                name="Decisions"
                                fill="#2563eb"
                                stroke="none"
                                radius={[4, 4, 0, 0]}
                                opacity={selectedDate ? (d => d.date === selectedDate ? 1 : 0.3) : 1}
                                cursor="pointer"
                                onClick={(data) => {
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
