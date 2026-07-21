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

describe('createApp notification rules', () => {
  test('fires application update rules when a newer version is available', async () => {
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
          return Response.json([]);
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

    const createChannel = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Update ntfy',
          type: 'ntfy',
          enabled: true,
          config: { topic: 'crowdsec-updates' },
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
          name: 'App updates',
          type: 'application-update',
          enabled: true,
          severity: 'info',
          channel_ids: [channelPayload.id],
          config: {},
        }),
      }),
    );
    expect(createRule.status).toBe(201);

    const alerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alerts.status).toBe(200);

    const notifications = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications'));
    expect(notifications.status).toBe(200);
    expect((await notifications.json()) as {
      data: Array<{ rule_type: string; title: string; metadata: { remote_version?: string | null } }>;
    }).toEqual(expect.objectContaining({
      data: [
        expect.objectContaining({
          rule_type: 'application-update',
          title: 'App updates: application update available',
          metadata: expect.objectContaining({ remote_version: '2.0.0' }),
        }),
      ],
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('creates and evaluates lapi availability rules through the API', async () => {
    const { controller, database, lapiClient } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '168h',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?')) {
          return Response.json([]);
        }
        return undefined;
      },
    });

    const initialAlerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(initialAlerts.status).toBe(200);

    const createRule = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'LAPI health',
          type: 'lapi-availability',
          enabled: true,
          severity: 'critical',
          channel_ids: [],
          config: {
            outage_threshold_seconds: 60,
            notify_on_recovery: true,
          },
        }),
      }),
    );
    expect(createRule.status).toBe(201);

    const offlineSince = new Date(Date.now() - 90_000).toISOString();
    lapiClient.updateStatus(false, { message: 'LAPI offline' });
    (lapiClient as unknown as { lapiStatus: { offline_since: string | null } }).lapiStatus.offline_since = offlineSince;
    lapiClient.fetchAlerts = async () => {
      throw new Error('LAPI offline');
    };

    const alertsDuringOutage = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(alertsDuringOutage.status).toBe(200);

    const notifications = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications'));
    expect(notifications.status).toBe(200);
    expect((await notifications.json()) as {
      data: Array<{ rule_type: string; title: string; severity: string; metadata: { offline_since?: string; last_error?: string } }>;
    }).toEqual(expect.objectContaining({
      data: [
        expect.objectContaining({
          rule_type: 'lapi-availability',
          title: 'LAPI health: LAPI unavailable',
          severity: 'critical',
          metadata: expect.objectContaining({
            offline_since: offlineSince,
            last_error: 'LAPI offline',
          }),
        }),
      ],
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('marks the dashboard offline after failed refreshes and then creates lapi availability notifications', async () => {
    let failAlerts = false;
    const { controller, database, lapiClient } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: '0',
        CROWDSEC_LOOKBACK_PERIOD: '168h',
      },
      fetchResolver: (url) => {
        if (url.endsWith('/v1/watchers/login')) {
          return Response.json({ code: 200, token: 'token' });
        }
        if (url.includes('/v1/alerts?')) {
          if (failAlerts) {
            throw new Error('fetch failed');
          }
          return Response.json([]);
        }
        return undefined;
      },
    });

    const bootstrapAlerts = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(bootstrapAlerts.status).toBe(200);

    const createRule = await controller.fetch(
      new Request('http://localhost/crowdsec/api/notification-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'LAPI health',
          type: 'lapi-availability',
          enabled: true,
          severity: 'critical',
          channel_ids: [],
          config: {
            outage_threshold_seconds: 1,
            notify_on_recovery: true,
          },
        }),
      }),
    );
    expect(createRule.status).toBe(201);

    failAlerts = true;
    const failedRefresh = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(failedRefresh.status).toBe(200);

    const configAfterFailure = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    expect(configAfterFailure.status).toBe(200);
    expect((await configAfterFailure.json()) as { lapi_status: { isConnected: boolean; offline_since: string | null; lastError: string | null } }).toEqual(
      expect.objectContaining({
        lapi_status: expect.objectContaining({
          isConnected: false,
          offline_since: expect.any(String),
          lastError: 'fetch failed',
        }),
      }),
    );

    const offlineSince = new Date(Date.now() - 2_000).toISOString();
    (lapiClient as unknown as { lapiStatus: { offline_since: string | null } }).lapiStatus.offline_since = offlineSince;

    const secondFailedRefresh = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts'));
    expect(secondFailedRefresh.status).toBe(200);

    const notifications = await controller.fetch(new Request('http://localhost/crowdsec/api/notifications'));
    expect(notifications.status).toBe(200);
    expect((await notifications.json()) as {
      data: Array<{ rule_type: string; title: string; severity: string; metadata: { offline_since?: string; last_error?: string } }>;
    }).toEqual(expect.objectContaining({
      data: [
        expect.objectContaining({
          rule_type: 'lapi-availability',
          title: 'LAPI health: LAPI unavailable',
          severity: 'critical',
          metadata: expect.objectContaining({
            offline_since: offlineSince,
            last_error: 'fetch failed',
          }),
        }),
      ],
    }));

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });
});
