import { buildNotificationPage, buildSettings } from './harness';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Notifications } from '../../Notifications';
import { createNotificationChannel, createNotificationRule, fetchConfig, fetchNotificationSettings, fetchNotificationsPaginated, markNotificationRead } from '../../../lib/api';

describe('Notifications page configuration', () => {
  test('hides notification management controls when read-only but keeps mark-read available', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchConfig).mockResolvedValueOnce({
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
        mode: 'read-only',
        can_manage_enforcement: false,
        can_manage_settings: false,
      },
    });
    vi.mocked(fetchNotificationSettings).mockResolvedValue(buildSettings({
      rules: [
        {
          id: 'rule-1',
          name: 'Threshold',
          type: 'alert-threshold',
          enabled: true,
          severity: 'warning',
          channel_ids: ['channel-1'],
          config: {
            window_minutes: 60,
            alert_threshold: 5,
          },
          created_at: '2026-03-28T12:00:00.000Z',
          updated_at: '2026-03-28T12:00:00.000Z',
        },
      ],
    }));
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
    expect(screen.queryByRole('button', { name: /add destination/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add rule/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete selected/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete all read/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete notification' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send test notification' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit destination' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete destination' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit rule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send rule test' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete rule' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledWith('notif-1'));
  });

  test('generates an editable rule name from the current type and positive filters', async () => {
    const user = userEvent.setup();
    render(<Notifications />);

    await user.click(await screen.findByRole('button', { name: 'Add Rule' }));
    const name = screen.getByRole('textbox', { name: 'Name' });
    const generate = screen.getByRole('button', { name: 'Generate name' });
    expect(name).toHaveValue('');

    await user.click(generate);
    expect(name).toHaveValue('Monitored traffic');

    await user.selectOptions(screen.getByLabelText('Rule Type'), 'ip-ban');
    await user.type(screen.getByLabelText('Country Filter (ISO Codes)'), 'DE');
    await user.click(generate);
    expect(name).toHaveValue('Monitored IPs · DE');

    await user.clear(name);
    await user.type(name, 'My custom name');
    expect(name).toHaveValue('My custom name');

    await user.selectOptions(screen.getByLabelText('Rule Type'), 'application-update');
    await user.click(generate);
    expect(name).toHaveValue('Web UI releases');
  });

  test('generates editable destination names from the type and configured endpoint', async () => {
    const user = userEvent.setup();
    render(<Notifications />);

    await user.click(await screen.findByRole('button', { name: 'Add Destination' }));
    const name = screen.getByRole('textbox', { name: 'Name' });
    const generate = screen.getByRole('button', { name: 'Generate name' });
    await user.click(generate);
    expect(name).toHaveValue('ntfy alerts');

    await user.type(screen.getByLabelText('Topic'), 'security-alerts');
    await user.click(generate);
    expect(name).toHaveValue('ntfy alerts · security-alerts');

    await user.selectOptions(screen.getByLabelText('Type'), 'webhook');
    await user.type(screen.getByLabelText('URL'), 'https://hooks.example.com/notify');
    await user.click(generate);
    expect(name).toHaveValue('Webhook events · hooks.example.com/notify');

    await user.clear(name);
    await user.type(name, 'My webhook');
    expect(name).toHaveValue('My webhook');
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

  test('submits the email subject prefix from the destination form', async () => {
    const user = userEvent.setup();
    render(<Notifications />);

    await user.click(await screen.findByRole('button', { name: /add destination/i }));
    await user.selectOptions(screen.getByLabelText('Type'), 'email');
    expect(screen.getByLabelText('Subject Prefix')).toHaveValue('[CrowdSec]');

    await user.type(screen.getByLabelText('Name'), 'Security email');
    await user.type(screen.getByLabelText('SMTP Host'), 'smtp.example.com');
    await user.type(screen.getByLabelText('From Address'), 'alerts@example.com');
    await user.type(screen.getByLabelText('To Address(es)'), 'admin@example.com');
    await user.clear(screen.getByLabelText('Subject Prefix'));
    await user.type(screen.getByLabelText('Subject Prefix'), 'Home');
    await user.click(screen.getByRole('button', { name: /save destination/i }));

    await waitFor(() => expect(createNotificationChannel).toHaveBeenCalledWith(expect.objectContaining({
      type: 'email',
      config: expect.objectContaining({ subjectPrefix: 'Home' }),
    })));
  });

  test('submits all ntfy settings and offers every Gotify priority', async () => {
    const user = userEvent.setup();
    render(<Notifications />);

    await user.click(await screen.findByRole('button', { name: /add destination/i }));
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Title Prefix')).toHaveValue('CrowdSec');
    expect(screen.getByLabelText('Tags')).toHaveValue('warning,shield');

    await user.type(screen.getByLabelText('Name'), 'Private ntfy');
    await user.type(screen.getByLabelText('Topic'), 'alerts');
    await user.type(screen.getByLabelText('Username'), 'operator');
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.clear(screen.getByLabelText('Title Prefix'));
    await user.type(screen.getByLabelText('Title Prefix'), 'Network A');
    await user.clear(screen.getByLabelText('Tags'));
    await user.type(screen.getByLabelText('Tags'), 'shield');
    await user.click(screen.getByRole('button', { name: /save destination/i }));

    await waitFor(() => expect(createNotificationChannel).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ntfy',
      config: expect.objectContaining({
        ntfyUsername: 'operator',
        ntfyPassword: 'secret',
        titlePrefix: 'Network A',
        tags: 'shield',
      }),
    })));

    await user.click(screen.getByRole('button', { name: /add destination/i }));
    await user.selectOptions(screen.getByLabelText('Type'), 'gotify');
    expect(within(screen.getByLabelText('Priority')).getAllByRole('option')).toHaveLength(12);
    await user.selectOptions(screen.getByLabelText('Priority'), '9');
    expect(screen.getByLabelText('Priority')).toHaveValue('9');
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

  test('shows destination type badges in the rule modal', async () => {
    const user = userEvent.setup();
    render(<Notifications />);

    await waitFor(() => expect(screen.getByRole('button', { name: /add rule/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /add rule/i }));

    const modal = screen.getByRole('dialog', { name: 'New Rule' });
    expect(within(modal).getByText('mqtt')).toBeInTheDocument();
  });

  test('keeps recent notifications newest-first while restoring destination and rule order after remounting', async () => {
    window.localStorage.setItem('crowdsec-web-ui:notifications:notification-order', JSON.stringify(['notif-1', 'notif-2']));
    window.localStorage.setItem('crowdsec-web-ui:notifications:destination-order', JSON.stringify(['channel-2', 'channel-1']));
    window.localStorage.setItem('crowdsec-web-ui:notifications:rule-order', JSON.stringify(['rule-2', 'rule-1']));

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
        {
          id: 'channel-2',
          name: 'Security Email',
          type: 'email',
          enabled: true,
          config: {},
          configured_secrets: [],
          created_at: '2026-03-28T12:05:00.000Z',
          updated_at: '2026-03-28T12:05:00.000Z',
        },
      ],
      rules: [
        {
          id: 'rule-1',
          name: 'Alert Threshold',
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
        {
          id: 'rule-2',
          name: 'New CVE',
          type: 'new-cve',
          enabled: true,
          severity: 'critical',
          channel_ids: ['channel-2'],
          config: {
            max_cve_age_days: 14,
            filters: {
              scenario: '',
              target: '',
              include_simulated: false,
            },
          },
          created_at: '2026-03-28T12:10:00.000Z',
          updated_at: '2026-03-28T12:10:00.000Z',
        },
      ],
    }));
    vi.mocked(fetchNotificationsPaginated).mockResolvedValueOnce(buildNotificationPage({
      data: [
        {
          id: 'notif-1',
          rule_id: 'rule-1',
          rule_name: 'Alert Threshold',
          rule_type: 'alert-threshold',
          severity: 'warning',
          title: 'First server notification',
          message: 'Server order first',
          created_at: '2026-03-28T12:00:00.000Z',
          read_at: null,
          metadata: {},
          deliveries: [],
        },
        {
          id: 'notif-2',
          rule_id: 'rule-2',
          rule_name: 'New CVE',
          rule_type: 'new-cve',
          severity: 'critical',
          title: 'Saved order notification',
          message: 'Saved order first',
          created_at: '2026-03-28T12:10:00.000Z',
          read_at: null,
          metadata: {},
          deliveries: [],
        },
      ],
      selectable_ids: ['notif-1', 'notif-2'],
      unread_count: 2,
      total: 2,
    }));

    render(<Notifications />);

    await waitFor(() => expect(screen.getByText('Saved order notification')).toBeInTheDocument());

    expect(screen.queryByLabelText('Reorder notification notif-2')).not.toBeInTheDocument();
    expect(screen.getByText('Saved order notification').compareDocumentPosition(screen.getByText('First server notification')) & 4).toBeTruthy();
    expect(screen.getByLabelText('Reorder destination Security Email').compareDocumentPosition(screen.getByLabelText('Reorder destination Ops MQTT')) & 4).toBeTruthy();
    expect(screen.getByLabelText('Reorder rule New CVE').compareDocumentPosition(screen.getByLabelText('Reorder rule Alert Threshold')) & 4).toBeTruthy();
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

  test('shows and submits the CrowdSec update rule without alert filters', async () => {
    const user = userEvent.setup();
    render(<Notifications />);

    await waitFor(() => expect(screen.getByRole('button', { name: /add rule/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /add rule/i }));
    await user.selectOptions(screen.getByLabelText('Rule Type'), 'crowdsec-update');

    expect(screen.getByText(/latest stable CrowdSec release/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Scenario Contains')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'CrowdSec updates');
    await user.click(screen.getByRole('button', { name: /save rule/i }));

    await waitFor(() => expect(createNotificationRule).toHaveBeenCalledWith(expect.objectContaining({
      name: 'CrowdSec updates',
      type: 'crowdsec-update',
      config: {},
    })));
  });

  test('shows and submits the lapi availability rule config without alert filters', async () => {
    const user = userEvent.setup();
    render(<Notifications />);

    await waitFor(() => expect(screen.getByRole('button', { name: /add rule/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /add rule/i }));
    await user.selectOptions(screen.getByLabelText('Rule Type'), 'lapi-availability');

    expect(screen.getByLabelText('Outage Threshold (seconds)')).toHaveValue('60');
    expect(screen.getByText(/send recovery notification/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Scenario Contains')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Target Contains')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Name'), 'LAPI health');
    await user.clear(screen.getByLabelText('Outage Threshold (seconds)'));
    await user.type(screen.getByLabelText('Outage Threshold (seconds)'), '90');
    await user.click(screen.getAllByRole('switch')[1]);
    await user.click(screen.getByRole('button', { name: /save rule/i }));

    expect(createNotificationRule).toHaveBeenCalledWith(expect.objectContaining({
      name: 'LAPI health',
      type: 'lapi-availability',
      config: {
        outage_threshold_seconds: 90,
        notify_on_recovery: true,
      },
    }));
  });

  test('shows and submits the IP ban rule with IP range and country filters', async () => {
    const user = userEvent.setup();
    render(<Notifications />);

    await waitFor(() => expect(screen.getByRole('button', { name: /add rule/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /add rule/i }));
    await user.selectOptions(screen.getByLabelText('Rule Type'), 'ip-ban');

    expect(screen.getByLabelText('Window Minutes')).toHaveValue('60');
    expect(screen.getByLabelText('IP / Range Filter')).toBeInTheDocument();
    expect(screen.getByLabelText('Country Filter (ISO Codes)')).toBeInTheDocument();
    expect(screen.getByText(/include simulated decisions/i)).toBeInTheDocument();
    expect(screen.getByText(/exclude selected countries/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Name'), 'Ban watch');
    await user.type(screen.getByLabelText('IP / Range Filter'), '203.0.113.10, 10.0.0.0/24');
    await user.type(screen.getByLabelText('Country Filter (ISO Codes)'), 'us, DE');
    await user.type(screen.getByLabelText('Scenario Contains'), 'ssh');
    await user.type(screen.getByLabelText('Target Contains'), 'sshd');
    await user.click(screen.getAllByRole('switch')[1]);
    await user.click(screen.getAllByRole('switch')[2]);
    await user.click(screen.getByRole('button', { name: /save rule/i }));

    expect(createNotificationRule).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Ban watch',
      type: 'ip-ban',
      config: {
        window_minutes: 60,
        filters: {
          scenario: 'ssh',
          target: 'sshd',
          include_simulated: true,
          values: ['203.0.113.10', '10.0.0.0/24'],
          countries: ['US', 'DE'],
          exclude_countries: true,
        },
      },
    }));
  });

  test('shows scenario exclusion and time-window help on applicable rule types', async () => {
    const user = userEvent.setup();
    render(<Notifications />);

    await waitFor(() => expect(screen.getByRole('button', { name: /add rule/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /add rule/i }));

    const ruleType = screen.getByLabelText('Rule Type');
    const windowCases = [
      ['alert-spike', /compare alerts in this rolling window/i],
      ['alert-threshold', /count matching alerts created within this rolling window/i],
      ['new-alert-decision', /look back this many minutes for newly created alerts and decisions/i],
      ['ip-ban', /look back this many minutes for ban decisions that are still active/i],
    ] as const;
    for (const [type, hint] of windowCases) {
      await user.selectOptions(ruleType, type);
      expect(screen.getByLabelText('Scenario Contains')).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: 'Exclude matching scenarios' })).toBeInTheDocument();
      expect(screen.getByLabelText('Window Minutes')).toBeInTheDocument();
      expect(screen.getByText(hint)).toBeInTheDocument();
    }

    await user.selectOptions(ruleType, 'new-cve');
    expect(screen.getByRole('checkbox', { name: 'Exclude matching scenarios' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Window Minutes')).not.toBeInTheDocument();

    for (const type of ['application-update', 'crowdsec-update', 'lapi-availability']) {
      await user.selectOptions(ruleType, type);
      expect(screen.queryByRole('checkbox', { name: 'Exclude matching scenarios' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Window Minutes')).not.toBeInTheDocument();
    }
  });

  test('configures per-record alerts and decisions with filters', async () => {
    const user = userEvent.setup();
    render(<Notifications />);

    await waitFor(() => expect(screen.getByRole('button', { name: /add rule/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /add rule/i }));
    await user.selectOptions(screen.getByLabelText('Rule Type'), 'new-alert-decision');

    expect(screen.getByLabelText('Window Minutes')).toHaveValue('5');
    expect(screen.getByRole('checkbox', { name: 'Alerts' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Decisions' })).toBeChecked();
    expect(screen.getByLabelText('IP / Range Filter')).toBeInTheDocument();
    expect(screen.getByText(/include simulated alerts and decisions/i)).toBeInTheDocument();
    expect(screen.getByText(/look back this many minutes/i)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Exclude matching scenarios' })).not.toBeChecked();

    await user.type(screen.getByLabelText('Name'), 'Every decision');
    await user.type(screen.getByLabelText('Scenario Contains'), 'ssh');
    await user.click(screen.getByRole('checkbox', { name: 'Exclude matching scenarios' }));
    await user.click(screen.getByRole('checkbox', { name: 'Alerts' }));
    await user.type(screen.getByLabelText('IP / Range Filter'), '10.0.0.0/24');
    await user.click(screen.getByRole('button', { name: /save rule/i }));

    expect(createNotificationRule).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Every decision',
      type: 'new-alert-decision',
      config: {
        window_minutes: 5,
        event_type: 'decision',
        filters: {
          scenario: 'ssh',
          exclude_scenario: true,
          target: '',
          include_simulated: false,
          values: ['10.0.0.0/24'],
        },
      },
    }));
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

});
