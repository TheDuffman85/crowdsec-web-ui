import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as api from '../lib/api';
import { Decisions } from './Decisions';

const setLastUpdatedMock = vi.fn();

vi.mock('../contexts/useRefresh', () => ({
  useRefresh: () => ({
    refreshSignal: 0,
    setLastUpdated: setLastUpdatedMock,
  }),
}));

vi.mock('../lib/api', () => ({
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
}));

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json([
      {
        id: 10,
        created_at: '2026-03-23T10:00:00.000Z',
        machine: 'host-a',
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
        machine: 'machine-2',
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

  test('select all excludes expired decisions from bulk delete', async () => {
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
          id: 30,
          created_at: '2026-03-23T12:00:00.000Z',
          value: '9.9.9.9',
          expired: true,
          is_duplicate: false,
          simulated: false,
          detail: {
            reason: 'crowdsecurity/http-probing',
            country: 'FR',
            as: 'OVH',
            action: 'ban',
            duration: '-5m',
            alert_id: 3,
          },
        },
      ])),
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
