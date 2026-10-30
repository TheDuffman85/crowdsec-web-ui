import './harness';
import { SettingsRouter } from './router';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from '../../Settings';
import { fetchConfig, fetchIpReporters, previewIpReports, runIpReporter, saveIpReporter } from '../../../lib/api';
import { defaultIpReporterConfig } from '../../../../../shared/ip-reporting';
import type { IpReporter } from '../../../types';

function mockConfig(canManage: boolean) {
  vi.mocked(fetchConfig).mockResolvedValue({
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
    permissions: { mode: canManage ? 'admin' : 'read-only', can_manage_enforcement: canManage, can_manage_settings: canManage },
  });
}

const reporter: IpReporter = {
  id: 'reporter-1',
  name: 'AbuseIPDB main',
  provider: 'abuseipdb',
  enabled: true,
  config: { ...defaultIpReporterConfig(), apiKey: '(stored)' },
  configured_secrets: ['apiKey'],
  created_at: '2026-10-30T00:00:00.000Z',
  updated_at: '2026-10-30T00:00:00.000Z',
  last_attempt_at: '2026-10-30T06:00:00.000Z',
  last_success_at: '2026-10-30T06:00:00.000Z',
  next_run_at: '2026-10-30T12:00:00.000Z',
  last_run: null,
};

describe('Settings IP reports', () => {
  test('is hidden from users who cannot manage settings', async () => {
    mockConfig(false);
    render(<SettingsRouter tab="ip-reports"><Settings /></SettingsRouter>);

    expect(await screen.findByRole('tab', { name: 'pages.settings.account' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'pages.settings.ipReports.tab' })).not.toBeInTheDocument();
  });

  test('previews and saves a reporter with parsed categories and patterns', async () => {
    const user = userEvent.setup();
    mockConfig(true);
    vi.mocked(fetchIpReporters).mockResolvedValue([reporter]);
    vi.mocked(previewIpReports).mockResolvedValue({
      window_start: '2026-10-30T05:45:00.000Z',
      window_end: '2026-10-30T12:00:00.000Z',
      total: 1,
      rows: [{ ip: '203.0.113.10', categories: [18, 22], report_date: '2026-10-30T11:00:00.000Z', comment: 'CrowdSec detected ssh-bf', alerts: 3, scenarios: ['crowdsecurity/ssh-bf'] }],
      skipped: { cooldown: 2, allowlisted: 0, not_public: 1, below_threshold: 0, over_limit: 0 },
    });
    vi.mocked(saveIpReporter).mockImplementation(async (_id, data) => ({ ...reporter, name: data.name }));

    render(<SettingsRouter tab="ip-reports"><Settings /></SettingsRouter>);
    const row = await screen.findByTestId('ip-reporter-reporter-1');
    expect(within(row).getByText('AbuseIPDB main')).toBeInTheDocument();
    expect(within(row).getByText('pages.settings.ipReports.modes.bulk')).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'pages.settings.ipReports.edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'pages.settings.ipReports.editTitle' });
    expect(within(dialog).getByText('pages.settings.ipReports.modes.bulkHelp')).toBeInTheDocument();
    expect(within(dialog).getByText('pages.settings.ipReports.modes.singleHelp')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('pages.settings.ipReports.apiKey')).toHaveAttribute('placeholder', 'pages.notifications.unchanged');

    await user.click(within(dialog).getByRole('radio', { name: /pages\.settings\.ipReports\.modes\.single/ }));
    await user.type(within(dialog).getByLabelText('pages.settings.ipReports.excludeScenarios'), 'crowdsecurity/http-crawl-*');
    const defaults = within(dialog).getByLabelText('pages.settings.ipReports.defaultCategories');
    await user.clear(defaults);
    await user.type(defaults, '15, 21, 99');

    await user.click(within(dialog).getByRole('button', { name: 'pages.settings.ipReports.preview' }));
    expect(await within(dialog).findByText('203.0.113.10')).toBeInTheDocument();
    expect(previewIpReports).toHaveBeenCalledWith(expect.objectContaining({ id: 'reporter-1' }));

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveIpReporter).toHaveBeenCalledTimes(1));
    const [id, payload] = vi.mocked(saveIpReporter).mock.calls[0];
    expect(id).toBe('reporter-1');
    expect(payload.config).toMatchObject({
      apiKey: '(stored)',
      submitMode: 'single',
      excludeScenarios: ['crowdsecurity/http-crawl-*'],
      defaultCategories: [15, 21],
    });
  });

  test('runs a reporter on demand and reloads the list', async () => {
    const user = userEvent.setup();
    mockConfig(true);
    vi.mocked(fetchIpReporters).mockResolvedValue([reporter]);
    vi.mocked(runIpReporter).mockResolvedValue({
      id: 'run-1',
      reporter_id: 'reporter-1',
      trigger: 'manual',
      status: 'success',
      started_at: '2026-10-30T12:00:00.000Z',
      finished_at: '2026-10-30T12:00:01.000Z',
      window_start: '2026-10-30T05:45:00.000Z',
      window_end: '2026-10-30T12:00:00.000Z',
      candidates: 4,
      submitted: 4,
      saved: 4,
      rejected: [],
      skipped: { cooldown: 0, allowlisted: 0, not_public: 0, below_threshold: 0, over_limit: 0 },
    });

    render(<SettingsRouter tab="ip-reports"><Settings /></SettingsRouter>);
    const row = await screen.findByTestId('ip-reporter-reporter-1');
    await user.click(within(row).getByRole('button', { name: 'pages.settings.ipReports.runNow' }));

    await waitFor(() => expect(runIpReporter).toHaveBeenCalledWith('reporter-1'));
    await waitFor(() => expect(fetchIpReporters).toHaveBeenCalledTimes(2));
  });
});
