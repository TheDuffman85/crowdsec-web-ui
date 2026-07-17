import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchConfig } from '../lib/api';
import { apiUrl } from '../lib/basePath';
import type { ManualRefreshMode, RefreshContextValue, SyncStatus, WithChildren } from '../types';
import { RefreshContext } from './refresh-context';

export function RefreshProvider({ children }: WithChildren) {
    const [intervalMs, setIntervalMsState] = useState(0);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const [nextRefreshAt, setNextRefreshAt] = useState<Date | null>(null);
    const [refreshSignal, setRefreshSignal] = useState(0);
    const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);

    // Track previous sync status to detect when sync completes
    const prevIsSyncing = useRef<boolean | null>(null);
    const lastPushRevisionRef = useRef<string | null>(null);

    // Function to fetch current config including sync status
    const updateConfig = useCallback(async () => {
        try {
            const config = await fetchConfig();
            if (config) {
                if (config.refresh_interval !== undefined) {
                    setIntervalMsState(config.refresh_interval);
                }
                if (config.sync_status !== undefined) {
                    setSyncStatus(config.sync_status);
                }
                if (config.cache_last_update) {
                    const cacheUpdatedAt = new Date(config.cache_last_update);
                    if (Number.isFinite(cacheUpdatedAt.getTime())) setLastUpdated(cacheUpdatedAt);
                }
                if (config.next_refresh_at !== undefined) {
                    const nextRefresh = config.next_refresh_at ? new Date(config.next_refresh_at) : null;
                    setNextRefreshAt(nextRefresh && Number.isFinite(nextRefresh.getTime()) ? nextRefresh : null);
                }
            }
        } catch (err) {
            console.error("Failed to load config", err);
        }
    }, []);

    // Fetch initial config from backend
    useEffect(() => {
        const timeoutId = window.setTimeout(() => {
            void updateConfig();
        }, 0);

        return () => window.clearTimeout(timeoutId);
    }, [updateConfig]);

    // Poll more frequently while syncing
    useEffect(() => {
        if (syncStatus?.isSyncing) {
            const pollInterval = setInterval(() => {
                updateConfig();
            }, 1000); // Poll every second during sync

            return () => clearInterval(pollInterval);
        }
    }, [syncStatus?.isSyncing, updateConfig]);

    // Trigger refresh when sync completes (transitions from true to false)
    useEffect(() => {
        const currentIsSyncing = syncStatus?.isSyncing ?? null;

        // If we were syncing and now we're not, trigger a refresh
        if (prevIsSyncing.current === true && currentIsSyncing === false) {
            console.log('Historical sync completed - triggering data refresh');
            setRefreshSignal(prev => prev + 1);
        }

        // Update the ref for next comparison
        prevIsSyncing.current = currentIsSyncing;
    }, [syncStatus?.isSyncing]);

    // Function to update interval via API
    const setIntervalMs = async (newIntervalMs: number): Promise<void> => {
        // Convert milliseconds back to interval name
        let intervalName = '0';
        if (newIntervalMs === 5000) intervalName = '5s';
        else if (newIntervalMs === 30000) intervalName = '30s';
        else if (newIntervalMs === 60000) intervalName = '1m';
        else if (newIntervalMs === 300000) intervalName = '5m';

        try {
            const response = await fetch(apiUrl('/api/config/refresh-interval'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ interval: intervalName })
            });

            if (!response.ok) {
                throw new Error('Failed to update refresh interval');
            }

            const data = await response.json() as { new_interval_ms: number; next_refresh_at?: string | null };
            console.log('Refresh interval updated:', data);

            // Update local state to reflect backend change
            setIntervalMsState(data.new_interval_ms);
            if (data.next_refresh_at !== undefined) {
                const nextRefresh = data.next_refresh_at ? new Date(data.next_refresh_at) : null;
                setNextRefreshAt(nextRefresh && Number.isFinite(nextRefresh.getTime()) ? nextRefresh : null);
            }
        } catch (error) {
            console.error('Error updating refresh interval:', error);
            throw error;
        }
    };

    const refreshNow = async (mode: ManualRefreshMode): Promise<void> => {
        if (mode === 'full') {
            setSyncStatus({
                isSyncing: true,
                progress: 0,
                message: 'Starting historical data sync...',
                startedAt: new Date().toISOString(),
                completedAt: null,
                state: 'syncing',
                errors: [],
            });
        }

        try {
            const response = await fetch(apiUrl('/api/cache/refresh'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode }),
            });
            const data = await response.json().catch(() => ({})) as { error?: string };
            if (!response.ok) {
                throw new Error(data.error || 'Refresh failed');
            }
        } finally {
            await updateConfig();
        }
    };

    // Keep a bounded polling fallback even while push is connected. A WebSocket
    // can remain open while an intermediary silently drops individual messages;
    // treating an open socket as delivery confirmation can leave every page
    // stale indefinitely after one missed cache update.
    useEffect(() => {
        const ms = intervalMs || 0;
        if (ms <= 0) return;

        const id = setInterval(() => {
            setRefreshSignal(prev => prev + 1);
            void updateConfig();
        }, ms);

        return () => clearInterval(id);
    }, [intervalMs, updateConfig]);

    // Refresh the scheduler timestamp shortly after it becomes due. While a
    // refresh is still running, retry until the backend publishes its next run.
    useEffect(() => {
        if (intervalMs <= 0) return;
        const delayMs = nextRefreshAt
            ? Math.max(500, nextRefreshAt.getTime() - Date.now() + 500)
            : 1000;
        const timeoutId = window.setTimeout(() => void updateConfig(), delayMs);
        return () => window.clearTimeout(timeoutId);
    }, [intervalMs, nextRefreshAt, updateConfig]);

    // The backend refresh and browser polling clocks are independent. Listen
    // for the read-visible cache revision so pages refresh after the database
    // commit instead of potentially just before it.
    useEffect(() => {
        if (typeof window.WebSocket !== 'function') return;

        let stopped = false;
        let socket: WebSocket | null = null;
        let reconnectTimeout: number | null = null;
        let connectionTimeout: number | null = null;
        let idleTimeout: number | null = null;
        let reconnectAttempt = 0;

        const clearConnectionTimeout = () => {
            if (connectionTimeout !== null) {
                window.clearTimeout(connectionTimeout);
                connectionTimeout = null;
            }
        };

        const resetIdleTimeout = () => {
            if (idleTimeout !== null) window.clearTimeout(idleTimeout);
            idleTimeout = window.setTimeout(() => {
                if (socket?.readyState === WebSocket.OPEN) socket.close();
            }, 70_000);
        };

        const scheduleReconnect = () => {
            if (stopped || reconnectTimeout !== null) return;
            const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5));
            reconnectAttempt += 1;
            reconnectTimeout = window.setTimeout(() => {
                reconnectTimeout = null;
                connect();
            }, delayMs);
        };

        const connect = () => {
            if (stopped) return;
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            socket = new window.WebSocket(`${protocol}//${window.location.host}${apiUrl('/api/cache-updates')}`);
            connectionTimeout = window.setTimeout(() => {
                if (socket?.readyState === WebSocket.CONNECTING) socket.close();
            }, 10_000);

            socket.onopen = () => {
                clearConnectionTimeout();
                reconnectAttempt = 0;
                resetIdleTimeout();
            };
            socket.onmessage = (event) => {
                resetIdleTimeout();
                try {
                    const message = JSON.parse(String(event.data)) as { type?: string; updated_at?: string | null };
                    if (message.type !== 'ready' && message.type !== 'cache-updated') return;
                    const revision = message.updated_at || null;
                    const previousRevision = lastPushRevisionRef.current;
                    lastPushRevisionRef.current = revision;
                    if (revision) {
                        const cacheUpdatedAt = new Date(revision);
                        if (Number.isFinite(cacheUpdatedAt.getTime())) setLastUpdated(cacheUpdatedAt);
                    }
                    if (message.type === 'cache-updated' || (previousRevision !== null && revision !== previousRevision)) {
                        setRefreshSignal(prev => prev + 1);
                    }
                } catch {
                    // Ignore malformed extension or proxy messages.
                }
            };
            socket.onerror = () => {
                if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
            };
            socket.onclose = () => {
                clearConnectionTimeout();
                if (idleTimeout !== null) {
                    window.clearTimeout(idleTimeout);
                    idleTimeout = null;
                }
                scheduleReconnect();
            };
        };

        connect();
        return () => {
            stopped = true;
            clearConnectionTimeout();
            if (idleTimeout !== null) window.clearTimeout(idleTimeout);
            if (reconnectTimeout !== null) window.clearTimeout(reconnectTimeout);
            if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Page closed');
        };
    }, []);

    return (
        <RefreshContext.Provider value={{
            lastUpdated,
            setLastUpdated,
            intervalMs,
            nextRefreshAt,
            setIntervalMs,
            refreshSignal,
            syncStatus,
            refreshNow,
        }}>
            {children}
        </RefreshContext.Provider>
    );
}
