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

describe('createApp notification events', () => {
  test('supports notification settings APIs and records fired notifications', async () => {
    const liveAlert = sampleAlert({
      id: 99,
      uuid: 'alert-99',
      created_at: new Date().toISOString(),
    });

    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '1m',
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
      notificationFetchResolver: (url) => {
        if (url.includes('ntfy.sh')) {
          return Response.json({ id: 'msg' });
        }
        return undefined;
      },
    });

    const bootstrap = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(bootstrap.status).toBe(200);

    const createChannel = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Main ntfy',
          type: 'ntfy',
          enabled: true,
          config: { topic: 'crowdsec-test' },
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
          name: 'High volume',
          type: 'alert-threshold',
          enabled: true,
          severity: 'warning',
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

    const notifications = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications'));
    expect(notifications.status).toBe(200);
    const notificationsPayload = await notifications.json() as { unread_count: number; data: Array<{ id: string; deliveries: Array<{ status: string }> }> };
    expect(notificationsPayload.unread_count).toBe(1);
    expect(notificationsPayload.data[0]?.deliveries[0]?.status).toBe('delivered');

    const settings = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications/settings'));
    expect(settings.status).toBe(200);
    expect((await settings.json()) as { channels: Array<{ name: string }>; rules: Array<{ name: string }> }).toEqual(
      expect.objectContaining({
        channels: [expect.objectContaining({ name: 'Main ntfy' })],
        rules: [expect.objectContaining({ name: 'High volume' })],
      }),
    );

    const testChannel = await controller.fetch(new Request(`http://localhost/crowdsec/api/notification-channels/${channelPayload.id}/test`, { method: 'POST' }));
    expect(testChannel.status).toBe(200);

    const markRead = await controller.fetch(new Request(`http://localhost/crowdsec/api/notifications/${notificationsPayload.data[0]?.id}/read`, { method: 'POST' }));
    expect(markRead.status).toBe(200);

    const bulkRead = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications/bulk-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: notificationsPayload.data.map((notification) => notification.id) }),
    }));
    expect(bulkRead.status).toBe(200);

    const deleteRead = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications/delete-read', { method: 'POST' }));
    expect(deleteRead.status).toBe(200);

    const deleteRule = await controller.fetch(new Request('http://localhost/crowdsec/api/notification-rules/not-real', { method: 'DELETE' }));
    expect(deleteRule.status).toBe(200);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('runs IP ban notification evaluation after adding a manual decision', async () => {
    const manualAlert = sampleManualWebUiAlert({
      id: 377,
      uuid: 'alert-377',
      created_at: new Date().toISOString(),
      source: {
        ip: '203.0.113.10',
        value: '203.0.113.10',
      },
      decisions: [
        {
          id: 3770,
          type: 'ban',
          value: '203.0.113.10',
          duration: '4h',
          stop_at: new Date(Date.now() + 4 * 60 * 60 * 1_000).toISOString(),
          origin: 'cscli',
          scenario: 'manual/web-ui',
          simulated: false,
        },
      ],
    });

    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '1m',
      },
      fetchResolver: (url, init) => {
        if (url.endsWith('/v1/alerts') && init?.method === 'POST') {
          return Response.json({ ok: true });
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([manualAlert]);
        }
        return undefined;
      },
    });

    const createRule = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Manual bans',
          type: 'ip-ban',
          enabled: true,
          severity: 'warning',
          channel_ids: [],
          config: {
            window_minutes: 60,
            filters: {
              values: ['203.0.113.10'],
            },
          },
        }),
      }),
    );
    expect(createRule.status).toBe(201);

    const addDecision = await controller.fetch(
      new Request('http://localhost/crowdsec/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: '203.0.113.10',
          type: 'ban',
          duration: '4h',
          reason: 'manual test',
        }),
      }),
    );
    expect(addDecision.status).toBe(200);

    const notifications = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications'));
    expect(notifications.status).toBe(200);
    expect((await notifications.json()) as {
      data: Array<{ rule_type: string; metadata: Record<string, unknown> }>;
    }).toEqual(expect.objectContaining({
      data: [
        expect.objectContaining({
          rule_type: 'ip-ban',
          metadata: expect.objectContaining({
            decision_id: '3770',
            value: '203.0.113.10',
          }),
        }),
      ],
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('does not wait for outbound IP ban notification delivery when adding a manual decision', async () => {
    const manualAlert = sampleManualWebUiAlert({
      id: 399,
      uuid: 'alert-399',
      created_at: new Date().toISOString(),
      source: {
        ip: '1.2.3.4',
        value: '1.2.3.4',
      },
      decisions: [
        {
          id: 3990,
          type: 'ban',
          value: '1.2.3.4',
          duration: '4h',
          stop_at: new Date(Date.now() + 4 * 60 * 60 * 1_000).toISOString(),
          origin: 'cscli',
          scenario: 'manual/web-ui',
          simulated: false,
        },
      ],
    });
    let releaseNotification!: () => void;
    let notificationStarted = false;
    let notificationFinished = false;
    const notificationGate = new Promise<void>((resolve) => {
      releaseNotification = resolve;
    });

    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '168h',
      },
      fetchResolver: (url, init) => {
        if (url.endsWith('/v1/alerts') && init?.method === 'POST') {
          return Response.json({ ok: true });
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([manualAlert]);
        }
        return undefined;
      },
      notificationFetchResolver: async () => {
        notificationStarted = true;
        await notificationGate;
        notificationFinished = true;
        return Response.json({ ok: true });
      },
    });

    const bootstrap = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(bootstrap.status).toBe(200);

    const createChannel = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Slow webhook',
          type: 'webhook',
          enabled: true,
          config: {
            url: 'https://example.com/webhook',
            method: 'POST',
            retryAttempts: 0,
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
          name: 'CrowdSec: IP Ban',
          type: 'ip-ban',
          enabled: true,
          severity: 'warning',
          channel_ids: [channelPayload.id],
          config: {
            window_minutes: 60,
            filters: {
              values: ['1.2.3.4'],
            },
          },
        }),
      }),
    );
    expect(createRule.status).toBe(201);

    const addDecision = await controller.fetch(
      new Request('http://localhost/crowdsec/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: '1.2.3.4',
          type: 'ban',
          duration: '4h',
          reason: 'manual test',
        }),
      }),
    );

    expect(addDecision.status).toBe(200);
    expect(notificationFinished).toBe(false);

    await vi.waitFor(() => expect(notificationStarted).toBe(true));

    releaseNotification();
    for (let index = 0; index < 10 && !notificationFinished; index += 1) {
      await Promise.resolve();
    }
    expect(notificationFinished).toBe(true);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('treats duration-only decisions as remaining time from sync', async () => {
    const remainingMs = 44 * 60 * 1_000 + 40 * 1_000;
    const createdAt = new Date(Date.now() - 4 * 60 * 60 * 1_000).toISOString();
    const durationOnlyAlert = sampleManualWebUiAlert({
      id: 388,
      uuid: 'alert-388',
      created_at: createdAt,
      decisions: [
        {
          id: 3880,
          type: 'ban',
          value: '1.2.3.4',
          duration: '44m40s',
          origin: 'cscli',
          scenario: 'manual/web-ui',
          simulated: false,
        },
      ],
    });

    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '168h',
      },
      fetchResolver: (url) => {
        if (url.includes('/v1/alerts?')) {
          return Response.json([durationOnlyAlert]);
        }
        return undefined;
      },
    });

    const beforeRefresh = Date.now();
    const firstRefresh = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    const afterRefresh = Date.now();
    expect(firstRefresh.status).toBe(200);
    const cachedStopAt = Date.parse(database.getDecisionById('3880')?.stop_at || '');
    expect(cachedStopAt).toBeGreaterThanOrEqual(beforeRefresh + remainingMs);
    expect(cachedStopAt).toBeLessThanOrEqual(afterRefresh + remainingMs);
    expect(cachedStopAt).toBeGreaterThan(Date.now());

    const decisionsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=50&alert_id=388&include_expired=true'));
    expect(decisionsResponse.status).toBe(200);
    const decisionsJson = await decisionsResponse.json() as {
      data: Array<{ id: number; expired: boolean; detail: { duration: string } }>;
      selectable_ids: number[];
    };
    expect(decisionsJson.data).toEqual([
      expect.objectContaining({
        id: 3880,
        expired: false,
        detail: expect.objectContaining({ duration: '44m40s' }),
      }),
    ]);
    expect(decisionsJson.selectable_ids).toEqual([3880]);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('marks an externally deleted decision inactive when LAPI retains it on the historical alert', async () => {
    const createdAt = new Date(Date.now() - 45 * 60 * 1_000).toISOString();
    const cachedOldAlert = sampleManualWebUiAlert({
      id: 390,
      uuid: 'alert-390',
      created_at: createdAt,
      decisions: [{
        id: 3900,
        type: 'ban',
        value: '1.2.3.4',
        duration: '4h',
        stop_at: new Date(Date.now() + 3 * 60 * 60 * 1_000).toISOString(),
        origin: 'cscli',
        scenario: 'manual/web-ui',
        simulated: false,
      }],
    });
    const expiredOldAlert = sampleManualWebUiAlert({
      ...cachedOldAlert,
      decisions: [{
        id: 3900,
        type: 'ban',
        value: '1.2.3.4',
        duration: '-1s',
        origin: 'cscli',
        scenario: 'manual/web-ui',
        simulated: false,
      }],
    });
    const replacementAlert = sampleManualWebUiAlert({
      id: 391,
      uuid: 'alert-391',
      created_at: new Date().toISOString(),
      decisions: [{
        id: 3910,
        type: 'ban',
        value: '1.2.3.4',
        duration: '4h',
        origin: 'cscli',
        scenario: 'manual/web-ui',
        simulated: false,
      }],
    });
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    seedAlert(database, cachedOldAlert);
    const { controller } = createController({
      database,
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '1h',
      },
      fetchResolver: (url) => url.includes('/v1/alerts?')
        ? Response.json([replacementAlert, expiredOldAlert])
        : undefined,
    });

    const activeResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=50'));
    expect(activeResponse.status).toBe(200);
    const activeJson = await activeResponse.json() as { data: Array<{ id: number; expired: boolean }> };
    expect(activeJson.data).toEqual([
      expect.objectContaining({ id: 3910, expired: false }),
    ]);

    const allResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=50&include_expired=true'));
    expect(allResponse.status).toBe(200);
    const allJson = await allResponse.json() as { data: Array<{ id: number; expired: boolean }> };
    expect(allJson.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 3900, expired: true }),
      expect.objectContaining({ id: 3910, expired: false }),
    ]));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('uses a shared observation time and prefers the newest equal-expiry duplicate', async () => {
    const createdAt = new Date(Date.now() - 4 * 60 * 60 * 1_000).toISOString();
    const olderAlert = sampleManualWebUiAlert({
      id: 388,
      uuid: 'alert-388',
      created_at: createdAt,
      decisions: [{
        id: 3880,
        type: 'ban',
        value: '1.2.3.4',
        duration: '44m40s',
        origin: 'crowdsec',
        simulated: false,
      }],
    });
    const newerAlert = sampleManualWebUiAlert({
      id: 389,
      uuid: 'alert-389',
      created_at: createdAt,
      decisions: [{
        id: 3890,
        type: 'ban',
        value: '1.2.3.4',
        duration: '44m40s',
        origin: 'crowdsec',
        simulated: false,
      }],
    });

    const { controller, database } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '168h',
      },
      fetchResolver: (url) => url.includes('/v1/alerts?')
        ? Response.json([newerAlert, olderAlert])
        : undefined,
    });

    const alertsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsResponse.status).toBe(200);
    expect(database.getDecisionById('3880')?.stop_at).toBe(database.getDecisionById('3890')?.stop_at);

    const decisionsResponse = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions'));
    expect(decisionsResponse.status).toBe(200);
    const decisions = await decisionsResponse.json() as Array<{ id: number; is_duplicate: boolean }>;
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 3880, is_duplicate: true }),
      expect.objectContaining({ id: 3890, is_duplicate: false }),
    ]));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

});
