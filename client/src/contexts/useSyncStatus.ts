import { useContext } from 'react';
import type { SyncStatus } from '../types';
import { SyncStatusContext } from './sync-status-context';

export function useSyncStatus(): SyncStatus | null {
    return useContext(SyncStatusContext);
}
