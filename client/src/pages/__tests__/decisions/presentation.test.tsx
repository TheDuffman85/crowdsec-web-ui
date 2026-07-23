import { chineseI18nValue, flushDecisionSearchDebounce, getVisibleColumnHeaderNames, toPaginatedDecisions } from './harness';
import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../../../lib/api';
import { Decisions } from '../../Decisions';
import { I18nContext } from '../../../lib/i18n';

describe('Decisions page presentation and columns', () => {
  test('hides enforcement actions in read-only mode', async () => {
    vi.mocked(api.fetchConfig).mockResolvedValue({
      lookback_period: '1h',
      lookback_hours: 1,
      lookback_days: 1,
      refresh_interval: 30000,
      current_interval_name: '30s',
      lapi_status: { isConnected: true, lastCheck: null, lastError: null, offline_since: null },
      sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
      simulations_enabled: true,
      machine_features_enabled: false,
      origin_features_enabled: false,
      permissions: {
        mode: 'read-only',
        can_manage_enforcement: false,
      },
    });

    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: 'Add Decision' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete selected' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose decision table columns' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Add Decision' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete selected' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose decision table columns' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Decision' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete all alerts and decisions for/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Select all loaded decisions')).not.toBeInTheDocument();
  });

  test('localizes country names in the decisions table', async () => {
    render(
      <I18nContext.Provider value={chineseI18nValue}>
        <MemoryRouter initialEntries={['/decisions']}>
          <Decisions />
        </MemoryRouter>
      </I18nContext.Provider>,
    );

    await waitFor(() => expect(screen.getByText('德国')).toBeInTheDocument());
    expect(screen.getByText('美国')).toBeInTheDocument();
    expect(screen.queryByText('Germany')).not.toBeInTheDocument();
    expect(screen.queryByText('United States')).not.toBeInTheDocument();
  });

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

  test('keeps optional columns hidden by default', async () => {
    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    expect(screen.queryByRole('columnheader', { name: 'ID' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Machine' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Origin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Region' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'City' })).not.toBeInTheDocument();
    expect(screen.queryByText('Berlin')).not.toBeInTheDocument();
    expect(screen.queryByText('State of Berlin')).not.toBeInTheDocument();
  });

  test('counts decision expiration down live from the absolute stop time', async () => {
    const expiresAt = new Date(Date.now() + 2_500).toISOString();
    vi.mocked(api.fetchDecisionsPaginated).mockImplementationOnce(async (page, pageSize) =>
      toPaginatedDecisions([
        {
          id: 10,
          created_at: new Date(Date.now() - 60_000).toISOString(),
          value: '1.2.3.4',
          expired: false,
          is_duplicate: false,
          simulated: false,
          detail: {
            origin: 'manual',
            reason: 'crowdsecurity/ssh-bf',
            country: 'DE',
            as: 'Hetzner',
            action: 'ban',
            duration: '4m10s',
            expiration: expiresAt,
            alert_id: 1,
          },
        },
      ], page, pageSize),
    );

    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/^[123]s$/)).toBeInTheDocument());
    expect(screen.queryByText('4m10s')).not.toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_600));
    });
    await waitFor(() => expect(screen.getByText('0s')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/Expired/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Select decision 10' })).toBeDisabled());
  });

  test('saves decision table columns from the modal', async () => {
    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Choose decision table columns' }));
    await userEvent.click(screen.getByLabelText('ID'));
    await userEvent.click(screen.getByLabelText('Region'));
    await userEvent.click(screen.getByLabelText('City'));
    await userEvent.click(screen.getByLabelText('Machine'));
    await userEvent.click(screen.getByLabelText('Origin'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'ID' })).toBeInTheDocument());
    expect(getVisibleColumnHeaderNames()[0]).toBe('ID');
    const headers = getVisibleColumnHeaderNames();
    expect(headers.indexOf('Country')).toBeLessThan(headers.indexOf('Region'));
    expect(headers.indexOf('Region')).toBeLessThan(headers.indexOf('City'));
    expect(screen.getByText('State of Berlin')).toBeInTheDocument();
    expect(screen.getByText('Berlin')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Machine' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Origin' })).toBeInTheDocument();
  });

  test('uses saved decision column order', async () => {
    window.localStorage.setItem('crowdsec-web-ui:table-column-preferences', JSON.stringify({
      decisions: ['source', 'action', 'time', 'alert'],
    }));

    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    expect(getVisibleColumnHeaderNames()).toEqual(['IP / Range', 'Action', 'Time', 'Alert', 'Actions']);
  });

  test('shows machine column and allows filtering by machine when enabled', async () => {
    window.localStorage.setItem('crowdsec-web-ui:table-column-preferences', JSON.stringify({
      decisions: ['time', 'scenario', 'country', 'as', 'source', 'action', 'expiration', 'machine', 'origin', 'alert'],
    }));
    vi.mocked(api.fetchConfig).mockResolvedValue({
      lookback_period: '1h',
      lookback_hours: 1,
      lookback_days: 1,
      refresh_interval: 30000,
      current_interval_name: '30s',
      lapi_status: { isConnected: true, lastCheck: null, lastError: null, offline_since: null },
      sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
      simulations_enabled: true,
      machine_features_enabled: true,
      origin_features_enabled: true,
    });

    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Machine' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('host-a')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Expand search' }));
    fireEvent.change(screen.getByPlaceholderText('Filter decisions...'), { target: { value: 'host-a' } });
    await flushDecisionSearchDebounce();
    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('5.6.7.8')).not.toBeInTheDocument());
  });

  test('shows origin column and allows filtering by origin when enabled', async () => {
    window.localStorage.setItem('crowdsec-web-ui:table-column-preferences', JSON.stringify({
      decisions: ['time', 'scenario', 'country', 'as', 'source', 'action', 'expiration', 'origin', 'alert'],
    }));
    vi.mocked(api.fetchConfig).mockResolvedValue({
      lookback_period: '1h',
      lookback_hours: 1,
      lookback_days: 1,
      refresh_interval: 30000,
      current_interval_name: '30s',
      lapi_status: { isConnected: true, lastCheck: null, lastError: null, offline_since: null },
      sync_status: { isSyncing: false, progress: 100, message: 'done', startedAt: null, completedAt: null },
      simulations_enabled: true,
      machine_features_enabled: false,
      origin_features_enabled: true,
    });

    render(
      <MemoryRouter initialEntries={['/decisions']}>
        <Decisions />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Origin' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('manual')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('CAPI')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Expand search' }));
    fireEvent.change(screen.getByPlaceholderText('Filter decisions...'), { target: { value: 'manual' } });
    await flushDecisionSearchDebounce();
    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('5.6.7.8')).not.toBeInTheDocument());
  });

});
