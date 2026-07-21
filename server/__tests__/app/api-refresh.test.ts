import { describe, expect, test, vi } from 'vitest';
import path from 'path';
import type { AlertRecord, DashboardStatsResponse, PaginatedResponse, SlimAlert } from '../../../shared/contracts';
import { CrowdsecDatabase } from '../../database';
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

 });
