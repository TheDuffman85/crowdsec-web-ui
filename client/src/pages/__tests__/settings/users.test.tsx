import { useAuthMock } from './harness';
import { SettingsRouter } from './router';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from '../../Settings';
import { fetchConfig } from '../../../lib/api';

const adminAuth = {
  authEnabled: true,
  setupRequired: false,
  authenticated: true,
  user: { userId: 1, username: 'admin', role: 'admin' },
  authMethod: 'password',
  oidcEnabled: true,
  passwordLoginDisabled: false,
  passkeysEnabled: false,
  hasPassword: true,
  totpEnabled: false,
  loading: false,
  refresh: vi.fn(),
  login: vi.fn(),
  setup: vi.fn(),
  logout: vi.fn(),
};

const users = [
  { id: 1, username: 'admin', role: 'admin', source: 'local', disabled: false, passwordChangeRequired: false, totpEnabled: false, passkeyCount: 0, createdAt: '2026-01-01T00:00:00.000Z', current: true },
  { id: 2, username: 'viewer', role: 'read-only', source: 'local', disabled: false, passwordChangeRequired: true, totpEnabled: true, passkeyCount: 2, createdAt: '2026-01-02T00:00:00.000Z', current: false },
  { id: 3, username: 'sso-user', role: 'admin', source: 'oidc', disabled: false, passwordChangeRequired: false, totpEnabled: false, passkeyCount: 0, createdAt: '2026-01-03T00:00:00.000Z', current: false },
];

function mockAdminConfig(canManage = true) {
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
      mode: canManage ? 'admin' : 'read-only',
      can_manage_enforcement: canManage,
      can_manage_settings: canManage,
    },
  });
}

function stubUsersFetch() {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || 'GET';
    if (url.endsWith('/api/auth/users') && method === 'GET') return Response.json({ users, totpManagedByConfig: false });
    if (url.endsWith('/api/auth/users') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { username: string; role: string };
      return Response.json({
        status: 'ok',
        user: { ...users[1], id: 4, username: body.username, role: body.role, totpEnabled: false, passkeyCount: 0 },
      }, { status: 201 });
    }
    if (url.endsWith('/api/auth/users/3') && method === 'DELETE') return Response.json({ status: 'ok' });
    if (url.endsWith('/api/auth/users/2') && method === 'PATCH') {
      return Response.json({ status: 'ok', user: { ...users[1], ...JSON.parse(String(init?.body)) } });
    }
    if (url.includes('/api/auth/settings')) return Response.json({ hasPassword: true, passkeysAvailable: false, authMethod: 'password' });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Settings users', () => {
  test('hides the Users tab from read-only users', async () => {
    useAuthMock.mockReturnValue({ ...adminAuth, user: { userId: 2, username: 'viewer', role: 'read-only' } });
    mockAdminConfig(false);
    stubUsersFetch();

    render(<SettingsRouter tab="users"><Settings /></SettingsRouter>);

    expect(await screen.findByRole('tab', { name: 'pages.settings.account' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Authentication' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'pages.settings.users' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'pages.settings.account' })).toHaveAttribute('aria-selected', 'true');
  });

  test('lists local and OIDC users with the actions each allows', async () => {
    const user = userEvent.setup();
    useAuthMock.mockReturnValue(adminAuth);
    mockAdminConfig();
    stubUsersFetch();

    render(<SettingsRouter tab="users"><Settings /></SettingsRouter>);

    const own = await screen.findByTestId('settings-user-admin');
    expect(within(own).getByText('pages.settings.userYou')).toBeInTheDocument();
    // Your own account shows its role but has no controls here.
    expect(within(own).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(own).getByTestId('settings-user-role-admin')).toHaveTextContent('pages.settings.userRoleAdmin');
    expect(within(own).queryByRole('button', { name: 'pages.settings.userActionsFor' })).not.toBeInTheDocument();

    const viewer = screen.getByTestId('settings-user-viewer');
    expect(within(viewer).getByText('pages.settings.userPasswordChangePending')).toBeInTheDocument();
    expect(within(viewer).getByRole('combobox')).toBeEnabled();
    await user.click(within(viewer).getByRole('button', { name: 'pages.settings.userActionsFor' }));
    let menu = within(viewer).getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'pages.settings.resetUserPassword' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: 'pages.settings.resetUserMfa' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: 'pages.settings.disableUser' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: 'pages.settings.deleteUser' })).toBeEnabled();

    // OIDC users get their role from the identity provider and can only be deleted.
    const oidc = screen.getByTestId('settings-user-sso-user');
    expect(within(oidc).getByText('pages.settings.userSourceOidc')).toBeInTheDocument();
    expect(within(oidc).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(oidc).getByTestId('settings-user-role-sso-user')).toHaveTextContent('pages.settings.userRoleAdmin');
    await user.click(within(oidc).getByRole('button', { name: 'pages.settings.userActionsFor' }));
    expect(within(viewer).queryByRole('menu')).not.toBeInTheDocument();
    menu = within(oidc).getByRole('menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
    expect(within(menu).getByRole('menuitem', { name: 'pages.settings.deleteUser' })).toBeEnabled();
  });

  test('creates users, changes roles and deletes OIDC users', async () => {
    const user = userEvent.setup();
    useAuthMock.mockReturnValue(adminAuth);
    mockAdminConfig();
    const fetchMock = stubUsersFetch();

    render(<SettingsRouter tab="users"><Settings /></SettingsRouter>);
    await screen.findByTestId('settings-user-viewer');

    await user.click(screen.getByRole('button', { name: 'pages.settings.addUser' }));
    const dialog = await screen.findByRole('dialog', { name: 'pages.settings.addUser' });
    await user.type(within(dialog).getByLabelText('pages.login.username'), 'operator');
    await user.type(within(dialog).getByLabelText('pages.settings.initialPassword'), 'Initial123');
    await user.selectOptions(within(dialog).getByLabelText('pages.settings.userRole'), 'admin');
    await user.click(within(dialog).getByRole('button', { name: 'pages.settings.createUser' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/users'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: 'operator', password: 'Initial123', role: 'admin', requirePasswordChange: true }),
      }),
    ));
    expect(await screen.findByTestId('settings-user-operator')).toBeInTheDocument();

    await user.selectOptions(within(screen.getByTestId('settings-user-viewer')).getByRole('combobox'), 'admin');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/users/2'),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ role: 'admin' }) }),
    ));

    const oidc = screen.getByTestId('settings-user-sso-user');
    await user.click(within(oidc).getByRole('button', { name: 'pages.settings.userActionsFor' }));
    await user.click(within(oidc).getByRole('menuitem', { name: 'pages.settings.deleteUser' }));
    const confirm = await screen.findByRole('dialog', { name: 'pages.settings.deleteUserTitle' });
    await user.click(within(confirm).getByRole('button', { name: 'common.delete' }));
    await waitFor(() => expect(screen.queryByTestId('settings-user-sso-user')).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/auth/users/3'), expect.objectContaining({ method: 'DELETE' }));
  });
});
