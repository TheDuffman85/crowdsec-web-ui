import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { PaginatedResponse, SlimAlert } from '../types';
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
let refreshSignalMock = 0;

function toPaginatedAlerts(
  alerts: SlimAlert[],
  page = 1,
  pageSize = 50,
  unfilteredTotal = alerts.length,
): PaginatedResponse<SlimAlert> {
  return {
    data: alerts.slice((page - 1) * pageSize, page * pageSize),
    pagination: {
      page,
      page_size: pageSize,
      total: alerts.length,
      total_pages: Math.ceil(alerts.length / pageSize),
      unfiltered_total: unfilteredTotal,
    },
    selectable_ids: alerts.map((alert) => alert.id),
  };
}

vi.mock('../contexts/useRefresh', () => ({
  useRefresh: () => ({
    refreshSignal: refreshSignalMock,
    setLastUpdated: setLastUpdatedMock,
  }),
}));

vi.mock('../lib/api', () => {
  const defaultAlerts = [
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
  ];

  const paginateAlerts = (
    alerts: typeof defaultAlerts,
    page = 1,
    pageSize = 50,
    unfilteredTotal = alerts.length,
  ) => ({
    data: alerts.slice((page - 1) * pageSize, page * pageSize),
    pagination: {
      page,
      page_size: pageSize,
      total: alerts.length,
      total_pages: Math.ceil(alerts.length / pageSize),
      unfiltered_total: unfilteredTotal,
    },
    selectable_ids: alerts.map((alert) => alert.id),
  });

  return {
    fetchAlertsPaginated: vi.fn(async (page: number, pageSize: number, filters?: Record<string, string>) => {
      let alerts = defaultAlerts;
      if (filters?.simulation === 'simulated') {
        alerts = alerts.filter((alert) => alert.simulated === true);
      }
      if (filters?.ip) {
        alerts = alerts.filter((alert) => {
          const source = alert.source?.ip || alert.source?.value || alert.source?.range || '';
          return source.toLowerCase().includes(filters.ip.toLowerCase());
        });
      }
      if (filters?.scenario) {
        alerts = alerts.filter((alert) => (alert.scenario || '').includes(filters.scenario));
      }
      return paginateAlerts(alerts, page, pageSize, defaultAlerts.length);
    }),
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
  };
});

afterEach(() => {
  refreshSignalMock = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function installControlledIntersectionObserver() {
  let triggerIntersection: (() => void) | undefined;

  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) {
      triggerIntersection = () => {
        callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      };
    }

    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  });

  return () => triggerIntersection?.();
}

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

    await waitFor(() => expect(screen.getByText('Showing 1 of 1 alerts (3 total before filters)')).toBeInTheDocument());
    expect(screen.getByRole('columnheader', { name: 'IP / Range' })).toBeInTheDocument();
    expect(screen.getAllByText('192.168.5.0/24')).toHaveLength(2);
    expect(screen.queryByText('1.2.3.4')).not.toBeInTheDocument();
  });

  test('shows loaded alert count when server filters still have more pages', async () => {
    const filteredAlerts = Array.from({ length: 55 }, (_, index) => ({
      id: index + 1,
      created_at: `2026-03-24T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
      scenario: 'filtered/scenario',
      source: { ip: `10.0.0.${index + 1}`, value: `10.0.0.${index + 1}`, cn: 'DE', as_name: 'Hetzner' },
      target: 'ssh',
      meta_search: 'filtered',
      decisions: [],
    }));
    vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedAlerts(filteredAlerts, page, pageSize, 60),
    );

    render(
      <MemoryRouter initialEntries={['/alerts?scenario=filtered/scenario']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Showing 50 of 55 alerts (60 total before filters)')).toBeInTheDocument());
    expect(screen.queryByText('10.0.0.55')).not.toBeInTheDocument();
  });

  test('loads the first alert page once when StrictMode replays mount effects', async () => {
    const alerts = [
      {
        id: 1,
        created_at: '2026-03-23T10:00:00.000Z',
        scenario: 'crowdsecurity/ssh-bf',
        source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
        target: 'ssh',
        meta_search: 'ssh',
        decisions: [],
      },
    ];
    const fetchAlertsPaginatedMock = vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedAlerts(alerts, page, pageSize, alerts.length),
    );
    fetchAlertsPaginatedMock.mockClear();

    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/alerts']}>
          <Alerts />
        </MemoryRouter>
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    expect(fetchAlertsPaginatedMock.mock.calls.filter(([page]) => page === 1)).toHaveLength(1);
  });

  test('auto-refresh preserves the already loaded alert pages', async () => {
    const triggerIntersection = installControlledIntersectionObserver();
    const pagedAlerts = Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      created_at: `2026-03-24T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
      scenario: 'paged/scenario',
      source: { ip: `10.1.0.${index + 1}`, value: `10.1.0.${index + 1}`, cn: 'DE', as_name: 'Hetzner' },
      target: 'ssh',
      meta_search: 'paged',
      decisions: [],
    }));
    const fetchAlertsPaginatedMock = vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedAlerts(pagedAlerts, page, pageSize, pagedAlerts.length),
    );

    const { rerender } = render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Showing 50 of 120 alerts')).toBeInTheDocument());

    await act(async () => {
      triggerIntersection();
    });

    await waitFor(() => expect(screen.getByText('Showing 100 of 120 alerts')).toBeInTheDocument());
    expect(screen.getByText('10.1.0.100')).toBeInTheDocument();

    const callCountBeforeRefresh = fetchAlertsPaginatedMock.mock.calls.length;
    refreshSignalMock = 1;

    rerender(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(fetchAlertsPaginatedMock.mock.calls.length).toBeGreaterThanOrEqual(callCountBeforeRefresh + 2));
    expect(fetchAlertsPaginatedMock.mock.calls.slice(callCountBeforeRefresh, callCountBeforeRefresh + 2).map(([page]) => page)).toEqual([1, 2]);
    expect(screen.getByText('Showing 100 of 120 alerts')).toBeInTheDocument();
    expect(screen.getByText('10.1.0.100')).toBeInTheDocument();
    expect(screen.queryByText('10.1.0.101')).not.toBeInTheDocument();
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
    vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedAlerts(bulkAlerts, page, pageSize, bulkAlerts.length),
    );
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
