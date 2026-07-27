import { buildDashboardStatsResponse, chartSpy, createDeferred, fetchConfigMock, fetchDashboardStatsMock, mapSpy } from './harness';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from '../../Dashboard';
import { describe, expect, test } from 'vitest';
import { QUICK_FILTERS_STORAGE_KEY } from '../../../lib/quickFilters';

async function openSimulationQuickFilter() {
  await userEvent.click(screen.getByRole('button', { name: 'Filters' }));
  await userEvent.click(screen.getByRole('button', { name: 'Mode' }));
}

describe('Dashboard filters and drilldowns', () => {
  test('replaces the three drilldown controls with the shared quick-filter trigger', async () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await screen.findByText('Top Countries');
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveClass(
      'h-[38px]',
      'rounded-lg',
      'border-gray-100',
      'shadow-sm',
    );
    const statisticsHeading = screen.getByRole('heading', { name: 'Last 7 Days Statistics' });
    const searchButton = screen.getByRole('button', { name: 'Expand search' });
    const filtersButton = screen.getByRole('button', { name: 'Filters' });
    const toolbar = statisticsHeading.parentElement?.parentElement;
    expect(toolbar).toHaveClass('md:items-center');
    expect(toolbar).toContainElement(searchButton);
    expect(toolbar).toContainElement(filtersButton);
    expect(statisticsHeading.compareDocumentPosition(searchButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(searchButton.compareDocumentPosition(filtersButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(chartSpy).toHaveBeenCalled());
    const chartProps = chartSpy.mock.calls.at(-1)?.[0] as {
      percentageBasis: 'filtered' | 'global';
      setPercentageBasis: (basis: 'filtered' | 'global') => void;
    };
    expect(chartProps.percentageBasis).toBe('global');
    act(() => chartProps.setPercentageBasis('filtered'));
    await waitFor(() => {
      const latestChartProps = chartSpy.mock.calls.at(-1)?.[0] as {
        percentageBasis: 'filtered' | 'global';
      };
      expect(latestChartProps.percentageBasis).toBe('filtered');
    });
    expect(localStorage.getItem('dashboard_percentage_basis')).toBe('filtered');
    expect(screen.queryByRole('button', { name: 'Simulation' })).not.toBeInTheDocument();
    await openSimulationQuickFilter();
    const scenarioFilter = screen.getByRole('button', { name: 'Scenario' });
    const modeFilter = screen.getByRole('button', { name: 'Mode' });
    expect(scenarioFilter.compareDocumentPosition(modeFilter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'View Alerts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View Decisions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset Filters' })).not.toBeInTheDocument();
  });

  test('applies dashboard advanced search to alert and decision data', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await screen.findByText('Top Countries');
    fetchDashboardStatsMock.mockClear();
    await user.click(screen.getByRole('button', { name: 'Expand search' }));
    expect(screen.getByRole('button', { name: 'Collapse search' })).toHaveClass(
      'border-gray-300',
      'bg-white',
      'text-gray-600',
    );
    expect(screen.getByRole('button', { name: 'Collapse search' })).not.toHaveClass(
      'border-primary-500',
      'bg-primary-50',
      'text-primary-700',
    );
    await user.type(screen.getByPlaceholderText('Search'), 'country:DE');

    await waitFor(() => expect(fetchDashboardStatsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'country=DE',
        decision_q: 'country=DE',
      }),
      expect.any(Object),
    ));
    expect(screen.getByPlaceholderText('Search')).toHaveValue('country=DE');

    const alertsCard = screen.getByText('Total Alerts').closest('a');
    const decisionsCard = screen.getByText('Active Decisions').closest('a');
    expect(alertsCard).toHaveAttribute('href', '/alerts?q=country%3DDE');
    expect(decisionsCard).toHaveAttribute('href', '/decisions?q=country%3DDE');
  });

  test('shows quick-filter selections in search and opens dashboard syntax help', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await screen.findByText('Top Countries');
    await user.click(screen.getByText('Germany'));
    await user.click(screen.getByRole('button', { name: 'Expand search' }));

    expect(screen.getByPlaceholderText('Search')).toHaveValue('country=DE');
    await user.click(screen.getByRole('button', { name: 'Search syntax help' }));
    expect(screen.getByRole('heading', { name: 'Dashboard Search Syntax' })).toBeInTheDocument();
  });

  test('shows page-only filters in the unavailable section and allows clearing them', async () => {
    const user = userEvent.setup();
    localStorage.setItem(QUICK_FILTERS_STORAGE_KEY, JSON.stringify({
      selections: {
        action: { included: ['ban'], excluded: [] },
      },
      dateRange: { start: '', end: '' },
      simulation: 'all',
    }));

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await screen.findByText('Top Countries');
    await waitFor(() => expect(fetchDashboardStatsMock).toHaveBeenCalledWith(
      expect.objectContaining({ decision_q: 'action=ban' }),
      expect.any(Object),
    ));
    await user.click(screen.getByRole('button', { name: 'Filters' }));

    expect(screen.getByRole('heading', { name: 'Unavailable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decisions' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Action' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Expiration' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Alert' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Clear Action' }));
    await waitFor(() => expect(
      JSON.parse(localStorage.getItem(QUICK_FILTERS_STORAGE_KEY) || '{}').selections.action,
    ).toBeUndefined());
  });

  test('hydrates dashboard requests from shared quick-filter persistence', async () => {
    localStorage.setItem(QUICK_FILTERS_STORAGE_KEY, JSON.stringify({
      selections: {
        country: { included: ['DE', 'FR'], excluded: ['US'] },
        machine: { included: ['firewall-1'], excluded: [] },
      },
      dateRange: { start: '2026-04-01T10:00', end: '2026-04-02T10:00' },
      simulation: 'live',
    }));

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(fetchDashboardStatsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        q: '(country=DE OR country=FR) AND country<>US AND machine=firewall-1',
        decision_q: '(country=DE OR country=FR) AND country<>US AND machine=firewall-1',
        dateStart: '2026-04-01T10:00',
        dateEnd: '2026-04-02T10:00',
        simulation: 'live',
      }),
      expect.any(Object),
    ));
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveTextContent('7');
  });

  test('writes top-list selections to quick-filter persistence and reflects drawer changes', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await screen.findByText('Top Countries');
    await user.click(screen.getByText('Germany'));
    await waitFor(() => expect(fetchDashboardStatsMock).toHaveBeenCalledWith(
      expect.objectContaining({ country: 'DE', q: 'country=DE', decision_q: 'country=DE' }),
      expect.any(Object),
    ));
    expect(JSON.parse(localStorage.getItem(QUICK_FILTERS_STORAGE_KEY) || '{}').selections.country).toEqual({
      included: ['DE'],
      excluded: [],
    });

    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.click(screen.getByRole('button', { name: 'Country' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Toggle France in Country' }));

    await waitFor(() => expect(fetchDashboardStatsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'country=DE OR country=FR',
        decision_q: 'country=DE OR country=FR',
      }),
      expect.any(Object),
    ));
    expect(JSON.parse(localStorage.getItem(QUICK_FILTERS_STORAGE_KEY) || '{}').selections.country).toEqual({
      included: ['DE', 'FR'],
      excluded: [],
    });
  });

  test('keeps the activity-history range and quick-filter date range in sync', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(chartSpy).toHaveBeenCalled());
    const chartProps = chartSpy.mock.calls.at(-1)?.[0] as {
      onDateRangeSelect: (
        range: { start: string; end: string } | null,
        isAtEnd: boolean,
      ) => void;
    };
    act(() => {
      chartProps.onDateRangeSelect(
        { start: '2026-04-01T10:00', end: '2026-04-02T11:00' },
        true,
      );
    });

    await waitFor(() => expect(
      JSON.parse(localStorage.getItem(QUICK_FILTERS_STORAGE_KEY) || '{}').dateRange,
    ).toEqual({
      start: '2026-04-01T10:00',
      end: '2026-04-02T11:00',
    }));

    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.click(screen.getByRole('button', { name: 'Date and time' }));
    fireEvent.change(screen.getByLabelText('From'), {
      target: { value: '2026-04-01T12:00' },
    });

    await waitFor(() => {
      const latestChartProps = chartSpy.mock.calls.at(-1)?.[0] as {
        selectedDateRange: { start: string; end: string } | null;
        isSticky: boolean;
      };
      expect(latestChartProps.selectedDateRange).toEqual({
        start: '2026-04-01T12:00',
        end: '2026-04-02T11:00',
      });
      expect(latestChartProps.isSticky).toBe(false);
    });
  });

  test('keeps an explicit advanced-search till boundary fixed', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(chartSpy).toHaveBeenCalled());
    const chartProps = chartSpy.mock.calls.at(-1)?.[0] as {
      onDateRangeSelect: (
        range: { start: string; end: string } | null,
        isAtEnd: boolean,
      ) => void;
    };
    act(() => {
      chartProps.onDateRangeSelect(
        { start: '2026-04-01T10:00', end: '2026-04-07T10:00' },
        true,
      );
    });
    await waitFor(() => {
      const latestChartProps = chartSpy.mock.calls.at(-1)?.[0] as { isSticky: boolean };
      expect(latestChartProps.isSticky).toBe(true);
    });

    await user.click(screen.getByRole('button', { name: 'Expand search' }));
    fireEvent.change(screen.getByPlaceholderText('Search'), {
      target: {
        value: 'date>=2026-04-01T10:00 AND date<=2026-04-02T11:00',
      },
    });

    await waitFor(() => {
      const latestChartProps = chartSpy.mock.calls.at(-1)?.[0] as {
        selectedDateRange: { start: string; end: string } | null;
        isSticky: boolean;
      };
      expect(latestChartProps.selectedDateRange).toEqual({
        start: '2026-04-01T10:00',
        end: '2026-04-02T11:00',
      });
      expect(latestChartProps.isSticky).toBe(false);
    });
  });

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

    await openSimulationQuickFilter();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Toggle Simulation in Mode' }));
    await waitFor(() => expect(within(alertsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('1'));
    await waitFor(() => expect(within(decisionsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('1'));
    expect(within(alertsCard as HTMLElement).queryByText('Simulation')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Toggle Simulation in Mode' }));
    await waitFor(() => expect(within(alertsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('2'));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Toggle Live in Mode' }));
    await waitFor(() => expect(within(alertsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('1'));
    await waitFor(() => expect(within(decisionsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('1'));
    expect(within(decisionsCard as HTMLElement).queryByText('Simulation')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Toggle Live in Mode' }));
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
    await openSimulationQuickFilter();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Toggle Simulation in Mode' }));

    const alertsCard = screen.getByText('Total Alerts').closest('a');
    const decisionsCard = screen.getByText('Active Decisions').closest('a');
    expect(alertsCard).not.toBeNull();
    expect(decisionsCard).not.toBeNull();

    const alertsParams = new URLSearchParams((alertsCard as HTMLElement).getAttribute('href')?.split('?')[1] ?? '');
    const decisionsParams = new URLSearchParams((decisionsCard as HTMLElement).getAttribute('href')?.split('?')[1] ?? '');
    const expectedQuery = 'scenario=crowdsecurity/ssh-bf AND country=DE AND as=Hetzner AND target=ssh AND sim=live';

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
    const expectedQuery = 'country=DE AND date>=2026-03-29T01 AND date<=2026-03-29T03';

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
