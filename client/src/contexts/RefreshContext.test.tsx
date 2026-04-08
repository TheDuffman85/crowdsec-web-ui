import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RefreshProvider } from './RefreshContext';
import { useRefresh } from './useRefresh';
import { fetchConfig } from '../lib/api';

vi.mock('../lib/api', () => ({
  fetchConfig: vi.fn(async () => ({
    lookback_period: '1h',
    lookback_hours: 1,
    lookback_days: 1,
    refresh_interval: 5000,
    current_interval_name: '5s',
    lapi_status: { isConnected: true, lastCheck: null, lastError: null },
    sync_status: {
      isSyncing: false,
      progress: 100,
      message: 'done',
      startedAt: null,
      completedAt: null,
    },
    simulations_enabled: true,
    machine_features_enabled: false,
    origin_features_enabled: false,
  })),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

function Consumer() {
  const { intervalMs, refreshSignal, syncStatus, setIntervalMs } = useRefresh();

  return (
    <div>
      <span data-testid="interval">{intervalMs}</span>
      <span data-testid="refresh">{refreshSignal}</span>
      <span data-testid="sync">{syncStatus?.message}</span>
      <button type="button" onClick={() => void setIntervalMs(30000)}>
        update
      </button>
    </div>
  );
}

function IntervalConsumer({ value }: { value: number }) {
  const { setIntervalMs } = useRefresh();

  return (
    <button type="button" onClick={() => void setIntervalMs(value)}>
      set-{value}
    </button>
  );
}

describe('RefreshContext', () => {
  test('loads config and updates interval via API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          new_interval_ms: 30000,
        }),
      ),
    );

    render(
      <RefreshProvider>
        <Consumer />
      </RefreshProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('interval')).toHaveTextContent('5000'));
    expect(screen.getByTestId('sync')).toHaveTextContent('done');

    await userEvent.click(screen.getByRole('button', { name: 'update' }));
    await waitFor(() => expect(screen.getByTestId('interval')).toHaveTextContent('30000'));
  });

  test('polls while syncing and logs update failures without crashing', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce({
      refresh_interval: 1000,
      sync_status: {
        isSyncing: true,
        progress: 50,
        message: 'syncing',
        startedAt: null,
        completedAt: null,
      },
      lookback_period: '1h',
      lookback_hours: 1,
      lookback_days: 1,
      current_interval_name: '5s',
      lapi_status: { isConnected: true, lastCheck: null, lastError: null },
      simulations_enabled: true,
      machine_features_enabled: false,
      origin_features_enabled: false,
    }).mockResolvedValueOnce({
      refresh_interval: 1000,
      sync_status: {
        isSyncing: false,
        progress: 100,
        message: 'done',
        startedAt: null,
        completedAt: null,
      },
      lookback_period: '1h',
      lookback_hours: 1,
      lookback_days: 1,
      current_interval_name: '5s',
      lapi_status: { isConnected: true, lastCheck: null, lastError: null },
      simulations_enabled: true,
      machine_features_enabled: false,
      origin_features_enabled: false,
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));

    render(
      <RefreshProvider>
        <Consumer />
      </RefreshProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('sync')).toHaveTextContent('syncing'));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await waitFor(() => expect(Number(screen.getByTestId('refresh').textContent)).toBeGreaterThan(0));

    await userEvent.click(screen.getByRole('button', { name: 'update' }));
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
  });

  test('logs config load failures and supports 5m interval updates', async () => {
    vi.mocked(fetchConfig).mockRejectedValueOnce(new Error('boom'));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = vi.fn(async (_input, init) => {
      expect(init?.body).toBe(JSON.stringify({ interval: '5m' }));
      return Response.json({ new_interval_ms: 300000 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <RefreshProvider>
        <IntervalConsumer value={300000} />
      </RefreshProvider>,
    );

    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith('Failed to load config', expect.any(Error)));
    await userEvent.click(screen.getByRole('button', { name: 'set-300000' }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
  });

  test('handles missing config fields and all interval names', async () => {
    vi.mocked(fetchConfig)
      .mockResolvedValueOnce(null as unknown as Awaited<ReturnType<typeof fetchConfig>>)
      .mockResolvedValueOnce({
        lookback_period: '1h',
        lookback_hours: 1,
        lookback_days: 1,
        current_interval_name: 'off',
        lapi_status: { isConnected: true, lastCheck: null, lastError: null },
        simulations_enabled: true,
        machine_features_enabled: false,
        origin_features_enabled: false,
      } as unknown as Awaited<ReturnType<typeof fetchConfig>>);

    const fetchSpy = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { interval: string };
      return Response.json({ new_interval_ms: body.interval === '0' ? 0 : 1234 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const firstRender = render(
      <RefreshProvider>
        <Consumer />
      </RefreshProvider>,
    );
    await waitFor(() => expect(fetchConfig).toHaveBeenCalledTimes(1));
    firstRender.unmount();

    render(
      <RefreshProvider>
        <IntervalConsumer value={5000} />
        <IntervalConsumer value={60000} />
        <IntervalConsumer value={0} />
      </RefreshProvider>,
    );

    await waitFor(() => expect(fetchConfig).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole('button', { name: 'set-5000' }));
    await userEvent.click(screen.getByRole('button', { name: 'set-60000' }));
    await userEvent.click(screen.getByRole('button', { name: 'set-0' }));

    expect(fetchSpy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { interval: '5s' },
      { interval: '1m' },
      { interval: '0' },
    ]);
  });

  test('throws when used outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => render(<Consumer />)).toThrow('useRefresh must be used within RefreshProvider');
    spy.mockRestore();
  });
});
