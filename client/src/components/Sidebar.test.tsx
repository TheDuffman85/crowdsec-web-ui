import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Sidebar } from './Sidebar';
import { useNotificationUnreadCount } from '../contexts/useNotificationUnreadCount';

vi.mock('../contexts/useRefresh', () => ({
  useRefresh: () => ({
    intervalMs: 0,
    setIntervalMs: vi.fn(),
    lastUpdated: null,
    refreshSignal: 0,
    syncStatus: null,
  }),
}));

vi.mock('../contexts/useNotificationUnreadCount', () => ({
  useNotificationUnreadCount: vi.fn(),
}));

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar
        isOpen
        onClose={vi.fn()}
        onToggle={vi.fn()}
        theme="dark"
        toggleTheme={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('Sidebar', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('VITE_VERSION', '2026.5.2');
    vi.stubEnv('VITE_BRANCH', 'main');
    vi.stubEnv('VITE_COMMIT_HASH', 'abc123');
    fetchMock = vi.fn(async () => Response.json({ update_available: false }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
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
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(screen.queryByLabelText('0 unread notifications')).not.toBeInTheDocument();
  });

  test('passes frontend build metadata and suppresses stale matching update responses', async () => {
    vi.mocked(useNotificationUnreadCount).mockReturnValue({
      unreadCount: 0,
      setUnreadCount: vi.fn(),
      refreshUnreadCount: vi.fn(),
    });
    fetchMock.mockResolvedValueOnce(Response.json({
      update_available: true,
      local_version: '2026.5.1',
      remote_version: '2026.5.2',
      release_url: 'https://example.com/release',
      tag: 'latest',
    }));

    renderSidebar();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/update-check?version=2026.5.2&branch=main&commit_hash=abc123');
    expect(screen.queryByText('Update Available')).not.toBeInTheDocument();
  });
});
