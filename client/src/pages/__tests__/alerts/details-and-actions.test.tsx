import { installControlledIntersectionObserver, largeDecisionList, setRefreshSignalMock, toPaginatedAlerts, toPaginatedDecisions } from './harness';
import { describe, expect, test, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../../../lib/api';
import { Alerts } from '../../Alerts';
import { type DecisionListItem, type SlimAlert } from '../../../types';

describe('Alerts page details and actions', () => {
  test('streams large decision lists inside alert details', async () => {
    const triggerIntersection = installControlledIntersectionObserver();
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
    });
    vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedAlerts([
        {
          id: 1,
          created_at: '2026-03-23T11:00:00.000Z',
          scenario: 'crowdsecurity/community-blocklist',
          source: { value: 'community-blocklist' },
          target: 'blocklist',
          meta_search: 'community-blocklist',
          decisions: [],
        },
      ], page, pageSize, 1),
    );
    const fetchAlertMock = vi.mocked(api.fetchAlert);
    fetchAlertMock.mockResolvedValueOnce({
      id: 1,
      created_at: '2026-03-23T11:00:00.000Z',
      scenario: 'crowdsecurity/community-blocklist',
      source: { value: 'community-blocklist' },
      decisions: [],
      events: [],
    });
    const fetchDecisionsPaginatedMock = vi.mocked(api.fetchDecisionsPaginated).mockImplementation(async (page, pageSize, filters) => {
      expect(filters).toEqual(expect.objectContaining({
        alert_id: '1',
        include_expired: 'true',
      }));

      const decisions: DecisionListItem[] = largeDecisionList.map((decision) => ({
        id: decision.id,
        created_at: '2026-03-23T11:00:00.000Z',
        value: decision.value,
        expired: false,
        is_duplicate: false,
        simulated: false,
        detail: {
          origin: decision.origin || 'CAPI',
          type: decision.type,
          reason: 'crowdsecurity/community-blocklist',
          action: decision.type,
          duration: decision.duration,
          expiration: '2030-01-01T00:00:00.000Z',
          alert_id: 1,
        },
      }));

      return toPaginatedDecisions(decisions, page, pageSize);
    });

    render(
      <MemoryRouter initialEntries={['/alerts?id=1']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Alert Details #1')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Showing 50 of 75')).toBeInTheDocument());
    expect(fetchDecisionsPaginatedMock.mock.calls.map(([page]) => page)).toEqual([1]);
    expect(screen.getByText('#1000')).toBeInTheDocument();
    expect(screen.queryByText('#1074')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load 50 more decisions/i })).not.toBeInTheDocument();

    await act(async () => {
      triggerIntersection();
    });

    await waitFor(() => expect(screen.getByText('#1074')).toBeInTheDocument());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetchDecisionsPaginatedMock.mock.calls.map(([page]) => page)).toEqual([1, 2]);
  });

  test('refreshes alert detail decisions for the same open alert during data refresh', async () => {
    const fetchAlertMock = vi.mocked(api.fetchAlert);
    fetchAlertMock
      .mockResolvedValueOnce({
        id: 1,
        created_at: '2026-03-23T11:00:00.000Z',
        scenario: 'crowdsecurity/ssh-bf',
        source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
        target: 'ssh',
        message: 'Initial alert',
        simulated: false,
        decisions: [{ id: 10, value: '1.2.3.4', type: 'ban', simulated: false, expired: false }],
        events: [],
      })
      .mockResolvedValueOnce({
        id: 1,
        created_at: '2026-03-23T11:00:00.000Z',
        scenario: 'crowdsecurity/ssh-bf',
        source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
        target: 'ssh',
        message: 'Refreshed alert',
        simulated: false,
        decisions: [
          { id: 10, value: '1.2.3.4', type: 'ban', simulated: false, expired: false },
          { id: 11, value: '1.2.3.4', type: 'ban', simulated: false, expired: false },
        ],
        events: [],
      });

    let decisionIds = [10];
    const fetchDecisionsPaginatedMock = vi.mocked(api.fetchDecisionsPaginated).mockImplementation(async (_page, pageSize, filters) => {
      const decisions: DecisionListItem[] = decisionIds.map((id) => ({
        id,
        created_at: '2026-03-23T11:00:00.000Z',
        machine: 'host-a',
        value: '1.2.3.4',
        expired: false,
        is_duplicate: false,
        simulated: false,
        detail: {
          origin: 'manual',
          type: 'ban',
          reason: 'crowdsecurity/ssh-bf',
          action: 'ban',
          country: 'DE',
          as: 'Hetzner',
          duration: '4h',
          expiration: '2030-01-01T00:00:00.000Z',
          alert_id: Number(filters?.alert_id || 1),
        },
      }));

      return toPaginatedDecisions(decisions, 1, pageSize);
    });

    const { rerender } = render(
      <MemoryRouter initialEntries={['/alerts?id=1']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Alert Details #1')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('#10')).toBeInTheDocument());
    expect(screen.queryByText('#11')).not.toBeInTheDocument();

    decisionIds = [10, 11];
    setRefreshSignalMock(1);

    rerender(
      <MemoryRouter initialEntries={['/alerts?id=1']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('#11')).toBeInTheDocument());
    expect(fetchDecisionsPaginatedMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchDecisionsPaginatedMock.mock.calls.at(-1)?.[2]).toEqual(expect.objectContaining({
      alert_id: '1',
      include_expired: 'true',
    }));
  });

  test('preserves loaded decision pages during same-alert detail refresh', async () => {
    const triggerIntersection = installControlledIntersectionObserver();
    vi.mocked(api.fetchAlert).mockResolvedValue({
      id: 1,
      created_at: '2026-03-23T11:00:00.000Z',
      scenario: 'crowdsecurity/community-blocklist',
      source: { value: 'community-blocklist' },
      decisions: [],
      events: [],
    });

    let refreshedDecisionList = largeDecisionList;
    const fetchDecisionsPaginatedMock = vi.mocked(api.fetchDecisionsPaginated).mockImplementation(async (page, pageSize, filters) => {
      expect(filters).toEqual(expect.objectContaining({
        alert_id: '1',
        include_expired: 'true',
      }));

      const decisions: DecisionListItem[] = refreshedDecisionList.map((decision) => ({
        id: decision.id,
        created_at: '2026-03-23T11:00:00.000Z',
        value: decision.value,
        expired: false,
        is_duplicate: false,
        simulated: false,
        detail: {
          origin: decision.origin || 'CAPI',
          type: decision.type,
          reason: 'crowdsecurity/community-blocklist',
          action: decision.type,
          duration: decision.duration,
          expiration: '2030-01-01T00:00:00.000Z',
          alert_id: 1,
        },
      }));

      return toPaginatedDecisions(decisions, page, pageSize);
    });

    const { rerender } = render(
      <MemoryRouter initialEntries={['/alerts?id=1']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Showing 50 of 75')).toBeInTheDocument());

    await act(async () => {
      triggerIntersection();
    });

    await waitFor(() => expect(screen.getByText('#1074')).toBeInTheDocument());

    const callCountBeforeRefresh = fetchDecisionsPaginatedMock.mock.calls.length;
    refreshedDecisionList = [{
      id: 2000,
      value: '198.51.100.200',
      type: 'ban',
      duration: '24h',
      simulated: false,
      expired: false,
      origin: 'CAPI',
    }, ...largeDecisionList];
    setRefreshSignalMock(1);

    rerender(
      <MemoryRouter initialEntries={['/alerts?id=1']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(fetchDecisionsPaginatedMock.mock.calls.length).toBe(callCountBeforeRefresh + 1));
    expect(fetchDecisionsPaginatedMock.mock.calls.at(-1)?.[0]).toBe(1);
    expect(fetchDecisionsPaginatedMock.mock.calls.at(-1)?.[1]).toBe(100);
    expect(screen.getByText('#2000')).toBeInTheDocument();
    expect(screen.getByText('#1074')).toBeInTheDocument();
  });

  test('bulk delete selects loaded alerts without requiring all filtered ids', async () => {
    const bulkAlerts = Array.from({ length: 55 }, (_, index) => ({
      id: index + 1,
      created_at: `2026-03-24T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
      scenario: 'bulk/scenario',
      source: { ip: `10.0.0.${index + 1}`, value: `10.0.0.${index + 1}`, cn: 'DE', as_name: 'Hetzner' },
      target: 'ssh',
      meta_search: 'bulk',
      decisions: [],
    }));
    vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedAlerts(bulkAlerts, page, pageSize, bulkAlerts.length),
    );
    const bulkDeleteAlertsMock = vi.mocked(api.bulkDeleteAlerts).mockResolvedValue({
      requested_alerts: 55,
      requested_decisions: 0,
      deleted_alerts: 55,
      deleted_decisions: 0,
      failed: [],
    });

    render(
      <MemoryRouter initialEntries={['/alerts?scenario=bulk/scenario']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('10.0.0.1')).toBeInTheDocument());
    expect(screen.queryByText('10.0.0.55')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all loaded alerts' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(bulkDeleteAlertsMock).toHaveBeenCalledWith(
      Array.from({ length: 50 }, (_, index) => String(index + 1)),
    ));
  });

  test('shows delete permission guidance inside the confirmation modal', async () => {
    const alerts: SlimAlert[] = [{
      id: 1,
      created_at: '2026-03-23T10:00:00.000Z',
      scenario: 'crowdsecurity/ssh-bf',
      machine_id: 'machine-1',
      machine_alias: 'host-a',
      source: { ip: '1.2.3.4', value: '1.2.3.4', cn: 'DE', as_name: 'Hetzner' },
      target: 'ssh',
      meta_search: 'ssh',
      decisions: [{ id: 10, value: '1.2.3.4', type: 'ban', origin: 'manual', simulated: false, expired: false }],
    }];
    const permissionError = Object.assign(new Error('Permission denied.'), {
      helpLink: 'https://github.com/TheDuffman85/crowdsec-web-ui#trusted-ips-for-delete-operations-optional',
      helpText: 'Trusted IPs for Delete Operations',
    });
    vi.mocked(api.fetchAlertsPaginated).mockImplementation(async (page, pageSize) =>
      toPaginatedAlerts(alerts, page, pageSize),
    );
    vi.mocked(api.deleteAlert).mockRejectedValueOnce(permissionError);

    render(
      <MemoryRouter initialEntries={['/alerts']}>
        <Alerts />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1.2.3.4')).toBeInTheDocument());

    await userEvent.click(screen.getAllByTitle('Delete Alert')[0]);
    let deleteDialog = screen.getByRole('dialog', { name: 'Delete Alert?' });
    await userEvent.click(within(deleteDialog).getByRole('button', { name: 'Delete' }));

    deleteDialog = screen.getByRole('dialog', { name: 'Delete Alert?' });
    const modalAlert = await within(deleteDialog).findByRole('alert');
    expect(modalAlert).toHaveTextContent('Permission denied.');
    expect(within(modalAlert).getByRole('link', { name: 'Trusted IPs for Delete Operations' })).toHaveAttribute(
      'href',
      'https://github.com/TheDuffman85/crowdsec-web-ui#trusted-ips-for-delete-operations-optional',
    );
  });
});
