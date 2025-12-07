import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/Card";

/**
 * Simple SVG-based time series line chart component
 */
export function TimeSeriesChart({ title, data, color = "#3b82f6", icon: Icon }) {
    const [hoveredIndex, setHoveredIndex] = useState(null);

    if (!data || data.length === 0) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        {Icon && <Icon className="w-5 h-5 text-primary-600 dark:text-primary-400" />}
                        {title}
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
                        No data available
                    </p>
                </CardContent>
            </Card>
        );
    }

    const maxValue = Math.max(...data.map(d => d.count), 1);
    const chartHeight = 200;
    const chartWidth = 100; // percentage
    const padding = 50; // Largely increased padding to prevent clipping

    // Calculate points for the line
    const points = data.map((item, index) => {
        // Adjust width to have some side padding too
        const x = (index / (data.length - 1)) * (chartWidth - 10) + 5;
        const y = chartHeight - ((item.count / maxValue) * (chartHeight - padding * 2)) - padding;
        return { x, y, count: item.count, label: item.label };
    });

    // Create path for the line
    const linePath = points.map((point, index) =>
        `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`
    ).join(' ');

    // Create area path (filled area under the line)
    const areaPath = `M ${points[0].x} ${chartHeight} L ${points.map(p => `${p.x} ${p.y}`).join(' L ')} L ${points[points.length - 1].x} ${chartHeight} Z`;

    // Smart tooltip positioning - avoid edges
    const getTooltipPosition = (index) => {
        const percentage = (index / (data.length - 1)) * 100;
        let left = `${points[index].x}%`;
        let transform = 'translate(-50%, -50%)';

        // Adjust for edges
        if (points[index].x < 15) {
            transform = 'translate(-10%, -50%)';
        } else if (points[index].x > 85) {
            transform = 'translate(-90%, -50%)';
        }

        return { left, transform };
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    {Icon && <Icon className="w-5 h-5 text-primary-600 dark:text-primary-400" />}
                    {title}
                </CardTitle>
            </CardHeader>
            <CardContent>
                <div className="relative" style={{ height: `${chartHeight + 40}px` }}>
                    {/* Data Labels (HTML Overlay for crisp text) */}
                    <div className="absolute inset-0 pointer-events-none" style={{ height: `${chartHeight}px` }}>
                        {points.map((point, index) => (
                            <div
                                key={index}
                                className="absolute text-xs font-bold text-center transition-opacity"
                                style={{
                                    left: `${point.x}%`, // Use point.x directly as it's already a percentage
                                    top: `${(point.y / chartHeight) * 100}%`,     // Use percentage for vertical pos
                                    transform: 'translate(-50%, -150%)',           // Center and move up
                                    color: color
                                }}
                            >
                                {point.count}
                            </div>
                        ))}
                    </div>

                    {/* Chart area */}
                    <svg
                        className="w-full"
                        height={chartHeight}
                        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                        preserveAspectRatio="none"
                        style={{ overflow: 'visible' }} // Allow labels to overflow slightly
                    >
                        {/* Grid lines (Minimal/None as per reference, maybe just baseline) */}
                        <line
                            x1="0"
                            y1={chartHeight}
                            x2={chartWidth}
                            y2={chartHeight}
                            stroke="currentColor"
                            strokeWidth="1"
                            vectorEffect="non-scaling-stroke"
                            className="text-gray-200 dark:text-gray-700"
                        />

                        {/* Area under the line */}
                        <path
                            d={areaPath}
                            fill={color}
                            opacity="0.1"
                        />

                        {/* Line */}
                        <path
                            d={linePath}
                            fill="none"
                            stroke={color}
                            strokeWidth="2"
                            vectorEffect="non-scaling-stroke"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>

                    {/* Points Overlay (HTML for perfect circles) */}
                    <div className="absolute inset-0 pointer-events-none" style={{ height: `${chartHeight}px` }}>
                        {points.map((point, index) => {
                            const isHovered = hoveredIndex === index;
                            return (
                                <div
                                    key={index}
                                    className="absolute transition-all cursor-pointer pointer-events-auto flex items-center justify-center transform -translate-x-1/2 -translate-y-1/2"
                                    style={{
                                        left: `${point.x}%`,
                                        top: `${(point.y / chartHeight) * 100}%`,
                                        width: '20px', // Hit area
                                        height: '20px', // Hit area
                                    }}
                                    onMouseEnter={() => setHoveredIndex(index)}
                                    onMouseLeave={() => setHoveredIndex(null)}
                                >
                                    {/* Visible Dot */}
                                    <div
                                        className="rounded-full border border-white dark:border-gray-800 transition-all shadow-sm"
                                        style={{
                                            backgroundColor: color,
                                            width: isHovered ? '8px' : '6px',
                                            height: isHovered ? '8px' : '6px',
                                        }}
                                    />
                                </div>
                            );
                        })}
                    </div>

                    {/* X-axis labels */}
                    <div className="flex justify-between mt-2 px-1">
                        {data.map((item, index) => (
                            <div
                                key={index}
                                className="text-xs text-gray-500 dark:text-gray-400 text-center"
                                style={{ width: `${100 / data.length}%` }}
                            >
                                {item.label}
                            </div>
                        ))}
                    </div>

                    {/* Tooltip - improved positioning and styling */}
                    {hoveredIndex !== null && (
                        <div
                            className="absolute bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 px-3 py-2 rounded-lg shadow-xl text-sm font-medium pointer-events-none z-10 transition-all duration-150"
                            style={{
                                ...getTooltipPosition(hoveredIndex),
                                top: '45%',
                            }}
                        >
                            <div className="font-bold text-base">{points[hoveredIndex].count}</div>
                            <div className="text-xs opacity-80 mt-0.5">{points[hoveredIndex].label}</div>
                        </div>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}
