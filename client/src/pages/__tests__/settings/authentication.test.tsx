import { useAuthMock } from './harness';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from '../../Settings';
import { fetchConfig } from '../../../lib/api';

describe('Settings authentication methods', () => {
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
