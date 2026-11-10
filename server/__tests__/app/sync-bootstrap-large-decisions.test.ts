import { expect, test, vi } from 'vitest';
import path from 'node:path';
import type { DecisionListItem, PaginatedResponse } from '../../../shared/contracts';
import { CrowdsecDatabase } from '../../database';
import {
  createController,
  destroyTempDir,
  sampleBlocklistImportAlert,
  seedAlert,
  tempDir,
} from './harness';

const decisionCount = 272_333;
// These tests run the real sync and query workers, including index creation at
// the scale reported in #581. Leave room for slower CI machines.
const bootstrapTimeout = 180_000;

test('bootstraps a fresh cache with 272k active blocklist decisions', async () => {
  const stopAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const alert = sampleBlocklistImportAlert({
    decisions: Array.from({ length: decisionCount }, (_, index) => {
      // The first two decisions share a value so completion also checks that
      // duplicate ranking ran, rather than merely accepting the large import.
      const valueIndex = index === 1 ? 0 : index;
      return {
        id: index + 1,
        type: 'ban',
        value: `10.${Math.floor(valueIndex / 65_536)}.${Math.floor(valueIndex / 256) % 256}.${valueIndex % 256}`,
        duration: '24h',
        stop_at: stopAt,
        origin: 'lists',
        simulated: false,
      };
    }),
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { controller, database, fetchCalls } = createController({
    env: { CROWDSEC_REFRESH_INTERVAL: '1h' },
    fetchResolver: (url) => url.includes('/v1/alerts?') ? Response.json([alert]) : undefined,
  });

  try {
    expect(database.countDecisions()).toBe(0);
    const response = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/decisions?page=1&page_size=10',
    ));

    expect(controller.getSyncStatus()).toMatchObject({ state: 'complete', isSyncing: false, errors: [] });
    expect(response.status).toBe(200);
    const page = await response.json() as PaginatedResponse<DecisionListItem>;
    expect(page.data).toHaveLength(10);
    expect(page.pagination.total).toBe(decisionCount - 1);
    expect(database.countDecisions()).toBe(decisionCount);
    expect(database.db.prepare("SELECT id, is_duplicate FROM decisions WHERE id IN ('1', '2') ORDER BY id").all()).toEqual([
      { id: '1', is_duplicate: 1 },
      { id: '2', is_duplicate: 0 },
    ]);
    expect(database.db.prepare('SELECT COUNT(*) AS count FROM decisions_fts').get()).toEqual({ count: decisionCount });
    expect(database.getMeta('decision_duplicate_flags_dirty')?.value).toBe('false');
    expect(controller.getCacheLastUpdate()).not.toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();

    // A subsequent UI read must use the completed cache instead of starting
    // another historical sync, as happened in the bootstrap retry loop.
    const historyRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?')).length;
    expect(historyRequests).toBeGreaterThan(0);
    const nextPage = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/decisions?page=2&page_size=10',
    ));
    expect(nextPage.status).toBe(200);
    expect(fetchCalls.filter((call) => call.url.includes('/v1/alerts?'))).toHaveLength(historyRequests);
  } finally {
    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
    errorSpy.mockRestore();
  }
}, bootstrapTimeout);

test('bootstraps a reopened 272k-decision cache after 200k blocklist decisions expire', async () => {
  const now = Date.now();
  const previousRefreshAt = new Date(now - 60_000).toISOString();
  const expiredAt = new Date(now - 30_000).toISOString();
  const createdAt = new Date(now - 120_000).toISOString();
  const stopAt = new Date(now + 24 * 60 * 60_000).toISOString();
  const expiringCount = 200_000;
  const dbPath = path.join(tempDir, 'test.db');
  const seeded = new CrowdsecDatabase({ cachePath: dbPath });
  try {
    // The alert predates the requested history window, as long-lived blocklist
    // buckets often do. Its decisions must survive historical reconciliation.
    seedAlert(seeded, sampleBlocklistImportAlert({ created_at: createdAt, decisions: [] }));
    seeded.beginDeferredSearchIndexUpdates();
    seeded.db.prepare(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO decisions (id, uuid, alert_id, created_at, stop_at, value, type, origin, scenario, search_text)
      SELECT CAST(i AS TEXT), CAST(i AS TEXT), 4, ?, CASE WHEN i <= ? THEN ? ELSE ? END,
        '10.' || (i / 65536) || '.' || ((i / 256) % 256) || '.' || (i % 256),
        'ban', 'lists', 'crowdsec-blocklist-import/external_blocklist', 'blocklist'
      FROM n
    `).run(decisionCount, createdAt, expiringCount, expiredAt, stopAt);
    // One expiring row is a duplicate of a surviving active decision. Its flag
    // must be cleared by the incremental refresh after the cache is reopened.
    seeded.db.prepare('UPDATE decisions SET value = (SELECT value FROM decisions WHERE id = ?) WHERE id = ?')
      .run(String(decisionCount), '1');
    expect(seeded.refreshDecisionDuplicateFlags(previousRefreshAt)).toBe(1);
    expect(seeded.db.prepare("SELECT is_duplicate FROM decisions WHERE id = '1'").get()).toEqual({ is_duplicate: 1 });
  } finally {
    seeded.close();
  }

  const database = new CrowdsecDatabase({ cachePath: dbPath });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const logSpy = vi.spyOn(console, 'log');
  const { controller, fetchCalls } = createController({
    database,
    env: { CROWDSEC_REFRESH_INTERVAL: '1h' },
  });

  try {
    expect(database.getMeta('decision_duplicate_refresh_at')?.value).toBe(previousRefreshAt);
    expect(database.getMeta('decision_duplicate_flags_dirty')?.value).toBe('false');
    const response = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/decisions?page=1&page_size=10',
    ));

    expect(controller.getSyncStatus()).toMatchObject({ state: 'complete', isSyncing: false, errors: [] });
    expect(response.status).toBe(200);
    const page = await response.json() as PaginatedResponse<DecisionListItem>;
    expect(page.data).toHaveLength(10);
    expect(page.pagination.total).toBe(decisionCount - expiringCount);
    expect(database.countDecisions()).toBe(decisionCount);
    expect(database.db.prepare('SELECT id, is_duplicate FROM decisions WHERE id IN (?, ?) ORDER BY id')
      .all('1', String(decisionCount))).toEqual([
      { id: '1', is_duplicate: 0 },
      { id: String(decisionCount), is_duplicate: 0 },
    ]);
    expect(database.db.prepare('SELECT COUNT(*) AS count FROM decisions_fts').get()).toEqual({ count: decisionCount });
    expect(database.getMeta('decision_duplicate_flags_dirty')?.value).toBe('false');
    expect(Date.parse(database.getMeta('decision_duplicate_refresh_at')!.value)).toBeGreaterThan(Date.parse(expiredAt));
    expect(controller.getCacheLastUpdate()).not.toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();

    // Match the reported failure sequence: search indexes are rebuilt before
    // the duplicate refresh on a populated startup cache.
    const logs = logSpy.mock.calls.map(([message]) => String(message));
    const indexBuilt = logs.findIndex((message) => message.startsWith('Secondary and search indexes built in'));
    const duplicatesRefreshed = logs.findIndex((message) => message.startsWith('Decision duplicate index refreshed in'));
    expect(indexBuilt).toBeGreaterThanOrEqual(0);
    expect(duplicatesRefreshed).toBeGreaterThan(indexBuilt);

    const historyRequests = fetchCalls.filter((call) => call.url.includes('/v1/alerts?')).length;
    expect(historyRequests).toBeGreaterThan(0);
    const nextPage = await controller.fetch(new Request(
      'http://localhost/crowdsec/api/decisions?page=2&page_size=10',
    ));
    expect(nextPage.status).toBe(200);
    expect(fetchCalls.filter((call) => call.url.includes('/v1/alerts?'))).toHaveLength(historyRequests);
  } finally {
    controller.stopBackgroundTasks();
    database.close();
    destroyTempDir();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  }
}, bootstrapTimeout);
