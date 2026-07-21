import { describe, expect, test, vi } from 'vitest';
import path from 'path';
import { CrowdsecDatabase } from '../../database';
import type { MqttPublishConfig } from '../../notifications/mqtt-client';
import {
  createController,
  destroyTempDir,
  sampleAlert,
  sampleManualWebUiAlert,
  seedAlert,
  tempDir,
} from './harness';

describe('createApp notification destinations', () => {
  test('stores notification channel secrets encrypted at rest', async () => {
    const { controller, database } = createController();

    const createChannel = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'SMTP main',
          type: 'email',
          enabled: true,
          config: {
            smtpHost: 'smtp.example.com',
            smtpPort: 587,
            smtpTlsMode: 'starttls',
            smtpUser: 'ops',
            smtpPassword: 'super-secret-password',
            smtpFrom: 'ops@example.com',
            emailTo: 'team@example.com',
          },
        }),
      }),
    );
    expect(createChannel.status).toBe(201);
    const channelPayload = await createChannel.json() as { id: string; config: { smtpPassword: string } };
    expect(channelPayload.config.smtpPassword).toBe('(stored)');

    const stored = database.getNotificationChannelById(channelPayload.id);
    if (!stored?.config_json) {
      throw new Error('Expected stored notification channel config to be persisted');
    }
    expect(stored.config_json.startsWith('enc:v1:')).toBe(true);
    expect(stored.config_json.includes('super-secret-password')).toBe(false);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('auto-generates and persists the notification secret key when not configured', async () => {
    const first = createController();
    const generatedKey = first.database.getMeta('notification_secret_key')?.value;
    expect(generatedKey).toBeTruthy();

    const createChannel = await first.controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'SMTP main',
          type: 'email',
          enabled: true,
          config: {
            smtpHost: 'smtp.example.com',
            smtpPort: 587,
            smtpTlsMode: 'starttls',
            smtpUser: 'ops',
            smtpPassword: 'super-secret-password',
            smtpFrom: 'ops@example.com',
            emailTo: 'team@example.com',
          },
        }),
      }),
    );
    expect(createChannel.status).toBe(201);
    first.controller.stopBackgroundTasks();
    first.database.close();

    const second = createController();
    expect(second.database.getMeta('notification_secret_key')?.value).toBe(generatedKey);

    const settings = await second.controller.fetch(new Request('http://localhost/crowdsec/api/notifications/settings'));
    expect(settings.status).toBe(200);
    expect((await settings.json()) as { channels: Array<{ name: string; configured_secrets: string[] }> }).toEqual(
      expect.objectContaining({
        channels: [expect.objectContaining({ name: 'SMTP main', configured_secrets: ['smtpPassword'] })],
      }),
    );

    second.controller.stopBackgroundTasks();
    second.database.close();
    destroyTempDir();
  });

  test('blocks private notification destinations unless explicitly allowed', async () => {
    const { controller, database } = createController({
      env: {
        NOTIFICATION_ALLOW_PRIVATE_ADDRESSES: 'false',
      },
    });

    const createChannel = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Local webhook',
          type: 'webhook',
          enabled: true,
          config: {
            url: 'http://127.0.0.1/hooks/notify',
            method: 'POST',
            body: { mode: 'json', template: '{"ok":true}' },
            retryAttempts: 0,
          },
        }),
      }),
    );
    expect(createChannel.status).toBe(201);
    const channelPayload = database.listNotificationChannels()[0] as { id?: string };

    const testChannel = await controller.fetch(new Request(`http://localhost/crowdsec/api/notification-channels/${channelPayload.id}/test`, { method: 'POST' }));
    expect(testChannel.status).toBe(400);
    expect((await testChannel.json()) as { error: string }).toEqual({
      error: 'Webhook URL points to a restricted address (127.0.0.1)',
    });

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('allows private notification destinations when explicitly enabled', async () => {
    const { controller, database } = createController({
      env: {
        NOTIFICATION_ALLOW_PRIVATE_ADDRESSES: 'true',
      },
      notificationFetchResolver: (url) => {
        if (url.includes('127.0.0.1')) {
          return Response.json({ ok: true });
        }
        return undefined;
      },
    });

    const createChannel = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Local webhook',
          type: 'webhook',
          enabled: true,
          config: {
            url: 'http://127.0.0.1/hooks/notify',
            method: 'POST',
            body: { mode: 'json', template: '{"ok":true}' },
            retryAttempts: 0,
          },
        }),
      }),
    );
    expect(createChannel.status).toBe(201);
    const channelPayload = database.listNotificationChannels()[0] as { id?: string };

    const testChannel = await controller.fetch(new Request(`http://localhost/crowdsec/api/notification-channels/${channelPayload.id}/test`, { method: 'POST' }));
    expect(testChannel.status).toBe(200);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('exposes truncated remote notification response snippets to clients', async () => {
    const { controller, database } = createController({
      notificationFetchResolver: (url) => {
        if (url.includes('198.51.100.10')) {
          return new Response('internal token leaked', { status: 500 });
        }
        return undefined;
      },
    });

    const createChannel = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Webhook prod',
          type: 'webhook',
          enabled: true,
          config: {
            url: 'https://198.51.100.10/hooks/notify',
            method: 'POST',
            body: { mode: 'json', template: '{"ok":true}' },
            retryAttempts: 0,
          },
        }),
      }),
    );
    expect(createChannel.status).toBe(201);
    const channelPayload = database.listNotificationChannels()[0] as { id?: string };

    const testChannel = await controller.fetch(new Request(`http://localhost/crowdsec/api/notification-channels/${channelPayload.id}/test`, { method: 'POST' }));
    expect(testChannel.status).toBe(400);
    expect((await testChannel.json()) as { error: string }).toEqual({
      error: 'Webhook request failed with status 500: internal token leaked',
    });

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('delivers rule notifications to MQTT destinations', async () => {
    const liveAlert = sampleAlert({
      id: 100,
      uuid: 'alert-100',
      created_at: new Date().toISOString(),
    });

    const mqttPublishes: Array<{ config: MqttPublishConfig; payload: string }> = [];
    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '168h',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([liveAlert]);
        }
        return undefined;
      },
      mqttPublishResolver: (config, payload) => {
        mqttPublishes.push({ config, payload });
      },
    });

    const createChannel = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Primary MQTT',
          type: 'mqtt',
          enabled: true,
          config: {
            brokerUrl: 'mqtt://broker.example.com:1883',
            topic: 'crowdsec/notifications',
            keepaliveSeconds: 45,
            connectTimeoutMs: 5000,
            qos: 1,
            retainEvents: true,
          },
        }),
      }),
    );
    expect(createChannel.status).toBe(201);
    const channelPayload = await createChannel.json() as { id: string };

    const createRule = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'MQTT threshold',
          type: 'alert-threshold',
          enabled: true,
          severity: 'critical',
          channel_ids: [channelPayload.id],
          config: {
            window_minutes: 60,
            alert_threshold: 1,
            filters: {},
          },
        }),
      }),
    );
    expect(createRule.status).toBe(201);

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(200);

    expect(mqttPublishes).toHaveLength(1);
    expect(mqttPublishes[0]?.config).toEqual(expect.objectContaining({
      brokerUrl: 'mqtt://broker.example.com:1883',
      topic: 'crowdsec/notifications',
      qos: 1,
      retainEvents: true,
    }));
    expect(JSON.parse(mqttPublishes[0]?.payload || '{}')).toEqual(expect.objectContaining({
      title: 'MQTT threshold: threshold exceeded',
      severity: 'critical',
      channel_name: 'Primary MQTT',
      rule_name: 'MQTT threshold',
    }));

    const testChannel = await controller.fetch(new Request(`http://localhost/crowdsec/api/notification-channels/${channelPayload.id}/test`, { method: 'POST' }));
    expect(testChannel.status).toBe(200);
    expect(mqttPublishes).toHaveLength(2);
    expect(JSON.parse(mqttPublishes[1]?.payload || '{}')).toEqual(expect.objectContaining({
      rule_name: 'Test notification',
      rule_type: 'test',
      severity: 'info',
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

});
