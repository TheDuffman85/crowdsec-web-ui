import { buildNotificationPage, installControlledIntersectionObserver } from './harness';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Notifications } from '../../Notifications';
import { bulkDeleteNotifications, deleteNotification, deleteReadNotifications, fetchNotificationsPaginated, markNotificationsRead } from '../../../lib/api';

describe('Notifications page list actions', () => {
  test('supports selecting notifications and marking selected ones as read', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchNotificationsPaginated)
      .mockResolvedValueOnce(buildNotificationPage({
        data: [
          {
            id: 'notif-1',
            rule_id: 'rule-1',
            rule_name: 'Threshold',
            rule_type: 'alert-threshold',
            severity: 'warning',
            title: 'Threshold breached',
            message: 'Alert volume is elevated',
            created_at: '2026-03-28T12:00:00.000Z',
            read_at: null,
            metadata: {},
            deliveries: [],
          },
          {
            id: 'notif-2',
            rule_id: 'rule-1',
            rule_name: 'Threshold',
            rule_type: 'alert-threshold',
            severity: 'info',
            title: 'Informational',
            message: 'Already read',
            created_at: '2026-03-28T12:10:00.000Z',
            read_at: '2026-03-28T12:15:00.000Z',
            metadata: {},
            deliveries: [],
          },
        ],
        selectable_ids: ['notif-1', 'notif-2'],
        unread_count: 1,
        total: 2,
      }))
      .mockResolvedValueOnce(buildNotificationPage({
        data: [
          {
            id: 'notif-1',
            rule_id: 'rule-1',
            rule_name: 'Threshold',
            rule_type: 'alert-threshold',
            severity: 'warning',
            title: 'Threshold breached',
            message: 'Alert volume is elevated',
            created_at: '2026-03-28T12:00:00.000Z',
            read_at: '2026-03-28T12:20:00.000Z',
            metadata: {},
            deliveries: [],
          },
          {
            id: 'notif-2',
            rule_id: 'rule-1',
            rule_name: 'Threshold',
            rule_type: 'alert-threshold',
            severity: 'info',
            title: 'Informational',
            message: 'Already read',
            created_at: '2026-03-28T12:10:00.000Z',
            read_at: '2026-03-28T12:15:00.000Z',
            metadata: {},
            deliveries: [],
          },
        ],
        selectable_ids: ['notif-1', 'notif-2'],
        unread_count: 0,
        total: 2,
      }));

    render(<Notifications />);

    await waitFor(() => expect(screen.getByText('Threshold breached')).toBeInTheDocument());
    const selectAll = screen.getByLabelText('Select all notifications');
    expect(screen.getByRole('button', { name: /mark selected read/i })).toBeDisabled();

    await user.click(selectAll);
    expect(screen.getByRole('button', { name: /mark selected read/i })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /mark selected read/i }));

    await waitFor(() => expect(markNotificationsRead).toHaveBeenCalledWith(['notif-1', 'notif-2']));
    await waitFor(() => expect(fetchNotificationsPaginated).toHaveBeenCalledTimes(2));
  });

  test('supports deleting selected notifications and deleting all read notifications', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchNotificationsPaginated).mockResolvedValue(buildNotificationPage({
      data: [
        {
          id: 'notif-1',
          rule_id: 'rule-1',
          rule_name: 'Threshold',
          rule_type: 'alert-threshold',
          severity: 'warning',
          title: 'Threshold breached',
          message: 'Alert volume is elevated',
          created_at: '2026-03-28T12:00:00.000Z',
          read_at: null,
          metadata: {},
          deliveries: [],
        },
        {
          id: 'notif-2',
          rule_id: 'rule-1',
          rule_name: 'Threshold',
          rule_type: 'alert-threshold',
          severity: 'info',
          title: 'Read item',
          message: 'Already read',
          created_at: '2026-03-28T12:10:00.000Z',
          read_at: '2026-03-28T12:15:00.000Z',
          metadata: {},
          deliveries: [],
        },
      ],
      selectable_ids: ['notif-1', 'notif-2'],
      unread_count: 1,
      total: 2,
    }));

    render(<Notifications />);

    await waitFor(() => expect(screen.getByText('Threshold breached')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Select notification notif-1'));
    await user.click(screen.getByRole('button', { name: /delete selected/i }));
    expect(screen.getByText(/are you sure you want to delete 1 selected notification/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(bulkDeleteNotifications).toHaveBeenCalledWith(['notif-1']));

    await user.click(screen.getByRole('button', { name: /delete all read/i }));
    expect(screen.getByText(/are you sure you want to delete all read notifications/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(deleteReadNotifications).toHaveBeenCalled());
  });

  test('supports deleting a single notification', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchNotificationsPaginated).mockResolvedValue(buildNotificationPage({
      data: [
        {
          id: 'notif-1',
          rule_id: 'rule-1',
          rule_name: 'Threshold',
          rule_type: 'alert-threshold',
          severity: 'warning',
          title: 'Threshold breached',
          message: 'Alert volume is elevated',
          created_at: '2026-03-28T12:00:00.000Z',
          read_at: null,
          metadata: {},
          deliveries: [],
        },
      ],
      selectable_ids: ['notif-1'],
      unread_count: 1,
      total: 1,
    }));

    render(<Notifications />);

    await waitFor(() => expect(screen.getByText('Threshold breached')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Delete notification' }));
    expect(screen.getByRole('dialog', { name: 'Delete Notification?' })).toHaveTextContent('Are you sure you want to delete notification notif-1?');
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(deleteNotification).toHaveBeenCalledWith('notif-1'));
  });

  test('loads more notifications with infinite scroll', async () => {
    const triggerIntersection = installControlledIntersectionObserver();
    vi.mocked(fetchNotificationsPaginated)
      .mockResolvedValueOnce(buildNotificationPage({
        data: [
          {
            id: 'notif-1',
            rule_id: 'rule-1',
            rule_name: 'Threshold',
            rule_type: 'alert-threshold',
            severity: 'warning',
            title: 'First page',
            message: 'Page one item',
            created_at: '2026-03-28T12:00:00.000Z',
            read_at: null,
            metadata: {},
            deliveries: [],
          },
        ],
        selectable_ids: ['notif-1', 'notif-2'],
        unread_count: 2,
        total: 2,
        total_pages: 2,
      }))
      .mockResolvedValueOnce(buildNotificationPage({
        data: [
          {
            id: 'notif-2',
            rule_id: 'rule-1',
            rule_name: 'Threshold',
            rule_type: 'alert-threshold',
            severity: 'warning',
            title: 'Second page',
            message: 'Page two item',
            created_at: '2026-03-28T12:10:00.000Z',
            read_at: null,
            metadata: {},
            deliveries: [],
          },
        ],
        selectable_ids: ['notif-1', 'notif-2'],
        unread_count: 2,
        total: 2,
        total_pages: 2,
        page: 2,
      }));

    render(<Notifications />);

    await waitFor(() => expect(screen.getByText('First page')).toBeInTheDocument());
    triggerIntersection();
    await waitFor(() => expect(fetchNotificationsPaginated).toHaveBeenLastCalledWith(2, 50));
    await waitFor(() => expect(screen.getByText('Second page')).toBeInTheDocument());
  });
});
