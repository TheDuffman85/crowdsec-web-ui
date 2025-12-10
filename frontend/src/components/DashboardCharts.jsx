import { useMemo } from 'react';
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
import { BarChart3 } from 'lucide-react';

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
        <Card className="h-full outline-none">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <BarChart3 className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                    Activity History
                </CardTitle>
            </CardHeader>
            <CardContent>
                <div className="h-[200px] w-full outline-none">
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                            data={data}
                            margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                        >
                            <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                            <XAxis dataKey="label" stroke="#888888" fontSize={12} tickLine={false} axisLine={false} />
                            <YAxis stroke="#888888" fontSize={12} tickLine={false} axisLine={false} />
                            <Tooltip
                                cursor={{ fill: 'transparent' }}
                                contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                            />
                            <Legend verticalAlign="top" height={36} />
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
                                    if (data && data.date) {
                                        onDateSelect(data.date);
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
                                    if (data && data.date) {
                                        onDateSelect(data.date);
                                    }
                                }}
                            />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            </CardContent>
        </Card>
    );
}
