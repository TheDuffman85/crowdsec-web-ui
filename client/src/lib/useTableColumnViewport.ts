import { useEffect, useState } from 'react';
import type { TableColumnPreferenceViewport } from '../types';

const MOBILE_TABLE_COLUMNS_QUERY = '(max-width: 767px)';

export function useTableColumnViewport(): TableColumnPreferenceViewport {
    const [viewport, setViewport] = useState<TableColumnPreferenceViewport>(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return 'desktop';
        }
        return window.matchMedia(MOBILE_TABLE_COLUMNS_QUERY).matches ? 'mobile' : 'desktop';
    });

    useEffect(() => {
        if (typeof window.matchMedia !== 'function') {
            return undefined;
        }

        const mediaQuery = window.matchMedia(MOBILE_TABLE_COLUMNS_QUERY);
        const updateViewport = () => setViewport(mediaQuery.matches ? 'mobile' : 'desktop');
        updateViewport();
        mediaQuery.addEventListener('change', updateViewport);

        return () => mediaQuery.removeEventListener('change', updateViewport);
    }, []);

    return viewport;
}
