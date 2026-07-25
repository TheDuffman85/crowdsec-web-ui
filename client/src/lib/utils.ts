import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}

export function getHubUrl(scenarioName?: string | null): string | null {
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

export function getCountryName(code?: string | null, locale = 'en'): string | null {
    if (!code) return null;
    try {
        const regionNames = new Intl.DisplayNames([locale], { type: 'region' });
        return regionNames.of(code.toUpperCase()) || code;
    } catch {
        return code;
    }
}

const localizedCountryEntries = new Map<string, Array<{ code: string; name: string }>>();

export function getCountryCodesMatchingName(search: string, locale = 'en'): string[] {
    const normalizedSearch = search.trim().toLocaleLowerCase(locale);
    if (!normalizedSearch) return [];

    let entries = localizedCountryEntries.get(locale);
    if (!entries) {
        entries = [];
        for (let first = 65; first <= 90; first += 1) {
            for (let second = 65; second <= 90; second += 1) {
                const code = String.fromCharCode(first, second);
                const name = getCountryName(code, locale);
                if (name && name !== code) entries.push({ code, name });
            }
        }
        localizedCountryEntries.set(locale, entries);
    }

    return entries
        .filter(({ name }) => name.toLocaleLowerCase(locale).includes(normalizedSearch))
        .map(({ code }) => code);
}
