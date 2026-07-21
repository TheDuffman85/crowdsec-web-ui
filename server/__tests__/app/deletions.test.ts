import { describe, expect, test, vi } from 'vitest';
import {
  createController,
  destroyTempDir,
  sampleAlert,
  sampleManualWebUiAlert,
  sampleSimulatedAlert,
  seedAlert,
} from './harness';

describe('createApp deletion workflows', () => {
  test('single alert delete immediately hides the alert while backend deletion completes', async () => {
    const { controller, database, lapiClient, fetchCalls } = createController();
    seedAlert(database, sampleAlert());
    await lapiClient.login();

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/1', {
      method: 'DELETE',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      requested_alerts: 1,
      requested_decisions: 1,
      deleted_alerts: 1,
      deleted_decisions: 1,
      failed: [],
    }));
    await vi.waitFor(() => {
      expect(fetchCalls.some((call) => call.url.endsWith('/v1/alerts/1') && call.method === 'DELETE')).toBe(true);
    });
    const decisionDeleteIndex = fetchCalls.findIndex((call) => call.url.endsWith('/v1/decisions/10') && call.method === 'DELETE');
    const alertDeleteIndex = fetchCalls.findIndex((call) => call.url.endsWith('/v1/alerts/1') && call.method === 'DELETE');
    expect(decisionDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(alertDeleteIndex).toBeGreaterThan(decisionDeleteIndex);
    expect(database.countAlerts()).toBe(0);
    expect(database.getDecisionById('10')).toBeNull();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('returns the delete response without waiting for backend LAPI deletion', async () => {
    let releaseDecisionDelete: ((response: Response) => void) | undefined;
    const decisionDeleteBlocked = new Promise<Response>((resolve) => {
      releaseDecisionDelete = resolve;
    });
    const { controller, database, lapiClient, fetchCalls } = createController({
      fetchResolver: (url, init) => {
        if (url.endsWith('/v1/decisions/10') && init?.method === 'DELETE') {
          return decisionDeleteBlocked;
        }
        return undefined;
      },
    });
    seedAlert(database, sampleAlert());
    await lapiClient.login();

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/1', {
      method: 'DELETE',
    }));

    expect(response.status).toBe(200);
    expect(database.countAlerts()).toBe(0);
    expect(database.getAlertDeletionTombstone('1')?.completed_at).toBeNull();
    expect(fetchCalls.some((call) => call.url.endsWith('/v1/alerts/1') && call.method === 'DELETE')).toBe(false);

    releaseDecisionDelete?.(Response.json({ message: 'Deleted' }));
    await vi.waitFor(() => {
      expect(database.getAlertDeletionTombstone('1')?.completed_at).not.toBeNull();
    });

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('logs queued and executed alert and decision deletion lifecycle', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { controller, database, lapiClient } = createController();
    try {
      seedAlert(database, sampleAlert());
      await lapiClient.login();

      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/1', {
        method: 'DELETE',
      }));
      expect(response.status).toBe(200);
      await vi.waitFor(() => {
        expect(database.getAlertDeletionTombstone('1')?.completed_at).not.toBeNull();
      });
      await vi.waitFor(() => {
        expect(logSpy.mock.calls.some((call) => String(call[0]).includes('[deletion-queue] Queue is empty'))).toBe(true);
      });

      const messages = logSpy.mock.calls.map((call) => String(call[0]));
      expect(messages.some((message) => message.includes('[deletion-queue] Queued 1 alert deletion(s) and 1 decision deletion(s)'))).toBe(true);
      expect(messages.some((message) => message.includes('[deletion-queue] Deleted alert 1 and 1 linked decision(s)'))).toBe(true);
      expect(messages.some((message) => message.includes('[deletion-queue] Queue is empty'))).toBe(true);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      logSpy.mockRestore();
      destroyTempDir();
    }
  });

  test('logs when a decision is added', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { controller, database, lapiClient } = createController({
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date().toISOString(),
      },
    });
    try {
      await lapiClient.login();
      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: '5.6.7.8', duration: '4h', type: 'ban', reason: 'manual' }),
      }));

      expect(response.status).toBe(200);
      expect(logSpy.mock.calls.some((call) =>
        String(call[0]).includes('[decisions] Added ban decision for 5.6.7.8 (4h).'),
      )).toBe(true);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
      logSpy.mockRestore();
      destroyTempDir();
    }
  });

  test('waits for the configured bouncer propagation delay before deleting an owning alert', async () => {
    let decisionDeletedAt = 0;
    let alertDeletedAt = 0;
    const { controller, database, lapiClient } = createController({
      env: { CROWDSEC_BOUNCER_PROPAGATION_DELAY: '30ms' },
      fetchResolver: (url, init) => {
        if (url.endsWith('/v1/decisions/10') && init?.method === 'DELETE') {
          decisionDeletedAt = performance.now();
        }
        if (url.endsWith('/v1/alerts/1') && init?.method === 'DELETE') {
          alertDeletedAt = performance.now();
        }
        return undefined;
      },
    });
    seedAlert(database, sampleAlert());
    await lapiClient.login();

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/1', {
      method: 'DELETE',
    }));

    expect(response.status).toBe(200);
    expect(decisionDeletedAt).toBeGreaterThan(0);
    expect(alertDeletedAt).toBe(0);
    await vi.waitFor(() => expect(alertDeletedAt).toBeGreaterThan(0));
    expect(alertDeletedAt - decisionDeletedAt).toBeGreaterThanOrEqual(20);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('processes durable alert deletions before historical sync and blocks stale sync restoration', async () => {
    const { controller, database, fetchCalls } = createController({
      env: {
        CROWDSEC_REFRESH_INTERVAL: 'manual',
        CROWDSEC_HEARTBEAT_INTERVAL: 'manual',
      },
      fetchResolver: (url, init) => {
        if (url.includes('/v1/alerts?') && (!init?.method || init.method === 'GET')) {
          return Response.json([sampleAlert()]);
        }
        return undefined;
      },
    });
    seedAlert(database, sampleAlert());
    const queue = database.transaction(() => {
      database.queueAlertDeletion('1', ['10'], new Date(Date.now() - 60_000).toISOString());
      database.deleteDecisionsByAlertId('1');
      database.deleteAlert('1');
    });
    queue(undefined);

    controller.startBackgroundTasks();
    await vi.waitFor(() => expect(controller.getSyncStatus().state).toBe('complete'));

    const alertDeleteIndex = fetchCalls.findIndex((call) => call.url.endsWith('/v1/alerts/1') && call.method === 'DELETE');
    const firstHistoricalSyncIndex = fetchCalls.findIndex((call) => call.url.includes('/v1/alerts?') && call.method === 'GET');
    expect(alertDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(firstHistoricalSyncIndex).toBeGreaterThan(alertDeleteIndex);
    expect(database.getAlertDeletionTombstone('1')?.completed_at).not.toBeNull();
    expect(database.countAlerts()).toBe(0);
    expect(database.countDecisions()).toBe(0);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('bulk alert delete immediately hides alerts before backend deletion completes', async () => {
    const { controller, database, lapiClient, fetchCalls } = createController();
    seedAlert(database, sampleAlert());
    seedAlert(database, sampleManualWebUiAlert());
    await lapiClient.login();

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1, 3] }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      requested_alerts: 2,
      requested_decisions: 2,
      deleted_alerts: 2,
      deleted_decisions: 2,
      failed: [],
    }));
    await vi.waitFor(() => {
      expect(fetchCalls.filter((call) => /\/v1\/alerts\/(1|3)$/.test(call.url) && call.method === 'DELETE')).toHaveLength(2);
    });
    const decisionDeleteIndexes = fetchCalls.flatMap((call, index) => /\/v1\/decisions\/(10|30)$/.test(call.url) && call.method === 'DELETE' ? [index] : []);
    const alertDeleteIndexes = fetchCalls.flatMap((call, index) => /\/v1\/alerts\/(1|3)$/.test(call.url) && call.method === 'DELETE' ? [index] : []);
    expect(decisionDeleteIndexes).toHaveLength(2);
    expect(alertDeleteIndexes).toHaveLength(2);
    expect(alertDeleteIndexes[0]).toBeGreaterThan(decisionDeleteIndexes[0]);
    expect(alertDeleteIndexes[1]).toBeGreaterThan(decisionDeleteIndexes[1]);
    expect(database.countAlerts()).toBe(0);
    expect(database.getActiveDecisions(new Date().toISOString())).toHaveLength(0);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('alert delete still purges alerts which have no linked decisions', async () => {
    const { controller, database, lapiClient, fetchCalls } = createController();
    seedAlert(database, sampleAlert({ id: 6, uuid: 'alert-6', decisions: [] }));
    await lapiClient.login();

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/6', {
      method: 'DELETE',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      requested_alerts: 1,
      requested_decisions: 0,
      deleted_alerts: 1,
      deleted_decisions: 0,
      failed: [],
    }));
    await vi.waitFor(() => {
      expect(fetchCalls.some((call) => call.url.endsWith('/v1/alerts/6') && call.method === 'DELETE')).toBe(true);
    });
    expect(fetchCalls.some((call) => call.url.endsWith('/v1/alerts/6') && call.method === 'DELETE')).toBe(true);
    expect(database.countAlerts()).toBe(0);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('bulk decision delete removes only the selected decisions', async () => {
    const { controller, database, lapiClient } = createController();
    seedAlert(database, sampleAlert());
    seedAlert(database, sampleSimulatedAlert());
    await lapiClient.login();

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/decisions/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [10] }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      requested_decisions: 1,
      deleted_alerts: 0,
      deleted_decisions: 1,
      failed: [],
    }));
    expect(database.getDecisionById('10')).toBeNull();
    expect(database.getDecisionById('20')).not.toBeNull();
    expect(database.countAlerts()).toBe(2);

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('cleanup by IP expires decisions before deleting their alerts', async () => {
    const { controller, database, lapiClient, fetchCalls } = createController();
    seedAlert(database, sampleAlert());
    seedAlert(database, sampleSimulatedAlert());
    database.insertDecision({
      $id: '90',
      $uuid: '90',
      $alert_id: 999,
      $created_at: '2026-03-23T12:00:00.000Z',
      $stop_at: '2030-01-01T00:00:00.000Z',
      $value: '1.2.3.4',
      $type: 'ban',
      $origin: 'manual',
      $scenario: 'manual/web-ui',
      $raw_data: JSON.stringify({
        id: 90,
        created_at: '2026-03-23T12:00:00.000Z',
        scenario: 'manual/web-ui',
        value: '1.2.3.4',
        stop_at: '2030-01-01T00:00:00.000Z',
        type: 'ban',
        origin: 'manual',
        country: 'DE',
        as: 'Hetzner',
        target: 'ssh',
        alert_id: 999,
        simulated: false,
      }),
    });
    await lapiClient.login();

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/cleanup/by-ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: '1.2.3.4' }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      ip: '1.2.3.4',
      requested_alerts: 1,
      requested_decisions: 2,
      deleted_alerts: 1,
      deleted_decisions: 2,
      failed: [],
    }));
    await vi.waitFor(() => {
      expect(fetchCalls.some((call) => call.url.endsWith('/v1/alerts/1') && call.method === 'DELETE')).toBe(true);
    });
    const decisionDeleteIndexes = fetchCalls.flatMap((call, index) => /\/v1\/decisions\/(10|90)$/.test(call.url) && call.method === 'DELETE' ? [index] : []);
    const alertDeleteIndex = fetchCalls.findIndex((call) => call.url.endsWith('/v1/alerts/1') && call.method === 'DELETE');
    expect(decisionDeleteIndexes).toHaveLength(2);
    const linkedDecisionDeleteIndex = fetchCalls.findIndex((call) => call.url.endsWith('/v1/decisions/10') && call.method === 'DELETE');
    expect(alertDeleteIndex).toBeGreaterThan(linkedDecisionDeleteIndex);
    expect(database.countAlerts()).toBe(1);
    expect(database.getDecisionById('10')).toBeNull();
    expect(database.getDecisionById('90')).toBeNull();
    expect(database.getDecisionById('20')).not.toBeNull();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('bulk alert delete keeps failed backend work queued while alerts stay hidden', async () => {
    const { controller, database, lapiClient, fetchCalls } = createController({
      fetchResolver: (url, init) => {
        if (url.endsWith('/v1/decisions/20') && init?.method === 'DELETE') {
          return Response.json({ error: 'boom' }, { status: 500 });
        }
        return undefined;
      },
    });
    seedAlert(database, sampleAlert());
    seedAlert(database, sampleSimulatedAlert());
    await lapiClient.login();

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1, 2] }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      requested_alerts: 2,
      requested_decisions: 2,
      deleted_alerts: 2,
      deleted_decisions: 2,
      failed: [],
    }));
    await vi.waitFor(() => {
      expect(database.getAlertDeletionTombstone('2')?.last_error).toContain('HTTP 500');
    });
    expect(fetchCalls.some((call) => call.url.endsWith('/v1/alerts/1') && call.method === 'DELETE')).toBe(true);
    expect(fetchCalls.some((call) => call.url.endsWith('/v1/alerts/2') && call.method === 'DELETE')).toBe(false);
    expect(database.countAlerts()).toBe(0);
    expect(database.getDecisionById('10')).toBeNull();
    expect(database.getDecisionById('20')).toBeNull();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });

  test('bulk alert delete retries failed delayed alert deletion while it stays hidden', async () => {
    const { controller, database, lapiClient } = createController({
      fetchResolver: (url, init) => {
        if (url.endsWith('/v1/alerts/2') && init?.method === 'DELETE') {
          return Response.json({ error: 'boom' }, { status: 500 });
        }
        return undefined;
      },
    });
    seedAlert(database, sampleAlert());
    seedAlert(database, sampleSimulatedAlert());
    await lapiClient.login();

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1, 2] }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      requested_alerts: 2,
      requested_decisions: 2,
      deleted_alerts: 2,
      deleted_decisions: 2,
      failed: [],
    }));
    await vi.waitFor(() => {
      expect(database.getAlertDeletionTombstone('2')?.last_error).toContain('HTTP 500');
    });
    expect(database.countAlerts()).toBe(0);
    expect(database.getDecisionById('10')).toBeNull();
    expect(database.getDecisionById('20')).toBeNull();

    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
  });
});
