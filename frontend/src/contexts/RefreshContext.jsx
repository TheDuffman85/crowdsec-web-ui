import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { fetchConfig } from '../lib/api';

const RefreshContext = createContext();

export function RefreshProvider({ children }) {
    const [intervalMs, setIntervalMsState] = useState(0);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [refreshSignal, setRefreshSignal] = useState(0);
    const [syncStatus, setSyncStatus] = useState(null);

    // Track previous sync status to detect when sync completes
    const prevIsSyncing = useRef(null);

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
            }
        } catch (err) {
            console.error("Failed to load config", err);
        }
    }, []);

    // Fetch initial config from backend
    useEffect(() => {
        updateConfig();
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
        const currentIsSyncing = syncStatus?.isSyncing;

        // If we were syncing and now we're not, trigger a refresh
        if (prevIsSyncing.current === true && currentIsSyncing === false) {
            console.log('Historical sync completed - triggering data refresh');
            setRefreshSignal(prev => prev + 1);
        }

        // Update the ref for next comparison
        prevIsSyncing.current = currentIsSyncing;
    }, [syncStatus?.isSyncing]);

    // Function to update interval via API
    const setIntervalMs = async (newIntervalMs) => {
        // Convert milliseconds back to interval name
        let intervalName = '0';
        if (newIntervalMs === 5000) intervalName = '5s';
        else if (newIntervalMs === 30000) intervalName = '30s';
        else if (newIntervalMs === 60000) intervalName = '1m';
        else if (newIntervalMs === 300000) intervalName = '5m';

        try {
            const response = await fetch('/api/config/refresh-interval', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ interval: intervalName })
            });

            if (!response.ok) {
                throw new Error('Failed to update refresh interval');
            }

            const data = await response.json();
            console.log('Refresh interval updated:', data);

            // Update local state to reflect backend change
            setIntervalMsState(data.new_interval_ms);
        } catch (error) {
            console.error('Error updating refresh interval:', error);
        }
    };

    // Frontend polling for manual refresh signal (backend handles actual caching)
    useEffect(() => {
        const ms = intervalMs || 0;
        if (ms <= 0) return;

        const id = setInterval(() => {
            setRefreshSignal(prev => prev + 1);
        }, ms);

        return () => clearInterval(id);
    }, [intervalMs]);

    return (
        <RefreshContext.Provider value={{
            lastUpdated,
            setLastUpdated,
            intervalMs,
            setIntervalMs,
            refreshSignal,
            syncStatus
        }}>
            {children}
        </RefreshContext.Provider>
    );
}

export const useRefresh = () => useContext(RefreshContext);
