import type { AlertEvent } from '../types';
import { getDisplayMetadata, type DisplayMetadataEntry } from '../lib/alertMetadata';
import { useDateTime } from '../lib/dateTime';
import { useI18n } from '../lib/i18n';
import { ContextSummary } from './ContextSummary';
import { Collapsible } from './ui/Collapsible';

interface EventCardProps {
    event: AlertEvent;
    index: number;
}

export function EventCard({ event, index }: EventCardProps) {
    const { t } = useI18n();
    const { formatDateTime } = useDateTime();
    const timestamp = event.timestamp ? formatDateTime(event.timestamp) : '-';
    const metadata: DisplayMetadataEntry[] = [
        {
            key: t('components.eventCard.timestamp'),
            value: timestamp,
            formattedValue: timestamp,
        },
        ...getDisplayMetadata(event.meta),
    ];

    return (
        <Collapsible
            trigger={
                <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">
                    #{index + 1}
                </span>
            }
            defaultOpen={false}
            className="rounded border border-gray-100 bg-gray-50 text-sm dark:border-gray-800 dark:bg-gray-900/30"
            triggerClassName="p-3"
        >
            <div className="px-3 pb-3">
                <ContextSummary entries={metadata} />
            </div>
        </Collapsible>
    );
}
