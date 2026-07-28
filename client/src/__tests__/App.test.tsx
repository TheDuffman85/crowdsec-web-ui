import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import App from '../App';
import { updateLanguagePreference } from '../lib/api';

vi.mock('../contexts/RefreshContext', () => ({
  RefreshProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../contexts/useRefresh', () => ({
  useRefresh: () => ({
    syncStatus: null,
  }),
}));

vi.mock('../pages/Dashboard', () => ({
  Dashboard: () => <div>Dashboard Page</div>,
}));

vi.mock('../pages/Alerts', () => ({
  Alerts: () => <div>Alerts Page</div>,
}));

vi.mock('../pages/Decisions', () => ({
  Decisions: () => <div>Decisions Page</div>,
}));

vi.mock('../pages/Notifications', () => ({
  Notifications: () => <div>Notifications Page</div>,
}));

vi.mock('../pages/Settings', () => ({
  Settings: () => <div>Settings Page</div>,
}));

vi.mock('../pages/Login', () => ({
  Login: () => <div>Login Page</div>,
}));

describe('App lazy routes', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ update_available: false })));
    window.history.pushState({}, '', '/');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('renders the lazy dashboard route', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Dashboard Page')).toBeInTheDocument());
  });

  test('renders the lazy alerts route', async () => {
    window.history.pushState({}, '', '/alerts');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Alerts Page')).toBeInTheDocument());
  });

  test('renders the lazy notifications route', async () => {
    window.history.pushState({}, '', '/notifications');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Notifications Page')).toBeInTheDocument());
  });

  test('renders the lazy settings route', async () => {
    window.history.pushState({}, '', '/settings');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Settings Page')).toBeInTheDocument());
  });

  test('redirects authenticated users away from setup', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/api/auth/status')) {
          return Response.json({
            authEnabled: true,
            setupRequired: false,
            authenticated: true,
            user: { userId: 1, username: 'admin', role: 'admin' },
            oidcEnabled: false,
            passkeysEnabled: false,
          });
        }
        return Response.json({ update_available: false });
      }),
    );
    window.history.pushState({}, '', '/setup');

    render(<App />);

    await waitFor(() => expect(screen.getByText('Dashboard Page')).toBeInTheDocument());
    expect(window.location.pathname).toBe('/');
  });

  test('redirects to login when an authenticated API request returns 401', async () => {
    let sessionInvalidated = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/api/auth/status')) {
          return Response.json({
            authEnabled: true,
            setupRequired: false,
            authenticated: true,
            user: { userId: 1, username: 'admin', role: 'admin' },
            authMethod: 'password',
            oidcEnabled: false,
            passwordLoginDisabled: false,
            passkeysEnabled: false,
            hasPassword: true,
            totpEnabled: false,
          });
        }
        if (sessionInvalidated) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }
        return Response.json({ update_available: false });
      }),
    );

    render(<App />);
    await waitFor(() => expect(screen.getByText('Dashboard Page')).toBeInTheDocument());

    sessionInvalidated = true;
    await expect(updateLanguagePreference('en')).rejects.toThrow('Unauthorized');

    await waitFor(() => expect(screen.getByText('Login Page')).toBeInTheDocument());
    expect(window.location.pathname).toBe('/login');
  });
});
