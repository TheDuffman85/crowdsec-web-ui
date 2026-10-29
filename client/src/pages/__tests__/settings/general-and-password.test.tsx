import { setLanguagePreferenceMock, useAuthMock } from './harness';
import { SettingsRouter } from './router';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from '../../Settings';
import { fetchConfig, updateAllowlistsSidebarPreference, updateManualRefreshSetting, updateMetricsSidebarPreference } from '../../../lib/api';
import { DateTimeContext, createDateTimeContextValue } from '../../../lib/dateTime';
import { FontContext } from '../../../lib/font';

describe('Settings general and password', () => {
  test('defaults allowlists visibility on and only saves changes on Save', async () => {
    const user = userEvent.setup();
    const config = await fetchConfig();
    vi.mocked(fetchConfig).mockResolvedValue({
      ...config,
      permissions: { mode: 'admin', can_manage_enforcement: true, can_manage_settings: true },
    });
    vi.mocked(updateAllowlistsSidebarPreference).mockResolvedValue({
      success: true, allowlists_sidebar_visible: false,
    });
    const changed = vi.fn();
    window.addEventListener('allowlists-sidebar-preference-changed', changed);
    try {
      render(<SettingsRouter><Settings /></SettingsRouter>);
      const toggle = await screen.findByRole('switch', { name: 'Show Allowlists in sidebar' });
      await waitFor(() => expect(toggle).toBeEnabled());
      expect(toggle).toBeChecked();
      await user.click(toggle);
      expect(updateAllowlistsSidebarPreference).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(changed).toHaveBeenCalledOnce());
      expect(updateAllowlistsSidebarPreference).toHaveBeenCalledWith({ visible: false });
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(updateAllowlistsSidebarPreference).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('allowlists-sidebar-preference-changed', changed);
    }
  });

  test.each([
    ['allowlists_sidebar_visible', 'ui.allowlistsSidebarVisible', 'CONFIG_UI_ALLOWLISTS_SIDEBAR_VISIBLE', 'Show Allowlists in sidebar'],
    ['metrics_sidebar_visible', 'ui.metricsSidebarVisible', 'CONFIG_UI_METRICS_SIDEBAR_VISIBLE', 'Show Metrics in sidebar'],
  ] as const)('loads and locks %s managed by configuration', async (key, path, env, label) => {
    const config = await fetchConfig();
    vi.mocked(fetchConfig).mockResolvedValue({
      ...config,
      [key]: false,
      managed_settings: {
        [key]: { path, env },
      },
      permissions: { mode: 'admin', can_manage_enforcement: true, can_manage_settings: true },
    });
    render(<SettingsRouter><Settings /></SettingsRouter>);
    expect(await screen.findByLabelText(`Managed by the ${env} environment variable. To manage it here, remove it and any copy in the config file, then restart.`)).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: label });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeDisabled();
  });

  test('keeps language editable but disables refresh in read-only mode', async () => {
    render(<SettingsRouter><Settings /></SettingsRouter>);

    expect(await screen.findByLabelText('Language')).toBeEnabled();
    expect(screen.getByLabelText('Refresh interval')).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Show Allowlists in sidebar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByText('Read-only mode is enabled.')).toBeInTheDocument();
  });

  test('shows each section in its own tab', async () => {
    const user = userEvent.setup();
    render(<SettingsRouter><Settings /></SettingsRouter>);

    const generalTab = await screen.findByRole('tab', { name: 'General' });
    expect(generalTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Language')).toBeInTheDocument();
    expect(screen.queryByLabelText('Scenarios')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Authentication' }));
    expect(screen.getByRole('tab', { name: 'Authentication' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Dashboard authentication is disabled. Set CONFIG_AUTH_ENABLED=true and restart the web UI to enable sign-in and account settings.');
    expect(screen.queryByLabelText('Language')).not.toBeInTheDocument();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'pages.settings.manualDecisions' })).toHaveFocus();
    expect(screen.getByLabelText('Scenarios')).toBeInTheDocument();
  });

  test('opens the tab named in the URL', async () => {
    render(<SettingsRouter tab="branding"><Settings /></SettingsRouter>);

    expect(await screen.findByRole('tab', { name: 'pages.settings.branding' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('pages.settings.appName')).toBeInTheDocument();
    expect(screen.queryByLabelText('Language')).not.toBeInTheDocument();
  });

  test('only applies language changes when saved', async () => {
    const user = userEvent.setup();
    render(<SettingsRouter><Settings /></SettingsRouter>);

    await user.selectOptions(await screen.findByLabelText('Language'), 'de');
    expect(setLanguagePreferenceMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(setLanguagePreferenceMock).toHaveBeenCalledWith('de');
  });

  test('only applies font changes when saved', async () => {
    const user = userEvent.setup();
    const setFontPreference = vi.fn();
    render(
      <FontContext.Provider value={{ preference: 'system', setFontPreference }}>
        <SettingsRouter><Settings /></SettingsRouter>
      </FontContext.Provider>,
    );

    const fontSelect = await screen.findByLabelText('Font');
    expect(fontSelect).toBeEnabled();
    expect(screen.getByRole('option', { name: 'Match language (IBM Plex Sans)' })).toBeInTheDocument();

    await user.selectOptions(fontSelect, 'ibm-plex-sans-kr');
    expect(setFontPreference).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(setFontPreference).toHaveBeenCalledWith('ibm-plex-sans-kr');
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

    render(<SettingsRouter><Settings /></SettingsRouter>);

    await user.click(await screen.findByRole('switch', { name: 'Show Metrics in sidebar' }));
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

    render(<SettingsRouter><Settings /></SettingsRouter>);
    await user.click(await screen.findByRole('switch', { name: 'Enable manual refresh' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateManualRefreshSetting).toHaveBeenCalledWith({ enabled: true });
  });

  test('locks refresh settings managed by configuration', async () => {
    vi.mocked(fetchConfig).mockResolvedValue({
      lookback_period: '1h',
      lookback_hours: 1,
      lookback_days: 1,
      refresh_interval: 120000,
      manual_refresh_enabled: true,
      managed_settings: {
        refresh_interval: { path: 'crowdsec.sync.refreshInterval' },
        manual_refresh_enabled: { path: 'crowdsec.sync.manualRefreshEnabled', env: 'CONFIG_CROWDSEC_SYNC_MANUAL_REFRESH_ENABLED' },
      },
      current_interval_name: '2m',
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

    render(<SettingsRouter><Settings /></SettingsRouter>);

    expect(await screen.findByLabelText('Managed by crowdsec.sync.refreshInterval in the config file. To manage it here, remove it there and restart.')).toBeInTheDocument();
    expect(screen.getByText('crowdsec.sync.refreshInterval', { selector: 'code' })).toBeInTheDocument();
    const refreshSelect = screen.getByLabelText('Refresh interval');
    expect(refreshSelect).toBeDisabled();
    expect(refreshSelect).toHaveValue('120000');
    expect(screen.getByRole('option', { name: '2m' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable manual refresh' })).toBeDisabled();
    expect(screen.getByLabelText('Managed by the CONFIG_CROWDSEC_SYNC_MANUAL_REFRESH_ENABLED environment variable. To manage it here, remove it and any copy in the config file, then restart.')).toBeInTheDocument();
  });

  test('saves the password login setting with the authentication settings', async () => {
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

    const dateTime = createDateTimeContextValue({ timeZone: 'America/Los_Angeles', timeFormat: '24h', dateFormat: 'browser' });
    render(
      <DateTimeContext.Provider value={dateTime}>
        <SettingsRouter tab="authentication"><Settings /></SettingsRouter>
      </DateTimeContext.Provider>,
    );

    await screen.findByRole('heading', { name: 'Authentication' });
    expect(screen.getByText(`Added ${dateTime.formatDate('2026-01-01T00:00:00.000Z')}`)).toBeInTheDocument();
    await user.click(screen.getByLabelText(/Disable password login/i));

    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/settings'),
      expect.objectContaining({ method: 'PUT' }),
    );

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/settings'),
      expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('"disablePasswordLogin":true'),
      }),
    ));
    expect(refreshAuth).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Change Password' })).toBeInTheDocument();
  });

  test('locks the password login setting when it is managed by configuration', async () => {
    const user = userEvent.setup();
    useAuthMock.mockReturnValue({
      authEnabled: true,
      setupRequired: false,
      authenticated: true,
      user: { userId: 1, username: 'admin', role: 'admin' },
      authMethod: 'password',
      oidcEnabled: false,
      passwordLoginDisabled: false,
      passkeysEnabled: false,
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
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/auth/passkeys')) return Response.json({ passkeys: [] });
      if (url.includes('/api/auth/settings')) {
        return Response.json({
          disablePasswordLogin: false,
          passwordLoginManaged: true,
          passwordLoginFallback: true,
          managedSettings: { disablePasswordLogin: { path: 'auth.passwordLogin.enabled' } },
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

    render(<SettingsRouter tab="authentication"><Settings /></SettingsRouter>);

    expect(await screen.findByLabelText('Managed by auth.passwordLogin.enabled in the config file. To manage it here, remove it there and restart.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Disable password login/i)).toBeDisabled();
    expect(screen.getByText(/stays enabled until OIDC/)).toBeInTheDocument();

    // Saving leaves out the managed password login setting.
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/settings'),
      expect.objectContaining({ method: 'PUT', body: expect.not.stringContaining('disablePasswordLogin') }),
    ));
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

    render(<SettingsRouter tab="authentication"><Settings /></SettingsRouter>);

    await screen.findByRole('heading', { name: 'Authentication' });

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

    render(<SettingsRouter tab="authentication"><Settings /></SettingsRouter>);

    await screen.findByRole('heading', { name: 'Authentication' });

    await waitFor(() => expect(screen.queryByText('Passkeys')).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/api/auth/passkeys'));
  });

});
