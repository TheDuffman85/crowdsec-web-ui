import { useMemo, useRef, useState, useEffect, useCallback, type PointerEvent as ReactPointerEvent } from 'react';
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { BarChart3, ShieldAlert, Gavel } from 'lucide-react';
import type { ActivityChartSeriesPoint, DateRangeSelection } from '../types';
import { DASHBOARD_COLORS } from '../lib/dashboardColors';
import {
    type BrushWindow,
    getBrushSelectionPayload,
    getDraggedBrushWindow,
    type SliderDragMode,
    type SliderDragState,
} from './DashboardCharts.helpers';

type Granularity = 'day' | 'hour';

interface ChartDatum {
    date: string;
    bucketKey: string;
    label: string;
    alerts: number;
    simulatedAlerts: number;
    decisions: number;
    simulatedDecisions: number;
}

interface CustomTooltipEntry {
    name?: string;
    value?: string | number;
    color?: string;
}

interface CustomTooltipProps {
    active?: boolean;
    payload?: CustomTooltipEntry[];
    label?: string;
}


interface ActivityBarChartProps {
    alertsData: ActivityChartSeriesPoint[];
    decisionsData: ActivityChartSeriesPoint[];
    simulatedAlertsData?: ActivityChartSeriesPoint[];
    simulatedDecisionsData?: ActivityChartSeriesPoint[];
    unfilteredAlertsData: ActivityChartSeriesPoint[];
    unfilteredDecisionsData: ActivityChartSeriesPoint[];
    unfilteredSimulatedAlertsData?: ActivityChartSeriesPoint[];
    unfilteredSimulatedDecisionsData?: ActivityChartSeriesPoint[];
    simulationsEnabled?: boolean;
    granularity: Granularity;
    setGranularity: (value: Granularity) => void;
    onDateRangeSelect?: (dateRange: DateRangeSelection | null, isAtEnd: boolean) => void;
    selectedDateRange: DateRangeSelection | null;
    isSticky: boolean;
}

/**
 * Custom Tooltip Component for better dark mode support
 */
const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
    if (active && payload && payload.length) {
        const tooltipOrder = ['Alerts', 'Decisions', 'Simulation Alerts', 'Simulation Decisions'];
        const sortedPayload = [...payload].sort((left, right) => {
            const leftIndex = tooltipOrder.indexOf(left.name || '');
            const rightIndex = tooltipOrder.indexOf(right.name || '');
            return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
        });

        return (
            <div className="bg-white dark:bg-gray-800 p-3 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">{label}</p>
                {sortedPayload.map((entry, index) => {
                    const isAlert = entry.name?.toLowerCase().includes('alert');
                    const Icon = isAlert ? ShieldAlert : Gavel;
                    return (
                        <div key={index} className="flex items-center gap-2 mb-1 last:mb-0">
                            <Icon className="w-4 h-4" style={{ color: entry.color }} />
                            <span className="text-sm" style={{ color: entry.color }}>
                                {entry.name || 'Value'}: {entry.value ?? 0}
                            </span>
                        </div>
                    );
                })}
            </div>
        );
    }
    return null;
};

/**
 * Combined Bar Chart for Alerts and Decisions
 */
export function ActivityBarChart({
    alertsData,
    decisionsData,
    simulatedAlertsData = [],
    simulatedDecisionsData = [],
    unfilteredAlertsData,
    unfilteredDecisionsData,
    unfilteredSimulatedAlertsData = [],
    unfilteredSimulatedDecisionsData = [],
    simulationsEnabled = false,
    granularity,
    setGranularity,
    onDateRangeSelect,
    selectedDateRange,
    isSticky,
}: ActivityBarChartProps) {
    // -------------------------------------------------------------------------
    // 1. Process Filtered Data (Main Chart)
    // -------------------------------------------------------------------------
    const filteredData = useMemo<ChartDatum[]>(() => {
        const merged: Record<string, ChartDatum> = {};

        // Process alerts
        alertsData.forEach(item => {
            merged[item.date] = {
                date: item.fullDate || item.date,
                bucketKey: item.date, // Store the bucket key for filtering
                alerts: item.count,
                simulatedAlerts: 0,
                decisions: 0,
                simulatedDecisions: 0,
                label: item.label
            };
        });

        // Process decisions
        decisionsData.forEach(item => {
            if (!merged[item.date]) merged[item.date] = {
                date: item.fullDate || item.date,
                bucketKey: item.date, // Store the bucket key for filtering
                alerts: 0,
                simulatedAlerts: 0,
                decisions: 0,
                simulatedDecisions: 0,
                label: item.label
            };
            merged[item.date].decisions = item.count;
        });

        simulatedAlertsData.forEach(item => {
            if (!merged[item.date]) {
                merged[item.date] = {
                    date: item.fullDate || item.date,
                    bucketKey: item.date,
                    alerts: 0,
                    simulatedAlerts: 0,
                    decisions: 0,
                    simulatedDecisions: 0,
                    label: item.label,
                };
            }
            merged[item.date].simulatedAlerts = item.count;
        });

        simulatedDecisionsData.forEach(item => {
            if (!merged[item.date]) {
                merged[item.date] = {
                    date: item.fullDate || item.date,
                    bucketKey: item.date,
                    alerts: 0,
                    simulatedAlerts: 0,
                    decisions: 0,
                    simulatedDecisions: 0,
                    label: item.label,
                };
            }
            merged[item.date].simulatedDecisions = item.count;
        });

        return Object.values(merged).sort((left, right) => left.date.localeCompare(right.date));
    }, [alertsData, decisionsData, simulatedAlertsData, simulatedDecisionsData]);


    // -------------------------------------------------------------------------
    // 2. Process Unfiltered Data (Slider)
    // -------------------------------------------------------------------------
    const sliderData = useMemo<ChartDatum[]>(() => {
        const merged: Record<string, ChartDatum> = {};
        if (unfilteredAlertsData) {
            unfilteredAlertsData.forEach(item => {
                merged[item.date] = {
                    date: item.fullDate || item.date,
                    bucketKey: item.date,
                    label: item.label,
                    alerts: item.count, // Include counts
                    simulatedAlerts: 0,
                    decisions: 0,
                    simulatedDecisions: 0,
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
                    simulatedAlerts: 0,
                    decisions: 0,
                    simulatedDecisions: 0,
                };
                merged[item.date].decisions = item.count; // Include counts
            });
        }
        if (unfilteredSimulatedAlertsData) {
            unfilteredSimulatedAlertsData.forEach(item => {
                if (!merged[item.date]) {
                    merged[item.date] = {
                        date: item.fullDate || item.date,
                        bucketKey: item.date,
                        label: item.label,
                        alerts: 0,
                        simulatedAlerts: 0,
                        decisions: 0,
                        simulatedDecisions: 0,
                    };
                }
                merged[item.date].simulatedAlerts = item.count;
            });
        }
        if (unfilteredSimulatedDecisionsData) {
            unfilteredSimulatedDecisionsData.forEach(item => {
                if (!merged[item.date]) {
                    merged[item.date] = {
                        date: item.fullDate || item.date,
                        bucketKey: item.date,
                        label: item.label,
                        alerts: 0,
                        simulatedAlerts: 0,
                        decisions: 0,
                        simulatedDecisions: 0,
                    };
                }
                merged[item.date].simulatedDecisions = item.count;
            });
        }
        return Object.values(merged).sort((left, right) => left.date.localeCompare(right.date));
    }, [unfilteredAlertsData, unfilteredDecisionsData, unfilteredSimulatedAlertsData, unfilteredSimulatedDecisionsData]);

    // Slider Brush Logic
    const [localBrushState, setLocalBrushState] = useState<BrushWindow>({ startIndex: 0, endIndex: 0 });
    const [isDraggingState, setIsDraggingState] = useState(false);
    const [isSliderHovered, setIsSliderHovered] = useState(false);
    const [sliderLabelOffsets, setSliderLabelOffsets] = useState({ start: 0, end: 0 });
    const localBrushStateRef = useRef<BrushWindow>({ startIndex: 0, endIndex: 0 });
    const sliderTrackRef = useRef<HTMLDivElement | null>(null);
    const sliderDragRef = useRef<SliderDragState | null>(null);
    const sliderStartLabelRef = useRef<HTMLSpanElement | null>(null);
    const sliderEndLabelRef = useRef<HTMLSpanElement | null>(null);

    // Keep ref in sync
    useEffect(() => {
        localBrushStateRef.current = localBrushState;
    }, [localBrushState]);

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

    // Use target indices when not dragging to prevent "collapse" during data updates
    const startIndex = isDraggingState ? localBrushState.startIndex : targetStartIndex;
    const endIndex = isDraggingState ? localBrushState.endIndex : targetEndIndex;

    const sliderBucketCount = sliderData.length;
    const sliderSelectionWidthPercent = sliderBucketCount > 0
        ? ((endIndex - startIndex + 1) / sliderBucketCount) * 100
        : 0;
    const sliderSelectionLeftPercent = sliderBucketCount > 0
        ? (startIndex / sliderBucketCount) * 100
        : 0;
    const sliderSelectionRightPercent = sliderSelectionLeftPercent + sliderSelectionWidthPercent;
    const sliderStartLabel = sliderData[startIndex]?.label ?? '';
    const sliderEndLabel = sliderData[endIndex]?.label ?? '';
    const showSliderLabels = (isSliderHovered || isDraggingState) && sliderBucketCount > 0;
    const sliderLabelMinGapPx = 4;

    useEffect(() => {
        if (!showSliderLabels) {
            return;
        }

        const trackElement = sliderTrackRef.current;
        const startLabelElement = sliderStartLabelRef.current;
        const endLabelElement = sliderEndLabelRef.current;
        if (!trackElement || !startLabelElement || !endLabelElement) {
            return;
        }

        const animationFrameId = window.requestAnimationFrame(() => {
            const trackWidth = trackElement.getBoundingClientRect().width;
            const startLabelWidth = startLabelElement.getBoundingClientRect().width;
            const endLabelWidth = endLabelElement.getBoundingClientRect().width;
            if (trackWidth <= 0 || startLabelWidth <= 0 || endLabelWidth <= 0) {
                setSliderLabelOffsets({ start: 0, end: 0 });
                return;
            }

            const startCenterPx = (sliderSelectionLeftPercent / 100) * trackWidth;
            const endCenterPx = (sliderSelectionRightPercent / 100) * trackWidth;
            const startLeft = startCenterPx - (startLabelWidth / 2);
            const endLeft = endCenterPx - (endLabelWidth / 2);
            const overlapAmount = (startLeft + startLabelWidth + sliderLabelMinGapPx) - endLeft;

            if (overlapAmount <= 0) {
                setSliderLabelOffsets({ start: 0, end: 0 });
                return;
            }

            setSliderLabelOffsets({
                start: -(overlapAmount / 2),
                end: overlapAmount / 2,
            });
        });

        return () => {
            window.cancelAnimationFrame(animationFrameId);
        };
    }, [
        showSliderLabels,
        sliderSelectionLeftPercent,
        sliderSelectionRightPercent,
        sliderStartLabel,
        sliderEndLabel,
    ]);

    const commitBrushSelection = useCallback((nextRange: BrushWindow) => {
        const payload = getBrushSelectionPayload(sliderData, nextRange);
        if (payload && onDateRangeSelect) {
            onDateRangeSelect(payload.dateRange, payload.isAtEnd);
        }
    }, [onDateRangeSelect, sliderData]);

    const updateSliderDrag = useCallback((clientX: number) => {
        const dragState = sliderDragRef.current;
        if (!dragState) {
            return;
        }

        const nextRange = getDraggedBrushWindow(dragState, clientX, localBrushStateRef.current);
        if (!nextRange) {
            return;
        }

        setLocalBrushState(nextRange);
    }, []);

    const startSliderDrag = (mode: SliderDragMode, event: ReactPointerEvent<HTMLDivElement>) => {
        if (sliderData.length === 0) {
            return;
        }

        const trackWidth = sliderTrackRef.current?.getBoundingClientRect().width ?? 0;
        if (trackWidth <= 0) {
            return;
        }

        sliderDragRef.current = {
            mode,
            pointerStartX: event.clientX,
            initialStartIndex: targetStartIndex,
            initialEndIndex: targetEndIndex,
            bucketWidth: trackWidth / sliderData.length,
            bucketCount: sliderData.length,
        };

        sliderTrackRef.current?.setPointerCapture(event.pointerId);
        setLocalBrushState({ startIndex: targetStartIndex, endIndex: targetEndIndex });
        setIsDraggingState(true);
        event.preventDefault();
        event.stopPropagation();
    };

    const handleSliderPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!isDraggingState) {
            return;
        }

        updateSliderDrag(event.clientX);
        event.preventDefault();
    };

    const handleSliderPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!isDraggingState) {
            return;
        }

        sliderTrackRef.current?.releasePointerCapture(event.pointerId);
        sliderDragRef.current = null;
        commitBrushSelection(localBrushStateRef.current);
        window.setTimeout(() => {
            setIsDraggingState(false);
        }, 0);
        event.preventDefault();
    };

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
    const containerRef = useRef<HTMLDivElement | null>(null);
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
        const numBarGroups = filteredData.length;
        const barGroupWidth = availableWidth / numBarGroups;
        const calculatedBarSize = barGroupWidth * 0.35;

        // Clamp between 4 and 40
        return Math.max(4, Math.min(40, calculatedBarSize));
    }, [containerWidth, filteredData.length]);

    const granularities: Granularity[] = ['day', 'hour'];

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
                                    setGranularity(g);
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
                <div ref={containerRef} className="flex-1 min-h-0 outline-none relative">
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
                                fill={DASHBOARD_COLORS.liveAlerts}
                                stroke="none"
                                radius={[4, 4, 0, 0]}
                                barSize={dynamicBarSize}
                                stackId="alerts"
                            />
                            {simulationsEnabled && (
                                <Bar
                                    isAnimationActive={false}
                                    dataKey="simulatedAlerts"
                                    name="Simulation Alerts"
                                    fill={DASHBOARD_COLORS.simulatedAlerts}
                                    stroke="none"
                                    radius={[4, 4, 0, 0]}
                                    barSize={dynamicBarSize}
                                    stackId="alerts"
                                />
                            )}
                            <Bar
                                isAnimationActive={false}
                                dataKey="decisions"
                                name="Decisions"
                                fill={DASHBOARD_COLORS.liveDecisions}
                                stroke="none"
                                radius={[4, 4, 0, 0]}
                                barSize={dynamicBarSize}
                                stackId="decisions"
                            />
                            {simulationsEnabled && (
                                <Bar
                                    isAnimationActive={false}
                                    dataKey="simulatedDecisions"
                                    name="Simulation Decisions"
                                    fill={DASHBOARD_COLORS.simulatedDecisions}
                                    stroke="none"
                                    radius={[4, 4, 0, 0]}
                                    barSize={dynamicBarSize}
                                    stackId="decisions"
                                />
                            )}
                        </BarChart>
                    </ResponsiveContainer>
                </div>

                {/* Slider Section */}
                <div className="mt-4 h-[60px] outline-none relative px-[60px] pr-[30px]">
                    <div
                        ref={sliderTrackRef}
                        data-testid="activity-slider-track"
                        data-label-layout={showSliderLabels ? 'below' : 'hidden'}
                        data-label-offset-active={showSliderLabels && (sliderLabelOffsets.start !== 0 || sliderLabelOffsets.end !== 0) ? 'true' : 'false'}
                        className="relative h-10 rounded-md border border-slate-300/80 bg-slate-100/70 shadow-inner dark:border-gray-600/40 dark:bg-gray-700/25 select-none touch-none overflow-visible"
                        onPointerEnter={() => setIsSliderHovered(true)}
                        onPointerLeave={() => {
                            if (!isDraggingState) {
                                setIsSliderHovered(false);
                            }
                        }}
                        onPointerMove={handleSliderPointerMove}
                        onPointerUp={handleSliderPointerEnd}
                        onPointerCancel={handleSliderPointerEnd}
                    >
                        {showSliderLabels && (
                            <>
                                <span
                                    ref={sliderStartLabelRef}
                                    data-testid="activity-range-start-label"
                                    className="absolute left-0 top-full mt-2 text-xs text-slate-600 pointer-events-none whitespace-nowrap dark:text-gray-200/90"
                                    style={{
                                        left: `${sliderSelectionLeftPercent}%`,
                                        transform: `translateX(calc(-50% + ${sliderLabelOffsets.start}px))`,
                                    }}
                                >
                                    {sliderStartLabel}
                                </span>
                                <span
                                    ref={sliderEndLabelRef}
                                    data-testid="activity-range-end-label"
                                    className="absolute left-0 top-full mt-2 text-xs text-slate-600 pointer-events-none whitespace-nowrap dark:text-gray-200/90"
                                    style={{
                                        left: `${sliderSelectionRightPercent}%`,
                                        transform: `translateX(calc(-50% + ${sliderLabelOffsets.end}px))`,
                                    }}
                                >
                                    {sliderEndLabel}
                                </span>
                            </>
                        )}
                        <div
                            data-testid="activity-range-selection"
                            data-start-index={startIndex}
                            data-end-index={endIndex}
                            className={`absolute top-0 bottom-0 border border-slate-500/90 bg-slate-500/20 dark:border-gray-300/80 dark:bg-gray-300/25 ${isDraggingState ? 'cursor-grabbing' : 'cursor-grab'}`}
                            style={{
                                left: `${sliderSelectionLeftPercent}%`,
                                width: `${sliderSelectionWidthPercent}%`,
                            }}
                            onPointerDown={(event) => startSliderDrag('move', event)}
                        >
                            <div
                                data-testid="activity-range-start-handle"
                                className="absolute left-0 top-0 bottom-0 w-[6px] bg-slate-500 cursor-ew-resize dark:bg-gray-200/90"
                                onPointerDown={(event) => startSliderDrag('start', event)}
                            >
                                <span className="absolute left-1/2 top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-slate-100/90 dark:bg-gray-600/80 pointer-events-none" />
                            </div>
                            <div
                                data-testid="activity-range-end-handle"
                                className="absolute right-0 top-0 bottom-0 w-[6px] bg-slate-500 cursor-ew-resize dark:bg-gray-200/90"
                                onPointerDown={(event) => startSliderDrag('end', event)}
                            >
                                <span className="absolute left-1/2 top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-slate-100/90 dark:bg-gray-600/80 pointer-events-none" />
                            </div>
                        </div>
                    </div>
                </div>
            </CardContent>
        </Card >
    );
}
