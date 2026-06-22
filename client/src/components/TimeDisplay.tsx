import { useDateTime } from '../lib/dateTime';

/**
 * TimeDisplay component - shows date small above, time larger below
 * Similar layout pattern to ScenarioName component
 */
interface TimeDisplayProps {
    timestamp?: string | null;
    className?: string;
}

export function TimeDisplay({ timestamp, className = "" }: TimeDisplayProps) {
    const { formatDate, formatTime } = useDateTime();
    if (!timestamp) return null;

    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) {
        return <span className={className}>{timestamp}</span>;
    }

    // Format date as "Dec 16, 2025"
    const dateStr = formatDate(date, {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    });

    // Format time as "15:30:45"
    const timeStr = formatTime(date, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    return (
        <div className={`flex flex-col items-start ${className}`}>
            <span className="text-xs text-gray-500 font-normal">{dateStr}</span>
            <span className="font-medium text-gray-900 dark:text-gray-200">{timeStr}</span>
        </div>
    );
}
