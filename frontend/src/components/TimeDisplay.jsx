/**
 * TimeDisplay component - shows date small above, time larger below
 * Similar layout pattern to ScenarioName component
 */
export function TimeDisplay({ timestamp, className = "" }) {
    if (!timestamp) return null;

    const date = new Date(timestamp);

    // Format date as "Dec 16, 2025"
    const dateStr = date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    });

    // Format time as "15:30:45"
    const timeStr = date.toLocaleTimeString(undefined, {
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
