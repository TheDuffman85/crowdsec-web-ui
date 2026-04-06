import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as api from '../lib/api';
import { Alerts } from './Alerts';

const largeDecisionList = Array.from({ length: 75 }, (_, index) => ({
  id: 1000 + index,
  value: `203.0.113.${index}`,
  type: 'ban',
  duration: `${index + 1}h`,
  simulated: false,
  expired: false,
  origin: 'CAPI',
}));

const setLastUpdatedMock = vi.fn();

vi.mock('../contexts/useRefresh', () => ({
  useRefresh: () => ({
    refreshSignal: 0,
    setLastUpdated: setLastUpdatedMock,
  }),
}));

vi.mock('../lib/api', () => ({
  fetchAlerts: vi.fn(async () => [
    {
      id: 1,
      created_at: '2026-03-23T10:00:00.000Z',
      scenario: 'crowdsecurity/ssh-bf',
      machine_id: 'machine-1',
      machine_alias: 'host-a',
      source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
      target: 'ssh',
      meta_search: 'ssh',
      decisions: [{ id: 10, value: '1.2.3.4', type: 'ban', simulated: false, expired: false }],
    },
    {
      id: 2,
      created_at: '2026-03-23T11:00:00.000Z',
      scenario: 'crowdsecurity/nginx-bf',
      machine_id: 'machine-2',
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
    machine_id: 'machine-2',
    source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
    target: 'nginx',
    message: 'Simulated alert',
    simulated: true,
    decisions: [{ id: 20, value: '5.6.7.8', type: 'ban', simulated: true, expired: false }],
    events: [],
  })),
  deleteAlert: vi.fn(),
  bulkDeleteAlerts: vi.fn(async () => ({
    requested_alerts: 0,
    requested_decisions: 0,
    deleted_alerts: 0,
    deleted_decisions: 0,
    failed: [],
  })),
  cleanupByIp: vi.fn(async () => ({
    requested_alerts: 0,
    requested_decisions: 0,
    deleted_alerts: 0,
    deleted_decisions: 0,
    failed: [],
  })),
  fetchConfig: vi.fn(async () => ({
    lookback_period: '1h',
    lookback_hours: 1,
    lookback_days: 1,
    refresh_interval: 30000,
    current_interval_name: '30s',
    lapi_status: { isConnected: true, lastCheck: null, lastError: null },
    sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
    simulations_enabled: true,
    machine_features_enabled: false,
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

  test('keeps machine UI hidden when the feature flag is disabled', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    expect(screen.queryByRole('columnheader', { name: 'Machine' })).not.toBeInTheDocument();
  });

  test('shows machine column and detail card when the feature flag is enabled', async () => {
    vi.mocked(api.fetchConfig).mockResolvedValue({
      lookback_period: '1h',
      lookback_hours: 1,
      lookback_days: 1,
      refresh_interval: 30000,
      current_interval_name: '30s',
      lapi_status: { isConnected: true, lastCheck: null, lastError: null },
      sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
      simulations_enabled: true,
      machine_features_enabled: true,
    });
    vi.mocked(api.fetchAlert).mockResolvedValueOnce({
      id: 1,
      created_at: '2026-03-23T10:00:00.000Z',
      scenario: 'crowdsecurity/ssh-bf',
      machine_id: 'machine-1',
      machine_alias: 'host-a',
      source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
      target: 'ssh',
      message: 'Alert with machine alias',
      simulated: false,
      decisions: [{ id: 10, value: '1.2.3.4', type: 'ban', simulated: false, expired: false }],
      events: [],
    });

    render(
      <MemoryRouter initialEntries={['/alerts?id=1']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Machine' })).toBeInTheDocument());
    expect(screen.getAllByText('host-a').length).toBeGreaterThan(1);
    expect(screen.getByText('Alert Details #1')).toBeInTheDocument();
    expect(screen.getAllByText('Machine').length).toBeGreaterThan(1);
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

  test('streams large decision lists inside alert details', async () => {
    const fetchAlertMock = vi.mocked(api.fetchAlert);
    fetchAlertMock.mockResolvedValueOnce({
      id: 1,
      created_at: '2026-03-23T11:00:00.000Z',
      scenario: 'crowdsecurity/community-blocklist',
      source: { value: 'community-blocklist' },
      decisions: largeDecisionList,
      events: [],
    });

    render(
      <MemoryRouter initialEntries={['/alerts?id=1']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Alert Details #1')).toBeInTheDocument());
    expect(screen.getByText('Showing 50 of 75')).toBeInTheDocument();
    expect(screen.getByText('#1000')).toBeInTheDocument();
    expect(screen.queryByText('#1074')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Load 50 more decisions/i }));

    await waitFor(() => expect(screen.getByText('#1074')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Load 50 more decisions/i })).not.toBeInTheDocument();
  });

  test('bulk delete selects all filtered alerts, not just the first rendered slice', async () => {
    const bulkAlerts = Array.from({ length: 55 }, (_, index) => ({
      id: index + 1,
      created_at: `2026-03-24T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
      scenario: 'bulk/scenario',
      source: { ip: `10.0.0.${index + 1}`, value: `10.0.0.${index + 1}`, cn: 'DE', as_name: 'Hetzner' },
      target: 'ssh',
      meta_search: 'bulk',
      decisions: [],
    }));
    vi.mocked(api.fetchAlerts).mockResolvedValue(bulkAlerts);
    const bulkDeleteAlertsMock = vi.mocked(api.bulkDeleteAlerts).mockResolvedValue({
      requested_alerts: 55,
      requested_decisions: 0,
      deleted_alerts: 55,
      deleted_decisions: 0,
      failed: [],
    });

    render(
      <MemoryRouter initialEntries={['/alerts?scenario=bulk/scenario']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('10.0.0.1')).toBeInTheDocument());
    expect(screen.queryByText('10.0.0.55')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all filtered alerts' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(bulkDeleteAlertsMock).toHaveBeenCalledWith(
      Array.from({ length: 55 }, (_, index) => String(index + 1)),
    ));
  });
});
