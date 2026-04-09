import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
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
    fetchMock = vi.fn(async () => Response.json({ update_available: false }));
    vi.stubGlobal('fetch', fetchMock);
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
});
