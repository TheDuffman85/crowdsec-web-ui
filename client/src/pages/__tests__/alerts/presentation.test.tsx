import { chineseI18nValue, createDefaultConfigResponse, getVisibleColumnHeaderNames, toPaginatedAlerts } from './harness';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../../../lib/api';
import { Alerts } from '../../Alerts';
import { I18nContext } from '../../../lib/i18n';
import { type SlimAlert } from '../../../types';

describe('Alerts page presentation and columns', () => {
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
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: 'Delete selected' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Alert' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose alert table columns' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Delete selected' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Alert' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose alert table columns' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete all alerts and decisions for/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Select all loaded alerts')).not.toBeInTheDocument();
  });

  test('localizes country names in the alert table and alert details', async () => {
    render(
      <I18nContext.Provider value={chineseI18nValue}>
        <MemoryRouter initialEntries={['/alerts?id=2']}>
          <Alerts />
        </MemoryRouter>
      </I18nContext.Provider>,
    );

    await waitFor(() => expect(screen.getByText('Alert Details #2')).toBeInTheDocument());
    expect(screen.getByText('德国')).toBeInTheDocument();
    expect(screen.getAllByText('美国')).toHaveLength(2);
    expect(screen.queryByText('Germany')).not.toBeInTheDocument();
    expect(screen.queryByText('United States')).not.toBeInTheDocument();
  });

  test('shows simulated alerts with an inline scenario badge and standard decision actions', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts?simulation=simulated']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Active: 1')).toBeInTheDocument());
    expect(screen.getByText('Simulation')).toBeInTheDocument();
    expect(screen.queryByText('Simulation Mode')).not.toBeInTheDocument();
  });

  test('keeps optional columns hidden by default', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
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

  test('saves alert table columns from the modal', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Choose alert table columns' }));
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

  test('uses saved alert column order', async () => {
    window.localStorage.setItem('crowdsec-web-ui:table-column-preferences', JSON.stringify({
      alerts: ['source', 'time', 'decisions', 'scenario'],
    }));

    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    expect(getVisibleColumnHeaderNames()).toEqual(['IP / Range', 'Time', 'Decisions', 'Scenario', 'Actions']);
  });

  test('keeps unsaved column edits local to the modal until save', async () => {
    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Choose alert table columns' }));
    await userEvent.click(screen.getByLabelText('ID'));
    expect(screen.getByLabelText('ID')).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('columnheader', { name: 'ID' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Choose alert table columns' }));
    expect(screen.getByLabelText('ID')).not.toBeChecked();
  });

  test('resets alert column visibility and order to defaults', async () => {
    window.localStorage.setItem(
      'crowdsec-web-ui:alerts:table-column-order',
      JSON.stringify(['source', 'id', 'machine', 'origin', 'time', 'scenario', 'country', 'as', 'decisions']),
    );

    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Choose alert table columns' }));
    await userEvent.click(screen.getByLabelText('ID'));
    await userEvent.click(screen.getByLabelText('Machine'));
    await userEvent.click(screen.getByLabelText('Origin'));
    expect(screen.getByLabelText('ID')).toBeChecked();
    expect(screen.getByLabelText('Machine')).toBeChecked();
    expect(screen.getByLabelText('Origin')).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Reset defaults' }));

    expect(screen.getByLabelText('ID')).not.toBeChecked();
    expect(screen.getByLabelText('Machine')).not.toBeChecked();
    expect(screen.getByLabelText('Origin')).not.toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(getVisibleColumnHeaderNames()).toEqual(['Time', 'Scenario', 'Country', 'AS', 'IP / Range', 'Decisions', 'Actions']));
    expect(JSON.parse(window.localStorage.getItem('crowdsec-web-ui:alerts:table-column-order') || '[]'))
      .toEqual(['id', 'instance', 'time', 'scenario', 'country', 'region', 'city', 'as', 'source', 'machine', 'origin', 'decisions']);
  });

  test('keeps saved order for hidden alert columns when they are enabled later', async () => {
    window.localStorage.setItem(
      'crowdsec-web-ui:alerts:table-column-order',
      JSON.stringify(['time', 'scenario', 'country', 'as', 'source', 'id', 'decisions', 'machine', 'origin']),
    );

    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Choose alert table columns' }));
    await userEvent.click(screen.getByLabelText('ID'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'ID' })).toBeInTheDocument());
    const headers = getVisibleColumnHeaderNames();
    expect(headers.indexOf('IP / Range')).toBeLessThan(headers.indexOf('ID'));
    expect(headers.indexOf('ID')).toBeLessThan(headers.indexOf('Decisions'));
  });

  test('migrates legacy split alert column preferences to one layout', async () => {
    window.localStorage.setItem('crowdsec-web-ui:table-column-preferences', JSON.stringify({
      alerts: {
        desktop: ['id', 'source'],
        mobile: ['id', 'source'],
      },
      decisions: {
        mobile: ['source', 'alert'],
      },
    }));

    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());
    expect(screen.getByRole('columnheader', { name: 'ID' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'IP / Range' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Scenario' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Choose alert table columns' }));
    expect(screen.getByText('Column choices are saved in this browser.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'mobile' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'desktop' })).not.toBeInTheDocument();
  });

  test('shows machine column and detail card when the column is enabled', async () => {
    window.localStorage.setItem('crowdsec-web-ui:table-column-preferences', JSON.stringify({
      alerts: ['time', 'scenario', 'country', 'as', 'source', 'machine', 'decisions'],
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
      origin_features_enabled: false,
    });
    vi.mocked(api.fetchAlert).mockResolvedValueOnce({
      id: 1,
      created_at: '2026-03-23T10:00:00.000Z',
      scenario: 'crowdsecurity/ssh-bf',
      machine_id: 'machine-1',
      machine_alias: 'host-a',
      source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
      target: 'ssh',
      message: 'Alert with machine alias',
      simulated: false,
      decisions: [{ id: 10, value: '1.2.3.4', type: 'ban', simulated: false, expired: false }],
      events: [],
    });

    render(
      <MemoryRouter initialEntries={['/alerts?id=1']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Alert Details #1')).toBeInTheDocument());
    expect(screen.getAllByText('host-a').length).toBeGreaterThan(1);
    expect(screen.getAllByText('Machine').length).toBeGreaterThan(1);
  });

  test('shows the instance in alert details only when multiple instances are configured', async () => {
    const config = createDefaultConfigResponse();
    vi.mocked(api.fetchConfig).mockResolvedValue({
      ...config,
      instances: [
        { id: 'primary', name: 'Primary', lapi_status: config.lapi_status, sync_status: config.sync_status, prometheus: [] },
        { id: 'branch', name: 'Branch Office', lapi_status: config.lapi_status, sync_status: config.sync_status, prometheus: [] },
      ],
    });
    vi.mocked(api.fetchAlert).mockResolvedValueOnce({
      id: 1,
      instance_id: 'branch',
      instance_name: 'Branch Office',
      created_at: '2026-03-23T10:00:00.000Z',
      scenario: 'crowdsecurity/ssh-bf',
      source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
      target: 'ssh',
      simulated: false,
      decisions: [],
      events: [],
    });

    render(
      <MemoryRouter initialEntries={['/alerts?id=1']}>
        <Alerts />
      </MemoryRouter>,
    );

    const dialog = await screen.findByRole('dialog', { name: 'Alert Details #1' });
    expect(within(dialog).getByText('Instance')).toHaveClass('text-xs', 'text-gray-500', 'dark:text-gray-400');
    expect(within(dialog).getByText('Branch Office')).toHaveClass('text-lg', 'font-medium', 'text-gray-900', 'dark:text-gray-100');
    expect(within(dialog).getByText('ssh-bf')).toHaveClass('text-lg', 'font-medium', 'text-gray-900', 'dark:text-gray-100');
    expect(within(dialog).getByRole('link', { name: '1.2.3.4' })).toHaveClass('text-lg', 'font-medium', 'text-gray-900', 'dark:text-gray-100');
  });

  test('omits the instance from alert details for a single configured instance', async () => {
    const config = createDefaultConfigResponse();
    vi.mocked(api.fetchConfig).mockResolvedValue({
      ...config,
      instances: [
        { id: 'primary', name: 'Primary', lapi_status: config.lapi_status, sync_status: config.sync_status, prometheus: [] },
      ],
    });
    vi.mocked(api.fetchAlert).mockResolvedValueOnce({
      id: 1,
      instance_id: 'primary',
      instance_name: 'Primary',
      created_at: '2026-03-23T10:00:00.000Z',
      scenario: 'crowdsecurity/ssh-bf',
      source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
      target: 'ssh',
      simulated: false,
      decisions: [],
      events: [],
    });

    render(
      <MemoryRouter initialEntries={['/alerts?id=1']}>
        <Alerts />
      </MemoryRouter>,
    );

    const dialog = await screen.findByRole('dialog', { name: 'Alert Details #1' });
    expect(within(dialog).queryByText('Instance')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Primary')).not.toBeInTheDocument();
  });

  test('shows origin column, renders mixed origins, and filters alerts by origin when enabled', async () => {
    window.localStorage.setItem('crowdsec-web-ui:table-column-preferences', JSON.stringify({
      alerts: ['time', 'scenario', 'country', 'as', 'source', 'origin', 'decisions'],
    }));
    const originAlerts: SlimAlert[] = [
      {
        id: 1,
        created_at: '2026-03-23T10:00:00.000Z',
        scenario: 'crowdsecurity/ssh-bf',
        source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
        target: 'ssh',
        meta_search: 'ssh',
        decisions: [],
        decision_summary: {
          origins: ['CAPI', 'manual'],
          active_count: 2,
          expired_count: 0,
          simulated_active_count: 0,
          simulated_expired_count: 0,
        },
      },
      {
        id: 2,
        created_at: '2026-03-23T11:00:00.000Z',
        scenario: 'crowdsecurity/nginx-bf',
        source: { ip: '5.6.7.8', value: '5.6.7.8', cn: 'US', as_name: 'AWS' },
        target: 'nginx',
        meta_search: 'nginx',
        decisions: [],
        decision_summary: {
          origins: ['crowdsec'],
          active_count: 1,
          expired_count: 0,
          simulated_active_count: 0,
          simulated_expired_count: 0,
        },
      },
    ];

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
    vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (page, pageSize, filters) => {
      const query = (filters?.q || '').toLowerCase();
      const filteredAlerts = query
        ? originAlerts.filter((alert) => alert.decision_summary?.origins.some((origin) => origin.toLowerCase().includes(query)))
        : originAlerts;
      return toPaginatedAlerts(filteredAlerts, page, pageSize, originAlerts.length);
    });

    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Origin' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Mixed')).toBeInTheDocument());
    expect(screen.getByText('crowdsec')).toBeInTheDocument();
    expect(screen.getByText('Active: 2')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Expand search' }));
    await userEvent.type(screen.getByPlaceholderText('Filter alerts...'), 'capi');

    await waitFor(() => expect(screen.getByText('Mixed')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('crowdsec')).not.toBeInTheDocument());
  });

});
