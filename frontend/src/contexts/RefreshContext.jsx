import { createContext, useContext, useState, useEffect } from 'react';
import { fetchConfig } from '../lib/api';

const RefreshContext = createContext();

export function RefreshProvider({ children }) {
    // intervalMs: 0 means off. Default 0 (Manual)
    // Initialize from localStorage if available, otherwise null (to signal "use config")
    const [intervalMs, setIntervalMs] = useState(() => {
        const saved = localStorage.getItem('refresh_interval');
        return saved !== null ? parseInt(saved, 10) : null;
    });

    const [lastUpdated, setLastUpdated] = useState(null);
    const [refreshSignal, setRefreshSignal] = useState(0);

    // Initial Config Fetch
    useEffect(() => {
        // Only fetch/apply config if we didn't restore a value from local storage
        if (intervalMs !== null) return;

        fetchConfig().then(config => {
            if (config && config.refresh_interval !== undefined) {
                console.log('Setting refresh interval from config:', config.refresh_interval);
                setIntervalMs(config.refresh_interval);
            } else {
                // Default to 0 (Manual) if no config
                setIntervalMs(0);
            }
        }).catch(err => {
            console.error("Failed to load refresh config", err);
            setIntervalMs(0);
        });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Persist to localStorage
    useEffect(() => {
        if (intervalMs !== null) {
            localStorage.setItem('refresh_interval', intervalMs);
        }
    }, [intervalMs]);

    useEffect(() => {
        // Treat null as 0 for the actual timer logic
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
