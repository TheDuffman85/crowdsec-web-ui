import { createContext, useContext, useState, useEffect } from 'react';
import { fetchConfig } from '../lib/api';

const RefreshContext = createContext();

export function RefreshProvider({ children }) {
    // intervalMs: 0 means off. Default 0 (Manual)
    const [intervalMs, setIntervalMs] = useState(0);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [refreshSignal, setRefreshSignal] = useState(0);

    // Initial Config Fetch
    useEffect(() => {
        fetchConfig().then(config => {
            if (config && config.refresh_interval !== undefined) {
                console.log('Setting refresh interval from config:', config.refresh_interval);
                setIntervalMs(config.refresh_interval);
            }
        }).catch(err => console.error("Failed to load refresh config", err));
    }, []);

    useEffect(() => {
        if (!intervalMs || intervalMs <= 0) return;

        const id = setInterval(() => {
            setRefreshSignal(prev => prev + 1);
        }, intervalMs);

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
