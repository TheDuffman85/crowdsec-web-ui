import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Decisions } from './Decisions';

vi.mock('../contexts/useRefresh', () => ({
  useRefresh: () => ({
    refreshSignal: 0,
    setLastUpdated: vi.fn(),
  }),
}));

vi.mock('../lib/api', () => ({
  addDecision: vi.fn(),
  deleteDecision: vi.fn(),
  fetchConfig: vi.fn(async () => ({
    lookback_period: '1h',
    lookback_hours: 1,
    lookback_days: 1,
    refresh_interval: 30000,
    current_interval_name: '30s',
    lapi_status: { isConnected: true, lastCheck: null, lastError: null },
    sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
    simulations_enabled: true,
  })),
}));

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json([
      {
        id: 10,
        created_at: '2026-03-23T10:00:00.000Z',
        value: '1.2.3.4',
        expired: false,
        is_duplicate: false,
        simulated: false,
        detail: {
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
        value: '5.6.7.8',
        expired: false,
        is_duplicate: false,
        simulated: true,
        detail: {
          reason: 'crowdsecurity/nginx-bf',
          country: 'US',
          as: 'AWS',
          action: 'ban',
          duration: '4h',
          alert_id: 2,
        },
      },
    ])),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

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
});
