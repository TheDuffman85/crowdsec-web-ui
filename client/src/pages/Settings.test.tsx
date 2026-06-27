import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Settings } from './Settings';
import { fetchConfig } from '../lib/api';
import { useRefresh } from '../contexts/useRefresh';

const { setLanguagePreferenceMock, tMock } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'common.save': 'Save',
    'common.saving': 'Saving...',
    'components.sidebar.refresh.every30Seconds': 'Every 30s',
    'components.sidebar.refresh.every5Minutes': 'Every 5m',
    'components.sidebar.refresh.every5Seconds': 'Every 5s',
    'components.sidebar.refresh.every1Minute': 'Every 1m',
    'components.sidebar.refresh.off': 'Off',
    'languages.de': 'Deutsch',
    'languages.en': 'English',
    'pages.settings.failedToLoadSettings': 'Failed to load settings.',
    'pages.settings.general': 'General',
    'pages.settings.generalDescription': 'Manage interface preferences.',
    'pages.settings.language': 'Language',
    'pages.settings.languageDescription': 'Choose the language used by the interface.',
    'pages.settings.languageHelp': 'Browser default help.',
    'pages.settings.readOnlyRefresh': 'Read-only mode is enabled.',
    'pages.settings.refresh': 'Refresh',
    'pages.settings.refreshDescription': 'Control automatic refreshes.',
    'pages.settings.refreshHelp': 'Refresh help.',
    'pages.settings.refreshInterval': 'Refresh interval',
    'pages.settings.authDisabledHint': 'Dashboard authentication is disabled. Set CROWDSEC_AUTH_ENABLED=true and restart the web UI to enable sign-in and account settings.',
  };

  return {
    setLanguagePreferenceMock: vi.fn(),
    tMock: (key: string, values?: Record<string, string | number>) => {
      if (key === 'pages.settings.browserDefaultLanguage') {
        return `Browser default (${values?.language ?? ''})`;
      }
      return translations[key] ?? key;
    },
  };
});

vi.mock('../lib/api', () => ({
  fetchConfig: vi.fn(),
}));

vi.mock('../contexts/useRefresh', () => ({
  useRefresh: vi.fn(),
}));

vi.mock('../lib/i18n', () => ({
  BROWSER_LANGUAGE_SETTING: 'browser',
  SUPPORTED_LANGUAGES: [
    { code: 'en', labelKey: 'languages.en' },
    { code: 'de', labelKey: 'languages.de' },
  ],
  getLanguageLabelKey: (language: string) => `languages.${language}`,
  useI18n: () => ({
    browserLanguage: 'en',
    preference: 'browser',
    setLanguagePreference: setLanguagePreferenceMock,
    t: tMock,
  }),
}));

describe('Settings', () => {
  beforeEach(() => {
    setLanguagePreferenceMock.mockReset();
    vi.mocked(useRefresh).mockReturnValue({
      intervalMs: 30000,
      setIntervalMs: vi.fn(),
      lastUpdated: null,
      setLastUpdated: vi.fn(),
      refreshSignal: 0,
      syncStatus: null,
    });
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
      permissions: {
        mode: 'read-only',
        can_manage_enforcement: false,
        can_manage_settings: false,
      },
    });
  });

  test('keeps language editable but disables refresh in read-only mode', async () => {
    render(<Settings />);

    await waitFor(() => expect(fetchConfig).toHaveBeenCalled());

    expect(screen.getByLabelText('Language')).toBeEnabled();
    expect(screen.getByLabelText('Refresh interval')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByText('Read-only mode is enabled.')).toBeInTheDocument();
    expect(screen.getByText('Dashboard authentication is disabled. Set CROWDSEC_AUTH_ENABLED=true and restart the web UI to enable sign-in and account settings.')).toBeInTheDocument();
  });

  test('only applies language changes when saved', async () => {
    const user = userEvent.setup();
    render(<Settings />);

    await waitFor(() => expect(fetchConfig).toHaveBeenCalled());

    await user.selectOptions(screen.getByLabelText('Language'), 'de');
    expect(setLanguagePreferenceMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(setLanguagePreferenceMock).toHaveBeenCalledWith('de');
  });
});
