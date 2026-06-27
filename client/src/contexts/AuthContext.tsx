import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiUrl } from '../lib/basePath';

export type AuthRole = 'admin' | 'read-only';

export interface AuthUser {
  userId: number;
  username: string;
  role: AuthRole;
}

export interface AuthStatus {
  authEnabled: boolean;
  setupRequired: boolean;
  authenticated: boolean;
  user: AuthUser | null;
  oidcEnabled: boolean;
  passwordLoginDisabled: boolean;
  passkeysEnabled: boolean;
  hasPassword: boolean;
}

interface AuthContextValue extends AuthStatus {
  loading: boolean;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  setup: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const DEFAULT_STATUS: AuthStatus = {
  authEnabled: true,
  setupRequired: false,
  authenticated: false,
  user: null,
  oidcEnabled: false,
  passwordLoginDisabled: false,
  passkeysEnabled: false,
  hasPassword: false,
};

const fallbackAuthContext: AuthContextValue = {
  ...DEFAULT_STATUS,
  authEnabled: false,
  authenticated: true,
  loading: false,
  refresh: async () => undefined,
  login: async () => undefined,
  setup: async () => undefined,
  logout: async () => undefined,
};

const AuthContext = createContext<AuthContextValue>(fallbackAuthContext);

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), init);
  if (!response.ok) {
    let message = 'Request failed';
    try {
      const payload = await response.json() as { error?: string };
      message = payload.error || message;
    } catch {
      // Use the default message.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>(DEFAULT_STATUS);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const nextStatus = await readJson<AuthStatus>('/api/auth/status', { cache: 'no-store' });
    setStatus(nextStatus);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readJson<AuthStatus>('/api/auth/status', { cache: 'no-store' })
      .then((nextStatus) => {
        if (!cancelled) {
          setStatus(nextStatus);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus(DEFAULT_STATUS);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    await readJson('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    await refresh();
  }, [refresh]);

  const setup = useCallback(async (username: string, password: string) => {
    await readJson('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await readJson('/api/auth/logout', { method: 'POST' });
    await refresh();
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...status, loading, refresh, login, setup, logout }),
    [loading, login, logout, refresh, setup, status],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
