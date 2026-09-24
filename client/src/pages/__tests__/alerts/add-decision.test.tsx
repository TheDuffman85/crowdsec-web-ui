import { createDefaultConfigResponse, toPaginatedAlerts } from './harness';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../../../lib/api';
import { Alerts } from '../../Alerts';
import type { SlimAlert } from '../../../types';

const renderAlerts = (path = '/alerts') => render(
  <MemoryRouter initialEntries={[path]}><Alerts /></MemoryRouter>,
);

function multiInstanceConfig() {
  const config = createDefaultConfigResponse();
  return {
    ...config,
    instances: ['east', 'west'].map((id) => ({
      id,
      name: id.toUpperCase(),
      lapi_status: config.lapi_status,
      sync_status: config.sync_status,
      prometheus: [],
    })),
  };
}

describe('Add Decision from alerts', () => {
  test('prefills the row action, allows edits, refreshes alerts, and resets on reopen', async () => {
    vi.mocked(api.addDecision).mockResolvedValue(undefined);
    renderAlerts();

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Add Decision' })).toHaveLength(2));
    const fetchCount = vi.mocked(api.fetchAlertsPaginated).mock.calls.length;
    await userEvent.click(screen.getAllByRole('button', { name: 'Add Decision' })[0]);
    let dialog = screen.getByRole('dialog', { name: 'Add Manual Decision' });
    expect(within(dialog).getByRole('textbox', { name: 'IP / Range' })).toHaveValue('1.2.3.4');
    expect(within(dialog).getByRole('textbox', { name: 'Duration' })).toHaveValue('4h');
    expect(within(dialog).getByRole('textbox', { name: 'Reason' })).toHaveValue('crowdsecurity/ssh-bf');
    expect(within(dialog).queryByRole('checkbox', { name: 'All instances' })).not.toBeInTheDocument();

    await userEvent.clear(within(dialog).getByRole('textbox', { name: 'IP / Range' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'IP / Range' }), '203.0.113.7');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Decision' }));
    await waitFor(() => expect(api.addDecision).toHaveBeenCalledWith({
      ip: '203.0.113.7', duration: '4h', reason: 'crowdsecurity/ssh-bf',
    }));
    await waitFor(() => expect(vi.mocked(api.fetchAlertsPaginated).mock.calls.length).toBeGreaterThan(fetchCount));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Manual Decision' })).not.toBeInTheDocument());

    await userEvent.click(screen.getAllByRole('button', { name: 'Add Decision' })[0]);
    dialog = screen.getByRole('dialog', { name: 'Add Manual Decision' });
    expect(within(dialog).getByRole('textbox', { name: 'IP / Range' })).toHaveValue('1.2.3.4');
    expect(screen.getAllByRole('button', { name: 'Add Decision' })).toHaveLength(3);
  });

  test('opens from details, restores them on cancel, and refreshes their decisions after success', async () => {
    vi.mocked(api.addDecision).mockResolvedValue(undefined);
    renderAlerts('/alerts?id=2');
    const details = await screen.findByRole('dialog', { name: 'Alert Details #2' });
    await userEvent.click(within(details).getByRole('button', { name: 'Add Decision' }));

    const addDialog = screen.getByRole('dialog', { name: 'Add Manual Decision' });
    expect(screen.queryByRole('dialog', { name: 'Alert Details #2' })).not.toBeInTheDocument();
    expect(within(addDialog).getByRole('textbox', { name: 'IP / Range' })).toHaveValue('5.6.7.8');
    expect(within(addDialog).getByRole('textbox', { name: 'Reason' })).toHaveValue('crowdsecurity/nginx-bf');
    await userEvent.click(within(addDialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'Alert Details #2' })).toBeInTheDocument();

    const decisionFetchCount = vi.mocked(api.fetchDecisionsPaginated).mock.calls.length;
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Alert Details #2' })).getByRole('button', { name: 'Add Decision' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Add Manual Decision' })).getByRole('button', { name: 'Add Decision' }));
    await waitFor(() => expect(vi.mocked(api.fetchDecisionsPaginated).mock.calls.length).toBeGreaterThan(decisionFetchCount));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Alert Details #2' })).toBeInTheDocument());
  });

  test('falls back to a manual reason when the alert has no scenario', async () => {
    vi.mocked(api.fetchAlert).mockResolvedValueOnce({
      id: 42,
      created_at: '2026-03-23T11:00:00.000Z',
      source: { ip: '203.0.113.42' },
      decisions: [],
      events: [],
    });
    renderAlerts('/alerts?id=42');
    const details = await screen.findByRole('dialog', { name: 'Alert Details #42' });
    await userEvent.click(within(details).getByRole('button', { name: 'Add Decision' }));
    expect(within(screen.getByRole('dialog', { name: 'Add Manual Decision' })).getByRole('textbox', { name: 'Reason' })).toHaveValue('manual');
  });

  test('omits the detail action when the source has no IP', async () => {
    vi.mocked(api.fetchAlert).mockResolvedValueOnce({
      id: 43,
      created_at: '2026-03-23T11:00:00.000Z',
      scenario: 'crowdsecurity/community-blocklist',
      source: { range: '192.0.2.0/24' },
      decisions: [],
      events: [],
    });
    renderAlerts('/alerts?id=43');
    const details = await screen.findByRole('dialog', { name: 'Alert Details #43' });
    expect(within(details).queryByRole('button', { name: 'Add Decision' })).not.toBeInTheDocument();
  });

  test('targets the alert instance by default and offers all instances', async () => {
    const fetchAlerts = vi.mocked(api.fetchAlertsPaginated);
    const originalImplementation = fetchAlerts.getMockImplementation();
    const alert: SlimAlert = {
      id: 31,
      instance_id: 'east',
      instance_name: 'EAST',
      created_at: '2026-03-23T11:00:00.000Z',
      scenario: 'crowdsecurity/ssh-bf',
      source: { ip: '198.51.100.4' },
      meta_search: 'ssh',
      decisions: [],
    };
    vi.mocked(api.fetchConfig).mockResolvedValue(multiInstanceConfig());
    fetchAlerts.mockImplementation(async (page, pageSize) => toPaginatedAlerts([alert], page, pageSize));
    vi.mocked(api.addDecision).mockResolvedValue(undefined);
    try {
      renderAlerts();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Add Decision' })).toBeInTheDocument());
      await userEvent.click(screen.getByRole('button', { name: 'Add Decision' }));
      let dialog = screen.getByRole('dialog', { name: 'Add Manual Decision' });
      expect(within(dialog).getByRole('checkbox', { name: 'All instances' })).not.toBeChecked();
      expect(within(dialog).getByText('Current instance: EAST')).toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add Decision' }));
      await waitFor(() => expect(api.addDecision).toHaveBeenLastCalledWith({
        ip: '198.51.100.4', duration: '4h', reason: 'crowdsecurity/ssh-bf',
        scope: 'instance', instance_id: 'east',
      }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Manual Decision' })).not.toBeInTheDocument());

      await userEvent.click(screen.getByRole('button', { name: 'Add Decision' }));
      dialog = screen.getByRole('dialog', { name: 'Add Manual Decision' });
      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'All instances' }));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add Decision' }));
      await waitFor(() => expect(api.addDecision).toHaveBeenLastCalledWith({
        ip: '198.51.100.4', duration: '4h', reason: 'crowdsecurity/ssh-bf', scope: 'all',
      }));
    } finally {
      if (originalImplementation) fetchAlerts.mockImplementation(originalImplementation);
    }
  });
});
