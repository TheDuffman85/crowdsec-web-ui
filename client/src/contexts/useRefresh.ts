import { useContext } from 'react';
import type { RefreshContextValue } from '../types';
import { RefreshContext } from './refresh-context';

export function useRefresh(): RefreshContextValue {
    const context = useContext(RefreshContext);
    if (!context) {
        throw new Error('useRefresh must be used within RefreshProvider');
    }
    return context;
}
