import { useMemo, useRef, useState, useEffect } from 'react';
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
export function ActivityBarChart({ alertsData, decisionsData, unfilteredAlertsData, unfilteredDecisionsData, granularity, setGranularity, onDateRangeSelect, selectedDateRange, isSticky }) {
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
                    label: item.label,
                    alerts: item.count, // Include counts
                    decisions: 0
                };
            });
        }
        if (unfilteredDecisionsData) {
            unfilteredDecisionsData.forEach(item => {
                if (!merged[item.date]) merged[item.date] = {
                    date: item.fullDate || item.date,
                    bucketKey: item.date,
                    label: item.label,
                    alerts: 0,
                    decisions: 0
                };
                merged[item.date].decisions = item.count; // Include counts
            });
        }
        return Object.values(merged).sort((a, b) => a.date.localeCompare(b.date));
    }, [unfilteredAlertsData, unfilteredDecisionsData]);

    // Slider Brush Logic
    const [localBrushState, setLocalBrushState] = useState({ startIndex: 0, endIndex: 0 });
    const localBrushStateRef = useRef({ startIndex: 0, endIndex: 0 });
    const isDragging = useRef(false);
    const dragStartWindowSize = useRef(0); // Track window size at drag start
    const dragSource = useRef(null); // 'slide' or 'handle'

    // Keep ref in sync
    useEffect(() => {
        localBrushStateRef.current = localBrushState;
    }, [localBrushState]);

    const brushKey = useMemo(() => {
        return `brush-${Date.now()}`;
    }, [sliderData]);

    // Calculate the 'target' indices based on props
    const { startIndex: targetStartIndex, endIndex: targetEndIndex } = useMemo(() => {
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


    // Sync local state with target when NOT dragging
    // Use target indices when not dragging to prevent "collapse" during data updates
    const startIndex = isDragging.current ? localBrushState.startIndex : targetStartIndex;
    const endIndex = isDragging.current ? localBrushState.endIndex : targetEndIndex;

    // Sticky Brush Logic: Auto-follow time
    useEffect(() => {
        if (!sliderData || sliderData.length === 0) return;
        if (!isSticky || !selectedDateRange) return;

        const currentLastBucketKey = sliderData[sliderData.length - 1].bucketKey;

        // Check if the current selection already ends at the rightmost bucket
        if (selectedDateRange.end === currentLastBucketKey) return;

        // The brush is sticky and new data has arrived - expand to include new buckets
        // Find the original window size based on current selection
        const startBucketIndex = sliderData.findIndex(d => d.bucketKey === selectedDateRange.start);
        const endBucketIndex = sliderData.findIndex(d => d.bucketKey === selectedDateRange.end);

        if (startBucketIndex !== -1 && endBucketIndex !== -1) {
            // Calculate window size (distance between start and old end)
            const windowSize = endBucketIndex - startBucketIndex;

            // New end is the last item
            const newEndIndex = sliderData.length - 1;
            // New start preserves the window size
            const newStartIndex = Math.max(0, newEndIndex - windowSize);

            const newStartKey = sliderData[newStartIndex].bucketKey;

            if (onDateRangeSelect) {
                // Keep sticky = true since we're still at the end
                onDateRangeSelect({
                    start: newStartKey,
                    end: currentLastBucketKey
                }, true);
            }
        }
    }, [sliderData, selectedDateRange, isSticky, onDateRangeSelect]);


    // -------------------------------------------------------------------------
    // 4. Dynamic Bar Size Calculation
    // -------------------------------------------------------------------------
    const containerRef = useRef(null);
    const [containerWidth, setContainerWidth] = useState(0);

    useEffect(() => {
        if (!containerRef.current) return;

        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                setContainerWidth(entry.contentRect.width);
            }
        });

        resizeObserver.observe(containerRef.current);
        return () => resizeObserver.disconnect();
    }, []);

    // Calculate bar size: minimum 4px, maximum 40px, based on available space
    const dynamicBarSize = useMemo(() => {
        if (!containerWidth || !filteredData.length) return undefined;

        // Available width for bars (subtract margins: 20 left + 30 right + 40 yAxis)
        const availableWidth = containerWidth - 90;
        // Each data point has 2 bars (alerts + decisions) + gap between them
        const numBarGroups = filteredData.length;
        // Calculate width per bar group, accounting for category gap (typically ~30% of bar group)
        const barGroupWidth = availableWidth / numBarGroups;
        // Each bar is about 35% of the bar group width (leaving room for gaps)
        const calculatedBarSize = barGroupWidth * 0.35;

        // Clamp between 4 and 40
        return Math.max(4, Math.min(40, calculatedBarSize));
    }, [containerWidth, filteredData.length]);

    const granularities = ['day', 'hour'];

    return (
        <Card className="h-full outline-none flex flex-col">
            <CardHeader className="flex-none">
                <div className="flex items-center justify-between w-full">
                    <CardTitle className="flex items-center gap-2">
                        <BarChart3 className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                        Activity History
                        {selectedDateRange && sliderData.length > 0 && (
                            <span className="ml-2 text-sm font-normal text-gray-500 dark:text-gray-400">
                                {endIndex === sliderData.length - 1 ? 'Last' : 'Selected'} {endIndex - startIndex + 1} {granularity === 'day' ? 'Days' : 'Hours'}
                            </span>
                        )}
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
            <CardContent className="flex-1 min-h-0 flex flex-col gap-0">
                {/* Main Chart Section */}
                <div ref={containerRef} className="flex-1 min-h-0 outline-none">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                            data={filteredData}
                            margin={{ top: 20, right: 30, left: 20, bottom: 0 }}
                            barGap={2}
                        >
                            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                            <XAxis dataKey="label" stroke="#888888" fontSize={12} tickLine={false} axisLine={false} />
                            <YAxis stroke="#888888" fontSize={12} tickLine={false} axisLine={false} width={40} />
                            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'transparent' }} />
                            <Legend verticalAlign="top" height={36} />
                            <Bar
                                isAnimationActive={false}
                                dataKey="alerts"
                                name="Alerts"
                                fill="#dc2626"
                                stroke="none"
                                radius={[4, 4, 0, 0]}
                                barSize={dynamicBarSize}
                            />
                            <Bar
                                isAnimationActive={false}
                                dataKey="decisions"
                                name="Decisions"
                                fill="#2563eb"
                                stroke="none"
                                radius={[4, 4, 0, 0]}
                                barSize={dynamicBarSize}
                            />
                        </BarChart>
                    </ResponsiveContainer>
                </div>

                {/* Slider Section */}
                <div
                    className="h-[60px] outline-none"
                    onMouseDownCapture={(e) => {
                        const target = e.target;
                        // Check if hitting the slide or handles
                        // We check classList or closest element with the class
                        // Note: Recharts renders SVG, so standard DOM traversal works
                        if (target.closest('.recharts-brush-slide')) {
                            dragSource.current = 'slide';
                        } else if (target.closest('.recharts-brush-traveller')) {
                            dragSource.current = 'handle';
                        } else {
                            // If clicking background/track, might be a jump. 
                            // Usually dragSource should be null.
                            dragSource.current = null;
                        }
                    }}
                    onTouchStartCapture={(e) => {
                        const target = e.target;
                        if (target.closest('.recharts-brush-slide')) {
                            dragSource.current = 'slide';
                        } else if (target.closest('.recharts-brush-traveller')) {
                            dragSource.current = 'handle';
                        } else {
                            dragSource.current = null;
                        }
                    }}
                >
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                            data={sliderData}
                            margin={{ top: 0, right: 30, left: 60, bottom: 0 }}
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

                                    let newStart = e.startIndex;
                                    let newEnd = e.endIndex;

                                    // Start tracking drag if not already
                                    if (!isDragging.current) {
                                        isDragging.current = true;
                                        // Capture initial window size at drag start
                                        dragStartWindowSize.current = localBrushStateRef.current.endIndex - localBrushStateRef.current.startIndex;

                                        const handleDragEnd = () => {
                                            window.removeEventListener('mouseup', handleDragEnd);
                                            window.removeEventListener('touchend', handleDragEnd);

                                            // Reset drag source
                                            dragSource.current = null;

                                            // Commit the value
                                            // We need to use the ref to get the LATEST state inside the callback
                                            const currentStart = localBrushStateRef.current?.startIndex ?? e.startIndex;
                                            const currentEnd = localBrushStateRef.current?.endIndex ?? e.endIndex;

                                            const isStartReset = currentStart === 0;
                                            const isEndReset = currentEnd >= sliderData.length - 1;
                                            const isFullRange = isStartReset && isEndReset;

                                            const startItem = sliderData[currentStart];
                                            const endItem = sliderData[currentEnd];

                                            if (startItem && endItem && onDateRangeSelect) {
                                                const dateRange = isFullRange ? null : {
                                                    start: startItem.bucketKey,
                                                    end: endItem.bucketKey
                                                };
                                                // Pass isAtEnd to indicate if brush is at the rightmost position
                                                onDateRangeSelect(dateRange, isEndReset);
                                            }
                                            // Defer the isDragging reset to allow state update to propagate first
                                            requestAnimationFrame(() => {
                                                isDragging.current = false;
                                            });
                                        };
                                        window.addEventListener('mouseup', handleDragEnd);
                                        window.addEventListener('touchend', handleDragEnd);
                                    } else {
                                        // During drag: Check if we are dragging the SLIDE
                                        if (dragSource.current === 'slide') {
                                            const currentWindowSize = newEnd - newStart;
                                            const expectedWindowSize = dragStartWindowSize.current;

                                            // If dragging slide, window size MUST match expected size
                                            // We fix both shrinking AND expansion here
                                            if (expectedWindowSize > 0 && currentWindowSize !== expectedWindowSize) {

                                                // Priority: Adjust the side that is NOT at the edge first, 
                                                // or if at edge, ensure the other side respects size.

                                                if (newStart <= 0) {
                                                    // Hit left edge: Force end to match size
                                                    newEnd = Math.min(sliderData.length - 1, newStart + expectedWindowSize);
                                                } else if (newEnd >= sliderData.length - 1) {
                                                    // Hit right edge: Force start to match size
                                                    newStart = Math.max(0, newEnd - expectedWindowSize);
                                                } else {
                                                    // Middle but size changed? 
                                                    // This can happen due to snapping. 
                                                    // We default to preserving the START index if dragging right? 
                                                    // Hard to know direction here easily without prev state.
                                                    // But generally, sticking to size is safer.
                                                    // If we expanded, we likely want to shrink back.
                                                    // If we assume standard drag, let's defer to Recharts in middle unless critical?
                                                    // Actually, user compliant was specifically about EDGE behavior.
                                                    // So let's stick to edge enforcement for now.
                                                }

                                                // Double Check: If we STILL have a mismatch (e.g. at right edge, calculated start < 0?)
                                                // Ideally strictly enforce at edges.
                                                // The above logic handles edges. 
                                                // If we are floating in middle with wrong size, it's weird but less annoying than edge expansion.
                                            }
                                        }
                                    }

                                    // Update local UI immediately
                                    setLocalBrushState({ startIndex: newStart, endIndex: newEnd });
                                }}
                                tickFormatter={(date) => {
                                    if (!date) return '';
                                    const d = new Date(date);
                                    if (granularity === 'hour') {
                                        return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.getHours().toString().padStart(2, '0') + ':00';
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

