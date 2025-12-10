/**
 * Statistics utility functions for dashboard analytics
 */

/**
 * Filter items to only include those from the last N days
 */
export function filterLastNDays(items, days = 7) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    return items.filter(item => {
        const itemDate = new Date(item.created_at);
        return itemDate >= cutoffDate;
    });
}

/**
 * Get top IPs by alert count
 */
export function getTopIPs(alerts, limit = 10) {
    const ipCounts = {};

    alerts.forEach(alert => {
        const ip = alert.source?.ip || alert.source?.value;
        if (ip) {
            ipCounts[ip] = (ipCounts[ip] || 0) + 1;
        }
    });

    return Object.entries(ipCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([ip, count]) => ({ label: ip, count }));
}

/**
 * Get top countries by alert count
 */
export function getTopCountries(alerts, limit = 10) {
    const countryStats = {};

    alerts.forEach(alert => {
        // Use ISO code as key for precision, fallback to CN
        const code = alert.source?.iso_code;
        const name = alert.source?.cn || "Unknown";

        if (code) {
            if (!countryStats[code]) {
                countryStats[code] = { count: 0, label: name, code: code };
            }
            countryStats[code].count++;
        } else if (name !== "Unknown") {
            // Fallback if no ISO code
            if (!countryStats[name]) {
                countryStats[name] = { count: 0, label: name, code: null };
            }
            countryStats[name].count++;
        }
    });

    return Object.values(countryStats)
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
        .map(item => ({
            label: item.label,
            count: item.count,
            countryCode: item.code
        }));
}

/**
 * Get top scenarios by alert count
 */
export function getTopScenarios(alerts, limit = 10) {
    const scenarioCounts = {};

    alerts.forEach(alert => {
        const scenario = alert.scenario;
        if (scenario) {
            scenarioCounts[scenario] = (scenarioCounts[scenario] || 0) + 1;
        }
    });

    return Object.entries(scenarioCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([scenario, count]) => ({ label: scenario, count }));
}

/**
 * Get top Autonomous Systems by alert count
 */
export function getTopAS(alerts, limit = 10) {
    const asCounts = {};

    alerts.forEach(alert => {
        const asName = alert.source?.as_name;
        if (asName && asName !== 'Unknown') {
            asCounts[asName] = (asCounts[asName] || 0) + 1;
        }
    });

    return Object.entries(asCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([as, count]) => ({ label: as, count }));
}

/**
 * Get alerts grouped by day for the last N days
 */
export function getAlertsPerDay(alerts, days = 7) {
    const dayMap = {};

    // Initialize all days with 0
    for (let i = days - 1; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateKey = date.toISOString().split('T')[0];
        dayMap[dateKey] = 0;
    }

    // Count alerts per day
    alerts.forEach(alert => {
        const date = new Date(alert.created_at);
        const dateKey = date.toISOString().split('T')[0];
        if (dayMap.hasOwnProperty(dateKey)) {
            dayMap[dateKey]++;
        }
    });

    return Object.entries(dayMap).map(([date, count]) => ({
        date,
        count,
        label: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }));
}

/**
 * Get decisions grouped by day for the last N days
 */
export function getDecisionsPerDay(decisions, days = 7) {
    const dayMap = {};

    // Initialize all days with 0
    for (let i = days - 1; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateKey = date.toISOString().split('T')[0];
        dayMap[dateKey] = 0;
    }

    // Count decisions per day
    decisions.forEach(decision => {
        const date = new Date(decision.created_at);
        const dateKey = date.toISOString().split('T')[0];
        if (dayMap.hasOwnProperty(dateKey)) {
            dayMap[dateKey]++;
        }
    });

    return Object.entries(dayMap).map(([date, count]) => ({
        date,
        count,
        label: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }));
}
