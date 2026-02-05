import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
    return twMerge(clsx(inputs))
}

export function getHubUrl(scenarioName) {
    if (!scenarioName) return null;
    const parts = scenarioName.split('/');
    if (parts.length === 2) {
        const [author, name] = parts;
        // Check if it's an AppSec rule (heuristic based on common prefixes)
        if (name.startsWith('vpatch-') || name.startsWith('crs-') || name.startsWith('appsec-')) {
            return `https://app.crowdsec.net/hub/author/${author}/appsec-rules/${name}`;
        }
        return `https://app.crowdsec.net/hub/author/${author}/scenarios/${name}`;
    }
    return null;
}

export function getCountryName(code) {
    if (!code) return null;
    try {
        const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
        return regionNames.of(code.toUpperCase());
    } catch {
        return code;
    }
}
