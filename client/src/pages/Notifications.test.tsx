import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { NotificationChannel, NotificationItem, NotificationListResponse, NotificationRule, NotificationSettingsResponse } from '../types';
import { Notifications } from './Notifications';

vi.mock('../contexts/useRefresh', () => ({
  useRefresh: () => ({
    refreshSignal: 0,
  }),
}));

vi.mock('../contexts/useNotificationUnreadCount', () => ({
  useNotificationUnreadCount: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  fetchNotificationSettings: vi.fn(),
  fetchNotificationsPaginated: vi.fn(),
  createNotificationChannel: vi.fn(),
  updateNotificationChannel: vi.fn(),
  deleteNotificationChannel: vi.fn(),
  testNotificationChannel: vi.fn(),
  createNotificationRule: vi.fn(),
  updateNotificationRule: vi.fn(),
  deleteNotificationRule: vi.fn(),
  deleteNotification: vi.fn(),
  bulkDeleteNotifications: vi.fn(),
  deleteReadNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markNotificationsRead: vi.fn(),
}));

import {
  bulkDeleteNotifications,
  deleteNotification,
  deleteReadNotifications,
  fetchNotificationSettings,
  fetchNotificationsPaginated,
  markNotificationsRead,
  testNotificationChannel,
} from '../lib/api';
import { useNotificationUnreadCount } from '../contexts/useNotificationUnreadCount';

const setUnreadCountMock = vi.fn();
const refreshUnreadCountMock = vi.fn();

const buildSettings = (overrides?: {
  channels?: NotificationChannel[];
  rules?: NotificationRule[];
}): NotificationSettingsResponse => ({
  channels: overrides?.channels ?? [
    {
      id: 'channel-1',
      name: 'Ops MQTT',
      type: 'mqtt',
      enabled: true,
      config: {
        brokerUrl: 'mqtt://broker.example.com:1883',
        username: 'ops',
        password: '(stored)',
        clientId: '',
        keepaliveSeconds: 60,
        connectTimeoutMs: 10000,
        qos: 1,
        topic: 'crowdsec/notifications',
        retainEvents: false,
      },
      configured_secrets: ['password'],
      created_at: '2026-03-28T12:00:00.000Z',
      updated_at: '2026-03-28T12:00:00.000Z',
    },
  ],
  rules: overrides?.rules ?? [],
});

function mockMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

function buildNotificationPage(overrides?: {
  data?: NotificationItem[];
  unread_count?: number;
  selectable_ids?: string[];
  total?: number;
  total_pages?: number;
  page?: number;
  page_size?: number;
}): NotificationListResponse {
  return {
    data: overrides?.data ?? [],
    pagination: {
      page: overrides?.page ?? 1,
      page_size: overrides?.page_size ?? 50,
      total: overrides?.total ?? (overrides?.data?.length ?? 0),
      total_pages: overrides?.total_pages ?? ((overrides?.data?.length ?? 0) > 0 ? 1 : 0),
      unfiltered_total: overrides?.total ?? (overrides?.data?.length ?? 0),
    },
    selectable_ids: overrides?.selectable_ids ?? (overrides?.data?.map((item) => String(item.id)) ?? []),
    unread_count: overrides?.unread_count ?? 0,
  };
}

function installControlledIntersectionObserver() {
  const callbacks: Array<() => void> = [];

  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) {
      callbacks.push(() => {
        callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      });
    }

    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  });

  return () => callbacks.forEach((callback) => callback());
}

describe('Notifications page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMatchMedia();
    setUnreadCountMock.mockReset();
    refreshUnreadCountMock.mockReset();

    vi.mocked(useNotificationUnreadCount).mockReturnValue({
      unreadCount: 0,
      setUnreadCount: setUnreadCountMock,
      refreshUnreadCount: refreshUnreadCountMock,
    });

    vi.mocked(fetchNotificationSettings).mockResolvedValue(buildSettings());

    vi.mocked(fetchNotificationsPaginated).mockResolvedValue(buildNotificationPage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('renders typed destination fields for MQTT and webhook', async () => {
    const user = userEvent.setup();
    render(<Notifications />);

    await waitFor(() => expect(screen.getByRole('button', { name: /add destination/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /add destination/i }));

    expect(screen.getByLabelText('Topic')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Type'), 'mqtt');
    expect(screen.getByLabelText('Broker URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Connect Timeout (ms)')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Type'), 'webhook');
    expect(screen.getByText('Query Parameters')).toBeInTheDocument();
    expect(screen.getByLabelText('Body Template')).toBeInTheDocument();
  });

  test('shows unchanged placeholder for stored secrets when editing', async () => {
    const user = userEvent.setup();
    render(<Notifications />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit destination' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Edit destination' }));

    expect(screen.getByPlaceholderText('(unchanged)')).toBeInTheDocument();
  });

  test('renders validation errors as a toast instead of inline in the destination modal', async () => {
    const user = userEvent.setup();
    render(<Notifications />);

    await waitFor(() => expect(screen.getByRole('button', { name: /add destination/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /add destination/i }));
    await user.click(screen.getByRole('button', { name: /save destination/i }));

    const modal = screen.getByRole('dialog', { name: 'New Destination' });
    expect(screen.getByText('ntfy topic is required')).toBeInTheDocument();
    expect(modal).not.toHaveTextContent('ntfy topic is required');
  });

  test('shows a hint when no outbound destinations exist in the rule modal', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchNotificationSettings).mockResolvedValueOnce(buildSettings({ channels: [] }));
    render(<Notifications />);

    await waitFor(() => expect(screen.getByRole('button', { name: /add rule/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /add rule/i }));

    expect(screen.getByText(/no outbound destinations exist yet/i)).toBeInTheDocument();
  });

  test('shows the application update rule type without alert filter fields', async () => {
    const user = userEvent.setup();
    render(<Notifications />);

    await waitFor(() => expect(screen.getByRole('button', { name: /add rule/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /add rule/i }));
    await user.selectOptions(screen.getByLabelText('Rule Type'), 'application-update');

    expect(screen.getByText(/built-in update check/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Scenario Contains')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Target Contains')).not.toBeInTheDocument();
  });

  test('supports adding webhook query, header, and form fields from the destination modal', async () => {
    const user = userEvent.setup();
    render(<Notifications />);

    await waitFor(() => expect(screen.getByRole('button', { name: /add destination/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /add destination/i }));
    await user.selectOptions(screen.getByLabelText('Type'), 'webhook');

    await user.click(screen.getByRole('button', { name: 'Add query' }));
    expect(screen.queryByText('No query parameters.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add header' }));
    expect(screen.queryByText('No headers.')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Body Mode'), 'form');
    await user.click(screen.getByRole('button', { name: 'Add field' }));
    expect(screen.queryByText('No form fields.')).not.toBeInTheDocument();
  });

  test('renders badges for rules without destinations and destinations without attached rules', async () => {
    vi.mocked(fetchNotificationSettings).mockResolvedValueOnce(buildSettings({
      channels: [
        {
          id: 'channel-1',
          name: 'Ops MQTT',
          type: 'mqtt',
          enabled: true,
          config: {
            brokerUrl: 'mqtt://broker.example.com:1883',
            username: 'ops',
            password: '(stored)',
            clientId: '',
            keepaliveSeconds: 60,
            connectTimeoutMs: 10000,
            qos: 1,
            topic: 'crowdsec/notifications',
            retainEvents: false,
          },
          configured_secrets: ['password'],
          created_at: '2026-03-28T12:00:00.000Z',
          updated_at: '2026-03-28T12:00:00.000Z',
        },
      ],
      rules: [
        {
          id: 'rule-1',
          name: 'Orphan Rule',
          type: 'new-cve',
          enabled: true,
          severity: 'warning',
          channel_ids: [],
          config: {
            max_cve_age_days: 14,
            filters: {
              scenario: '',
              target: '',
              include_simulated: false,
            },
          },
          created_at: '2026-03-28T12:00:00.000Z',
          updated_at: '2026-03-28T12:00:00.000Z',
        },
      ],
    }));
    render(<Notifications />);

    await waitFor(() => expect(screen.getByText('No rule attached')).toBeInTheDocument());
    expect(screen.getByText('No destinations')).toBeInTheDocument();
  });

  test('shows a success toast when sending a test notification', async () => {
    const user = userEvent.setup();
    vi.mocked(testNotificationChannel).mockResolvedValueOnce(undefined);
    render(<Notifications />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send test notification' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Send test notification' }));

    expect(await screen.findByText('Test notification sent to Ops MQTT')).toBeInTheDocument();
  });

  test('shows an error toast when sending a test notification fails', async () => {
    const user = userEvent.setup();
    vi.mocked(testNotificationChannel).mockRejectedValueOnce(new Error('MQTT broker unavailable'));
    render(<Notifications />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send test notification' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Send test notification' }));

    expect(await screen.findByText('MQTT broker unavailable')).toBeInTheDocument();
  });

  test('does not render cooldown fields or text for rules', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchNotificationSettings).mockResolvedValueOnce(buildSettings({
      rules: [
        {
          id: 'rule-1',
          name: 'Threshold Rule',
          type: 'alert-threshold',
          enabled: true,
          severity: 'warning',
          channel_ids: ['channel-1'],
          config: {
            window_minutes: 60,
            alert_threshold: 10,
            filters: {},
          },
          created_at: '2026-03-28T12:00:00.000Z',
          updated_at: '2026-03-28T12:00:00.000Z',
        },
      ],
    }));
    render(<Notifications />);

    await waitFor(() => expect(screen.getByText('Threshold Rule')).toBeInTheDocument());
    expect(screen.queryByText(/cooldown:/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /edit rule/i }));
    expect(screen.queryByLabelText(/cooldown/i)).not.toBeInTheDocument();
  });

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
