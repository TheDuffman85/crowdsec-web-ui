import { rmSync } from 'node:fs';
import path from 'node:path';
import { hashPassword } from '../server/app-auth';
import { CrowdsecDatabase } from '../server/database';

const dbDir = process.env.DB_DIR || path.join(process.env.TMPDIR || '/tmp', 'crowdsec-web-ui-screenshots');
const dbPath = path.join(dbDir, 'crowdsec.db');
const demoUsername = process.env.CROWDSEC_SCREENSHOT_USERNAME || 'admin';
const demoPassword = process.env.CROWDSEC_SCREENSHOT_PASSWORD || 'Screenshot123';

rmSync(dbPath, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
rmSync(`${dbPath}-wal`, { force: true });

const database = new CrowdsecDatabase({ dbDir });

database.createAuthUser({
  username: demoUsername,
  passwordHash: await hashPassword(demoPassword),
  role: 'admin',
  authProvider: 'password',
});

const now = new Date();
const iso = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
const futureIso = (hoursFromNow: number) => new Date(now.getTime() + hoursFromNow * 3_600_000).toISOString();
const pastIso = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();

type DemoAlertOptions = {
  id: number;
  minutesAgo: number;
  scenario: string;
  reason?: string;
  ip: string;
  country: string;
  asName: string;
  asNumber: number;
  target: string;
  machine: string;
  origin: string;
  latitude: number;
  longitude: number;
  simulated?: boolean;
  eventsCount: number;
  decisions?: Array<{
    id: string;
    type: string;
    value: string;
    origin: string;
    duration: string;
    stopAt: string;
    simulated?: boolean;
  }>;
};

function buildEvents(alert: DemoAlertOptions) {
  return Array.from({ length: Math.min(alert.eventsCount, 12) }, (_, index) => ({
    timestamp: iso(alert.minutesAgo + index),
    meta: [
      { key: 'target_fqdn', value: alert.target },
      { key: 'service', value: alert.target },
      { key: 'log_type', value: index % 2 === 0 ? 'auth' : 'access' },
      { key: 'method', value: index % 2 === 0 ? 'password' : 'GET' },
      { key: 'status', value: index % 2 === 0 ? 'failed' : '403' },
    ],
  }));
}

function insertAlert(options: DemoAlertOptions) {
  const createdAt = iso(options.minutesAgo);
  const decisions = (options.decisions || []).map((decision) => ({
    id: decision.id,
    type: decision.type,
    value: decision.value,
    duration: decision.duration,
    stop_at: decision.stopAt,
    created_at: createdAt,
    origin: decision.origin,
    scenario: options.scenario,
    simulated: decision.simulated === true,
  }));
  const alert = {
    id: options.id,
    uuid: `demo-alert-${options.id}`,
    created_at: createdAt,
    scenario: options.scenario,
    reason: options.reason,
    message: `${options.eventsCount} events matched ${options.scenario} from ${options.ip}`,
    machine_id: options.machine,
    machine_alias: options.machine,
    events_count: options.eventsCount,
    events: buildEvents(options),
    decisions,
    target: options.target,
    simulated: options.simulated === true,
    source: {
      scope: 'ip',
      value: options.ip,
      ip: options.ip,
      cn: options.country,
      as_name: options.asName,
      as_number: options.asNumber,
      latitude: options.latitude,
      longitude: options.longitude,
    },
  };

  database.insertAlert({
    $id: String(options.id),
    $uuid: String(alert.uuid),
    $created_at: createdAt,
    $scenario: options.scenario,
    $source_ip: options.ip,
    $message: String(alert.message),
    $raw_data: JSON.stringify(alert),
  });

  for (const decision of decisions) {
    database.insertDecision({
      $id: String(decision.id),
      $uuid: `demo-decision-${decision.id}`,
      $alert_id: String(options.id),
      $created_at: createdAt,
      $stop_at: String(decision.stop_at),
      $value: String(decision.value),
      $type: String(decision.type),
      $origin: String(decision.origin),
      $scenario: options.scenario,
      $raw_data: JSON.stringify({
        ...decision,
        alert_id: options.id,
        machine_id: options.machine,
        machine_alias: options.machine,
        country: options.country,
        as: options.asName,
        target: options.target,
        reason: options.reason || options.scenario,
      }),
    });
  }
}

insertAlert({
  id: 1042,
  minutesAgo: 0,
  scenario: 'crowdsecurity/ssh-bf',
  reason: 'SSH brute force',
  ip: '45.146.164.110',
  country: 'NL',
  asName: 'Stark Industries Solutions',
  asNumber: 44477,
  target: 'ssh',
  machine: 'edge-gateway-01',
  origin: 'crowdsec',
  latitude: 52.3676,
  longitude: 4.9041,
  eventsCount: 46,
  decisions: [
    { id: '4201', type: 'ban', value: '45.146.164.110', origin: 'crowdsec', duration: '4h', stopAt: futureIso(4) },
  ],
});

insertAlert({
  id: 1041,
  minutesAgo: 0,
  scenario: 'crowdsecurity/http-probing',
  reason: 'HTTP probing',
  ip: '91.240.118.172',
  country: 'DE',
  asName: 'Hetzner Online GmbH',
  asNumber: 24940,
  target: 'reverse-proxy',
  machine: 'proxy-01',
  origin: 'crowdsec',
  latitude: 50.1109,
  longitude: 8.6821,
  eventsCount: 28,
  decisions: [
    { id: '4202', type: 'ban', value: '91.240.118.172', origin: 'crowdsec', duration: '2h', stopAt: futureIso(2) },
  ],
});

insertAlert({
  id: 1040,
  minutesAgo: 0,
  scenario: 'crowdsecurity/appsec-vpatch',
  reason: 'Virtual patch match',
  ip: '198.51.100.24',
  country: 'US',
  asName: 'Example Transit',
  asNumber: 64512,
  target: 'appsec',
  machine: 'appsec-01',
  origin: 'crowdsec',
  latitude: 37.7749,
  longitude: -122.4194,
  eventsCount: 9,
  decisions: [
    { id: '4203', type: 'captcha', value: '198.51.100.24', origin: 'crowdsec', duration: '1h', stopAt: futureIso(1) },
  ],
});

insertAlert({
  id: 1039,
  minutesAgo: 0,
  scenario: 'crowdsecurity/community-blocklist',
  reason: 'Community blocklist',
  ip: '203.0.113.77',
  country: 'FR',
  asName: 'Demo Backbone',
  asNumber: 64513,
  target: 'firewall',
  machine: 'edge-gateway-01',
  origin: 'CAPI',
  latitude: 48.8566,
  longitude: 2.3522,
  eventsCount: 1,
  decisions: [
    { id: '4204', type: 'ban', value: '203.0.113.77', origin: 'CAPI', duration: '24h', stopAt: futureIso(24) },
  ],
});

insertAlert({
  id: 1038,
  minutesAgo: 0,
  scenario: 'crowdsecurity/ssh-bf',
  reason: 'SSH brute force simulation',
  ip: '192.0.2.44',
  country: 'GB',
  asName: 'Documentation Network',
  asNumber: 64514,
  target: 'ssh',
  machine: 'dev-bastion',
  origin: 'manual',
  latitude: 51.5072,
  longitude: -0.1276,
  eventsCount: 14,
  simulated: true,
  decisions: [
    { id: '4205', type: 'ban', value: '192.0.2.44', origin: 'manual', duration: '30m', stopAt: futureIso(0.5), simulated: true },
  ],
});

database.insertDecision({
  $id: '4206',
  $uuid: 'demo-decision-4206',
  $alert_id: '1041',
  $created_at: pastIso(12),
  $stop_at: pastIso(2),
  $value: '91.240.118.172',
  $type: 'ban',
  $origin: 'crowdsec',
  $scenario: 'crowdsecurity/http-probing',
  $raw_data: JSON.stringify({
    id: '4206',
    alert_id: 1041,
    created_at: pastIso(12),
    stop_at: pastIso(2),
    type: 'ban',
    value: '91.240.118.172',
    origin: 'crowdsec',
    scenario: 'crowdsecurity/http-probing',
    machine_alias: 'proxy-01',
    country: 'DE',
    as: 'Hetzner Online GmbH',
    target: 'reverse-proxy',
  }),
});

database.upsertNotificationChannel({
  $id: 'channel-email',
  $created_at: pastIso(30),
  $updated_at: iso(22),
  $name: 'Security Email',
  $type: 'email',
  $enabled: 0,
  $config_json: JSON.stringify({
    smtpHost: 'smtp.example.lan',
    smtpPort: 587,
    smtpUser: 'crowdsec',
    smtpPassword: '__stored_secret__',
    smtpFrom: 'crowdsec@example.lan',
    emailTo: 'secops@example.lan',
    smtpTlsMode: 'starttls',
  }),
});

database.upsertNotificationChannel({
  $id: 'channel-ntfy',
  $created_at: pastIso(26),
  $updated_at: iso(21),
  $name: 'On-call ntfy',
  $type: 'ntfy',
  $enabled: 1,
  $config_json: JSON.stringify({
    serverUrl: 'https://ntfy.sh',
    topic: 'crowdsec-demo-alerts',
    token: '__stored_secret__',
    priority: 'high',
  }),
});

database.upsertNotificationRule({
  $id: 'rule-spike',
  $created_at: pastIso(24),
  $updated_at: iso(20),
  $name: 'Alert spike watch',
  $type: 'alert-spike',
  $enabled: 1,
  $severity: 'critical',
  $channel_ids_json: JSON.stringify(['channel-ntfy']),
  $config_json: JSON.stringify({
    window_minutes: 60,
    percent_increase: 150,
    minimum_current_alerts: 10,
    filters: { scenario: '', target: '', include_simulated: false },
  }),
});

database.upsertNotificationRule({
  $id: 'rule-update',
  $created_at: pastIso(20),
  $updated_at: iso(19),
  $name: 'Application updates',
  $type: 'application-update',
  $enabled: 1,
  $severity: 'info',
  $channel_ids_json: JSON.stringify(['channel-ntfy']),
  $config_json: JSON.stringify({}),
});

database.insertNotification({
  $id: 'notification-spike',
  $created_at: iso(17),
  $updated_at: iso(17),
  $rule_id: 'rule-spike',
  $rule_name: 'Alert spike watch',
  $rule_type: 'alert-spike',
  $severity: 'critical',
  $title: 'Alert spike detected',
  $message: '46 SSH brute-force events were recorded against edge-gateway-01 in the last hour.',
  $read_at: null,
  $metadata_json: JSON.stringify({ scenario: 'crowdsecurity/ssh-bf', target: 'ssh', count: 46 }),
  $deliveries_json: JSON.stringify([
    { channel_id: 'channel-email', channel_name: 'Security Email', status: 'delivered' },
    { channel_id: 'channel-ntfy', channel_name: 'On-call ntfy', status: 'delivered' },
  ]),
  $dedupe_key: 'alert-spike:ssh',
});

database.insertNotification({
  $id: 'notification-update',
  $created_at: iso(31),
  $updated_at: iso(31),
  $rule_id: 'rule-update',
  $rule_name: 'Application updates',
  $rule_type: 'application-update',
  $severity: 'info',
  $title: 'CrowdSec Web UI update available',
  $message: 'Version 2026.06.06 is available for the configured container image.',
  $read_at: iso(29),
  $metadata_json: JSON.stringify({ current_version: '2026.06.05', remote_version: '2026.06.06' }),
  $deliveries_json: JSON.stringify([
    { channel_id: 'channel-email', channel_name: 'Security Email', status: 'delivered' },
  ]),
  $dedupe_key: 'app-update:2026.06.06',
});

database.setMeta('refresh_interval_ms', '300000');
database.close();

console.log(`Seeded screenshot database at ${dbPath}`);
