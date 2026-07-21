import { buildNotificationPage, buildSettings, renderWithChineseLocale } from './harness';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Notifications } from '../../Notifications';
import { fetchNotificationSettings, fetchNotificationsPaginated, testNotificationChannel } from '../../../lib/api';

describe('Notifications page localization and delivery', () => {
  test('localizes notification badges, rule types, delivery statuses, and stored server messages', async () => {
    vi.mocked(fetchNotificationSettings).mockResolvedValueOnce(buildSettings({
      rules: [
        {
          id: 'rule-1',
          name: 'IP Ban',
          type: 'ip-ban',
          enabled: true,
          severity: 'warning',
          channel_ids: ['channel-1'],
          config: {
            window_minutes: 60,
            filters: {},
          },
          created_at: '2026-06-08T01:49:55.034Z',
          updated_at: '2026-06-08T01:49:55.034Z',
        },
      ],
    }));
    vi.mocked(fetchNotificationsPaginated).mockResolvedValueOnce(buildNotificationPage({
      data: [
        {
          id: 'notif-1',
          rule_id: 'rule-1',
          rule_name: 'IP Ban',
          rule_type: 'ip-ban',
          severity: 'warning',
          title: 'IP Ban: IP banned',
          message: '1.2.3.4 was banned by manual/web-ui until 2026-06-08T01:49:55.034Z.',
          created_at: '2026-06-08T01:49:55.034Z',
          read_at: null,
          metadata: {
            value: '1.2.3.4',
            scenario: 'manual/web-ui',
            stop_at: '2026-06-08T01:49:55.034Z',
          },
          deliveries: [
            {
              channel_id: 'channel-1',
              channel_name: 'bbb',
              channel_type: 'mqtt',
              status: 'failed',
              attempted_at: '2026-06-08T01:49:56.034Z',
            },
          ],
        },
      ],
      selectable_ids: ['notif-1'],
      unread_count: 1,
      total: 1,
    }));

    renderWithChineseLocale(<Notifications />);

    expect(await screen.findByText('IP Ban：IP 已封禁')).toBeInTheDocument();
    expect(screen.getByText('1.2.3.4 已被封禁，由 manual/web-ui 触发，直到 2026-06-08T01:49:55.034Z。')).toBeInTheDocument();
    expect(screen.getAllByText('警告')).toHaveLength(2);
    expect(screen.getByText('IP 封禁')).toBeInTheDocument();
    expect(screen.getByText('bbb: 失败')).toBeInTheDocument();
    expect(screen.queryByText('warning')).not.toBeInTheDocument();
    expect(screen.queryByText('ip-ban')).not.toBeInTheDocument();
    expect(screen.queryByText('bbb: failed')).not.toBeInTheDocument();
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

});
