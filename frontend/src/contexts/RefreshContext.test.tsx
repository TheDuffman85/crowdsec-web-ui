import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RefreshProvider, useRefresh } from './RefreshContext';
import { fetchConfig } from '../lib/api';

vi.mock('../lib/api', () => ({
  fetchConfig: vi.fn(async () => ({
    refresh_interval: 5000,
    sync_status: {
      isSyncing: false,
      progress: 100,
      message: 'done',
      startedAt: null,
      completedAt: null,
    },
  })),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
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

  test('throws when used outside the provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => render(<Consumer />)).toThrow('useRefresh must be used within RefreshProvider');
    spy.mockRestore();
  });
});
