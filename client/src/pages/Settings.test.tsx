import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Settings } from './Settings';
import { fetchConfig, updateManualRefreshSetting, updateMetricsSidebarPreference } from '../lib/api';
import { useRefresh } from '../contexts/useRefresh';
import { DateTimeContext, createDateTimeContextValue } from '../lib/dateTime';

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
    'pages.settings.refreshDescription': 'Control how often the backend imports CrowdSec changes.',
    'pages.settings.refreshHelp': 'Pages update immediately after each LAPI refresh.',
    'pages.settings.refreshInterval': 'Refresh interval',
    'pages.settings.enableManualRefresh': 'Enable manual refresh',
    'pages.settings.enableManualRefreshHelp': 'Manual refresh help.',
    'pages.settings.showMetricsInSidebar': 'Show Metrics in sidebar',
    'pages.settings.showMetricsInSidebarHelp': 'Metrics sidebar help.',
    'pages.settings.authDisabledHint': 'Dashboard authentication is disabled. Set CONFIG_AUTH_ENABLED=true and restart the web UI to enable sign-in and account settings.',
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
    'pages.settings.totpTitle': 'Authenticator app (TOTP)',
    'pages.settings.totpDescription': 'Require a time-based code after password sign-in.',
    'pages.settings.totpEnabledDescription': 'Authenticator codes are required after password sign-in.',
    'pages.settings.setupTotp': 'Set Up TOTP',
    'pages.settings.manageTotp': 'Manage TOTP',
    'pages.settings.setupTotpTitle': 'Set Up TOTP',
    'pages.settings.manageTotpTitle': 'Manage TOTP',
    'pages.settings.setupTotpDescription': 'Scan the QR code with an authenticator app, or open the setup link on this device. Enter the generated code to finish setup.',
    'pages.settings.disableTotpDescription': 'Disabling TOTP removes the extra code requirement from password sign-in. Confirm with your current password.',
    'pages.settings.manualTotpSecret': 'Manual setup key',
    'pages.settings.copyTotpSecret': 'Copy setup key',
    'pages.settings.openAuthenticatorApp': 'Open in authenticator app',
    'pages.settings.authenticatorCode': 'Authenticator code',
    'pages.settings.verifyAndEnableTotp': 'Verify and Enable',
    'pages.settings.disableTotp': 'Disable TOTP',
    'pages.settings.totpQrAlt': 'TOTP setup QR code',
    'pages.settings.generatingQrCode': 'Generating QR code...',
    'pages.settings.failedToStartTotpSetup': 'Failed to start TOTP setup.',
    'pages.settings.failedToEnableTotp': 'Failed to enable TOTP.',
    'pages.settings.failedToDisableTotp': 'Failed to disable TOTP.',
    'pages.settings.totpEnabled': 'TOTP enabled.',
    'pages.settings.totpDisabled': 'TOTP disabled.',
    'pages.settings.copied': 'Copied.',
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
    'pages.settings.oidcScope': 'Scopes',
    'pages.settings.oidcGroupsClaim': 'Groups Claim',
    'pages.settings.oidcAdminGroups': 'Admin Groups',
    'pages.settings.oidcReadOnlyGroups': 'Read-only Groups',
    'pages.settings.oidcUnmatchedRole': 'Unmatched OIDC users',
    'pages.settings.oidcUnmatchedRoleDeny': 'Deny sign-in',
    'pages.settings.oidcUnmatchedRoleAdmin': 'Admin access',
    'pages.settings.oidcUnmatchedRoleReadOnly': 'Read-only access',
    'pages.settings.addGroup': 'Add',
    'pages.settings.noScopesConfigured': 'No scopes configured.',
    'pages.settings.removeScope': 'Remove {scope}',
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
  updateManualRefreshSetting: vi.fn(),
  updateMetricsSidebarPreference: vi.fn(),
}));

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr'),
  },
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
    vi.mocked(updateManualRefreshSetting).mockReset();
    vi.mocked(updateManualRefreshSetting).mockResolvedValue({
      success: true,
      manual_refresh_enabled: true,
    });
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
      totpEnabled: false,
      loading: false,
      refresh: vi.fn(),
      login: vi.fn(),
      setup: vi.fn(),
      logout: vi.fn(),
    });
    vi.mocked(useRefresh).mockReturnValue({
      intervalMs: 30000,
      nextRefreshAt: null,
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
    expect(screen.getByText('Dashboard authentication is disabled. Set CONFIG_AUTH_ENABLED=true and restart the web UI to enable sign-in and account settings.')).toBeInTheDocument();
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

  test('enables manual refresh from the general settings form', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchConfig).mockResolvedValue({
      lookback_period: '1h',
      lookback_hours: 1,
      lookback_days: 1,
      refresh_interval: 30000,
      manual_refresh_enabled: false,
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

    render(<Settings />);
    await waitFor(() => expect(fetchConfig).toHaveBeenCalled());

    await user.click(screen.getByRole('switch', { name: 'Enable manual refresh' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateManualRefreshSetting).toHaveBeenCalledWith({ enabled: true });
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
      totpEnabled: false,
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
          oidcScope: 'openid profile email',
          oidcGroupsClaim: 'groups',
          oidcAdminGroups: '',
          oidcReadOnlyGroups: '',
          oidcUnmatchedRole: 'deny',
          hasPassword: true,
          totpEnabled: false,
          authMethod: 'password',
        });
      }
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const dateTime = createDateTimeContextValue({ timeZone: 'America/Los_Angeles', timeFormat: '24h' });
    render(
      <DateTimeContext.Provider value={dateTime}>
        <Settings />
      </DateTimeContext.Provider>,
    );

    await screen.findByText('Authentication');
    expect(screen.getByText(`Added ${dateTime.formatDate('2026-01-01T00:00:00.000Z')}`)).toBeInTheDocument();
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

  test('hides password-backed settings when the session was not password-authenticated', async () => {
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
      totpEnabled: false,
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
          oidcScope: 'openid profile email',
          oidcGroupsClaim: 'groups',
          oidcAdminGroups: '',
          oidcReadOnlyGroups: '',
          oidcUnmatchedRole: 'deny',
          hasPassword: true,
          totpEnabled: false,
          authMethod: 'passkey',
        });
      }
      return Response.json({});
    }));

    render(<Settings />);

    await screen.findByText('Authentication');

    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change Password' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set Up TOTP' })).not.toBeInTheDocument();
  });

  test('hides passkey settings and does not request passkeys for an OIDC-only account', async () => {
    useAuthMock.mockReturnValue({
      authEnabled: true,
      setupRequired: false,
      authenticated: true,
      user: { userId: 1, username: 'oidc-admin', role: 'admin' },
      authMethod: 'oidc',
      oidcEnabled: true,
      passwordLoginDisabled: true,
      passkeysEnabled: false,
      hasPassword: false,
      totpEnabled: false,
      loading: false,
      refresh: vi.fn(),
      login: vi.fn(),
      setup: vi.fn(),
      logout: vi.fn(),
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/auth/settings')) {
        return Response.json({
          disablePasswordLogin: true,
          oidcIssuerUrl: 'https://idp.example.com',
          oidcClientId: 'crowdsec-web-ui',
          hasOidcClientSecret: true,
          oidcScope: 'openid profile email',
          oidcGroupsClaim: 'groups',
          oidcAdminGroups: 'admins',
          oidcReadOnlyGroups: '',
          oidcUnmatchedRole: 'deny',
          hasPassword: false,
          passkeysAvailable: false,
          totpEnabled: false,
          authMethod: 'oidc',
        });
      }
      return Response.json({ passkeys: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Settings />);

    await screen.findByText('Authentication');

    await waitFor(() => expect(screen.queryByText('Passkeys')).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/api/auth/passkeys'));
  });

  test('sets up TOTP from the password authentication modal', async () => {
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
      totpEnabled: false,
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
      if (url.includes('/api/auth/totp/setup')) {
        return Response.json({
          secret: 'JBSWY3DPEHPK3PXP',
          otpauthUrl: 'otpauth://totp/CrowdSec%20Web%20UI:admin?secret=JBSWY3DPEHPK3PXP&issuer=CrowdSec%20Web%20UI',
        });
      }
      if (url.includes('/api/auth/totp') && method === 'POST') {
        return Response.json({ status: 'ok', totpEnabled: true });
      }
      if (url.includes('/api/auth/passkeys')) {
        return Response.json({ passkeys: [] });
      }
      if (url.includes('/api/auth/settings')) {
        return Response.json({
          disablePasswordLogin: false,
          oidcIssuerUrl: '',
          oidcClientId: '',
          hasOidcClientSecret: false,
          oidcScope: 'openid profile email',
          oidcGroupsClaim: 'groups',
          oidcAdminGroups: '',
          oidcReadOnlyGroups: '',
          oidcUnmatchedRole: 'deny',
          hasPassword: true,
          totpEnabled: false,
          authMethod: 'password',
        });
      }
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Settings />);

    await screen.findByText('Authentication');
    await user.click(screen.getByRole('button', { name: 'Set Up TOTP' }));

    const dialog = await screen.findByRole('dialog', { name: 'Set Up TOTP' });
    expect(await screen.findByAltText('TOTP setup QR code')).toHaveAttribute('src', 'data:image/png;base64,qr');
    expect(screen.getByLabelText('Manual setup key')).toHaveValue('JBSWY3DPEHPK3PXP');
    expect(screen.getByRole('link', { name: 'Open in authenticator app' })).toHaveAttribute('href', expect.stringContaining('otpauth://totp/'));

    await user.type(screen.getByLabelText('Authenticator code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and Enable' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/totp/enable'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ code: '123456' }),
      }),
    ));
    expect(dialog).not.toBeInTheDocument();
  });

  test('requires only the current password when disabling TOTP', async () => {
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
      totpEnabled: true,
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
      if (url.includes('/api/auth/totp') && method === 'DELETE') {
        return Response.json({ status: 'ok', totpEnabled: false });
      }
      if (url.includes('/api/auth/passkeys')) {
        return Response.json({ passkeys: [] });
      }
      if (url.includes('/api/auth/settings')) {
        return Response.json({
          disablePasswordLogin: false,
          oidcIssuerUrl: '',
          oidcClientId: '',
          hasOidcClientSecret: false,
          oidcScope: 'openid profile email',
          oidcGroupsClaim: 'groups',
          oidcAdminGroups: '',
          oidcReadOnlyGroups: '',
          oidcUnmatchedRole: 'deny',
          hasPassword: true,
          totpEnabled: true,
          authMethod: 'password',
        });
      }
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Settings />);

    await screen.findByText('Authentication');
    await user.click(screen.getByRole('button', { name: 'Manage TOTP' }));

    const dialog = screen.getByRole('dialog', { name: 'Manage TOTP' });
    expect(within(dialog).getByRole('button', { name: 'Disable TOTP' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Current password'), 'Secret123');
    expect(within(dialog).queryByLabelText('Authenticator code')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Disable TOTP' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/totp'),
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ currentPassword: 'Secret123' }),
      }),
    ));
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
      totpEnabled: false,
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
          oidcScope: 'openid profile email',
          oidcGroupsClaim: 'groups',
          oidcAdminGroups: '',
          oidcReadOnlyGroups: '',
          oidcUnmatchedRole: 'deny',
          hasPassword: true,
          totpEnabled: false,
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
      totpEnabled: false,
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
          oidcScope: 'openid profile email',
          oidcGroupsClaim: 'groups',
          oidcAdminGroups: 'Application Admin,secops',
          oidcReadOnlyGroups: 'Application User',
          oidcUnmatchedRole: 'deny',
          hasPassword: true,
          totpEnabled: false,
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
    expect(screen.queryByRole('button', { name: 'Remove openid' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove email' }));
    await user.type(screen.getByLabelText('Scopes'), 'groups');
    await user.click(screen.getAllByRole('button', { name: 'Add' })[0]);
    await user.type(screen.getByLabelText('Scopes'), 'offline_access');
    await user.click(screen.getAllByRole('button', { name: 'Add' })[0]);
    await user.click(screen.getByRole('button', { name: 'Remove secops' }));
    await user.type(screen.getByLabelText('Admin Groups'), 'security-team');
    await user.click(screen.getAllByRole('button', { name: 'Add' })[1]);
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
          oidcScope: 'openid profile groups offline_access',
          oidcGroupsClaim: 'groups',
          oidcAdminGroups: 'Application Admin,security-team',
          oidcReadOnlyGroups: 'Application User',
          oidcUnmatchedRole: 'admin',
        }),
      }),
    ));
  });
});
