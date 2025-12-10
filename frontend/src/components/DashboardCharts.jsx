import { useMemo } from 'react';
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer,
    PieChart,
    Pie,
    Cell
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { BarChart3, PieChart as PieChartIcon } from 'lucide-react';

// Pastel Colors
const COLORS = ['#FF9AA2', '#FFB7B2', '#FFDAC1', '#E2F0CB', '#B5EAD7', '#C7CEEA', '#F0E68C', '#DDA0DD'];

/**
 * Combined Bar Chart for Alerts and Decisions
 */
export function ActivityBarChart({ alertsData, decisionsData, onDateSelect, selectedDate }) {
    // Merge data by date
    const data = useMemo(() => {
        const merged = {};

        // Process alerts
        alertsData.forEach(item => {
            if (!merged[item.date]) merged[item.date] = { date: item.date, alerts: 0, decisions: 0, label: item.label };
            merged[item.date].alerts = item.count;
        });

        // Process decisions
        decisionsData.forEach(item => {
            if (!merged[item.date]) merged[item.date] = { date: item.date, alerts: 0, decisions: 0, label: item.label };
            merged[item.date].decisions = item.count;
        });

        return Object.values(merged).sort((a, b) => new Date(a.date) - new Date(b.date));
    }, [alertsData, decisionsData]);

    return (
        <Card className="h-full">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <BarChart3 className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                    Activity History
                </CardTitle>
            </CardHeader>
            <CardContent>
                <div className="h-[300px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                            data={data}
                            margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                            onClick={(data) => {
                                if (data && data.activePayload && data.activePayload[0]) {
                                    onDateSelect(data.activePayload[0].payload.date);
                                }
                            }}
                        >
                            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                            <XAxis dataKey="label" stroke="#888888" fontSize={12} tickLine={false} axisLine={false} />
                            <YAxis stroke="#888888" fontSize={12} tickLine={false} axisLine={false} />
                            <Tooltip
                                cursor={{ fill: 'rgba(0,0,0,0.1)' }}
                                contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                            />
                            <Legend verticalAlign="top" height={36} />
                            <Bar
                                dataKey="alerts"
                                name="Alerts"
                                fill="#FF9AA2" // Pastel Red
                                radius={[4, 4, 0, 0]}
                                opacity={selectedDate ? (d => d.date === selectedDate ? 1 : 0.3) : 1}
                                cursor="pointer"
                            />
                            <Bar
                                dataKey="decisions"
                                name="Decisions"
                                fill="#C7CEEA" // Pastel Blue
                                radius={[4, 4, 0, 0]}
                                opacity={selectedDate ? (d => d.date === selectedDate ? 1 : 0.3) : 1}
                                cursor="pointer"
                            />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </CardContent>
        </Card>
    );
}

/**
 * Country Distribution Pie Chart
 */
export function CountryPieChart({ data, onCountrySelect, selectedCountry }) {
    const chartData = useMemo(() => {
        return data.map((item, index) => ({
            name: item.label,
            value: item.count,
            code: item.countryCode,
            color: COLORS[index % COLORS.length]
        }));
    }, [data]);

    const RADIAN = Math.PI / 180;
    const renderCustomizedLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent }) => {
        const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
        const x = cx + radius * Math.cos(-midAngle * RADIAN);
        const y = cy + radius * Math.sin(-midAngle * RADIAN);

        return (
            <text x={x} y={y} fill="#4b5563" textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central" className="text-xs font-bold pointer-events-none">
                {`${(percent * 100).toFixed(0)}%`}
            </text>
        );
    };

    /**
     * Custom Legend renderer to include country flags
     */
    const renderLegend = (props) => {
        const { payload } = props;
        return (
            <ul className="flex flex-wrap justify-center gap-4 text-xs mt-2">
                {payload.map((entry, index) => {
                    const item = chartData.find(d => d.name === entry.value);
                    return (
                        <li key={`item-${index}`} className="flex items-center gap-1.5 text-gray-700 dark:text-gray-300">
                            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: entry.color }} />
                            {item && item.code && (
                                <span className={`fi fi-${item.code.toLowerCase()} w-5 h-4 inline-block rounded-sm shadow-sm`} />
                            )}
                            <span>{entry.value}</span>
                        </li>
                    );
                })}
            </ul>
        );
    };

    return (
        <Card className="h-full">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <PieChartIcon className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                    Country Distribution
                </CardTitle>
            </CardHeader>
            <CardContent>
                {chartData.length === 0 ? (
                    <div className="h-[300px] flex items-center justify-center text-gray-500">No country data available</div>
                ) : (
                    <div className="h-[300px] w-full">
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                                <Pie
                                    data={chartData}
                                    cx="50%"
                                    cy="50%"
                                    labelLine={false}
                                    label={renderCustomizedLabel}
                                    outerRadius={90}
                                    fill="#8884d8"
                                    dataKey="value"
                                    onClick={(data) => onCountrySelect(data.code)}
                                    cursor="pointer"
                                    layout="centric"
                                >
                                    {chartData.map((entry, index) => (
                                        <Cell
                                            key={`cell-${index}`}
                                            fill={entry.color}
                                            opacity={selectedCountry && selectedCountry !== entry.code ? 0.3 : 1}
                                            stroke="none"
                                            strokeWidth={selectedCountry === entry.code ? 2 : 0}
                                        />
                                    ))}
                                </Pie>
                                <Tooltip
                                    formatter={(value, name) => [value, name]}
                                    contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                                />
                                <Legend content={renderLegend} />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
