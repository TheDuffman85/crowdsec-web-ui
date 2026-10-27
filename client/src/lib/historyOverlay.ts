import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

function isStateObject(state: unknown): state is Record<string, unknown> {
    return typeof state === "object" && state !== null;
}

function hasHistoryFlag(state: unknown, key: string): boolean {
    return isStateObject(state) && state[key] === true;
}

function withoutHistoryFlag(state: unknown, key: string): unknown {
    if (!isStateObject(state)) return state;
    const rest = { ...state };
    delete rest[key];
    return Object.keys(rest).length > 0 ? rest : null;
}

export interface HistoryBackedOverlay {
    /** True while the overlay's history entry is the current one. */
    isActive: boolean;
    /** Pushes a same-URL history entry flagged with the overlay key. */
    open: () => void;
    /** Removes the overlay's history entry again; returns false when there is none. */
    close: () => boolean;
}

/**
 * Backs an overlay (modal, drawer) with a same-URL history entry flagged in its
 * location state, so the browser Back button closes the overlay instead of
 * leaving the page. Only the history state changes, so the page is not reloaded.
 *
 * Overlays opened on top of each other stack, because `open` keeps the flags
 * already in the state. `onBack` runs when navigation leaves the entry. While
 * `isActive`, navigations away from the overlay should use `replace` so the
 * entry does not linger in the history.
 */
export function useHistoryBackedOverlay(key: string, onBack: () => void): HistoryBackedOverlay {
    const location = useLocation();
    const navigate = useNavigate();
    const isActive = hasHistoryFlag(location.state, key);
    const activeRef = useRef(isActive);
    const pushPendingRef = useRef(false);
    const pushedEntryKeyRef = useRef<string | null>(null);
    const onBackRef = useRef(onBack);

    useEffect(() => {
        onBackRef.current = onBack;
    });

    useEffect(() => {
        const wasActive = activeRef.current;
        activeRef.current = isActive;
        if (isActive && pushPendingRef.current) {
            pushPendingRef.current = false;
            pushedEntryKeyRef.current = location.key;
        } else if (wasActive && !isActive) {
            pushedEntryKeyRef.current = null;
            onBackRef.current();
        }
    }, [isActive, location.key]);

    const open = useCallback(() => {
        if (activeRef.current) return;
        activeRef.current = true;
        pushPendingRef.current = true;
        navigate(
            { pathname: location.pathname, search: location.search, hash: location.hash },
            { state: { ...(isStateObject(location.state) ? location.state : {}), [key]: true } },
        );
    }, [key, location, navigate]);

    const close = useCallback(() => {
        if (!activeRef.current) return false;
        activeRef.current = false;
        if (pushedEntryKeyRef.current === location.key) {
            navigate(-1);
        } else {
            // The entry was not pushed here (e.g. restored after a reload) or its
            // URL was replaced since, so popping it would change the page.
            navigate(
                { pathname: location.pathname, search: location.search, hash: location.hash },
                { replace: true, state: withoutHistoryFlag(location.state, key) },
            );
        }
        pushedEntryKeyRef.current = null;
        return true;
    }, [key, location, navigate]);

    return { isActive, open, close };
}
