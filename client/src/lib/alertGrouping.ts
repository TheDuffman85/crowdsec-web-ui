const ALERT_GROUPING_STORAGE_KEY = 'crowdsec-web-ui:alerts-grouped-by-ip';

export function loadStoredAlertGrouping(): boolean {
    if (typeof window === 'undefined') {
        return false;
    }

    try {
        return window.localStorage.getItem(ALERT_GROUPING_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function saveStoredAlertGrouping(grouped: boolean): void {
    if (typeof window === 'undefined') {
        return;
    }

    try {
        window.localStorage.setItem(ALERT_GROUPING_STORAGE_KEY, String(grouped));
    } catch {
        // The grouped view is a browser-local convenience; ignore storage failures.
    }
}

export function formatAlertSessionDuration(firstSeen: string, lastSeen: string): string {
    const minutes = Math.floor((Date.parse(lastSeen) - Date.parse(firstSeen)) / 60_000);
    if (!(minutes >= 1)) return '<1m';
    if (minutes < 60) return `${minutes}m`;
    return minutes % 60 === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
