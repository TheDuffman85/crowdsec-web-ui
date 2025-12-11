import { createContext, useContext, useState, useEffect } from 'react';

const RefreshContext = createContext();

export function RefreshProvider({ children }) {
    // intervalMs: 0 means off. Default 30s (30000ms)
    // configureable 30s, 1m, 5m
    const [intervalMs, setIntervalMs] = useState(30000);
    const [lastUpdated, setLastUpdated] = useState(null);
    const [refreshSignal, setRefreshSignal] = useState(0);

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
