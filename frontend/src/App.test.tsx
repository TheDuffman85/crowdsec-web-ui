import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import App from './App';

vi.mock('./contexts/RefreshContext', () => ({
  RefreshProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('./contexts/useRefresh', () => ({
  useRefresh: () => ({
    syncStatus: null,
  }),
}));

vi.mock('./pages/Dashboard', () => ({
  Dashboard: () => <div>Dashboard Page</div>,
}));

vi.mock('./pages/Alerts', () => ({
  Alerts: () => <div>Alerts Page</div>,
}));

vi.mock('./pages/Decisions', () => ({
  Decisions: () => <div>Decisions Page</div>,
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
});
