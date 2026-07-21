import { buildDashboardStatsResponse, chartSpy, createDeferred, fetchConfigMock, fetchDashboardStatsMock, mapSpy } from './harness';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from '../../Dashboard';
import { describe, expect, test } from 'vitest';

describe('Dashboard filters and drilldowns', () => {
  test.each([
    { connected: [true, true], status: 'All online', count: '2 of 2 online' },
    { connected: [true, false], status: 'Partial', count: '1 of 2 online' },
    { connected: [false, false], status: 'Offline', count: '0 of 2 online' },
  ])('shows aggregate LAPI status $status in All instances scope', async ({ connected, status, count }) => {
    const syncStatus = { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null };
    const lapiStatus = (isConnected: boolean) => ({ isConnected, lastCheck: null, lastError: null, offline_since: null });
    fetchConfigMock.mockResolvedValue({
      lookback_period: '7d',
      lookback_hours: 168,
      lookback_days: 7,
      refresh_interval: 30000,
      current_interval_name: '30s',
      lapi_status: lapiStatus(connected[0]),
      instances: [
        { id: 'primary', name: 'Primary', lapi_status: lapiStatus(connected[0]), sync_status: syncStatus, prometheus: [] },
        { id: 'secondary', name: 'Secondary', lapi_status: lapiStatus(connected[1]), sync_status: syncStatus, prometheus: [] },
      ],
      aggregate_lapi_status: connected.every(Boolean) ? 'healthy' : connected.some(Boolean) ? 'partial' : 'offline',
      sync_status: syncStatus,
      simulations_enabled: true,
      machine_features_enabled: false,
      origin_features_enabled: false,
    });

    render(
      <MemoryRouter initialEntries={['/?instance=all']}>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(status)).toBeInTheDocument());
    expect(screen.getByText('CrowdSec LAPIs')).toBeInTheDocument();
    expect(screen.getByText(count)).toBeInTheDocument();
  });

  test('shows only the selected instance LAPI status in instance scope', async () => {
    const syncStatus = { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null };
    const onlineStatus = { isConnected: true, lastCheck: null, lastError: null, offline_since: null };
    const offlineStatus = { isConnected: false, lastCheck: null, lastError: 'unavailable', offline_since: '2026-07-19T12:00:00.000Z' };
    fetchConfigMock.mockResolvedValue({
      lookback_period: '7d',
      lookback_hours: 168,
      lookback_days: 7,
      refresh_interval: 30000,
      current_interval_name: '30s',
      lapi_status: onlineStatus,
      instances: [
        { id: 'primary', name: 'Primary', lapi_status: onlineStatus, sync_status: syncStatus, prometheus: [] },
        { id: 'secondary', name: 'Secondary', lapi_status: offlineStatus, sync_status: syncStatus, prometheus: [] },
      ],
      aggregate_lapi_status: 'partial',
      sync_status: syncStatus,
      simulations_enabled: true,
      machine_features_enabled: false,
      origin_features_enabled: false,
    });

    render(
      <MemoryRouter initialEntries={['/?instance=secondary']}>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Offline')).toBeInTheDocument());
    expect(screen.getByText('CrowdSec LAPI')).toBeInTheDocument();
    expect(screen.queryByText(/of 2 online/)).not.toBeInTheDocument();
  });

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
      activeDecisionsData?: Array<{ count: number }>;
      activeSimulatedDecisionsData?: Array<{ count: number }>;
    };
    expect(chartProps.simulationsEnabled).toBe(true);
    expect(chartProps.simulatedAlertsData?.some((item) => item.count === 1)).toBe(true);
    expect(chartProps.simulatedDecisionsData?.some((item) => item.count === 1)).toBe(true);
    expect(chartProps.activeDecisionsData?.some((item) => item.count === 1)).toBe(true);
    expect(chartProps.activeSimulatedDecisionsData?.some((item) => item.count === 1)).toBe(true);

    const mapProps = mapSpy.mock.calls.at(-1)?.[0] as {
      simulationsEnabled?: boolean;
      attackLocations?: Array<{ latitude: number; longitude: number; count: number }>;
      data?: Array<{ simulatedCount?: number }>;
    };
    expect(mapProps.simulationsEnabled).toBe(true);
    expect(mapProps.attackLocations).toEqual([expect.objectContaining({ latitude: 52.52, longitude: 13.405, count: 2 })]);
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

  test('uses advanced search syntax for filtered drilldown links', async () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Top Countries')).toBeInTheDocument());

    await userEvent.click(screen.getByText('Germany'));
    await userEvent.click(screen.getByText('ssh-bf'));
    await userEvent.click(screen.getByText('Hetzner'));
    await userEvent.click(screen.getAllByText('ssh')[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Live' }));

    const alertsCard = screen.getByText('Total Alerts').closest('a');
    const decisionsCard = screen.getByText('Active Decisions').closest('a');
    expect(alertsCard).not.toBeNull();
    expect(decisionsCard).not.toBeNull();

    const alertsParams = new URLSearchParams((alertsCard as HTMLElement).getAttribute('href')?.split('?')[1] ?? '');
    const decisionsParams = new URLSearchParams((decisionsCard as HTMLElement).getAttribute('href')?.split('?')[1] ?? '');
    const expectedQuery = 'country:DE AND scenario:crowdsecurity/ssh-bf AND as:Hetzner AND target:ssh AND sim:live';

    expect(alertsParams.get('q')).toBe(expectedQuery);
    expect(decisionsParams.get('q')).toBe(expectedQuery);
    expect((alertsCard as HTMLElement).getAttribute('href')).not.toContain('country=');
    expect((decisionsCard as HTMLElement).getAttribute('href')).not.toContain('scenario=');
  });

  test('adds dashboard date ranges to drilldown search syntax', async () => {
    localStorage.setItem('dashboard_filters', JSON.stringify({
      dateRange: { start: '2026-03-29T01', end: '2026-03-29T03' },
      dateRangeSticky: true,
      country: 'DE',
      scenario: null,
      as: null,
      ip: null,
      target: null,
      simulation: 'all',
    }));

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Top Countries')).toBeInTheDocument());
    const alertsCard = screen.getByText('Total Alerts').closest('a');
    const decisionsCard = screen.getByText('Active Decisions').closest('a');
    const params = new URLSearchParams((alertsCard as HTMLElement).getAttribute('href')?.split('?')[1] ?? '');
    const decisionsParams = new URLSearchParams((decisionsCard as HTMLElement).getAttribute('href')?.split('?')[1] ?? '');
    const expectedQuery = 'country:DE AND date>=2026-03-29T01 AND date<=2026-03-29T03';

    expect(params.get('q')).toBe(expectedQuery);
    expect(decisionsParams.get('q')).toBe(expectedQuery);
    expect(params.get('dateStart')).toBeNull();
    expect(params.get('dateEnd')).toBeNull();
  });

  test('shows restored stale scenario filter as a selected zero-count row', async () => {
    localStorage.setItem('dashboard_filters', JSON.stringify({
      dateRange: null,
      dateRangeSticky: false,
      country: null,
      scenario: 'crowdsecurity/stale-scenario',
      as: null,
      ip: null,
      target: null,
      simulation: 'all',
    }));
    fetchDashboardStatsMock.mockResolvedValue({
      ...buildDashboardStatsResponse(),
      filteredTotals: {
        alerts: 0,
        decisions: 0,
        simulatedAlerts: 0,
        simulatedDecisions: 0,
      },
      globalTotal: 2,
      topTargets: [],
      topCountries: [],
      allCountries: [],
      attackLocations: [],
      topScenarios: [],
      topAS: [],
    });

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    const scenarioCard = await screen.findByText('Top Scenarios');
    const scenarioRow = screen.getByText('stale-scenario').closest('.cursor-pointer');
    expect(scenarioCard).toBeInTheDocument();
    expect(scenarioRow).not.toBeNull();
    expect(within(scenarioRow as HTMLElement).getByText('crowdsecurity')).toBeInTheDocument();
    expect(within(scenarioRow as HTMLElement).getByText('0')).toBeInTheDocument();
    expect(within(scenarioRow as HTMLElement).getByText('0.0%')).toBeInTheDocument();
  });

  test('shows restored stale country filter as a selected zero-count row and clears it on click', async () => {
    localStorage.setItem('dashboard_filters', JSON.stringify({
      dateRange: null,
      dateRangeSticky: false,
      country: 'FR',
      scenario: null,
      as: null,
      ip: null,
      target: null,
      simulation: 'all',
    }));
    fetchDashboardStatsMock.mockImplementation(async (filters?: Record<string, string>) => ({
      ...buildDashboardStatsResponse(filters),
      filteredTotals: {
        alerts: 0,
        decisions: 0,
        simulatedAlerts: 0,
        simulatedDecisions: 0,
      },
      globalTotal: 2,
      topTargets: [],
      topCountries: [],
      allCountries: [],
      attackLocations: [],
      topScenarios: [],
      topAS: [],
    }));

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(fetchDashboardStatsMock).toHaveBeenCalledWith(
      expect.objectContaining({ country: 'FR' }),
      expect.any(Object),
    ));

    const countryRow = await screen.findByText('FR');
    const countryRowContainer = countryRow.closest('.cursor-pointer');
    expect(countryRowContainer).not.toBeNull();
    expect(within(countryRowContainer as HTMLElement).getByText('0')).toBeInTheDocument();
    expect(within(countryRowContainer as HTMLElement).getByText('0.0%')).toBeInTheDocument();

    fetchDashboardStatsMock.mockClear();
    await userEvent.click(countryRow);

    await waitFor(() => expect(fetchDashboardStatsMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ country: expect.any(String) }),
      expect.any(Object),
    ));
  });

  test('scopes a stale scenario list to the selected scenario while filtered stats load', async () => {
    const pendingScenarioStats = createDeferred<ReturnType<typeof buildDashboardStatsResponse>>();
    fetchDashboardStatsMock.mockImplementation((filters?: Record<string, string>) => {
      if (filters?.scenario === 'crowdsecurity/vpatch-env-access') {
        return pendingScenarioStats.promise;
      }

      return Promise.resolve({
        ...buildDashboardStatsResponse(filters),
        filteredTotals: {
          alerts: 896,
          decisions: 0,
          simulatedAlerts: 0,
          simulatedDecisions: 0,
        },
        globalTotal: 896,
        topScenarios: [
          { label: 'crowdsecurity/vpatch-env-access', count: 894 },
          { label: 'crowdsecurity/vpatch-git-config', count: 2 },
        ],
      });
    });

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await screen.findByText('vpatch-env-access');
    expect(screen.getByText('vpatch-git-config')).toBeInTheDocument();

    await userEvent.click(screen.getByText('vpatch-env-access'));
    await waitFor(() => expect(fetchDashboardStatsMock).toHaveBeenCalledWith(
      expect.objectContaining({ scenario: 'crowdsecurity/vpatch-env-access' }),
      expect.any(Object),
    ));

    expect(screen.getByText('vpatch-env-access')).toBeInTheDocument();
    expect(screen.queryByText('vpatch-git-config')).not.toBeInTheDocument();

    pendingScenarioStats.resolve({
      ...buildDashboardStatsResponse({ scenario: 'crowdsecurity/vpatch-env-access' }),
      filteredTotals: {
        alerts: 894,
        decisions: 0,
        simulatedAlerts: 0,
        simulatedDecisions: 0,
      },
      globalTotal: 896,
      topScenarios: [{ label: 'crowdsecurity/vpatch-env-access', count: 894 }],
    });
    await waitFor(() => expect(screen.queryByText('vpatch-git-config')).not.toBeInTheDocument());
  });

  test('hides simulation labels and series when simulations are disabled', async () => {
    fetchConfigMock.mockResolvedValue({
      lookback_period: '7d',
      lookback_hours: 168,
      lookback_days: 7,
      refresh_interval: 30000,
      current_interval_name: '30s',
      lapi_status: { isConnected: true, lastCheck: null, lastError: null, offline_since: null },
      sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
      simulations_enabled: false,
      machine_features_enabled: false,
      origin_features_enabled: false,
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
