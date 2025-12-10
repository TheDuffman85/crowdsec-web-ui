import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/Card";
import { ExternalLink } from "lucide-react";
import { useMemo } from "react";

/**
 * StatCard component for displaying top statistics
 */
export function StatCard({
    title,
    icon: Icon,
    items,
    emptyMessage = "No data available",
    onSelect, // Changed from getLink to generic onSelect
    selectedValue, // The currently selected value for highlighting
    getExternalLink
}) {
    // Calculate total for percentages
    const totalCount = useMemo(() => {
        return items.reduce((sum, item) => sum + item.count, 0);
    }, [items]);

    return (
        <Card className="h-full">
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                    {Icon && <Icon className="w-5 h-5 text-primary-600 dark:text-primary-400" />}
                    {title}
                </CardTitle>
            </CardHeader>
            <CardContent>
                {items.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
                        {emptyMessage}
                    </p>
                ) : (
                    <div className="space-y-2">
                        {items.map((item, idx) => {
                            const isSelected = selectedValue === item.value || selectedValue === item.label; // Handle both potential value types
                            const percent = totalCount > 0 ? (item.count / totalCount * 100).toFixed(1) : '0.0';

                            const handleRowClick = () => {
                                if (onSelect) {
                                    onSelect(item);
                                }
                            };

                            const hubUrl = getExternalLink ? getExternalLink(item) : null;

                            return (
                                <div
                                    key={idx}
                                    onClick={handleRowClick}
                                    className={`flex items-center justify-between p-2 rounded-lg transition-colors cursor-pointer border ${isSelected
                                        ? 'bg-primary-50 dark:bg-primary-900/40 border-primary-200 dark:border-primary-800'
                                        : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-700/50'
                                        }`}
                                >
                                    <div className="flex items-center gap-2 min-w-0 flex-1">
                                        <span className={`flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-xs font-semibold ${isSelected
                                            ? 'bg-primary-600 text-white'
                                            : 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                                            }`}>
                                            {idx + 1}
                                        </span>
                                        {item.countryCode && (
                                            <span className={`fi fi-${item.countryCode.toLowerCase()} flex-shrink-0 rounded-sm`} />
                                        )}
                                        <span className={`text-sm truncate font-medium ${isSelected ? 'text-primary-900 dark:text-white' : 'text-gray-900 dark:text-gray-100'}`} title={item.label}>
                                            {item.label}
                                        </span>
                                        {hubUrl && (
                                            <a
                                                href={hubUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                onClick={(e) => e.stopPropagation()}
                                                className="ml-1 p-1 text-gray-400 hover:text-primary-600 dark:hover:text-primary-400 transition-colors"
                                                title="View on CrowdSec Hub"
                                            >
                                                <ExternalLink size={12} />
                                            </a>
                                        )}
                                    </div>
                                    <div className="flex flex-col items-end ml-2 flex-shrink-0">
                                        <span className={`text-sm font-bold ${isSelected
                                            ? 'text-primary-800 dark:text-primary-100'
                                            : 'text-gray-900 dark:text-white'
                                            }`}>
                                            {item.count.toLocaleString()}
                                        </span>
                                        <span className="text-xs text-gray-500 dark:text-gray-400">
                                            {percent}%
                                        </span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
