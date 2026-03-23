import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Dashboard } from './Dashboard';

vi.mock('../contexts/useRefresh', () => ({
  useRefresh: () => ({
    refreshSignal: 0,
    setLastUpdated: vi.fn(),
  }),
}));

vi.mock('../components/DashboardCharts', () => ({
  ActivityBarChart: () => <div>Chart</div>,
}));

vi.mock('../components/WorldMapCard', () => ({
  WorldMapCard: () => <div>Map</div>,
}));

vi.mock('../lib/api', () => ({
  fetchConfig: vi.fn(async () => ({
    lookback_period: '7d',
    lookback_hours: 168,
    lookback_days: 7,
    refresh_interval: 30000,
    current_interval_name: '30s',
    lapi_status: { isConnected: true, lastCheck: null, lastError: null },
    sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
    simulations_enabled: true,
  })),
  fetchAlertsForStats: vi.fn(async () => [
    {
      created_at: '2026-03-23T10:00:00.000Z',
      scenario: 'crowdsecurity/ssh-bf',
      source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
      target: 'ssh',
      simulated: false,
    },
    {
      created_at: '2026-03-23T11:00:00.000Z',
      scenario: 'crowdsecurity/nginx-bf',
      source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
      target: 'nginx',
      simulated: true,
    },
  ]),
  fetchDecisionsForStats: vi.fn(async () => [
    {
      id: 10,
      created_at: '2026-03-23T10:00:00.000Z',
      scenario: 'crowdsecurity/ssh-bf',
      value: '1.2.3.4',
      stop_at: '2099-03-23T12:00:00.000Z',
      target: 'ssh',
      simulated: false,
    },
    {
      id: 20,
      created_at: '2026-03-23T11:00:00.000Z',
      scenario: 'crowdsecurity/nginx-bf',
      value: '5.6.7.8',
      stop_at: '2099-03-23T13:00:00.000Z',
      target: 'nginx',
      simulated: true,
    },
  ]),
}));

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Dashboard page', () => {
  test('shows simulation counts separately and keeps active decisions live-only', async () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Active Decisions')).toBeInTheDocument());
    expect(screen.getAllByText('Simulation: 1').length).toBeGreaterThan(0);

    const decisionsCard = screen.getByText('Active Decisions').closest('a');
    expect(decisionsCard).not.toBeNull();
    expect(within(decisionsCard as HTMLElement).getByText('1')).toBeInTheDocument();
  });
});
