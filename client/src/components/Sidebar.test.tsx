import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Sidebar } from './Sidebar';
import { useNotificationUnreadCount } from '../contexts/useNotificationUnreadCount';
import { I18nContext } from '../lib/i18n';

const { refreshNowMock } = vi.hoisted(() => ({ refreshNowMock: vi.fn() }));

vi.mock('../contexts/useRefresh', () => ({
  useRefresh: () => ({
    intervalMs: 0,
    nextRefreshAt: null,
    setIntervalMs: vi.fn(),
    lastUpdated: null,
    refreshSignal: 0,
    syncStatus: null,
    refreshNow: refreshNowMock,
  }),
}));

vi.mock('../contexts/useNotificationUnreadCount', () => ({
  useNotificationUnreadCount: vi.fn(),
}));

function renderSidebar(translations?: Record<string, string>) {
  const sidebar = (
    <MemoryRouter>
      <Sidebar
        isOpen
        onClose={vi.fn()}
        onToggle={vi.fn()}
        theme="dark"
        toggleTheme={vi.fn()}
      />
    </MemoryRouter>
  );

  return render(
    translations ? (
      <I18nContext.Provider value={{
        language: 'de',
        preference: 'de',
        browserLanguage: 'en',
        setLanguagePreference: vi.fn(),
        t: (key) => translations[key] ?? key,
      }}>
        {sidebar}
      </I18nContext.Provider>
    ) : sidebar,
  );
}

describe('Sidebar', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    refreshNowMock.mockReset();
    refreshNowMock.mockResolvedValue(undefined);
    vi.stubEnv('VITE_VERSION', '2026.5.2');
    vi.stubEnv('VITE_BRANCH', 'main');
    vi.stubEnv('VITE_COMMIT_HASH', 'abc123');
    fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        return Response.json({ metrics_enabled: false, metrics_sidebar_visible: true, manual_refresh_enabled: true });
      }
      return Response.json({ update_available: false });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  test('shows unread notification badges when unread notifications exist', async () => {
    vi.mocked(useNotificationUnreadCount).mockReturnValue({
      unreadCount: 3,
      setUnreadCount: vi.fn(),
      refreshUnreadCount: vi.fn(),
    });

    renderSidebar();

    expect(await screen.findAllByLabelText('3 unread notifications')).toHaveLength(2);
  });

  test('hides unread notification badges when all notifications are read', async () => {
    vi.mocked(useNotificationUnreadCount).mockReturnValue({
      unreadCount: 0,
      setUnreadCount: vi.fn(),
      refreshUnreadCount: vi.fn(),
    });

    renderSidebar();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/config'), undefined));

    expect(screen.queryByLabelText('0 unread notifications')).not.toBeInTheDocument();
  });

  test('passes frontend build metadata and suppresses stale matching update responses', async () => {
    vi.mocked(useNotificationUnreadCount).mockReturnValue({
      unreadCount: 0,
      setUnreadCount: vi.fn(),
      refreshUnreadCount: vi.fn(),
    });
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        return Response.json({ metrics_enabled: false, metrics_sidebar_visible: true });
      }
      return Response.json({
        update_available: true,
        local_version: '2026.5.1',
        remote_version: '2026.5.2',
        release_url: 'https://example.com/release',
        tag: 'latest',
      });
    });

    renderSidebar();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/update-check?version=2026.5.2&branch=main&commit_hash=abc123'), expect.anything()));
    expect(screen.queryByText('Update Available')).not.toBeInTheDocument();
  });

  test('shows metrics below notifications when sidebar preference is visible', async () => {
    vi.mocked(useNotificationUnreadCount).mockReturnValue({
      unreadCount: 0,
      setUnreadCount: vi.fn(),
      refreshUnreadCount: vi.fn(),
    });
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        return Response.json({ metrics_enabled: false, metrics_sidebar_visible: true });
      }
      return Response.json({ update_available: false });
    });

    renderSidebar();

    const metricsLink = (await screen.findAllByRole('link', { name: 'Metrics' }))[0];
    const notificationsLink = screen.getAllByRole('link', { name: 'Notifications' })[0];
    const settingsLink = screen.getAllByRole('link', { name: 'Settings' })[0];

    expect(metricsLink.compareDocumentPosition(notificationsLink) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(metricsLink.compareDocumentPosition(settingsLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('hides metrics when sidebar preference is disabled', async () => {
    vi.mocked(useNotificationUnreadCount).mockReturnValue({
      unreadCount: 0,
      setUnreadCount: vi.fn(),
      refreshUnreadCount: vi.fn(),
    });
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        return Response.json({ metrics_enabled: true, metrics_sidebar_visible: false });
      }
      return Response.json({ update_available: false });
    });

    renderSidebar();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/config'), undefined));
    expect(screen.queryByRole('link', { name: 'Metrics' })).not.toBeInTheDocument();
  });

  test('translates the multi-instance selector label and all-instances option', async () => {
    vi.mocked(useNotificationUnreadCount).mockReturnValue({
      unreadCount: 0,
      setUnreadCount: vi.fn(),
      refreshUnreadCount: vi.fn(),
    });
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        return Response.json({
          metrics_enabled: false,
          metrics_sidebar_visible: true,
          instances: [
            { id: 'primary', name: 'Primary' },
            { id: 'secondary', name: 'Secondary' },
          ],
        });
      }
      return Response.json({ update_available: false });
    });

    renderSidebar({
      'components.sidebar.instance': 'Instanz',
      'components.sidebar.allInstances': 'Alle Instanzen',
    });

    const selector = await screen.findByRole('combobox', { name: 'Instanz' });
    expect(selector).toHaveDisplayValue('▦ Alle Instanzen');
  });

  test('identifies load-test mode instead of showing regular build metadata', async () => {
    vi.mocked(useNotificationUnreadCount).mockReturnValue({
      unreadCount: 0,
      setUnreadCount: vi.fn(),
      refreshUnreadCount: vi.fn(),
    });
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        return Response.json({
          metrics_enabled: false,
          metrics_sidebar_visible: true,
          deployment_mode: 'load-test',
          load_test_profile: 'blocklists-mixed',
        });
      }
      return Response.json({ update_available: false });
    });

    renderSidebar();

    expect(await screen.findByText('blocklists-mixed')).toBeInTheDocument();
    expect(screen.getByText(/Load test:/)).toBeInTheDocument();
    expect(screen.queryByText('v2026.5.2')).not.toBeInTheDocument();
  });

  test('links to settings and keeps controls out of the sidebar', async () => {
    vi.mocked(useNotificationUnreadCount).mockReturnValue({
      unreadCount: 0,
      setUnreadCount: vi.fn(),
      refreshUnreadCount: vi.fn(),
    });

    renderSidebar();

    expect(screen.getAllByRole('link', { name: 'Settings' }).map((link) => link.getAttribute('href'))).toContain('/settings');
    expect(screen.queryByLabelText('Language')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  test('hides manual refresh controls when the feature is disabled', async () => {
    vi.mocked(useNotificationUnreadCount).mockReturnValue({
      unreadCount: 0,
      setUnreadCount: vi.fn(),
      refreshUnreadCount: vi.fn(),
    });
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        return Response.json({
          metrics_enabled: false,
          metrics_sidebar_visible: true,
          manual_refresh_enabled: false,
        });
      }
      return Response.json({ update_available: false });
    });

    renderSidebar();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/config'), undefined));
    expect(screen.queryByRole('button', { name: 'Delta Refresh' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choose refresh type' })).not.toBeInTheDocument();
  });

  test('runs a delta refresh from the compact default button', async () => {
    vi.mocked(useNotificationUnreadCount).mockReturnValue({
      unreadCount: 0,
      setUnreadCount: vi.fn(),
      refreshUnreadCount: vi.fn(),
    });
    const user = userEvent.setup();
    renderSidebar();

    await user.click(await screen.findByRole('button', { name: 'Delta Refresh' }));

    expect(refreshNowMock).toHaveBeenCalledWith('delta');
  });

  test('offers latest-window refresh in the dropdown', async () => {
    vi.mocked(useNotificationUnreadCount).mockReturnValue({
      unreadCount: 0,
      setUnreadCount: vi.fn(),
      refreshUnreadCount: vi.fn(),
    });
    const user = userEvent.setup();
    renderSidebar();

    await user.click(await screen.findByRole('button', { name: 'Choose refresh type' }));
    await user.click(screen.getByRole('menuitem', { name: 'Latest Window' }));

    expect(refreshNowMock).toHaveBeenCalledWith('latest');
  });

  test('requires confirmation before starting a full historical refresh', async () => {
    vi.mocked(useNotificationUnreadCount).mockReturnValue({
      unreadCount: 0,
      setUnreadCount: vi.fn(),
      refreshUnreadCount: vi.fn(),
    });
    const user = userEvent.setup();
    renderSidebar();

    await user.click(await screen.findByRole('button', { name: 'Choose refresh type' }));
    await user.click(screen.getByRole('menuitem', { name: 'Full' }));
    expect(refreshNowMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Run full refresh' }));
    expect(refreshNowMock).toHaveBeenCalledWith('full');
  });
});
