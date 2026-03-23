import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Dashboard } from './Dashboard';

const {
  chartSpy,
  mapSpy,
  fetchConfigMock,
  fetchAlertsForStatsMock,
  fetchDecisionsForStatsMock,
} = vi.hoisted(() => ({
  chartSpy: vi.fn(),
  mapSpy: vi.fn(),
  fetchConfigMock: vi.fn(),
  fetchAlertsForStatsMock: vi.fn(),
  fetchDecisionsForStatsMock: vi.fn(),
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
  fetchAlertsForStats: fetchAlertsForStatsMock,
  fetchDecisionsForStats: fetchDecisionsForStatsMock,
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
  chartSpy.mockClear();
  mapSpy.mockClear();
  fetchConfigMock.mockResolvedValue({
    lookback_period: '7d',
    lookback_hours: 168,
    lookback_days: 7,
    refresh_interval: 30000,
    current_interval_name: '30s',
    lapi_status: { isConnected: true, lastCheck: null, lastError: null },
    sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
    simulations_enabled: true,
  });
  fetchAlertsForStatsMock.mockResolvedValue([
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
  ]);
  fetchDecisionsForStatsMock.mockResolvedValue([
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
  ]);
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
    expect(within(alertsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('1');
    expect(within(decisionsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('1');
    expect(within(alertsCard as HTMLElement).queryByText('Simulation')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Simulation' }));
    expect(within(alertsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('1');
    expect(within(decisionsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('1');
    expect(within(decisionsCard as HTMLElement).queryByText('Simulation')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(within(alertsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('2');
    expect(within(decisionsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('2');
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
});
