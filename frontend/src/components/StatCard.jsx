import { Link, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/Card";
import { ExternalLink } from "lucide-react";

/**
 * StatCard component for displaying top statistics
 */
export function StatCard({ title, icon: Icon, items, emptyMessage = "No data available", getLink, getExternalLink }) {
    const navigate = useNavigate();

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
                            const handleRowClick = () => {
                                if (getLink) {
                                    navigate(getLink(item));
                                }
                            };

                            const hubUrl = getExternalLink ? getExternalLink(item) : null;

                            return (
                                <div
                                    key={idx}
                                    onClick={handleRowClick}
                                    className={`flex items-center justify-between p-2 rounded-lg transition-colors ${getLink ? 'hover:bg-primary-50 dark:hover:bg-primary-900/10 cursor-pointer' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'}`}
                                >
                                    <div className="flex items-center gap-2 min-w-0 flex-1">
                                        <span className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-primary-100 dark:bg-primary-900/30 text-xs font-semibold text-primary-700 dark:text-primary-300">
                                            {idx + 1}
                                        </span>
                                        {item.countryCode && (
                                            <span className={`fi fi-${item.countryCode.toLowerCase()} flex-shrink-0 rounded-sm`} />
                                        )}
                                        <span className="text-sm text-gray-900 dark:text-gray-100 truncate font-medium" title={item.label}>
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
                                    <span className="flex-shrink-0 ml-2 px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-sm font-bold text-gray-700 dark:text-gray-300">
                                        {item.count}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
