import React, { createContext, useContext, useState, useEffect } from "react";
import axios from "axios";

// Create Context
const CapabilityContext = createContext();

// Provider Component
export const CapabilityProvider = ({ children }) => {
    const [capabilities, setCapabilities] = useState({
        agent: false,
        loaded: false,
    });

    const fetchCapabilities = async () => {
        try {
            // In development mode with proxy, this hits localhost:3000/api/config
            // In production, relative path works
            const response = await axios.get("/api/config");
            if (response.data && response.data.capabilities) {
                setCapabilities({
                    ...response.data.capabilities,
                    loaded: true,
                });
            } else {
                // Fallback for legacy backend if it doesn't return capabilities
                setCapabilities({
                    agent: false,
                    loaded: true,
                });
            }
        } catch (error) {
            console.error("Failed to fetch capabilities:", error);
            // Assume no agent if check fails
            setCapabilities({
                agent: false,
                loaded: true,
            });
        }
    };

    useEffect(() => {
        fetchCapabilities();
    }, []);

    return (
        <CapabilityContext.Provider value={capabilities}>
            {children}
        </CapabilityContext.Provider>
    );
};

// Hook
export const useCapabilities = () => {
    return useContext(CapabilityContext);
};
