import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
    return twMerge(clsx(inputs))
}

export function getHubUrl(scenarioName) {
    if (!scenarioName) return null;
    const parts = scenarioName.split('/');
    if (parts.length === 2) {
        return `https://app.crowdsec.net/hub/author/${parts[0]}/scenarios/${parts[1]}`;
    }
    return null;
}
