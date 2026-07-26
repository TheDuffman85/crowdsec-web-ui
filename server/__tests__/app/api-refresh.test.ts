import { describe, expect, test, vi } from 'vitest';
import path from 'path';
import type { AlertRecord, DashboardStatsResponse, PaginatedResponse, SlimAlert } from '../../../shared/contracts';
import { CrowdsecDatabase } from '../../database';
import { DatabaseQueryWorker } from '../../query-worker-client';
import {
  createController,
  dashboardDateKey,
  destroyTempDir,
  sampleAlert,
  sampleSimulatedAlert,
  seedAlert,
  tempDir,
} from './harness';

describe('createApp refresh API', () => {
  test('reports the next scheduled automatic refresh', async () => {
    const { controller } = createController({
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });
    const beforeUpdate = Date.now();

    const update = await controller.fetch(new Request('http://localhost/crowdsec/api/config/refresh-interval', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval: '5s' }),
    }));
    expect(update.status).toBe(200);
    const updatePayload = await update.json() as { next_refresh_at: string | null };
    expect(Date.parse(updatePayload.next_refresh_at || '')).toBeGreaterThanOrEqual(beforeUpdate + 4_900);

    const config = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    expect(await config.json()).toMatchObject({ next_refresh_at: updatePayload.next_refresh_at });
    controller.stopBackgroundTasks();
  });

  test('disables manual refresh by default and allows it to be enabled in settings', async () => {
    const { controller, database } = createController({
      env: { CROWDSEC_MANUAL_REFRESH_ENABLED: 'false' },
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });

    const initialConfig = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    expect(await initialConfig.json()).toEqual(expect.objectContaining({ manual_refresh_enabled: false }));

    const blockedRefresh = await controller.fetch(new Request('http://localhost/crowdsec/api/cache/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'delta' }),
    }));
    expect(blockedRefresh.status).toBe(403);
    expect(await blockedRefresh.json()).toEqual({
      error: 'Manual refresh is disabled',
      code: 'MANUAL_REFRESH_DISABLED',
    });

    const invalidUpdate = await controller.fetch(new Request('http://localhost/crowdsec/api/config/manual-refresh', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    }));
    expect(invalidUpdate.status).toBe(400);

    const update = await controller.fetch(new Request('http://localhost/crowdsec/api/config/manual-refresh', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }));
    expect(update.status).toBe(200);
    expect(await update.json()).toEqual({ success: true, manual_refresh_enabled: true });
    expect(database.getMeta('manual_refresh_enabled')?.value).toBe('true');

    const updatedConfig = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    expect(await updatedConfig.json()).toEqual(expect.objectContaining({ manual_refresh_enabled: true }));
  });

  test('validates manual refresh modes and exposes full refresh as a historical sync', async () => {
    let releaseFirstAlertRequest: ((response: Response) => void) | null = null;
    let holdFirstAlertRequest = true;
    const { controller, lapiClient } = createController({
      env: { CROWDSEC_REFRESH_INTERVAL: '1s' },
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
      fetchResolver: (url) => {
        if (holdFirstAlertRequest && url.includes('/v1/alerts?')) {
          holdFirstAlertRequest = false;
          return new Promise<Response>((resolve) => {
            releaseFirstAlertRequest = resolve;
          });
        }
        return undefined;
      },
    });
    await lapiClient.login();

    const invalid = await controller.fetch(new Request('http://localhost/crowdsec/api/cache/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'recent' }),
    }));
    expect(invalid.status).toBe(400);

    const fullRefreshPromise = controller.fetch(new Request('http://localhost/crowdsec/api/cache/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'full' }),
    }));

    await vi.waitFor(() => expect(controller.getSyncStatus()).toMatchObject({
      isSyncing: true,
      state: 'syncing',
    }));
    await vi.waitFor(() => expect(releaseFirstAlertRequest).not.toBeNull());

    controller.startBackgroundTasks();
    const scheduledBefore = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    const scheduledBeforeAt = Date.parse((await scheduledBefore.json() as { next_refresh_at: string }).next_refresh_at);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const scheduledAfter = await controller.fetch(new Request('http://localhost/crowdsec/api/config'));
    const scheduledAfterAt = Date.parse((await scheduledAfter.json() as { next_refresh_at: string }).next_refresh_at);
    expect(scheduledAfterAt).toBeGreaterThan(scheduledBeforeAt);

    const manualInterval = await controller.fetch(new Request('http://localhost/crowdsec/api/config/refresh-interval', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval: '0' }),
    }));
    expect(manualInterval.status).toBe(200);

    const readWhileRefreshing = await Promise.race([
      controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10')),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    expect(readWhileRefreshing).not.toBeNull();
    expect(readWhileRefreshing?.status).toBe(200);

    const release = releaseFirstAlertRequest as unknown;
    if (typeof release !== 'function') throw new Error('Alert request was not held');
    release(Response.json([]));

    const fullRefresh = await fullRefreshPromise;
    expect(fullRefresh.status).toBe(200);
    expect(await fullRefresh.json()).toMatchObject({ success: true, mode: 'full' });
    expect(controller.getSyncStatus()).toMatchObject({ isSyncing: false, state: 'complete' });
    controller.stopBackgroundTasks();
  });

  test('runs delta and latest-window manual refresh modes', async () => {
    const { controller, lapiClient, fetchCalls } = createController({
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date(Date.now() - 5_000).toISOString(),
      },
    });
    await lapiClient.login();

    for (const mode of ['delta', 'latest'] as const) {
      const response = await controller.fetch(new Request('http://localhost/crowdsec/api/cache/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, mode });
    }

    expect(fetchCalls.some((call) => call.url.includes('/v1/alerts?'))).toBe(true);
  });

  test('publishes one revision only after dashboard, alert, and decision views agree', async () => {
    const initialAlert = sampleAlert({
      id: 901,
      uuid: 'refresh-consistency-901',
      created_at: new Date(Date.now() - 4_000).toISOString(),
      source: { ip: '192.0.2.10', value: '192.0.2.10', cn: 'DE' },
      decisions: [{
        id: 9010,
        value: '192.0.2.10',
        stop_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        type: 'ban',
        origin: 'manual',
        simulated: false,
      }],
    });
    const refreshedAlert = sampleAlert({
      id: 902,
      uuid: 'refresh-consistency-902',
      created_at: new Date(Date.now() - 1_000).toISOString(),
      source: { ip: '192.0.2.20', value: '192.0.2.20', cn: 'US' },
      decisions: [{
        id: 9020,
        value: '192.0.2.20',
        stop_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        type: 'ban',
        origin: 'manual',
        simulated: false,
      }],
    });
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    seedAlert(database, initialAlert);
    const { controller, lapiClient } = createController({
      database,
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date(Date.now() - 5_000).toISOString(),
      },
      fetchResolver: (url) => url.includes('/v1/alerts?')
        ? Response.json([initialAlert, refreshedAlert])
        : undefined,
    });
    await lapiClient.login();

    try {
      const initialDashboard = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats'));
      expect(((await initialDashboard.json()) as DashboardStatsResponse).totals.alerts).toBe(1);

      const publishedRevisions: string[] = [];
      const unsubscribe = controller.subscribeCacheUpdates((revision) => {
        publishedRevisions.push(revision);
      });
      const refresh = await controller.fetch(new Request('http://localhost/crowdsec/api/cache/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'delta' }),
      }));
      unsubscribe();

      expect(refresh.status).toBe(200);
      const refreshPayload = await refresh.json() as { completed_at: string };
      expect(publishedRevisions).toEqual([refreshPayload.completed_at]);

      const [dashboardResponse, alertsResponse, decisionsResponse] = await Promise.all([
        controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats')),
        controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10&include_decisions=false')),
        controller.fetch(new Request('http://localhost/crowdsec/api/decisions?page=1&page_size=10')),
      ]);
      const dashboard = (await dashboardResponse.json()) as DashboardStatsResponse;
      const alerts = (await alertsResponse.json()) as PaginatedResponse<SlimAlert>;
      const decisions = (await decisionsResponse.json()) as PaginatedResponse<{ id: string | number }>;

      expect(dashboard.pending).toBeUndefined();
      expect(dashboard.totals.alerts).toBe(alerts.pagination.total);
      expect(dashboard.filteredTotals.alerts).toBe(alerts.pagination.total);
      expect(
        dashboard.filteredTotals.decisions + dashboard.filteredTotals.simulatedDecisions,
      ).toBe(decisions.pagination.total);
      expect(alerts.data.map((alert) => alert.id).sort()).toEqual([901, 902]);
      expect(decisions.data.map((decision) => Number(decision.id)).sort()).toEqual([9010, 9020]);
    } finally {
      controller.stopBackgroundTasks();
      database.close();
    }
  });

  test('does not keep rebuilding a large dashboard after dashboard requests stop', async () => {
    const initialAlert = sampleAlert({
      id: 911,
      uuid: 'refresh-demand-911',
      created_at: new Date(Date.now() - 4_000).toISOString(),
      decisions: [{
        id: 9110,
        value: '192.0.2.11',
        stop_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        type: 'ban',
        origin: 'manual',
        simulated: false,
      }],
    });
    const refreshedAlert = sampleAlert({
      id: 912,
      uuid: 'refresh-demand-912',
      created_at: new Date(Date.now() - 1_000).toISOString(),
      decisions: [{
        id: 9120,
        value: '192.0.2.12',
        stop_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        type: 'ban',
        origin: 'manual',
        simulated: false,
      }],
    });
    const database = new CrowdsecDatabase({ dbPath: path.join(tempDir, 'test.db') });
    const queryWorker = new DatabaseQueryWorker({ dbPath: database.dbPath });
    const queryAllSpy = vi.spyOn(queryWorker, 'all');
    seedAlert(database, initialAlert);
    const { controller, lapiClient } = createController({
      database,
      queryWorker,
      env: { CROWDSEC_REFRESH_INTERVAL: '5s' },
      initialCacheState: {
        isInitialized: true,
        isComplete: true,
        lastUpdate: new Date(Date.now() - 5_000).toISOString(),
      },
      fetchResolver: (url) => url.includes('/v1/alerts?')
        ? Response.json([initialAlert, refreshedAlert])
        : undefined,
    });
    await lapiClient.login();
    const nowSpy = vi.spyOn(Date, 'now');

    try {
      const initialDashboard = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats'));
      expect(((await initialDashboard.json()) as DashboardStatsResponse).totals.alerts).toBe(1);
      const decisionIndexQueryCount = () => queryAllSpy.mock.calls.filter(([sql]) => (
        sql.includes('SELECT rowid')
        && sql.includes('FROM decisions')
        && sql.includes('ORDER BY rowid ASC')
      )).length;
      const initialDecisionIndexQueries = decisionIndexQueryCount();

      nowSpy.mockReturnValue(Date.now() + 11_000);
      const refresh = await controller.fetch(new Request('http://localhost/crowdsec/api/cache/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'delta' }),
      }));
      expect(refresh.status).toBe(200);
      expect(decisionIndexQueryCount()).toBe(initialDecisionIndexQueries);

      const currentDashboard = await controller.fetch(new Request('http://localhost/crowdsec/api/dashboard/stats'));
      expect(((await currentDashboard.json()) as DashboardStatsResponse).totals.alerts).toBe(2);
      expect(decisionIndexQueryCount()).toBeGreaterThan(initialDecisionIndexQueries);
    } finally {
      nowSpy.mockRestore();
      controller.stopBackgroundTasks();
      database.close();
    }
  });

});
