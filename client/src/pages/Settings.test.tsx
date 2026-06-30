import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Settings } from './Settings';
import { fetchConfig, updateMetricsSidebarPreference } from '../lib/api';
import { useRefresh } from '../contexts/useRefresh';

const { setLanguagePreferenceMock, tMock, useAuthMock } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'common.cancel': 'Cancel',
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
    'pages.settings.settingsSaved': 'Settings saved.',
    'pages.settings.failedToSaveSettings': 'Failed to save settings.',
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
    'pages.settings.showMetricsInSidebar': 'Show Metrics in sidebar',
    'pages.settings.showMetricsInSidebarHelp': 'Metrics sidebar help.',
    'pages.settings.authDisabledHint': 'Dashboard authentication is disabled. Set AUTH_ENABLED=true and restart the web UI to enable sign-in and account settings.',
    'pages.settings.authentication': 'Authentication',
    'pages.settings.authenticationDescription': 'Manage account sign-in methods.',
    'pages.settings.password': 'Password',
    'pages.settings.passwordDescription': 'Change your local password or disable password login after another sign-in method is configured.',
    'pages.settings.disablePasswordLogin': 'Disable password login',
    'pages.settings.disablePasswordLoginDescription': 'When enabled, only passkeys and SSO can be used to sign in.',
    'pages.settings.currentPassword': 'Current password',
    'pages.settings.newPassword': 'New password',
    'pages.settings.confirmPassword': 'Confirm password',
    'pages.settings.changePassword': 'Change Password',
    'pages.settings.passkeys': 'Passkeys',
    'pages.settings.passkeysDescription': 'Register hardware keys, platform authenticators, or synced passkeys for passwordless sign-in.',
    'pages.settings.noPasskeys': 'No passkeys registered.',
    'pages.settings.passkey': 'Passkey',
    'pages.settings.passkeyAdded': 'Added {date}',
    'pages.settings.removePasskey': 'Remove passkey',
    'pages.settings.registerNewPasskey': 'Register New Passkey',
    'pages.settings.passkeyNamePrompt': 'Passkey name',
    'pages.settings.passkeyNameDefault': 'Security key',
    'pages.settings.registerPasskeyTitle': 'Register New Passkey',
    'pages.settings.registerPasskeyDescription': 'Give this passkey a recognizable name, then follow your browser or device prompt to finish registration.',
    'pages.settings.registerPasskeySubmit': 'Register Passkey',
    'pages.settings.oidcSso': 'OIDC (SSO)',
    'pages.settings.oidcDescription': 'Configure the provider connection and optional group mapping for admin and read-only access.',
    'pages.settings.oidcIssuerUrl': 'Issuer URL',
    'pages.settings.oidcClientId': 'Client ID',
    'pages.settings.oidcClientSecret': 'Client Secret',
    'pages.settings.unchanged': '(unchanged)',
    'pages.settings.oidcGroupsClaim': 'Groups Claim',
    'pages.settings.oidcAdminGroups': 'Admin Groups',
    'pages.settings.oidcReadOnlyGroups': 'Read-only Groups',
    'pages.settings.oidcUnmatchedRole': 'Unmatched OIDC users',
    'pages.settings.oidcUnmatchedRoleDeny': 'Deny sign-in',
    'pages.settings.oidcUnmatchedRoleAdmin': 'Admin access',
    'pages.settings.oidcUnmatchedRoleReadOnly': 'Read-only access',
    'pages.settings.addGroup': 'Add',
    'pages.settings.noGroupsConfigured': 'No groups configured.',
    'pages.settings.removeGroup': 'Remove {group}',
    'pages.settings.oidcGroupsHelp': 'Choose what happens when an OIDC user matches no configured group. The default is deny sign-in.',
    'pages.settings.saveOidcSettings': 'Save OIDC Settings',
    'pages.settings.oidcSettingsSaved': 'OIDC settings saved.',
    'pages.settings.failedToSaveOidcSettings': 'Failed to save OIDC settings.',
  };

  return {
    setLanguagePreferenceMock: vi.fn(),
    useAuthMock: vi.fn(),
    tMock: (key: string, values?: Record<string, string | number>) => {
      if (key === 'pages.settings.browserDefaultLanguage') {
        return `Browser default (${values?.language ?? ''})`;
      }
      const translation = translations[key] ?? key;
      return Object.entries(values ?? {}).reduce(
        (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
        translation,
      );
    },
  };
});

vi.mock('../lib/api', () => ({
  fetchConfig: vi.fn(),
  updateMetricsSidebarPreference: vi.fn(),
}));

vi.mock('../contexts/useRefresh', () => ({
  useRefresh: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: useAuthMock,
}));

vi.mock('../lib/i18n', () => ({
  BROWSER_LANGUAGE_SETTING: 'browser',
  SUPPORTED_LANGUAGES: [
    { code: 'en', labelKey: 'languages.en' },
    { code: 'de', labelKey: 'languages.de' },
  ],
  getLanguageLabelKey: (language: string) => `languages.${language}`,
  resolveLanguagePreference: (preference: string) => preference === 'browser' ? 'en' : preference,
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
    vi.mocked(updateMetricsSidebarPreference).mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({
      authEnabled: false,
      setupRequired: false,
      authenticated: true,
      user: null,
      authMethod: null,
      oidcEnabled: false,
      passwordLoginDisabled: false,
      passkeysEnabled: false,
      hasPassword: false,
      loading: false,
      refresh: vi.fn(),
      login: vi.fn(),
      setup: vi.fn(),
      logout: vi.fn(),
    });
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
      metrics_enabled: false,
      metrics_sidebar_visible: true,
      permissions: {
        mode: 'read-only',
        can_manage_enforcement: false,
        can_manage_settings: false,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('keeps language editable but disables refresh in read-only mode', async () => {
    render(<Settings />);

    await waitFor(() => expect(fetchConfig).toHaveBeenCalled());

    expect(screen.getByLabelText('Language')).toBeEnabled();
    expect(screen.getByLabelText('Refresh interval')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByText('Read-only mode is enabled.')).toBeInTheDocument();
    expect(screen.getByText('Dashboard authentication is disabled. Set AUTH_ENABLED=true and restart the web UI to enable sign-in and account settings.')).toBeInTheDocument();
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

  test('saves metrics sidebar visibility from the general settings form', async () => {
    const user = userEvent.setup();
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
      metrics_enabled: true,
      metrics_sidebar_visible: true,
      permissions: {
        mode: 'read-only',
        can_manage_enforcement: false,
        can_manage_settings: false,
      },
    });
    vi.mocked(updateMetricsSidebarPreference).mockResolvedValue({
      success: true,
      metrics_sidebar_visible: false,
    });

    render(<Settings />);

    await waitFor(() => expect(fetchConfig).toHaveBeenCalled());

    await user.click(screen.getByRole('switch', { name: 'Show Metrics in sidebar' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateMetricsSidebarPreference).toHaveBeenCalledWith({ visible: false });
  });

  test('saves password login setting only from its own save button', async () => {
    const user = userEvent.setup();
    const refreshAuth = vi.fn();
    useAuthMock.mockReturnValue({
      authEnabled: true,
      setupRequired: false,
      authenticated: true,
      user: { userId: 1, username: 'admin', role: 'admin' },
      authMethod: 'password',
      oidcEnabled: false,
      passwordLoginDisabled: false,
      passkeysEnabled: true,
      hasPassword: true,
      loading: false,
      refresh: refreshAuth,
      login: vi.fn(),
      setup: vi.fn(),
      logout: vi.fn(),
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
        mode: 'admin',
        can_manage_enforcement: true,
        can_manage_settings: true,
      },
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || (input instanceof Request ? input.method : 'GET');
      if (url.includes('/api/auth/passkeys')) {
        return Response.json({ passkeys: [{ id: 1, name: 'Security key', createdAt: '2026-01-01T00:00:00.000Z' }] });
      }
      if (url.includes('/api/auth/settings') && method === 'PUT') {
        return Response.json({ status: 'ok', settings: { disablePasswordLogin: true } });
      }
      if (url.includes('/api/auth/settings')) {
        return Response.json({
          disablePasswordLogin: false,
          oidcIssuerUrl: '',
          oidcClientId: '',
          hasOidcClientSecret: false,
          oidcGroupsClaim: 'groups',
          oidcAdminGroups: '',
          oidcReadOnlyGroups: '',
          oidcUnmatchedRole: 'deny',
          hasPassword: true,
          authMethod: 'password',
        });
      }
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Settings />);

    await screen.findByText('Authentication');
    await user.click(screen.getByLabelText(/Disable password login/i));

    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/settings'),
      expect.objectContaining({ method: 'PUT' }),
    );

    await user.click(screen.getAllByRole('button', { name: 'Save' })[1]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/settings'),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ disablePasswordLogin: true }),
      }),
    ));
    expect(refreshAuth).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Change Password' })).toBeInTheDocument();
  });

  test('hides password change when the session was not password-authenticated', async () => {
    useAuthMock.mockReturnValue({
      authEnabled: true,
      setupRequired: false,
      authenticated: true,
      user: { userId: 1, username: 'admin', role: 'admin' },
      authMethod: 'passkey',
      oidcEnabled: false,
      passwordLoginDisabled: false,
      passkeysEnabled: true,
      hasPassword: true,
      loading: false,
      refresh: vi.fn(),
      login: vi.fn(),
      setup: vi.fn(),
      logout: vi.fn(),
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/auth/passkeys')) {
        return Response.json({ passkeys: [] });
      }
      if (url.includes('/api/auth/settings')) {
        return Response.json({
          disablePasswordLogin: false,
          oidcIssuerUrl: '',
          oidcClientId: '',
          hasOidcClientSecret: false,
          oidcGroupsClaim: 'groups',
          oidcAdminGroups: '',
          oidcReadOnlyGroups: '',
          oidcUnmatchedRole: 'deny',
          hasPassword: true,
          authMethod: 'passkey',
        });
      }
      return Response.json({});
    }));

    render(<Settings />);

    await screen.findByText('Authentication');

    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change Password' })).not.toBeInTheDocument();
  });

  test('registers a passkey from the modal with the configured name', async () => {
    const user = userEvent.setup();
    useAuthMock.mockReturnValue({
      authEnabled: true,
      setupRequired: false,
      authenticated: true,
      user: { userId: 1, username: 'admin', role: 'admin' },
      authMethod: 'password',
      oidcEnabled: false,
      passwordLoginDisabled: false,
      passkeysEnabled: true,
      hasPassword: true,
      loading: false,
      refresh: vi.fn(),
      login: vi.fn(),
      setup: vi.fn(),
      logout: vi.fn(),
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
        mode: 'admin',
        can_manage_enforcement: true,
        can_manage_settings: true,
      },
    });

    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        create: vi.fn().mockResolvedValue({
          id: 'credential-id',
          rawId: new Uint8Array([1, 2, 3]).buffer,
          type: 'public-key',
          response: {
            attestationObject: new Uint8Array([4, 5, 6]).buffer,
            clientDataJSON: new Uint8Array([7, 8, 9]).buffer,
            getTransports: () => ['internal'],
          },
        }),
      },
    });

    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || (input instanceof Request ? input.method : 'GET');
      if (url.includes('/api/auth/webauthn/register/options')) {
        return Response.json({
          challenge: 'AQID',
          rp: { name: 'CrowdSec Web UI', id: 'localhost' },
          user: { id: 'BAUG', name: 'admin', displayName: 'admin' },
          pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
        });
      }
      if (url.includes('/api/auth/webauthn/register/verify')) {
        return Response.json({ status: 'ok' });
      }
      if (url.includes('/api/auth/passkeys')) {
        return Response.json({
          passkeys: method === 'GET' && fetchMock.mock.calls.some(([calledInput]) => String(calledInput).includes('/api/auth/webauthn/register/verify'))
            ? [{ id: 1, name: 'Laptop Touch ID', createdAt: '2026-01-01T00:00:00.000Z' }]
            : [],
        });
      }
      if (url.includes('/api/auth/settings')) {
        return Response.json({
          disablePasswordLogin: false,
          oidcIssuerUrl: '',
          oidcClientId: '',
          hasOidcClientSecret: false,
          oidcGroupsClaim: 'groups',
          oidcAdminGroups: '',
          oidcReadOnlyGroups: '',
          oidcUnmatchedRole: 'deny',
          hasPassword: true,
          authMethod: 'password',
        });
      }
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Settings />);

    await screen.findByText('Authentication');
    await user.click(screen.getByRole('button', { name: 'Register New Passkey' }));

    const dialog = screen.getByRole('dialog', { name: 'Register New Passkey' });
    await user.clear(screen.getByLabelText('Passkey name'));
    await user.type(screen.getByLabelText('Passkey name'), 'Laptop Touch ID');
    await user.click(screen.getByRole('button', { name: 'Register Passkey' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/webauthn/register/verify'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"name":"Laptop Touch ID"'),
      }),
    ));
    expect(dialog).not.toBeInTheDocument();
    expect(screen.getByText('Laptop Touch ID')).toBeInTheDocument();
  });

  test('edits OIDC groups as lists and serializes them for the API', async () => {
    const user = userEvent.setup();
    useAuthMock.mockReturnValue({
      authEnabled: true,
      setupRequired: false,
      authenticated: true,
      user: { userId: 1, username: 'admin', role: 'admin' },
      authMethod: 'password',
      oidcEnabled: true,
      passwordLoginDisabled: false,
      passkeysEnabled: true,
      hasPassword: true,
      loading: false,
      refresh: vi.fn(),
      login: vi.fn(),
      setup: vi.fn(),
      logout: vi.fn(),
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
        mode: 'admin',
        can_manage_enforcement: true,
        can_manage_settings: true,
      },
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || (input instanceof Request ? input.method : 'GET');
      if (url.includes('/api/auth/passkeys')) {
        return Response.json({ passkeys: [] });
      }
      if (url.includes('/api/auth/settings') && method === 'PUT') {
        return Response.json({ status: 'ok', settings: {} });
      }
      if (url.includes('/api/auth/settings')) {
        return Response.json({
          disablePasswordLogin: false,
          oidcIssuerUrl: 'https://idp.example.com',
          oidcClientId: 'crowdsec',
          hasOidcClientSecret: false,
          oidcGroupsClaim: 'groups',
          oidcAdminGroups: 'Application Admin,secops',
          oidcReadOnlyGroups: 'Application User',
          oidcUnmatchedRole: 'deny',
          hasPassword: true,
          authMethod: 'password',
        });
      }
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Settings />);

    await screen.findByText('Application Admin');
    expect(screen.getByLabelText('Unmatched OIDC users')).toHaveValue('deny');
    expect(screen.getByLabelText('Unmatched OIDC users')).toHaveAccessibleDescription('Choose what happens when an OIDC user matches no configured group. The default is deny sign-in.');
    await user.click(screen.getByRole('button', { name: 'Remove secops' }));
    await user.type(screen.getByLabelText('Admin Groups'), 'security-team');
    await user.click(screen.getAllByRole('button', { name: 'Add' })[0]);
    await user.selectOptions(screen.getByLabelText('Unmatched OIDC users'), 'admin');
    await user.click(screen.getByRole('button', { name: 'Save OIDC Settings' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/settings'),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          oidcIssuerUrl: 'https://idp.example.com',
          oidcClientId: 'crowdsec',
          oidcClientSecret: '',
          oidcGroupsClaim: 'groups',
          oidcAdminGroups: 'Application Admin,security-team',
          oidcReadOnlyGroups: 'Application User',
          oidcUnmatchedRole: 'admin',
        }),
      }),
    ));
  });
});
