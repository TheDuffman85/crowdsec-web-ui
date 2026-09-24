import { buildNotificationPage, buildSettings, renderWithChineseLocale } from './harness';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Notifications } from '../../Notifications';
import { fetchNotificationSettings, fetchNotificationsPaginated, testNotificationChannel, testNotificationRule } from '../../../lib/api';

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

  test('localizes CrowdSec update notices and links to the release', async () => {
    vi.mocked(fetchNotificationSettings).mockResolvedValueOnce(buildSettings({
      rules: [{
        id: 'rule-update',
        name: 'Updates',
        type: 'crowdsec-update',
        enabled: true,
        severity: 'info',
        channel_ids: [],
        config: {},
        created_at: '2026-09-24T10:00:00.000Z',
        updated_at: '2026-09-24T10:00:00.000Z',
      }],
    }));
    vi.mocked(fetchNotificationsPaginated).mockResolvedValueOnce(buildNotificationPage({
      data: [{
        id: 'notif-update',
        rule_id: 'rule-update',
        rule_name: 'Updates',
        rule_type: 'crowdsec-update',
        severity: 'info',
        title: 'CrowdSec update available',
        message: 'An update is available',
        created_at: '2026-09-24T10:00:00.000Z',
        read_at: null,
        metadata: {
          instance_name: 'Edge',
          endpoint_name: 'Node A',
          local_version: 'v1.7.8',
          remote_version: 'v1.8.0',
          release_url: 'https://github.com/crowdsecurity/crowdsec/releases/tag/v1.8.0',
        },
        deliveries: [],
      }],
      selectable_ids: ['notif-update'],
      unread_count: 1,
      total: 1,
    }));

    renderWithChineseLocale(<Notifications />);

    expect(await screen.findByText('Updates：CrowdSec 有可用更新')).toBeInTheDocument();
    expect(screen.getByText('Edge / Node A：CrowdSec v1.7.8 -> v1.8.0 已发布。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看 CrowdSec 版本' })).toHaveAttribute(
      'href',
      'https://github.com/crowdsecurity/crowdsec/releases/tag/v1.8.0',
    );
    expect(screen.getByText('CrowdSec 更新')).toBeInTheDocument();
  });

  test('shows destination test content and delivery in the shared result modal', async () => {
    const user = userEvent.setup();
    vi.mocked(testNotificationChannel).mockResolvedValueOnce({
      success: true,
      title: 'CrowdSec notification test',
      message: 'Test sent at 2026-09-24 12:00.',
      delivery: {
        channel_id: 'channel-1', channel_name: 'Ops MQTT', channel_type: 'mqtt',
        status: 'delivered', attempted_at: '2026-09-24T12:00:00.000Z',
      },
    });
    render(<Notifications />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send test notification' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Send test notification' }));

    expect(await screen.findByRole('dialog', { name: 'Test for Ops MQTT' })).toBeInTheDocument();
    expect(screen.getByText('CrowdSec notification test')).toBeInTheDocument();
    expect(screen.getByText('Test sent at 2026-09-24 12:00.')).toBeInTheDocument();
    expect(screen.getByText('Ops MQTT: Delivered')).toBeInTheDocument();
  });

  test('shows an error toast when sending a test notification fails', async () => {
    const user = userEvent.setup();
    vi.mocked(testNotificationChannel).mockRejectedValueOnce(new Error('MQTT broker unavailable'));
    render(<Notifications />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send test notification' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Send test notification' }));

    expect(await screen.findByText('MQTT broker unavailable')).toBeInTheDocument();
  });

  test('guides rule names and shows whether a rule test used a sample', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchNotificationSettings).mockResolvedValueOnce(buildSettings({
      rules: [{
        id: 'rule-1', name: 'EU probes', type: 'ip-ban', enabled: false, severity: 'warning',
        channel_ids: ['channel-1'], config: { window_minutes: 60, filters: {} },
        created_at: '2026-03-28T12:00:00.000Z', updated_at: '2026-03-28T12:00:00.000Z',
      }],
    }));
    vi.mocked(testNotificationRule).mockResolvedValueOnce({
      source: 'sample', title: '[TEST] EU probes: IP banned', message: '192.0.2.1 was banned.',
      deliveries: [{ channel_id: 'channel-1', channel_name: 'Ops MQTT', channel_type: 'mqtt', status: 'delivered', attempted_at: '2026-03-28T12:00:00.000Z' }],
    });
    render(<Notifications />);

    await user.click(await screen.findByRole('button', { name: 'Edit rule' }));
    expect(screen.getByLabelText('Name')).toHaveAttribute('placeholder', 'EU probes');
    expect(screen.getByText(/name appears at the start of notification titles/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Send rule test' }));
    expect(testNotificationRule).toHaveBeenCalledWith('rule-1');
    expect(await screen.findByText('[TEST] EU probes: IP banned')).toBeInTheDocument();
    expect(screen.getByText(/does not verify filters or thresholds/i)).toBeInTheDocument();
    expect(screen.getByText('Ops MQTT: Delivered')).toBeInTheDocument();
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
