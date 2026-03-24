import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Alerts } from './Alerts';

vi.mock('../contexts/useRefresh', () => ({
  useRefresh: () => ({
    refreshSignal: 0,
    setLastUpdated: vi.fn(),
  }),
}));

vi.mock('../lib/api', () => ({
  fetchAlerts: vi.fn(async () => [
    {
      id: 1,
      created_at: '2026-03-23T10:00:00.000Z',
      scenario: 'crowdsecurity/ssh-bf',
      source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
      target: 'ssh',
      meta_search: 'ssh',
      decisions: [{ id: 10, value: '1.2.3.4', type: 'ban', simulated: false, expired: false }],
    },
    {
      id: 2,
      created_at: '2026-03-23T11:00:00.000Z',
      scenario: 'crowdsecurity/nginx-bf',
      source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
      target: 'nginx',
      meta_search: 'nginx',
      simulated: true,
      decisions: [{ id: 20, value: '5.6.7.8', type: 'ban', simulated: true, expired: false }],
    },
    {
      id: 14302,
      created_at: '2026-03-24T19:47:52.000Z',
      scenario: 'manual/web-ui',
      source: { range: '192.168.5.0/24', cn: 'Unknown', as_name: 'Local Network' },
      target: 'manual',
      meta_search: '192.168.5.0/24 localhost',
      decisions: [{ id: 14302, value: '192.168.5.0/24', type: 'ban', simulated: false, expired: false }],
    },
  ]),
  fetchAlert: vi.fn(async (id: string | number) => ({
    id,
    created_at: '2026-03-23T11:00:00.000Z',
    scenario: 'crowdsecurity/nginx-bf',
    source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
    target: 'nginx',
    message: 'Simulated alert',
    simulated: true,
    decisions: [{ id: 20, value: '5.6.7.8', type: 'ban', simulated: true, expired: false }],
    events: [],
  })),
  deleteAlert: vi.fn(),
  fetchConfig: vi.fn(async () => ({
    lookback_period: '1h',
    lookback_hours: 1,
    lookback_days: 1,
    refresh_interval: 30000,
    current_interval_name: '30s',
    lapi_status: { isConnected: true, lastCheck: null, lastError: null },
    sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
    simulations_enabled: true,
  })),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Alerts page', () => {
  test('shows simulated alerts with an inline scenario badge and standard decision actions', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts?simulation=simulated']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Active: 1')).toBeInTheDocument());
    expect(screen.getByText('Simulation')).toBeInTheDocument();
    expect(screen.queryByText('Simulation Mode')).not.toBeInTheDocument();
  });

  test('renders and filters range-only alerts by CIDR source value', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts?ip=192.168.5.0/24']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Showing 1 of 3 alerts')).toBeInTheDocument());
    expect(screen.getByRole('columnheader', { name: 'IP / Range' })).toBeInTheDocument();
    expect(screen.getAllByText('192.168.5.0/24')).toHaveLength(2);
    expect(screen.queryByText('1.2.3.4')).not.toBeInTheDocument();
  });
});
