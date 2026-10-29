import { createDefaultConfigResponse } from './harness';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import * as api from '../../../lib/api';
import { Decisions } from '../../Decisions';

function configureInstances(ids: string[], scenarios: Record<string, string[]> = {}) {
  const config = createDefaultConfigResponse();
  vi.mocked(api.fetchConfig).mockResolvedValue({
    ...config,
    instances: ids.map((id) => ({
      id,
      name: id.toUpperCase(),
      lapi_status: config.lapi_status,
      sync_status: config.sync_status,
      prometheus: [],
      ...(scenarios[id] ? { manual_decision_scenarios: scenarios[id] } : {}),
    })),
  });
}

const configureMultipleInstances = (scenarios: Record<string, string[]> = {}) => configureInstances(['east', 'west'], scenarios);

async function openAddDecision(path: string) {
  renderDecisions(path);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add Decision' })).toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: 'Add Decision' }));
  return screen.getByRole('dialog', { name: 'Add Manual Decision' });
}

const renderDecisions = (path: string) => render(
  <MemoryRouter initialEntries={[path]}><Decisions /></MemoryRouter>,
);

describe('shared Add Decision modal on Decisions page', () => {
  test('defaults to the filtered instance, supports all instances, and retries only failures', async () => {
    configureMultipleInstances();
    vi.mocked(api.addDecision)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        results: [
          { instance_id: 'east', instance_name: 'EAST', success: true },
          { instance_id: 'west', instance_name: 'WEST', success: false, error: 'unavailable' },
        ],
        succeeded: 1,
        failed: 1,
      })
      .mockResolvedValueOnce({
        results: [{ instance_id: 'west', instance_name: 'WEST', success: true }],
        succeeded: 1,
        failed: 0,
      });
    renderDecisions('/decisions?instance=east');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Decision' })).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Add Decision' }));
    let dialog = screen.getByRole('dialog', { name: 'Add Manual Decision' });
    expect(within(dialog).getByRole('checkbox', { name: 'All instances' })).not.toBeChecked();
    expect(within(dialog).getByText('Current instance: EAST')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'IP / Range' }), '203.0.113.8');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Decision' }));
    await waitFor(() => expect(api.addDecision).toHaveBeenNthCalledWith(1, {
      ip: '203.0.113.8', duration: '4h', type: 'ban', reason: 'manual', scenario: 'manual/web-ui', scope: 'instance', instance_id: 'east',
    }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Manual Decision' })).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Add Decision' }));
    dialog = screen.getByRole('dialog', { name: 'Add Manual Decision' });
    expect(within(dialog).getByRole('textbox', { name: 'IP / Range' })).toHaveValue('');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'IP / Range' }), '203.0.113.9');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'All instances' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Decision' }));
    await waitFor(() => expect(api.addDecision).toHaveBeenNthCalledWith(2, {
      ip: '203.0.113.9', duration: '4h', type: 'ban', reason: 'manual', scenario: 'manual/web-ui', scope: 'all',
    }));
    dialog = screen.getByRole('dialog', { name: 'Add Manual Decision' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Failed: WEST');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry failed instances' }));
    await waitFor(() => expect(api.addDecision).toHaveBeenNthCalledWith(3, {
      ip: '203.0.113.9', duration: '4h', type: 'ban', reason: 'manual', scenario: 'manual/web-ui', scope: 'instance', instance_id: 'west',
    }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add Manual Decision' })).not.toBeInTheDocument());
  });

  test('keeps All instances selected when the page has no single-instance filter', async () => {
    configureMultipleInstances();
    vi.mocked(api.addDecision).mockResolvedValue(undefined);
    renderDecisions('/decisions');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add Decision' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Add Decision' }));
    const dialog = screen.getByRole('dialog', { name: 'Add Manual Decision' });
    const allInstances = within(dialog).getByRole('checkbox', { name: 'All instances' });
    expect(allInstances).toBeChecked();
    expect(allInstances).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'IP / Range' }), '203.0.113.10');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Decision' }));
    await waitFor(() => expect(api.addDecision).toHaveBeenCalledWith({
      ip: '203.0.113.10', duration: '4h', type: 'ban', reason: 'manual', scenario: 'manual/web-ui', scope: 'all',
    }));
  });

  test('defaults to a ban and hides the scenario field when only the manual scenario is available', async () => {
    vi.mocked(api.addDecision).mockResolvedValue(undefined);
    const dialog = await openAddDecision('/decisions');
    expect(within(dialog).getByRole('combobox', { name: 'Type' })).toHaveValue('ban');
    expect(within(dialog).queryByRole('combobox', { name: 'Scenario' })).not.toBeInTheDocument();

    await userEvent.type(within(dialog).getByRole('textbox', { name: 'IP / Range' }), '203.0.113.11');
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Type' }), 'captcha');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Decision' }));
    await waitFor(() => expect(api.addDecision).toHaveBeenCalledWith({
      ip: '203.0.113.11', duration: '4h', type: 'captcha', reason: 'manual', scenario: 'manual/web-ui',
    }));
  });

  test('offers the configured scenarios with the manual scenario selected first', async () => {
    configureInstances(['main'], { main: ['manual/web-ui', 'custom/abuse-report'] });
    vi.mocked(api.addDecision).mockResolvedValue(undefined);
    const dialog = await openAddDecision('/decisions');
    const scenario = await within(dialog).findByRole('combobox', { name: 'Scenario' });
    expect(scenario).toBeEnabled();
    expect(scenario).toHaveValue('manual/web-ui');
    expect(within(scenario).getAllByRole('option').map((option) => option.textContent)).toEqual(['manual/web-ui', 'custom/abuse-report']);

    await userEvent.type(within(dialog).getByRole('textbox', { name: 'IP / Range' }), '203.0.113.12');
    await userEvent.selectOptions(scenario, 'custom/abuse-report');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Decision' }));
    await waitFor(() => expect(api.addDecision).toHaveBeenCalledWith({
      ip: '203.0.113.12', duration: '4h', type: 'ban', reason: 'manual', scenario: 'custom/abuse-report',
    }));
  });

  test('lists target instances and keeps their shared scenarios for All instances', async () => {
    const shared = ['manual/web-ui', 'custom/abuse-report'];
    configureMultipleInstances({ east: shared, west: shared });
    vi.mocked(api.addDecision).mockResolvedValue(undefined);
    const dialog = await openAddDecision('/decisions');
    expect(within(dialog).getByText('Will be added to: EAST, WEST')).toBeInTheDocument();
    const scenario = within(dialog).getByRole('combobox', { name: 'Scenario' });
    expect(scenario).toBeEnabled();

    await userEvent.type(within(dialog).getByRole('textbox', { name: 'IP / Range' }), '203.0.113.13');
    await userEvent.selectOptions(scenario, 'custom/abuse-report');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Decision' }));
    await waitFor(() => expect(api.addDecision).toHaveBeenCalledWith({
      ip: '203.0.113.13', duration: '4h', type: 'ban', reason: 'manual', scenario: 'custom/abuse-report', scope: 'all',
    }));
  });

  test('falls back to the manual scenario and hides the field for All instances with different lists', async () => {
    configureMultipleInstances({ east: ['manual/web-ui', 'custom/east-only'] });
    vi.mocked(api.addDecision).mockResolvedValue(undefined);
    const dialog = await openAddDecision('/decisions?instance=east');
    const scenario = within(dialog).getByRole('combobox', { name: 'Scenario' });
    expect(scenario).toBeEnabled();
    await userEvent.selectOptions(scenario, 'custom/east-only');

    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'All instances' }));
    expect(within(dialog).getByText('Will be added to: EAST, WEST')).toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox', { name: 'Scenario' })).not.toBeInTheDocument();

    await userEvent.type(within(dialog).getByRole('textbox', { name: 'IP / Range' }), '203.0.113.14');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Decision' }));
    await waitFor(() => expect(api.addDecision).toHaveBeenCalledWith({
      ip: '203.0.113.14', duration: '4h', type: 'ban', reason: 'manual', scenario: 'manual/web-ui', scope: 'all',
    }));
  });
});

describe('allowlist protection in the Add Decision modal', () => {
  const allowlistedValue = '10.1.2.3';
  const allowlistedResults = (value: string) => value === allowlistedValue
    ? [{ instance_id: 'main', instance_name: 'MAIN', status: 'available' as const, allowlisted: true, reason: '10.0.0.0/8 from office (VPN)' }]
    : [];

  test('warns about an allowlisted value and only submits after the bypass is confirmed', async () => {
    configureInstances(['main']);
    vi.mocked(api.checkAllowlist).mockImplementation(async (value) => ({
      value,
      allowlisted: value === allowlistedValue,
      results: allowlistedResults(value),
    }));
    vi.mocked(api.addDecision).mockResolvedValue(undefined);
    const dialog = await openAddDecision('/decisions');

    await userEvent.type(within(dialog).getByRole('textbox', { name: 'IP / Range' }), allowlistedValue);
    const warning = await within(dialog).findByRole('alert');
    expect(warning).toHaveTextContent('10.1.2.3 is allowlisted');
    expect(warning).toHaveTextContent('10.0.0.0/8 from office (VPN)');
    expect(api.checkAllowlist).toHaveBeenLastCalledWith(allowlistedValue, 'all');
    const submit = within(dialog).getByRole('button', { name: 'Add Decision' });
    expect(submit).toBeDisabled();

    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Bypass allowlist' }));
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await waitFor(() => expect(api.addDecision).toHaveBeenCalledWith({
      ip: allowlistedValue, duration: '4h', type: 'ban', reason: 'manual', scenario: 'manual/web-ui', bypass_allowlist: true,
    }));
  });

  test('shows the server refusal and asks again for a bypass after the value changes', async () => {
    configureMultipleInstances();
    // The pre-check is still running when the form is submitted.
    vi.mocked(api.checkAllowlist).mockImplementation(() => new Promise(() => {}));
    vi.mocked(api.addDecision)
      .mockRejectedValueOnce(Object.assign(new Error('10.1.2.4 is allowlisted'), {
        code: 'ALLOWLISTED',
        allowlisted: [{ instance_id: 'west', instance_name: 'WEST', reason: '10.1.2.4 from partners' }],
      }))
      .mockResolvedValueOnce(undefined);
    try {
      const dialog = await openAddDecision('/decisions');
      const input = within(dialog).getByRole('textbox', { name: 'IP / Range' });
      const submit = within(dialog).getByRole('button', { name: 'Add Decision' });

      await userEvent.type(input, '10.1.2.4');
      await userEvent.click(submit);
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('WEST: 10.1.2.4 from partners');
      expect(submit).toBeDisabled();

      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Bypass allowlist' }));
      await userEvent.type(input, '0');
      expect(within(dialog).queryByRole('checkbox', { name: 'Bypass allowlist' })).not.toBeInTheDocument();
      await userEvent.type(input, '{Backspace}');
      expect(within(dialog).getByRole('checkbox', { name: 'Bypass allowlist' })).not.toBeChecked();
      expect(submit).toBeDisabled();

      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Bypass allowlist' }));
      await userEvent.click(submit);
      await waitFor(() => expect(api.addDecision).toHaveBeenLastCalledWith({
        ip: '10.1.2.4', duration: '4h', type: 'ban', reason: 'manual', scenario: 'manual/web-ui', scope: 'all', bypass_allowlist: true,
      }));
    } finally {
      vi.mocked(api.checkAllowlist).mockImplementation(async (value) => ({ value, allowlisted: false, results: [] }));
    }
  });
});
