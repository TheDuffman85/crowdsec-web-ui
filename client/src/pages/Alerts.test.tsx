import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { DecisionListItem, PaginatedResponse, SlimAlert } from '../types';
import * as api from '../lib/api';
import { Alerts } from './Alerts';
import { compileAlertSearch } from '../../../shared/search';

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

function toPaginatedDecisions(
  decisions: DecisionListItem[],
  page = 1,
  pageSize = 50,
): PaginatedResponse<DecisionListItem> {
  return {
    data: decisions.slice((page - 1) * pageSize, page * pageSize),
    pagination: {
      page,
      page_size: pageSize,
      total: decisions.length,
      total_pages: Math.ceil(decisions.length / pageSize),
      unfiltered_total: decisions.length,
    },
    selectable_ids: decisions
      .filter((decision) => !decision.expired && !(decision.detail.duration || '').startsWith('-'))
      .map((decision) => decision.id),
  };
}

vi.mock('../contexts/useRefresh', () => ({
  useRefresh: () => ({
    refreshSignal: refreshSignalMock,
    setLastUpdated: setLastUpdatedMock,
  }),
}));

vi.mock('../lib/api', () => {
  const defaultAlerts: SlimAlert[] = [
    {
      id: 1,
      created_at: '2026-03-23T10:00:00.000Z',
      scenario: 'crowdsecurity/ssh-bf',
      machine_id: 'machine-1',
      machine_alias: 'host-a',
      source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
      target: 'ssh',
      meta_search: 'ssh',
      decisions: [{ id: 10, value: '1.2.3.4', type: 'ban', origin: 'manual', simulated: false, expired: false }],
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
      decisions: [{ id: 20, value: '5.6.7.8', type: 'ban', origin: 'CAPI', simulated: true, expired: false }],
    },
    {
      id: 14302,
      created_at: '2026-03-24T19:47:52.000Z',
      scenario: 'manual/web-ui',
      source: { range: '192.168.5.0/24', cn: 'Unknown', as_name: 'Local Network' },
      target: 'manual',
      meta_search: '192.168.5.0/24 localhost',
      decisions: [{ id: 14302, value: '192.168.5.0/24', type: 'ban', origin: 'cscli', simulated: false, expired: false }],
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
      if (filters?.q) {
        const compiledSearch = compileAlertSearch(filters.q, {
          machineEnabled: true,
          originEnabled: true,
        });
        if (!compiledSearch.ok) {
          throw new Error(compiledSearch.error.message);
        }
        alerts = alerts.filter(compiledSearch.predicate);
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
    fetchDecisionsPaginated: vi.fn(async (_page: number, pageSize: number, filters?: Record<string, string>) => {
      const alertId = filters?.alert_id;
      const matchingAlert = defaultAlerts.find((alert) => String(alert.id) === alertId) || defaultAlerts[0];
      const decisions: DecisionListItem[] = (matchingAlert.decisions || []).map((decision) => ({
        id: decision.id,
        created_at: matchingAlert.created_at,
        machine: matchingAlert.machine_alias || matchingAlert.machine_id,
        value: decision.value,
        expired: decision.expired === true,
        is_duplicate: false,
        simulated: decision.simulated === true,
        detail: {
          origin: decision.origin || 'manual',
          type: decision.type,
          reason: matchingAlert.scenario,
          action: decision.type,
          country: matchingAlert.source?.cn,
          as: matchingAlert.source?.as_name,
          duration: decision.id === 14302 ? '30m' : '4h',
          expiration: '2030-01-01T00:00:00.000Z',
          alert_id: matchingAlert.id,
        },
      }));
      return toPaginatedDecisions(decisions, 1, pageSize);
    }),
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
      origin_features_enabled: false,
    })),
  };
});

afterEach(() => {
  refreshSignalMock = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function installControlledIntersectionObserver() {
  const callbacks: Array<() => void> = [];

  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) {
      callbacks.push(() => {
        callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      });
    }

    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  });

  return () => callbacks.forEach((callback) => callback());
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
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
    expect(screen.queryByRole('columnheader', { name: 'Origin' })).not.toBeInTheDocument();
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
      origin_features_enabled: false,
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

  test('shows origin column, renders mixed origins, and filters alerts by origin when enabled', async () => {
    const originAlerts: SlimAlert[] = [
      {
        id: 1,
        created_at: '2026-03-23T10:00:00.000Z',
        scenario: 'crowdsecurity/ssh-bf',
        source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
        target: 'ssh',
        meta_search: 'ssh',
        decisions: [
          { id: 10, value: '1.2.3.4', type: 'ban', origin: 'manual', simulated: false, expired: false },
          { id: 11, value: '1.2.3.4', type: 'ban', origin: 'CAPI', simulated: false, expired: false },
        ],
      },
      {
        id: 2,
        created_at: '2026-03-23T11:00:00.000Z',
        scenario: 'crowdsecurity/nginx-bf',
        source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
        target: 'nginx',
        meta_search: 'nginx',
        decisions: [
          { id: 20, value: '5.6.7.8', type: 'ban', origin: 'crowdsec', simulated: false, expired: false },
        ],
      },
    ];

    vi.mocked(api.fetchConfig).mockResolvedValue({
      lookback_period: '1h',
      lookback_hours: 1,
      lookback_days: 1,
      refresh_interval: 30000,
      current_interval_name: '30s',
      lapi_status: { isConnected: true, lastCheck: null, lastError: null },
      sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
      simulations_enabled: true,
      machine_features_enabled: false,
      origin_features_enabled: true,
    });
    vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (page, pageSize, filters) => {
      const query = (filters?.q || '').toLowerCase();
      const filteredAlerts = query
        ? originAlerts.filter((alert) => alert.decisions.some((decision) => (decision.origin || '').toLowerCase().includes(query)))
        : originAlerts;
      return toPaginatedAlerts(filteredAlerts, page, pageSize, originAlerts.length);
    });

    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Origin' })).toBeInTheDocument());
    expect(screen.getByText('Mixed')).toBeInTheDocument();
    expect(screen.getByText('crowdsec')).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('Filter alerts...'), 'capi');

    await waitFor(() => expect(screen.getByText('Mixed')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('crowdsec')).not.toBeInTheDocument());
  });

  test('supports advanced field search and shows the active search badge', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    const input = screen.getByPlaceholderText('Filter alerts...');
    await userEvent.type(input, 'country:germany');

    await waitFor(() => expect(screen.getByText('country:germany')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('5.6.7.8')).not.toBeInTheDocument());
  });

  test('supports date comparisons in advanced alert search', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    const input = screen.getByPlaceholderText('Filter alerts...');
    await userEvent.type(input, 'date>=2026-03-24');

    await waitFor(() => expect(screen.getByText('date>=2026-03-24')).toBeInTheDocument());
    expect(screen.queryByText(/Search syntax error/i)).not.toBeInTheDocument();
  });

  test('opens the alert search syntax help modal', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Search syntax help' }));

    expect(screen.getByRole('dialog', { name: 'Alert Search Syntax' })).toBeInTheDocument();
    expect(screen.getByText('origin:(manual OR CAPI) AND -sim:simulated')).toBeInTheDocument();
  });

  test('clicking an alert syntax example fills the search input', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Search syntax help' }));
    await userEvent.click(screen.getByRole('button', { name: /country:germany ssh/i }));

    await waitFor(() => expect(screen.getByPlaceholderText('Filter alerts...')).toHaveValue('country:germany ssh'));
  });

  test('clicking alert fields and operators inserts snippets into the search input', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Search syntax help' }));
    await userEvent.click(screen.getByRole('button', { name: 'Insert field date' }));
    await userEvent.click(screen.getByRole('button', { name: 'Search syntax help' }));
    await userEvent.click(screen.getByRole('button', { name: /^>=/ }));

    const input = screen.getByPlaceholderText('Filter alerts...');
    expect(input).toHaveValue('date>=');

    await userEvent.type(input, '2026-03-24');

    await waitFor(() => expect(screen.getByPlaceholderText('Filter alerts...')).toHaveValue('date>=2026-03-24'));
    await waitFor(() => expect(screen.getByText('date>=2026-03-24')).toBeInTheDocument());
  });

  test('reset all filters clears an advanced alert query without restoring it', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    const input = screen.getByPlaceholderText('Filter alerts...');
    await userEvent.type(input, 'country:germany AND target:ssh');

    await waitFor(() => expect(screen.queryByText('5.6.7.8')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Reset all filters' }));

    await waitFor(() => expect(screen.getByPlaceholderText('Filter alerts...')).toHaveValue(''));
    await waitFor(() => expect(screen.getByText('5.6.7.8')).toBeInTheDocument());
  });

  test('keeps the alerts table mounted while debounced search is loading and keeps the summary mounted', async () => {
    const user = userEvent.setup();
    const alerts: SlimAlert[] = [
      {
        id: 1,
        created_at: '2026-03-23T10:00:00.000Z',
        scenario: 'crowdsecurity/ssh-bf',
        source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
        target: 'ssh',
        meta_search: 'ssh',
        decisions: [],
      },
      {
        id: 2,
        created_at: '2026-03-23T11:00:00.000Z',
        scenario: 'crowdsecurity/nginx-bf',
        source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
        target: 'nginx',
        meta_search: 'aws',
        decisions: [],
      },
    ];
    const deferred = createDeferred<PaginatedResponse<SlimAlert>>();

    vi.mocked(api.fetchAlertsPaginated).mockImplementation((page, pageSize, filters) => {
      if (filters?.q === 'aws') {
        return deferred.promise;
      }

      return Promise.resolve(toPaginatedAlerts(alerts, page, pageSize, alerts.length));
    });

    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    const summary = screen.getByTestId('alerts-summary');
    expect(summary).toHaveTextContent('Showing 2 of 2 alerts');

    const input = screen.getByPlaceholderText('Filter alerts...');
    await user.clear(input);
    await user.type(input, 'aws');

    expect(summary).toBeInTheDocument();
    expect(screen.getByText('1.2.3.4')).toBeInTheDocument();
    expect(screen.queryByText('Loading alerts...')).not.toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    expect(screen.getByText('1.2.3.4')).toBeInTheDocument();
    expect(screen.queryByText('Loading alerts...')).not.toBeInTheDocument();

    deferred.resolve(toPaginatedAlerts([alerts[1]], 1, 50, alerts.length));

    await waitFor(() => expect(screen.queryByText('1.2.3.4')).not.toBeInTheDocument());
    expect(screen.getByText('5.6.7.8')).toBeInTheDocument();
    expect(summary).toHaveTextContent('Showing 1 of 1 alerts (2 total before filters)');
  });

  test('renders and filters range-only alerts by CIDR source value', async () => {
    vi.mocked(api.fetchConfig).mockResolvedValue({
      lookback_period: '1h',
      lookback_hours: 1,
      lookback_days: 1,
      refresh_interval: 30000,
      current_interval_name: '30s',
      lapi_status: { isConnected: true, lastCheck: null, lastError: null },
      sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
      simulations_enabled: true,
      machine_features_enabled: false,
      origin_features_enabled: false,
    });
    vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (page, pageSize, filters) => {
      const rangeAlerts: SlimAlert[] = [
        {
          id: 1,
          created_at: '2026-03-23T10:00:00.000Z',
          scenario: 'crowdsecurity/ssh-bf',
          source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
          target: 'ssh',
          meta_search: 'ssh',
          decisions: [{ id: 10, value: '1.2.3.4', type: 'ban', origin: 'manual', simulated: false, expired: false }],
        },
        {
          id: 2,
          created_at: '2026-03-23T11:00:00.000Z',
          scenario: 'crowdsecurity/nginx-bf',
          source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
          target: 'nginx',
          meta_search: 'nginx',
          decisions: [{ id: 20, value: '5.6.7.8', type: 'ban', origin: 'CAPI', simulated: false, expired: false }],
        },
        {
          id: 14302,
          created_at: '2026-03-24T19:47:52.000Z',
          scenario: 'manual/web-ui',
          source: { range: '192.168.5.0/24', cn: 'Unknown', as_name: 'Local Network' },
          target: 'manual',
          meta_search: '192.168.5.0/24 localhost',
          decisions: [{ id: 14302, value: '192.168.5.0/24', type: 'ban', origin: 'cscli', simulated: false, expired: false }],
        },
      ];
      const filteredAlerts = filters?.ip
        ? rangeAlerts.filter((alert) => (alert.source?.ip || alert.source?.value || alert.source?.range || '').toLowerCase().includes(filters.ip.toLowerCase()))
        : rangeAlerts;
      return toPaginatedAlerts(filteredAlerts, page, pageSize, rangeAlerts.length);
    });

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
    const triggerIntersection = installControlledIntersectionObserver();
    vi.mocked(api.fetchConfig).mockResolvedValue({
      lookback_period: '1h',
      lookback_hours: 1,
      lookback_days: 1,
      refresh_interval: 30000,
      current_interval_name: '30s',
      lapi_status: { isConnected: true, lastCheck: null, lastError: null },
      sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
      simulations_enabled: true,
      machine_features_enabled: false,
      origin_features_enabled: false,
    });
    vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedAlerts([
        {
          id: 1,
          created_at: '2026-03-23T11:00:00.000Z',
          scenario: 'crowdsecurity/community-blocklist',
          source: { value: 'community-blocklist' },
          target: 'blocklist',
          meta_search: 'community-blocklist',
          decisions: [],
        },
      ], page, pageSize, 1),
    );
    const fetchAlertMock = vi.mocked(api.fetchAlert);
    fetchAlertMock.mockResolvedValueOnce({
      id: 1,
      created_at: '2026-03-23T11:00:00.000Z',
      scenario: 'crowdsecurity/community-blocklist',
      source: { value: 'community-blocklist' },
      decisions: [],
      events: [],
    });
    vi.mocked(api.fetchDecisionsPaginated).mockImplementation(async (page, pageSize, filters) => {
      expect(filters).toEqual(expect.objectContaining({
        alert_id: '1',
        include_expired: 'true',
      }));

      const decisions: DecisionListItem[] = largeDecisionList.map((decision) => ({
        id: decision.id,
        created_at: '2026-03-23T11:00:00.000Z',
        value: decision.value,
        expired: false,
        is_duplicate: false,
        simulated: false,
        detail: {
          origin: decision.origin || 'CAPI',
          type: decision.type,
          reason: 'crowdsecurity/community-blocklist',
          action: decision.type,
          duration: decision.duration,
          expiration: '2030-01-01T00:00:00.000Z',
          alert_id: 1,
        },
      }));

      return toPaginatedDecisions(decisions, page, pageSize);
    });

    render(
      <MemoryRouter initialEntries={['/alerts?id=1']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Alert Details #1')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Showing 50 of 75')).toBeInTheDocument());
    expect(screen.getByText('#1000')).toBeInTheDocument();
    expect(screen.queryByText('#1074')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load 50 more decisions/i })).not.toBeInTheDocument();

    await act(async () => {
      triggerIntersection();
    });

    await waitFor(() => expect(screen.getByText('#1074')).toBeInTheDocument());
  });

  test('refreshes alert detail decisions for the same open alert during data refresh', async () => {
    const fetchAlertMock = vi.mocked(api.fetchAlert);
    fetchAlertMock
      .mockResolvedValueOnce({
        id: 1,
        created_at: '2026-03-23T11:00:00.000Z',
        scenario: 'crowdsecurity/ssh-bf',
        source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
        target: 'ssh',
        message: 'Initial alert',
        simulated: false,
        decisions: [{ id: 10, value: '1.2.3.4', type: 'ban', simulated: false, expired: false }],
        events: [],
      })
      .mockResolvedValueOnce({
        id: 1,
        created_at: '2026-03-23T11:00:00.000Z',
        scenario: 'crowdsecurity/ssh-bf',
        source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
        target: 'ssh',
        message: 'Refreshed alert',
        simulated: false,
        decisions: [
          { id: 10, value: '1.2.3.4', type: 'ban', simulated: false, expired: false },
          { id: 11, value: '1.2.3.4', type: 'ban', simulated: false, expired: false },
        ],
        events: [],
      });

    let decisionIds = [10];
    const fetchDecisionsPaginatedMock = vi.mocked(api.fetchDecisionsPaginated).mockImplementation(async (_page, pageSize, filters) => {
      const decisions: DecisionListItem[] = decisionIds.map((id) => ({
        id,
        created_at: '2026-03-23T11:00:00.000Z',
        machine: 'host-a',
        value: '1.2.3.4',
        expired: false,
        is_duplicate: false,
        simulated: false,
        detail: {
          origin: 'manual',
          type: 'ban',
          reason: 'crowdsecurity/ssh-bf',
          action: 'ban',
          country: 'DE',
          as: 'Hetzner',
          duration: '4h',
          expiration: '2030-01-01T00:00:00.000Z',
          alert_id: Number(filters?.alert_id || 1),
        },
      }));

      return toPaginatedDecisions(decisions, 1, pageSize);
    });

    const { rerender } = render(
      <MemoryRouter initialEntries={['/alerts?id=1']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Alert Details #1')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('#10')).toBeInTheDocument());
    expect(screen.queryByText('#11')).not.toBeInTheDocument();

    decisionIds = [10, 11];
    refreshSignalMock = 1;

    rerender(
      <MemoryRouter initialEntries={['/alerts?id=1']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('#11')).toBeInTheDocument());
    expect(fetchDecisionsPaginatedMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchDecisionsPaginatedMock.mock.calls.at(-1)?.[2]).toEqual(expect.objectContaining({
      alert_id: '1',
      include_expired: 'true',
    }));
  });

  test('preserves loaded decision pages during same-alert detail refresh', async () => {
    const triggerIntersection = installControlledIntersectionObserver();
    vi.mocked(api.fetchAlert).mockResolvedValue({
      id: 1,
      created_at: '2026-03-23T11:00:00.000Z',
      scenario: 'crowdsecurity/community-blocklist',
      source: { value: 'community-blocklist' },
      decisions: [],
      events: [],
    });

    const fetchDecisionsPaginatedMock = vi.mocked(api.fetchDecisionsPaginated).mockImplementation(async (page, pageSize, filters) => {
      expect(filters).toEqual(expect.objectContaining({
        alert_id: '1',
        include_expired: 'true',
      }));

      const decisions: DecisionListItem[] = largeDecisionList.map((decision) => ({
        id: decision.id,
        created_at: '2026-03-23T11:00:00.000Z',
        value: decision.value,
        expired: false,
        is_duplicate: false,
        simulated: false,
        detail: {
          origin: decision.origin || 'CAPI',
          type: decision.type,
          reason: 'crowdsecurity/community-blocklist',
          action: decision.type,
          duration: decision.duration,
          expiration: '2030-01-01T00:00:00.000Z',
          alert_id: 1,
        },
      }));

      return toPaginatedDecisions(decisions, page, pageSize);
    });

    const { rerender } = render(
      <MemoryRouter initialEntries={['/alerts?id=1']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Showing 50 of 75')).toBeInTheDocument());

    await act(async () => {
      triggerIntersection();
    });

    await waitFor(() => expect(screen.getByText('#1074')).toBeInTheDocument());

    const callCountBeforeRefresh = fetchDecisionsPaginatedMock.mock.calls.length;
    refreshSignalMock = 1;

    rerender(
      <MemoryRouter initialEntries={['/alerts?id=1']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(fetchDecisionsPaginatedMock.mock.calls.length).toBeGreaterThanOrEqual(callCountBeforeRefresh + 2));
    expect(fetchDecisionsPaginatedMock.mock.calls.slice(callCountBeforeRefresh, callCountBeforeRefresh + 2).map(([page]) => page)).toEqual([1, 2]);
    expect(screen.getByText('#1074')).toBeInTheDocument();
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
