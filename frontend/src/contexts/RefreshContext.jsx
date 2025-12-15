import { createContext, useContext, useState, useEffect } from 'react';
import { fetchConfig } from '../lib/api';

const RefreshContext = createContext();

export function RefreshProvider({ children }) {
    const [intervalMs, setIntervalMsState] = useState(null);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [refreshSignal, setRefreshSignal] = useState(0);

    // Fetch initial config from backend
    useEffect(() => {
        fetchConfig().then(config => {
            if (config && config.refresh_interval !== undefined) {
                console.log('Setting refresh interval from backend:', config.refresh_interval);
                setIntervalMsState(config.refresh_interval);
            } else {
                setIntervalMsState(0);
            }
        }).catch(err => {
            console.error("Failed to load refresh config", err);
            setIntervalMsState(0);
        });
    }, []);

    // Function to update interval via API
    const setIntervalMs = async (newIntervalMs) => {
        // Convert milliseconds back to interval name
        let intervalName = 'manual';
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
            refreshSignal
        }}>
            {children}
        </RefreshContext.Provider>
    );
}

export const useRefresh = () => useContext(RefreshContext);
