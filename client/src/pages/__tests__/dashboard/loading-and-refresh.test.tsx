import { buildDashboardStatsResponse, chartSpy, createDeferred, fetchDashboardStatsMock, setLastUpdatedMock, setRefreshSignalMock } from './harness';
import { StrictMode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from '../../Dashboard';
import { describe, expect, test } from 'vitest';

describe('Dashboard loading and refresh', () => {
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

  test('keeps dashboard cards and visualizations mounted while filter refresh is in flight', async () => {
    const deferred = createDeferred<ReturnType<typeof buildDashboardStatsResponse>>();
    fetchDashboardStatsMock.mockImplementation((filters?: Record<string, string>) => {
      if (filters?.simulation === 'live') {
        return deferred.promise;
      }

      return Promise.resolve(buildDashboardStatsResponse(filters));
    });

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Total Alerts')).toBeInTheDocument());
    expect(screen.getByText('Chart')).toBeInTheDocument();
    expect(screen.getByText('Map')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Live' }));

    expect(screen.getByText('Chart')).toBeInTheDocument();
    expect(screen.getByText('Map')).toBeInTheDocument();
    expect(screen.queryByText('Loading statistics...')).not.toBeInTheDocument();
    expect(screen.getByText('Refreshing dashboard...')).toBeInTheDocument();

    const chartControls = screen.getByText('Chart').closest('[aria-disabled="true"]');
    const statisticControls = screen.getByText('Top Countries').closest('[aria-disabled="true"]');
    expect(chartControls).not.toBeNull();
    expect(chartControls).not.toHaveClass('opacity-70');
    expect(chartControls).not.toHaveClass('transition-opacity');
    expect(statisticControls).not.toBeNull();
    expect(statisticControls).not.toHaveClass('opacity-70');
    expect(statisticControls).not.toHaveClass('transition-opacity');
    expect(screen.getByRole('button', { name: 'Live' })).not.toHaveClass('disabled:opacity-60');

    deferred.resolve(buildDashboardStatsResponse({ simulation: 'live' }));

    await waitFor(() => {
      const alertsCard = screen.getByText('Total Alerts').closest('a');
      expect(alertsCard).not.toBeNull();
      expect(within(alertsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('1');
    });
  });

  test('prevents another filter change until the current filter has been applied', async () => {
    const pendingLiveStats = createDeferred<ReturnType<typeof buildDashboardStatsResponse>>();
    fetchDashboardStatsMock.mockImplementation((filters?: Record<string, string>) => {
      if (filters?.simulation === 'live') {
        return pendingLiveStats.promise;
      }

      return Promise.resolve(buildDashboardStatsResponse(filters));
    });

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Total Alerts')).toBeInTheDocument());
    fetchDashboardStatsMock.mockClear();

    await userEvent.click(screen.getByRole('button', { name: 'Live' }));
    await waitFor(() => expect(fetchDashboardStatsMock).toHaveBeenCalledWith(
      expect.objectContaining({ simulation: 'live' }),
      expect.any(Object),
    ));

    expect(screen.getByRole('button', { name: 'All' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Live' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Simulation' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Simulation' }));
    expect(fetchDashboardStatsMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ simulation: 'simulated' }),
      expect.any(Object),
    );

    pendingLiveStats.resolve(buildDashboardStatsResponse({ simulation: 'live' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Simulation' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Simulation' }));

    await waitFor(() => expect(fetchDashboardStatsMock).toHaveBeenCalledWith(
      expect.objectContaining({ simulation: 'simulated' }),
      expect.any(Object),
    ));
  });

  test('retries the initial dashboard load after a strict mode abort cleanup', async () => {
    const pendingRequests: Array<{ resolve: (value: ReturnType<typeof buildDashboardStatsResponse>) => void }> = [];
    fetchDashboardStatsMock.mockImplementation((_filters?: Record<string, string>, init?: RequestInit) => (
      new Promise((resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }

        pendingRequests.push({
          resolve: (value) => resolve(value),
        });
      })
    ));

    render(
      <StrictMode>
        <MemoryRouter>
          <Dashboard />
        </MemoryRouter>
      </StrictMode>,
    );

    await waitFor(() => expect(fetchDashboardStatsMock).toHaveBeenCalledTimes(2));

    const latestRequest = pendingRequests.at(-1);
    expect(latestRequest).toBeDefined();
    latestRequest?.resolve(buildDashboardStatsResponse());

    await waitFor(() => expect(screen.getByText('Total Alerts')).toBeInTheDocument());
  });

  test('retries pending dashboard statistics without remounting the page', async () => {
    const readyStats = createDeferred<ReturnType<typeof buildDashboardStatsResponse>>();
    fetchDashboardStatsMock
      .mockResolvedValueOnce({
        ...buildDashboardStatsResponse(),
        pending: true,
        retryAfterMs: 1,
        totals: {
          alerts: 0,
          decisions: 0,
          simulatedAlerts: 0,
          simulatedDecisions: 0,
        },
        filteredTotals: {
          alerts: 0,
          decisions: 0,
          simulatedAlerts: 0,
          simulatedDecisions: 0,
        },
        topCountries: [],
        topScenarios: [],
        topAS: [],
        topTargets: [],
      })
      .mockReturnValueOnce(readyStats.promise);

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(fetchDashboardStatsMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Loading dashboard...')).toBeInTheDocument();
    expect(screen.queryByText('Total Alerts')).not.toBeInTheDocument();
    readyStats.resolve(buildDashboardStatsResponse());
    const alertsCard = await screen.findByText('Total Alerts');
    expect(within(alertsCard.closest('a') as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('2');
    expect(setLastUpdatedMock).not.toHaveBeenCalled();
  });

  test('reloads dashboard totals for a cache refresh even inside the duplicate-request window', async () => {
    const { rerender } = render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    const alertsLabel = await screen.findByText('Total Alerts');
    expect(within(alertsLabel.closest('a') as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('2');

    fetchDashboardStatsMock.mockResolvedValue({
      ...buildDashboardStatsResponse(),
      totals: {
        alerts: 5,
        decisions: 3,
        simulatedAlerts: 2,
        simulatedDecisions: 2,
      },
    });
    setRefreshSignalMock(1);
    rerender(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(within(screen.getByText('Total Alerts').closest('a') as HTMLElement)
        .getByRole('heading', { level: 3 })).toHaveTextContent('5');
    });
    expect(fetchDashboardStatsMock).toHaveBeenCalledTimes(2);
  });

  test('does not trigger a duplicate dashboard load when filters change after a refresh signal', async () => {
    setRefreshSignalMock(1);
    const completedLiveLoads: Array<Record<string, string> | undefined> = [];
    fetchDashboardStatsMock.mockImplementation((filters?: Record<string, string>, init?: RequestInit) => (
      new Promise((resolve, reject) => {
        const signal = init?.signal;
        const finishRequest = () => {
          if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }

          completedLiveLoads.push(filters);
          resolve(buildDashboardStatsResponse(filters));
        };

        if (signal) {
          if (signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }

        queueMicrotask(finishRequest);
      })
    ));

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Total Alerts')).toBeInTheDocument());
    fetchDashboardStatsMock.mockClear();
    completedLiveLoads.length = 0;
    await userEvent.click(screen.getByRole('button', { name: 'Live' }));

    await waitFor(() => {
      const alertsCard = screen.getByText('Total Alerts').closest('a');
      expect(alertsCard).not.toBeNull();
      expect(within(alertsCard as HTMLElement).getByRole('heading', { level: 3 })).toHaveTextContent('1');
    });

    expect(completedLiveLoads).toHaveLength(1);
    expect(completedLiveLoads[0]).toMatchObject({ simulation: 'live' });
  });
});
