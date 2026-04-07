import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Dashboard } from './Dashboard';

const {
  chartSpy,
  mapSpy,
  fetchConfigMock,
  fetchDashboardStatsMock,
} = vi.hoisted(() => ({
  chartSpy: vi.fn(),
  mapSpy: vi.fn(),
  fetchConfigMock: vi.fn(),
  fetchDashboardStatsMock: vi.fn(),
}));

vi.mock('../contexts/useRefresh', () => ({
  useRefresh: () => ({
    refreshSignal: 0,
    setLastUpdated: vi.fn(),
  }),
}));

vi.mock('../components/DashboardCharts', () => ({
  ActivityBarChart: (props: unknown) => {
    chartSpy(props);
    return <div>Chart</div>;
  },
}));

vi.mock('../components/WorldMapCard', () => ({
  WorldMapCard: (props: unknown) => {
    mapSpy(props);
    return <div>Map</div>;
  },
}));

vi.mock('../lib/api', () => ({
  fetchConfig: fetchConfigMock,
  fetchDashboardStats: fetchDashboardStatsMock,
}));

function buildDashboardStatsResponse(filters?: Record<string, string>) {
  const simulation = filters?.simulation || 'all';
  const liveAlertCount = simulation === 'simulated' ? 0 : 1;
  const simulatedAlertCount = simulation === 'live' ? 0 : 1;
  const liveDecisionCount = simulation === 'simulated' ? 0 : 1;
  const simulatedDecisionCount = simulation === 'live' ? 0 : 1;
  const allAlertCount = liveAlertCount + simulatedAlertCount;
  const bucket = {
    date: filters?.granularity === 'hour' ? '2026-04-07T10' : '2026-04-07',
    fullDate: '2026-04-07T10:00:00.000Z',
  };

  return {
    totals: {
      alerts: 2,
      decisions: 1,
      simulatedAlerts: 1,
      simulatedDecisions: 1,
    },
    filteredTotals: {
      alerts: allAlertCount,
      decisions: liveDecisionCount,
      simulatedAlerts: simulatedAlertCount,
      simulatedDecisions: simulatedDecisionCount,
    },
    globalTotal: allAlertCount,
    topTargets: liveAlertCount ? [{ label: 'ssh', count: liveAlertCount }] : [],
    topCountries: liveAlertCount ? [{ label: 'Germany', value: 'DE', countryCode: 'DE', count: liveAlertCount }] : [],
    allCountries: [
      {
        label: 'Germany',
        countryCode: 'DE',
        count: allAlertCount,
        liveCount: liveAlertCount,
        simulatedCount: simulatedAlertCount,
      },
    ],
    topScenarios: liveAlertCount ? [{ label: 'crowdsecurity/ssh-bf', count: liveAlertCount }] : [],
    topAS: liveAlertCount ? [{ label: 'Hetzner', count: liveAlertCount }] : [],
    series: {
      alertsHistory: [{ ...bucket, count: liveAlertCount }],
      simulatedAlertsHistory: [{ ...bucket, count: simulatedAlertCount }],
      decisionsHistory: [{ ...bucket, count: liveDecisionCount }],
      simulatedDecisionsHistory: [{ ...bucket, count: simulatedDecisionCount }],
      unfilteredAlertsHistory: [{ ...bucket, count: liveAlertCount }],
      unfilteredSimulatedAlertsHistory: [{ ...bucket, count: simulatedAlertCount }],
      unfilteredDecisionsHistory: [{ ...bucket, count: liveDecisionCount }],
      unfilteredSimulatedDecisionsHistory: [{ ...bucket, count: simulatedDecisionCount }],
    },
  };
}

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
  chartSpy.mockClear();
  mapSpy.mockClear();
  fetchDashboardStatsMock.mockClear();
  fetchConfigMock.mockResolvedValue({
    lookback_period: '7d',
    lookback_hours: 168,
    lookback_days: 7,
    refresh_interval: 30000,
    current_interval_name: '30s',
    lapi_status: { isConnected: true, lastCheck: null, lastError: null },
    sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
    simulations_enabled: true,
    machine_features_enabled: false,
  });
  fetchDashboardStatsMock.mockImplementation(async (filters?: Record<string, string>) => buildDashboardStatsResponse(filters));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Dashboard page', () => {
  test('shows simulation counts separately and passes simulation series to chart and map when enabled', async () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Active Decisions')).toBeInTheDocument());
    const alertsCard = screen.getByText('Total Alerts').closest('a');
    expect(alertsCard).not.toBeNull();
    expect(within(alertsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('2');
    expect(within(alertsCard as HTMLElement).getByText('Simulation')).toBeInTheDocument();
    expect(within(alertsCard as HTMLElement).getByText('1')).toBeInTheDocument();

    const decisionsCard = screen.getByText('Active Decisions').closest('a');
    expect(decisionsCard).not.toBeNull();
    expect(decisionsCard).toHaveAttribute('href', '/decisions');
    expect(within(decisionsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('2');
    expect(within(decisionsCard as HTMLElement).getByText('Simulation')).toBeInTheDocument();

    await waitFor(() => expect(chartSpy).toHaveBeenCalled());
    await waitFor(() => expect(mapSpy).toHaveBeenCalled());

    const chartProps = chartSpy.mock.calls.at(-1)?.[0] as {
      simulationsEnabled?: boolean;
      simulatedAlertsData?: Array<{ count: number }>;
      simulatedDecisionsData?: Array<{ count: number }>;
    };
    expect(chartProps.simulationsEnabled).toBe(true);
    expect(chartProps.simulatedAlertsData?.some((item) => item.count === 1)).toBe(true);
    expect(chartProps.simulatedDecisionsData?.some((item) => item.count === 1)).toBe(true);

    const mapProps = mapSpy.mock.calls.at(-1)?.[0] as {
      simulationsEnabled?: boolean;
      data?: Array<{ simulatedCount?: number }>;
    };
    expect(mapProps.simulationsEnabled).toBe(true);
    expect(mapProps.data?.some((item) => item.simulatedCount === 1)).toBe(true);
  });

  test('updates the headline totals when the mode filter changes', async () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Total Alerts')).toBeInTheDocument());

    const alertsCard = screen.getByText('Total Alerts').closest('a');
    const decisionsCard = screen.getByText('Active Decisions').closest('a');
    expect(alertsCard).not.toBeNull();
    expect(decisionsCard).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Live' }));
    await waitFor(() => expect(within(alertsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('1'));
    await waitFor(() => expect(within(decisionsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('1'));
    expect(within(alertsCard as HTMLElement).queryByText('Simulation')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Simulation' }));
    await waitFor(() => expect(within(alertsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('1'));
    await waitFor(() => expect(within(decisionsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('1'));
    expect(within(decisionsCard as HTMLElement).queryByText('Simulation')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(within(alertsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('2'));
    await waitFor(() => expect(within(decisionsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('2'));
    expect(within(alertsCard as HTMLElement).getByText('Simulation')).toBeInTheDocument();
  });

  test('hides simulation labels and series when simulations are disabled', async () => {
    fetchConfigMock.mockResolvedValue({
      lookback_period: '7d',
      lookback_hours: 168,
      lookback_days: 7,
      refresh_interval: 30000,
      current_interval_name: '30s',
      lapi_status: { isConnected: true, lastCheck: null, lastError: null },
      sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
      simulations_enabled: false,
      machine_features_enabled: false,
    });

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Total Alerts')).toBeInTheDocument());
    expect(screen.queryByText('Simulation')).not.toBeInTheDocument();

    const chartProps = chartSpy.mock.calls.at(-1)?.[0] as { simulationsEnabled?: boolean };
    const mapProps = mapSpy.mock.calls.at(-1)?.[0] as { simulationsEnabled?: boolean };
    expect(chartProps.simulationsEnabled).toBe(false);
    expect(mapProps.simulationsEnabled).toBe(false);
  });

  test('restores the saved activity chart scale mode and defaults to linear', async () => {
    localStorage.setItem('dashboard_scale_mode', 'symlog');

    const { unmount } = render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(chartSpy).toHaveBeenCalled());

    const savedScaleProps = chartSpy.mock.calls.at(-1)?.[0] as {
      scaleMode?: 'linear' | 'symlog';
    };
    expect(savedScaleProps.scaleMode).toBe('symlog');

    unmount();
    chartSpy.mockClear();
    localStorage.removeItem('dashboard_scale_mode');

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(chartSpy).toHaveBeenCalled());

    const defaultScaleProps = chartSpy.mock.calls.at(-1)?.[0] as {
      scaleMode?: 'linear' | 'symlog';
    };
    expect(defaultScaleProps.scaleMode).toBe('linear');
  });
});
