import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { DecisionListItem, PaginatedResponse } from '../types';
import * as api from '../lib/api';
import { Decisions } from './Decisions';

const setLastUpdatedMock = vi.fn();
let refreshSignalMock = 0;

function toPaginatedDecisions(
  decisions: DecisionListItem[],
  page = 1,
  pageSize = 50,
  unfilteredTotal = decisions.length,
): PaginatedResponse<DecisionListItem> {
  return {
    data: decisions.slice((page - 1) * pageSize, page * pageSize),
    pagination: {
      page,
      page_size: pageSize,
      total: decisions.length,
      total_pages: Math.ceil(decisions.length / pageSize),
      unfiltered_total: unfilteredTotal,
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
  const defaultDecisions = [
    {
      id: 10,
      created_at: '2026-03-23T10:00:00.000Z',
      machine: 'host-a',
      value: '1.2.3.4',
      expired: false,
      is_duplicate: false,
      simulated: false,
      detail: {
        origin: 'CAPI',
        reason: 'crowdsecurity/ssh-bf',
        country: 'DE',
        as: 'Hetzner',
        action: 'ban',
        duration: '4h',
        alert_id: 1,
      },
    },
    {
      id: 20,
      created_at: '2026-03-23T11:00:00.000Z',
      machine: 'machine-2',
      value: '5.6.7.8',
      expired: false,
      is_duplicate: false,
      simulated: true,
      detail: {
        origin: 'CAPI',
        reason: 'crowdsecurity/nginx-bf',
        country: 'US',
        as: 'AWS',
        action: 'ban',
        duration: '4h',
        alert_id: 2,
      },
    },
  ];

  const paginateDecisions = (
    decisions: typeof defaultDecisions,
    page = 1,
    pageSize = 50,
    unfilteredTotal = decisions.length,
  ) => ({
    data: decisions.slice((page - 1) * pageSize, page * pageSize),
    pagination: {
      page,
      page_size: pageSize,
      total: decisions.length,
      total_pages: Math.ceil(decisions.length / pageSize),
      unfiltered_total: unfilteredTotal,
    },
    selectable_ids: decisions
      .filter((decision) => !decision.expired && !(decision.detail.duration || '').startsWith('-'))
      .map((decision) => decision.id),
  });

  return {
    fetchDecisionsPaginated: vi.fn(async (page: number, pageSize: number, filters?: Record<string, string>) => {
      let decisions = defaultDecisions;
      if (filters?.simulation === 'simulated') {
        decisions = decisions.filter((decision) => decision.simulated === true);
      }
      if (filters?.q) {
        const query = filters.q.toLowerCase();
        decisions = decisions.filter((decision) => [
          decision.value,
          decision.machine,
          decision.detail.reason,
          decision.detail.country,
          decision.detail.as,
          decision.detail.action,
          decision.simulated === true ? 'simulation simulated' : 'live',
        ].some((value) => (value || '').toLowerCase().includes(query)));
      }
      return paginateDecisions(decisions, page, pageSize, defaultDecisions.length);
    }),
    addDecision: vi.fn(),
    deleteDecision: vi.fn(),
    bulkDeleteDecisions: vi.fn(async () => ({
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

describe('Decisions page', () => {
  test('filters to simulated decisions and shows the simulation badge inline in the scenario column', async () => {
    render(
      <MemoryRouter initialEntries={['/decisions?simulation=simulated']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('5.6.7.8')).toBeInTheDocument());
    expect(screen.queryByText('1.2.3.4')).not.toBeInTheDocument();
    expect(screen.getAllByText('Simulation').length).toBeGreaterThan(0);
    expect(screen.queryByText('Mode')).not.toBeInTheDocument();
  });

  test('keeps machine column hidden when the feature flag is disabled', async () => {
    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    expect(screen.queryByRole('columnheader', { name: 'Machine' })).not.toBeInTheDocument();
  });

  test('shows machine column and allows filtering by machine when enabled', async () => {
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

    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Machine' })).toBeInTheDocument());
    expect(screen.getByText('host-a')).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('Filter decisions...'), 'host-a');
    expect(screen.getByText('1.2.3.4')).toBeInTheDocument();
    expect(screen.queryByText('5.6.7.8')).not.toBeInTheDocument();
  });

  test('shows loaded decision count when server filters still have more pages', async () => {
    const filteredDecisions = Array.from({ length: 313 }, (_, index) => ({
      id: index + 1,
      created_at: `2026-03-24T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
      value: `10.0.0.${index + 1}`,
      expired: false,
      is_duplicate: false,
      simulated: false,
      detail: {
        origin: 'CAPI',
        reason: 'crowdsecurity/http-probing',
        country: 'DE',
        as: 'Hetzner',
        action: 'ban',
        duration: '4h',
        alert_id: index + 1,
      },
    }));
    vi.mocked(api.fetchDecisionsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedDecisions(filteredDecisions, page, pageSize, 314),
    );

    render(
      <MemoryRouter initialEntries={['/decisions?include_expired=true']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Showing 50 of 313 decisions (314 total before filters)')).toBeInTheDocument());
    expect(screen.queryByText('10.0.0.313')).not.toBeInTheDocument();
  });

  test('loads the first decision page once when StrictMode replays mount effects', async () => {
    const decisions = [
      {
        id: 10,
        created_at: '2026-03-23T10:00:00.000Z',
        value: '1.2.3.4',
        expired: false,
        is_duplicate: false,
        simulated: false,
        detail: {
          origin: 'CAPI',
          reason: 'crowdsecurity/ssh-bf',
          country: 'DE',
          as: 'Hetzner',
          action: 'ban',
          duration: '4h',
          alert_id: 1,
        },
      },
    ];
    const fetchDecisionsPaginatedMock = vi.mocked(api.fetchDecisionsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedDecisions(decisions, page, pageSize, decisions.length),
    );
    fetchDecisionsPaginatedMock.mockClear();

    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/decisions']}>
          <Decisions />
        </MemoryRouter>
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    expect(fetchDecisionsPaginatedMock.mock.calls.filter(([page]) => page === 1)).toHaveLength(1);
  });

  test('auto-refresh preserves the already loaded decision pages', async () => {
    const triggerIntersection = installControlledIntersectionObserver();
    const pagedDecisions = Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      created_at: `2026-03-24T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
      value: `10.1.0.${index + 1}`,
      expired: false,
      is_duplicate: false,
      simulated: false,
      detail: {
        origin: 'CAPI',
        reason: 'crowdsecurity/http-probing',
        country: 'DE',
        as: 'Hetzner',
        action: 'ban',
        duration: '4h',
        alert_id: index + 1,
      },
    }));
    const fetchDecisionsPaginatedMock = vi.mocked(api.fetchDecisionsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedDecisions(pagedDecisions, page, pageSize, pagedDecisions.length),
    );

    const { rerender } = render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Showing 50 of 120 decisions')).toBeInTheDocument());

    await act(async () => {
      triggerIntersection();
    });

    await waitFor(() => expect(screen.getByText('Showing 100 of 120 decisions')).toBeInTheDocument());
    expect(screen.getByText('10.1.0.100')).toBeInTheDocument();

    const callCountBeforeRefresh = fetchDecisionsPaginatedMock.mock.calls.length;
    refreshSignalMock = 1;

    rerender(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(fetchDecisionsPaginatedMock.mock.calls.length).toBeGreaterThanOrEqual(callCountBeforeRefresh + 2));
    expect(fetchDecisionsPaginatedMock.mock.calls.slice(callCountBeforeRefresh, callCountBeforeRefresh + 2).map(([page]) => page)).toEqual([1, 2]);
    expect(screen.getByText('Showing 100 of 120 decisions')).toBeInTheDocument();
    expect(screen.getByText('10.1.0.100')).toBeInTheDocument();
    expect(screen.queryByText('10.1.0.101')).not.toBeInTheDocument();
  });

  test('select all excludes expired decisions from bulk delete', async () => {
    vi.mocked(api.fetchDecisionsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedDecisions([
        {
          id: 10,
          created_at: '2026-03-23T10:00:00.000Z',
          value: '1.2.3.4',
          expired: false,
          is_duplicate: false,
          simulated: false,
          detail: {
            origin: 'CAPI',
            reason: 'crowdsecurity/ssh-bf',
            country: 'DE',
            as: 'Hetzner',
            action: 'ban',
            duration: '4h',
            alert_id: 1,
          },
        },
        {
          id: 30,
          created_at: '2026-03-23T12:00:00.000Z',
          value: '9.9.9.9',
          expired: true,
          is_duplicate: false,
          simulated: false,
          detail: {
            origin: 'CAPI',
            reason: 'crowdsecurity/http-probing',
            country: 'FR',
            as: 'OVH',
            action: 'ban',
            duration: '-5m',
            alert_id: 3,
          },
        },
      ], page, pageSize),
    );
    const bulkDeleteDecisionsMock = vi.mocked(api.bulkDeleteDecisions).mockResolvedValue({
      requested_alerts: 0,
      requested_decisions: 1,
      deleted_alerts: 0,
      deleted_decisions: 1,
      failed: [],
    });

    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    const deleteSelectedButton = screen.getByRole('button', { name: 'Delete selected' });
    expect(deleteSelectedButton).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all filtered decisions' }));
    expect(deleteSelectedButton).toBeEnabled();
    await userEvent.click(deleteSelectedButton);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(bulkDeleteDecisionsMock).toHaveBeenCalledWith(['10']));
  });

  test('delete all for this IP triggers cross-resource cleanup', async () => {
    const cleanupByIpMock = vi.mocked(api.cleanupByIp).mockResolvedValue({
      requested_alerts: 1,
      requested_decisions: 1,
      deleted_alerts: 1,
      deleted_decisions: 1,
      failed: [],
      ip: '1.2.3.4',
    });

    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    await userEvent.click(screen.getAllByRole('button', { name: 'Delete all alerts and decisions for 1.2.3.4' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(cleanupByIpMock).toHaveBeenCalledWith('1.2.3.4'));
  });
});
