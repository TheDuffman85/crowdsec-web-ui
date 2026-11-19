import { createContext } from 'react';
import type { SyncStatus } from '../types';

// Kept apart from RefreshContext: the status is polled every second during a
// sync, and only the sync overlay needs its details.
export const SyncStatusContext = createContext<SyncStatus | null>(null);
