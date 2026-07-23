import type { AlertEvent, AlertMeta, AlertMetaValue } from '../types';

export interface DisplayMetadataEntry extends AlertMeta {
    formattedValue: string;
}

export function formatMetaValue(value: AlertMetaValue | undefined): string | undefined {
    if (value == null) return undefined;

    if (typeof value === 'string') {
        return value.trim() ? value : undefined;
    }

    if (typeof value === 'object') {
        return JSON.stringify(value);
    }

    return String(value);
}

export function getDisplayMetadata(entries: AlertMeta[] | undefined): DisplayMetadataEntry[] {
    return (entries || []).flatMap((entry) => {
        const formattedValue = formatMetaValue(entry.value);
        return entry.key.trim() && formattedValue
            ? [{ ...entry, formattedValue }]
            : [];
    });
}

export function isAppSecEvent(event: Pick<AlertEvent, 'meta'>): boolean {
    return event.meta?.some((meta) =>
        meta.key === 'matched_zones' || meta.key === 'rule_name' || meta.key === 'appsec_action'
    ) ?? false;
}

export function getMetaValueItems(value: AlertMetaValue): string[] | null {
    let items: unknown[] | null = Array.isArray(value) ? value : null;

    if (!items && typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
                const parsed = JSON.parse(trimmed) as unknown;
                if (Array.isArray(parsed)) items = parsed;
            } catch {
                // Render malformed JSON-like strings as their original scalar value.
            }
        }
    }

    if (!items) return null;
    const formattedItems = items
        .map((item) => formatMetaValue(item as AlertMetaValue))
        .filter((item): item is string => item !== undefined);
    return formattedItems.length > 0 ? formattedItems : null;
}
