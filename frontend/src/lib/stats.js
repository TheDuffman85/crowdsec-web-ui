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
        // Use CN (2-letter country code) - same as used for flags in Alerts.jsx
        const code = alert.source?.cn;
        const name = alert.source?.cn || "Unknown";

        if (name !== "Unknown" && code) {
            // Use code as key
            if (!countryStats[code]) {
                countryStats[code] = { count: 0, label: code.toUpperCase(), code: code };
            }
            countryStats[code].count++;
        }
    });

    return Object.values(countryStats)
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
        .map(item => ({
            label: item.label,
            count: item.count,
            countryCode: item.code  // Will be the 2-letter code
        }));
}

/**
 * Get ALL countries with alert counts (not limited)
 */
export function getAllCountries(alerts) {
    const countryStats = {};

    alerts.forEach(alert => {
        const code = alert.source?.cn;
        const name = alert.source?.cn || "Unknown";

        if (name !== "Unknown" && code) {
            if (!countryStats[code]) {
                countryStats[code] = { count: 0, label: code.toUpperCase(), code: code };
            }
            countryStats[code].count++;
        }
    });

    return Object.values(countryStats)
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
 * Get aggregated stats for the given time range and granularity
 * @param {Array} items - List of items with created_at
 * @param {number} days - Number of days to look back
 * @param {string} granularity - 'day', 'hour'
 */
export function getAggregatedData(items, days = 7, granularity = 'day') {
    const dataMap = {};
    const now = new Date();
    const start = new Date(now);
    // Go back (days - 1) to get exactly 'days' complete calendar days including today
    start.setDate(start.getDate() - (days - 1));
    // Align to start of day for complete-day buckets
    start.setHours(0, 0, 0, 0);

    // Function to generate key based on granularity
    // Use LOCAL time components to avoid timezone shifts
    const getKey = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');

        if (granularity === 'hour') {
            const hour = String(date.getHours()).padStart(2, '0');
            return `${year}-${month}-${day}T${hour}`;   // YYYY-MM-DDTHH in local time
        }
        return `${year}-${month}-${day}`;                // YYYY-MM-DD in local time
    };

    // Label formatter
    const getLabel = (date) => {
        if (granularity === 'hour') {
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };

    // Initialize all slots with 0
    let current = new Date(start);
    // Align current to start of the period to be clean
    if (granularity === 'hour') current.setMinutes(0, 0, 0);
    else current.setHours(0, 0, 0, 0);

    while (current <= now) {
        const key = getKey(current);
        dataMap[key] = {
            date: key,
            count: 0,
            label: getLabel(current),
            fullDate: new Date(current).toISOString() // Store full date for sorting/reference
        };

        // Increment
        if (granularity === 'hour') current.setHours(current.getHours() + 1);
        else current.setDate(current.getDate() + 1);
    }

    // Populate counts
    items.forEach(item => {
        if (!item.created_at) return;
        const itemDate = new Date(item.created_at);
        if (itemDate < start) return; // Should be filtered already but safety check

        const key = getKey(itemDate);
        if (dataMap[key]) {
            dataMap[key].count++;
        }
    });

    return Object.values(dataMap).sort((a, b) => a.date.localeCompare(b.date));
}
