import { useState } from 'react';
import { getMetaValueItems, type DisplayMetadataEntry } from '../lib/alertMetadata';
import { useI18n } from '../lib/i18n';

interface ContextSummaryProps {
    entries: DisplayMetadataEntry[];
}

export function ContextSummary({ entries }: ContextSummaryProps) {
    const { t } = useI18n();
    const [expandedEntries, setExpandedEntries] = useState<Set<number>>(() => new Set());

    const toggleExpanded = (index: number) => {
        setExpandedEntries((current) => {
            const next = new Set(current);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    };

    return (
        <dl className="overflow-hidden rounded border border-gray-100 bg-gray-50 divide-y divide-gray-100 dark:border-gray-800 dark:bg-gray-900/30 dark:divide-gray-800">
            {entries.map((entry, index) => {
                const valueItems = getMetaValueItems(entry.value);
                const isExpanded = expandedEntries.has(index);
                const visibleItems = valueItems && !isExpanded ? valueItems.slice(0, 5) : valueItems;
                const hiddenCount = valueItems ? Math.max(0, valueItems.length - 5) : 0;
                return (
                    <div
                        key={`${entry.key}-${index}`}
                        className="grid grid-cols-1 sm:grid-cols-[minmax(9rem,12rem)_1fr]"
                    >
                        <dt className="px-3 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 break-all">
                            {entry.key}
                        </dt>
                        <dd className="min-w-0 border-t border-gray-200 dark:border-gray-800 sm:border-t-0 sm:border-l">
                            {visibleItems ? (
                                <div className="h-full overflow-hidden bg-white divide-y divide-gray-100 dark:bg-gray-950 dark:divide-gray-800">
                                    {visibleItems.map((item, itemIndex) => (
                                        <div
                                            key={`${item}-${itemIndex}`}
                                            className="px-3 py-1.5 font-mono text-xs leading-4 text-gray-700 break-all dark:text-gray-300"
                                        >
                                            {item}
                                        </div>
                                    ))}
                                    {hiddenCount > 0 && (
                                        <button
                                            type="button"
                                            onClick={() => toggleExpanded(index)}
                                            className="w-full px-3 py-2 text-left text-xs font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-900 dark:hover:text-gray-200 cursor-pointer"
                                        >
                                            {isExpanded
                                                ? t('pages.alerts.showFewerContextValues', { count: 5 })
                                                : t('pages.alerts.showAllContextValues', { total: hiddenCount + 5, remaining: hiddenCount })}
                                        </button>
                                    )}
                                </div>
                            ) : (
                                <span className="font-mono text-xs leading-5 text-gray-700 break-all dark:text-gray-200">
                                    {entry.formattedValue}
                                </span>
                            )}
                        </dd>
                    </div>
                );
            })}
        </dl>
    );
}
