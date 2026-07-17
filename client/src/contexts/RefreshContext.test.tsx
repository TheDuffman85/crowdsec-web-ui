import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RefreshProvider } from './RefreshContext';
import { useRefresh } from './useRefresh';
import { fetchConfig } from '../lib/api';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];
  static autoOpen = true;

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (!MockWebSocket.autoOpen || this.readyState !== MockWebSocket.CONNECTING) return;
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    });
  }

  close(): void {
    if (this.readyState >= MockWebSocket.CLOSING) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

vi.mock('../lib/api', () => ({
  fetchConfig: vi.fn(async () => ({
    lookback_period: '1h',
    lookback_hours: 1,
    lookback_days: 1,
    refresh_interval: 5000,
    current_interval_name: '5s',
    lapi_status: { isConnected: true, lastCheck: null, lastError: null, offline_since: null },
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
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  MockWebSocket.instances = [];
  MockWebSocket.autoOpen = true;
  vi.stubGlobal('WebSocket', MockWebSocket);
});

function Consumer() {
  const { intervalMs, lastUpdated, refreshSignal, syncStatus, setIntervalMs } = useRefresh();

  return (
    <div>
      <span data-testid="interval">{intervalMs}</span>
      <span data-testid="refresh">{refreshSignal}</span>
      <span data-testid="last-updated">{lastUpdated?.toISOString() || 'never'}</span>
      <span data-testid="sync">{syncStatus?.message}</span>
      <button type="button" onClick={() => void setIntervalMs(30000).catch(() => undefined)}>
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

function ManualRefreshConsumer() {
  const { refreshNow, syncStatus } = useRefresh();

  return (
    <div>
      <span data-testid="manual-sync">{syncStatus?.message}</span>
      <button type="button" onClick={() => void refreshNow?.('full')}>full-refresh</button>
    </div>
  );
}

describe('RefreshContext', () => {
  test('shows historical sync status immediately while a full refresh runs', async () => {
    let releaseRefresh: ((response: Response) => void) | null = null;
    const fetchSpy = vi.fn(async () => new Promise<Response>((resolve) => {
      releaseRefresh = resolve;
    }));
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <RefreshProvider>
        <ManualRefreshConsumer />
      </RefreshProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('manual-sync')).toHaveTextContent('done'));
    await userEvent.click(screen.getByRole('button', { name: 'full-refresh' }));
    expect(screen.getByTestId('manual-sync')).toHaveTextContent('Starting historical data sync...');
    expect(fetchSpy).toHaveBeenCalledWith('/api/cache/refresh', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ mode: 'full' }),
    }));

    const release = releaseRefresh as unknown;
    if (typeof release !== 'function') throw new Error('Refresh request was not held');
    release(Response.json({ success: true }));
    await waitFor(() => expect(screen.getByTestId('manual-sync')).toHaveTextContent('done'));
  });

  test('uses the backend cache revision for the last refresh time', async () => {
    vi.mocked(fetchConfig).mockResolvedValueOnce({
      ...await vi.mocked(fetchConfig)(),
      cache_last_update: '2026-07-17T07:59:00.000Z',
    });

    render(
      <RefreshProvider>
        <Consumer />
      </RefreshProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('last-updated')).toHaveTextContent('2026-07-17T07:59:00.000Z'));
  });

  test('refreshes immediately when the backend publishes a completed cache update', async () => {
    render(
      <RefreshProvider>
        <Consumer />
      </RefreshProvider>,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    expect(MockWebSocket.instances[0].url).toBe('ws://localhost:3000/api/cache-updates');
    act(() => MockWebSocket.instances[0].emit({ type: 'ready', updated_at: '2026-07-17T08:00:00.000Z' }));
    expect(screen.getByTestId('refresh')).toHaveTextContent('0');
    expect(screen.getByTestId('last-updated')).toHaveTextContent('2026-07-17T08:00:00.000Z');

    act(() => MockWebSocket.instances[0].emit({ type: 'cache-updated', updated_at: '2026-07-17T08:01:00.000Z' }));
    await waitFor(() => expect(screen.getByTestId('refresh')).toHaveTextContent('1'));
    expect(screen.getByTestId('last-updated')).toHaveTextContent('2026-07-17T08:01:00.000Z');
  });

  test('keeps the interval fallback active while the WebSocket is open', async () => {
    vi.useFakeTimers();
    render(
      <RefreshProvider>
        <Consumer />
      </RefreshProvider>,
    );

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.OPEN);
    expect(screen.getByTestId('interval')).toHaveTextContent('5000');

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByTestId('refresh')).toHaveTextContent('1');
    vi.useRealTimers();
  });

  test('times out stalled sockets and retries with bounded backoff', async () => {
    vi.useFakeTimers();
    MockWebSocket.autoOpen = false;

    render(
      <RefreshProvider>
        <Consumer />
      </RefreshProvider>,
    );

    expect(MockWebSocket.instances).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.CLOSED);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.useRealTimers();
  });

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
      lapi_status: { isConnected: true, lastCheck: null, lastError: null, offline_since: null },
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
      lapi_status: { isConnected: true, lastCheck: null, lastError: null, offline_since: null },
      simulations_enabled: true,
      machine_features_enabled: false,
      origin_features_enabled: false,
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));

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
        lapi_status: { isConnected: true, lastCheck: null, lastError: null, offline_since: null },
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
