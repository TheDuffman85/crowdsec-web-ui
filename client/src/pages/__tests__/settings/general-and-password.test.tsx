import { setLanguagePreferenceMock, useAuthMock } from './harness';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from '../../Settings';
import { fetchConfig, updateManualRefreshSetting, updateMetricsSidebarPreference } from '../../../lib/api';
import { DateTimeContext, createDateTimeContextValue } from '../../../lib/dateTime';

describe('Settings general and password', () => {
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

});
