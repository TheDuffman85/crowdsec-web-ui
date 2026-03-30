import { describe, expect, test } from 'vitest';
import type { NotificationChannel } from '../../shared/contracts';
import { getNotificationProvider, STORED_SECRET_SENTINEL, type NotificationProviderPayload } from './notifications/providers';

const basePayload: NotificationProviderPayload = {
  title: 'Alert threshold exceeded',
  message: '25 alerts matched in the last hour.',
  severity: 'warning',
  metadata: { matched_alerts: 25 },
  sent_at: '2026-03-28T12:00:00.000Z',
  channel_id: 'channel-1',
  channel_name: 'Ops',
  channel_type: 'mqtt',
  rule_id: 'rule-1',
  rule_name: 'Alert threshold',
  rule_type: 'alert-threshold',
};

function createChannel(type: NotificationChannel['type'], config: NotificationChannel['config']): NotificationChannel {
  return {
    id: 'channel-1',
    name: 'Primary',
    type,
    enabled: true,
    config,
    configured_secrets: [],
    created_at: '2026-03-28T12:00:00.000Z',
    updated_at: '2026-03-28T12:00:00.000Z',
  };
}

describe('notification providers', () => {
  test('email provider auto-upgrades legacy config and masks stored secrets', () => {
    const provider = getNotificationProvider('email');
    const normalized = provider.normalizeConfig({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      username: 'ops',
      password: 'secret',
      from: 'ops@example.com',
      to: 'team@example.com',
      subject_prefix: '[Legacy]',
    });

    expect(normalized).toEqual(expect.objectContaining({
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpTlsMode: 'tls',
      smtpUser: 'ops',
      smtpPassword: 'secret',
      smtpFrom: 'ops@example.com',
      emailTo: 'team@example.com',
      subjectPrefix: '[Legacy]',
    }));
    expect(provider.maskConfig(normalized)).toEqual(expect.objectContaining({
      smtpPassword: STORED_SECRET_SENTINEL,
    }));
  });

  test('webhook provider migrates authorization_header into advanced config and preserves masked secrets', () => {
    const provider = getNotificationProvider('webhook');
    const normalized = provider.normalizeConfig({
      url: 'https://example.com/webhook',
      method: 'POST',
      authorization_header: 'Bearer old-token',
    });

    expect(normalized).toEqual(expect.objectContaining({
      url: 'https://example.com/webhook',
      method: 'POST',
      headers: [expect.objectContaining({ name: 'Authorization', value: 'Bearer old-token', sensitive: true })],
    }));

    const merged = provider.normalizeConfig({
      url: 'https://example.com/webhook',
      method: 'PATCH',
      headers: [{ name: 'Authorization', value: STORED_SECRET_SENTINEL, sensitive: true }],
    }, normalized);

    expect(merged).toEqual(expect.objectContaining({
      method: 'PATCH',
      headers: [expect.objectContaining({ name: 'Authorization', value: 'Bearer old-token', sensitive: true })],
    }));

    const masked = provider.maskConfig(merged);
    expect(masked).toEqual(expect.objectContaining({
      headers: [expect.objectContaining({ name: 'Authorization', value: STORED_SECRET_SENTINEL, sensitive: true })],
    }));
  });

  test('mqtt provider validates config and publishes the expected payload', async () => {
    const provider = getNotificationProvider('mqtt');
    const config = provider.normalizeConfig({
      brokerUrl: 'mqtt://broker.example.com:1883',
      username: 'ops',
      password: 'secret',
      clientId: 'crowdsec-web-ui',
      keepaliveSeconds: 45,
      connectTimeoutMs: 5000,
      qos: 1,
      topic: 'crowdsec/notifications',
      retainEvents: true,
    });

    expect(provider.validateConfig(config)).toBeNull();

    const published: Array<{ config: unknown; payload: string }> = [];
    await provider.send(createChannel('mqtt', config), basePayload, {
      fetchImpl: async () => Response.json({}),
      assertHostAllowed: async () => {},
      assertUrlAllowed: async () => {},
      mqttPublishImpl: async (publishConfig, payload) => {
        published.push({ config: publishConfig, payload });
      },
    });

    expect(published).toHaveLength(1);
    expect(published[0]?.config).toEqual(expect.objectContaining({
      brokerUrl: 'mqtt://broker.example.com:1883',
      topic: 'crowdsec/notifications',
      retainEvents: true,
      qos: 1,
    }));
    expect(JSON.parse(published[0]?.payload || '{}')).toEqual(expect.objectContaining({
      severity: 'warning',
      channel_name: 'Ops',
      rule_name: 'Alert threshold',
      metadata: { matched_alerts: 25 },
    }));
  });
});
