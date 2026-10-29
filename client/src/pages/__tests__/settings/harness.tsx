import { afterEach, beforeEach, vi } from 'vitest';
import { fetchConfig, updateAllowlistsSidebarPreference, updateManualRefreshSetting, updateMetricsSidebarPreference } from '../../../lib/api';
import { useRefresh } from '../../../contexts/useRefresh';

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
    'pages.settings.font': 'Font',
    'pages.settings.fontAuto': 'Match language ({font})',
    'pages.settings.fontSystem': 'System default',
    'pages.settings.manualDecisionScenarios': 'Scenarios',
    'pages.settings.manualDecisionScenarioInvalid': '"{scenario}" is not a valid scenario.',
    'pages.settings.manualDecisionScenariosSaved': 'Scenarios saved',
    'pages.settings.removeManualDecisionScenario': 'Remove {scenario}',
    'pages.settings.refresh': 'Refresh',
    'pages.settings.refreshDescription': 'Control how often the backend imports CrowdSec changes.',
    'pages.settings.refreshHelp': 'Pages update immediately after each LAPI refresh.',
    'pages.settings.refreshInterval': 'Refresh interval',
    'pages.settings.enableManualRefresh': 'Enable manual refresh',
    'pages.settings.enableManualRefreshHelp': 'Manual refresh help.',
    'pages.settings.showMetricsInSidebar': 'Show Metrics in sidebar',
    'pages.settings.showMetricsInSidebarHelp': 'Metrics sidebar help.',
    'pages.settings.showAllowlistsInSidebar': 'Show Allowlists in sidebar',
    'pages.settings.showAllowlistsInSidebarHelp': 'Allowlists sidebar help.',
    'pages.settings.authDisabledHint': 'Dashboard authentication is disabled. Set CONFIG_AUTH_ENABLED=true and restart the web UI to enable sign-in and account settings.',
    'pages.settings.authentication': 'Authentication',
    'pages.settings.authenticationDescription': 'Manage account sign-in methods.',
    'pages.settings.password': 'Password',
    'pages.settings.passwordDescription': 'Change your local password or disable password login after another sign-in method is configured.',
    'pages.settings.disablePasswordLogin': 'Disable password login',
    'pages.settings.disablePasswordLoginDescription': 'When enabled, only passkeys and SSO can be used to sign in.',
    'pages.settings.managedByConfig': 'Managed by {setting} in the config file. To manage it here, remove it there and restart.',
    'pages.settings.managedByEnvironment': 'Managed by the {setting} environment variable. To manage it here, remove it and any copy in the config file, then restart.',
    'pages.settings.passwordLoginFallback': 'The config file disables password login, but it stays enabled until OIDC or a passkey is configured.',
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
    'pages.settings.oidcEndSession': 'Sign out of the identity provider on logout',
    'pages.settings.oidcEndSessionHelp': 'When an SSO user logs out, also end their session at the identity provider so the next SSO sign-in asks for credentials again. Register {url} as a post-logout redirect URI with your provider.',
    'pages.settings.oidcBackchannelLogout': 'End sessions when signing out at the identity provider',
    'pages.settings.oidcBackchannelLogoutHelp': 'Accept OpenID Connect back-channel logout notifications, so signing out at the identity provider also ends dashboard sessions. Register {url} as the back-channel logout URI with your provider.',
    'pages.settings.oidcAutoLogin': 'Sign in with SSO automatically',
    'pages.settings.oidcAutoLoginHelp': 'Skip the login page and go straight to the identity provider. Only applies while OIDC is configured and password login is disabled. Open {url} to reach the login page anyway, for example to use a passkey.',
    'pages.settings.oidcAutoLoginInactive': 'Auto-login is enabled but inactive: it requires OIDC to be configured and password login to be disabled.',
    'pages.settings.addGroup': 'Add',
    'pages.settings.noScopesConfigured': 'No scopes configured.',
    'pages.settings.removeScope': 'Remove {scope}',
    'pages.settings.noGroupsConfigured': 'No groups configured.',
    'pages.settings.removeGroup': 'Remove {group}',
    'pages.settings.oidcGroupsHelp': 'Choose what happens when an OIDC user matches no configured group. The default is deny sign-in.',
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

vi.mock('../../../lib/api', () => ({
  fetchConfig: vi.fn(),
  updateManualDecisionScenarios: vi.fn(),
  updateManualRefreshSetting: vi.fn(),
  updateMetricsSidebarPreference: vi.fn(),
  updateAllowlistsSidebarPreference: vi.fn(),
  updateLanguagePreference: vi.fn(async (language: string) => ({ success: true, language })),
  updateFontPreference: vi.fn(async (font: string) => ({ success: true, font })),
}));

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr'),
  },
}));

vi.mock('../../../contexts/useRefresh', () => ({
  useRefresh: vi.fn(),
}));

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: useAuthMock,
}));

vi.mock('../../../lib/i18n', () => ({
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

  beforeEach(() => {
    setLanguagePreferenceMock.mockReset();
    vi.mocked(updateMetricsSidebarPreference).mockReset();
    vi.mocked(updateAllowlistsSidebarPreference).mockReset();
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


export { setLanguagePreferenceMock, tMock, useAuthMock };
