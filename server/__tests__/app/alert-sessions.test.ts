import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AlertRecord, AlertSessionsResponse, PaginatedResponse, SlimAlert } from '../../../shared/contracts';
import {
  ALERT_SESSION_GAP_MS,
  ALERT_SESSION_SCAN_BATCH_SIZE,
  AlertSessionWalker,
  type AlertSessionScanRow,
} from '../../app/alert-sessions';
import { CrowdsecDatabase } from '../../database';
import { DatabaseQueryWorker, QueryWorkerTimeoutError } from '../../query-worker-client';
import {
  createController,
  destroyTempDir,
  sampleAlert,
  sampleCapiAlert,
  seedAlert,
  tempDir,
} from './harness';

const BASE_TIME = Date.parse('2026-11-01T12:00:00.000Z');
const minutesBefore = (minutes: number) => new Date(BASE_TIME - minutes * 60_000).toISOString();

function scanRow(id: number, minutes: number, overrides: Partial<AlertSessionScanRow> = {}): AlertSessionScanRow {
  return {
    id,
    instance_id: 'default',
    created_at: minutesBefore(minutes),
    source_ip: '1.1.1.1',
    source_scope: 'Ip',
    simulated: 0,
    kind: 'waf',
    scenario: 'crowdsecurity/vpatch-env-access',
    target: 'example.com',
    ...overrides,
  };
}

function walk(rows: AlertSessionScanRow[]) {
  const walker = new AlertSessionWalker();
  rows.forEach((row) => walker.add(row));
  walker.finish();
  return walker.toScans();
}

describe('AlertSessionWalker', () => {
  test('keeps alerts exactly one gap apart in a session and splits beyond it', () => {
    const gapMinutes = ALERT_SESSION_GAP_MS / 60_000;
    const sessions = walk([
      scanRow(4, 0),
      scanRow(3, gapMinutes),
      scanRow(2, gapMinutes * 2 + 1),
    ]);

    expect(sessions.map((session) => [session.latestAlertId, session.alertCount])).toEqual([[4, 2], [2, 1]]);
    expect(sessions[0]).toMatchObject({ firstSeen: minutesBefore(gapMinutes), lastSeen: minutesBefore(0) });
  });

  test('measures the gap between alerts rather than from the start of the session', () => {
    const sessions = walk([scanRow(3, 0), scanRow(2, 25), scanRow(1, 50)]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].alertCount).toBe(3);
  });

  test('groups scenarios by kind but separates IPs, instances and simulation state', () => {
    const sessions = walk([
      scanRow(6, 0, { kind: 'crowdsec', scenario: 'crowdsecurity/http-probing' }),
      scanRow(5, 1),
      scanRow(4, 2),
      scanRow(3, 3, { source_ip: '2.2.2.2' }),
      scanRow(2, 4, { instance_id: 'edge' }),
      scanRow(1, 5, { simulated: 1 }),
    ]);

    expect(sessions).toHaveLength(4);
    expect(sessions[0].alertCount).toBe(3);
    expect(sessions[0].scenarioCount).toBe(2);
    expect(sessions[0].scenarioGroups).toEqual([
      {
        kind: 'waf',
        scenario_count: 1,
        alert_count: 2,
        scenarios: [{ scenario: 'crowdsecurity/vpatch-env-access', count: 2 }],
      },
      {
        kind: 'crowdsec',
        scenario_count: 1,
        alert_count: 1,
        scenarios: [{ scenario: 'crowdsecurity/http-probing', count: 1 }],
      },
    ]);
  });

  test('never merges alerts without an IP or range source', () => {
    const sessions = walk([
      scanRow(4, 0, { source_ip: null, source_scope: null }),
      scanRow(3, 1, { source_ip: null, source_scope: null }),
      scanRow(2, 2, { source_ip: 'community-blocklist', source_scope: 'crowdsecurity/community-blocklist' }),
      scanRow(1, 3, { source_ip: 'community-blocklist', source_scope: 'crowdsecurity/community-blocklist' }),
    ]);

    expect(sessions.map((session) => session.alertCount)).toEqual([1, 1, 1, 1]);
    expect(new Set(sessions.map((session) => session.key)).size).toBe(4);
  });

  test('accepts range sources and alerts without a recorded scope', () => {
    const sessions = walk([
      scanRow(4, 0, { source_ip: '10.0.0.0/24', source_scope: 'Range' }),
      scanRow(3, 1, { source_ip: '10.0.0.0/24', source_scope: 'Range' }),
      scanRow(2, 2, { source_scope: null }),
      scanRow(1, 3, { source_scope: null }),
    ]);

    expect(sessions.map((session) => session.alertCount)).toEqual([2, 2]);
  });

  test('holds back older sessions while a newer session can still grow', () => {
    const walker = new AlertSessionWalker();
    walker.add(scanRow(3, 0));
    walker.add(scanRow(2, 1, { source_ip: '2.2.2.2' }));
    walker.add(scanRow(1, 40, { source_ip: '3.3.3.3' }));

    // 1.1.1.1 and 2.2.2.2 are out of reach at 40 minutes, 3.3.3.3 is still open.
    walker.advanceTo(minutesBefore(40));
    expect(walker.toScans().map((session) => session.latestAlertId)).toEqual([3, 2]);

    walker.advanceTo(minutesBefore(25));
    expect(walker.toScans()).toHaveLength(2);
  });

  test('does not return a completed older session ahead of an open newer one', () => {
    const walker = new AlertSessionWalker();
    walker.add(scanRow(4, 0));
    walker.add(scanRow(3, 1, { source_ip: '2.2.2.2' }));
    walker.add(scanRow(2, 29));

    // 2.2.2.2 cannot grow any more at 32 minutes, but 1.1.1.1 is newer and can.
    walker.advanceTo(minutesBefore(32));
    expect(walker.completeCount).toBe(0);

    walker.add(scanRow(1, 58));
    walker.advanceTo(minutesBefore(95));
    expect(walker.toScans().map((session) => [session.latestAlertId, session.alertCount])).toEqual([[4, 3], [3, 1]]);
  });

  test('caps retained alert IDs while still counting every alert', () => {
    const rows = Array.from({ length: 2_100 }, (_, index) => ({
      ...scanRow(5_000 - index, 0),
      created_at: new Date(BASE_TIME - index * 1_000).toISOString(),
    }));
    const [session] = walk(rows);

    expect(session.alertCount).toBe(2_100);
    expect(session.alertIds).toHaveLength(2_000);
    expect(session.latestAlertId).toBe(5_000);
  });

  test('limits scenario and target lists while reporting distinct totals', () => {
    const rows = Array.from({ length: 6 }, (_, index) => scanRow(10 - index, index, {
      scenario: `crowdsecurity/scenario-${index}`,
      target: `target-${index}`,
    }));
    const [session] = walk(rows);

    expect(session.scenarioCount).toBe(6);
    expect(session.scenarioGroups[0].scenario_count).toBe(6);
    expect(session.scenarioGroups[0].scenarios).toHaveLength(3);
    expect(session.targetCount).toBe(6);
    expect(session.targets).toHaveLength(3);
  });
});

describe('alert sessions API', () => {
  const now = Date.now();
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

  function sessionAlert(id: number, minutes: number, overrides: Partial<AlertRecord> = {}): AlertRecord {
    return sampleAlert({
      id,
      uuid: `session-alert-${id}`,
      created_at: ago(minutes),
      scenario: 'crowdsecurity/http-probing',
      kind: 'crowdsec',
      source: { ip: '1.1.1.1', value: '1.1.1.1', scope: 'Ip', cn: 'DE', as_name: 'Hetzner' },
      decisions: [],
      ...overrides,
    });
  }

  async function fetchSessions(controller: ReturnType<typeof createController>['controller'], query = '') {
    const response = await controller.fetch(new Request(`http://localhost/crowdsec/api/alerts/sessions${query}`));
    expect(response.status).toBe(200);
    return response.json() as Promise<AlertSessionsResponse>;
  }

  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    destroyTempDir();
  });

  function seededController(alerts: AlertRecord[]) {
    const database = new CrowdsecDatabase({ cachePath: path.join(tempDir, 'sessions.db') });
    alerts.forEach((alert) => seedAlert(database, alert));
    const queryWorker = new DatabaseQueryWorker({ dbPath: database.cachePath });
    const facetQueryWorker = new DatabaseQueryWorker({ dbPath: database.cachePath });
    const created = createController({
      database,
      queryWorker,
      facetQueryWorker,
      env: { CROWDSEC_LOOKBACK_PERIOD: '7d' },
      initialCacheState: { isInitialized: true, isComplete: true, lastUpdate: new Date().toISOString() },
    });
    cleanups.push(
      () => created.controller.stopBackgroundTasks(),
      () => queryWorker.close(),
      () => facetQueryWorker.close(),
      () => database.close(),
    );
    return { ...created, queryWorker, facetQueryWorker };
  }

  test('returns one row per IP session, newest first, with totals from the alert list', async () => {
    const { controller } = seededController([
      sessionAlert(1, 100),
      sessionAlert(2, 99, { scenario: 'crowdsecurity/vpatch-env-access', kind: 'waf' }),
      sessionAlert(3, 10),
      sessionAlert(4, 5, { source: { ip: '2.2.2.2', value: '2.2.2.2', scope: 'Ip' } }),
    ]);

    const body = await fetchSessions(controller, '?page=1&page_size=50');

    expect(body.data.map((session) => [session.latest.source?.ip, session.alert_count])).toEqual([
      ['2.2.2.2', 1],
      ['1.1.1.1', 1],
      ['1.1.1.1', 2],
    ]);
    expect(body.data[2]).toMatchObject({ first_seen: ago(100), last_seen: ago(99), scenario_count: 2 });
    expect(body.data[2].latest.id).toBe(2);
    expect(body.pagination).toEqual({
      page: 1,
      page_size: 50,
      has_more: false,
      total_alerts: 4,
      unfiltered_total_alerts: 4,
    });
  });

  test('uses the first page when no page is requested', async () => {
    const { controller } = seededController([sessionAlert(1, 1)]);

    const body = await fetchSessions(controller);

    expect(body.pagination).toMatchObject({ page: 1, page_size: 50 });
    expect(body.data).toHaveLength(1);
  });

  test('applies filters before grouping', async () => {
    const { controller } = seededController([
      sessionAlert(1, 3, { scenario: 'crowdsecurity/ssh-bf', kind: 'crowdsec' }),
      sessionAlert(2, 2, { scenario: 'crowdsecurity/vpatch-env-access', kind: 'waf' }),
      sessionAlert(3, 1, { scenario: 'crowdsecurity/ssh-bf', kind: 'crowdsec' }),
    ]);

    const body = await fetchSessions(controller, `?q=${encodeURIComponent('scenario=crowdsecurity/ssh-bf')}`);

    expect(body.data).toHaveLength(1);
    expect(body.data[0].alert_count).toBe(2);
    expect(body.data[0].scenario_count).toBe(1);
    expect(body.pagination).toMatchObject({ total_alerts: 2, unfiltered_total_alerts: 3 });
  });

  test('adds up decisions across every alert in a session', async () => {
    const future = new Date(now + 60 * 60_000).toISOString();
    const past = new Date(now - 60_000).toISOString();
    const { controller } = seededController([
      sessionAlert(1, 3, { decisions: [{ id: 101, type: 'ban', value: '1.1.1.1', duration: '1h', stop_at: future, origin: 'crowdsec', simulated: false }] }),
      sessionAlert(2, 2, { decisions: [{ id: 102, type: 'ban', value: '1.1.1.1', duration: '1h', stop_at: past, origin: 'cscli', simulated: false }] }),
      sessionAlert(3, 1),
    ]);

    const body = await fetchSessions(controller);

    expect(body.data).toHaveLength(1);
    expect(body.data[0].decision_summary_partial).toBe(false);
    expect(body.data[0].decision_alert_ids).toEqual(['2', '1']);
    expect(body.data[0].latest.decision_summary).toMatchObject({
      active_count: 1,
      expired_count: 1,
      origins: ['crowdsec', 'cscli'],
    });

    const decisions = await controller.fetch(new Request(
      `http://localhost/crowdsec/api/decisions?page=1&page_size=50&include_expired=true&alert_id=${body.data[0].decision_alert_ids.join(',')}`,
    ));
    expect(((await decisions.json()) as PaginatedResponse<{ id: number }>).data.map((decision) => decision.id).sort()).toEqual([101, 102]);
  });

  test('does not merge imported blocklist alerts that share a source value', async () => {
    const { controller } = seededController([
      sampleCapiAlert({ id: 1, uuid: 'capi-1', created_at: ago(2), decisions: [] }),
      sampleCapiAlert({ id: 2, uuid: 'capi-2', created_at: ago(1), decisions: [] }),
    ]);

    const body = await fetchSessions(controller);

    expect(body.data.map((session) => session.alert_count)).toEqual([1, 1]);
  });

  test('pages through sessions without an exact session total', async () => {
    const alerts = Array.from({ length: 25 }, (_, index) => sessionAlert(index + 1, index + 1, {
      source: { ip: `10.0.0.${index + 1}`, value: `10.0.0.${index + 1}`, scope: 'Ip' },
    }));
    const { controller } = seededController(alerts);

    const first = await fetchSessions(controller, '?page=1&page_size=10');
    const last = await fetchSessions(controller, '?page=3&page_size=10');

    expect(first.data).toHaveLength(10);
    expect(first.pagination.has_more).toBe(true);
    expect(last.data).toHaveLength(5);
    expect(last.pagination.has_more).toBe(false);
    expect(first.data[0].latest.source?.ip).toBe('10.0.0.1');
    expect(last.data[4].latest.source?.ip).toBe('10.0.0.25');
  });

  test('reuses the cached window for later pages', async () => {
    const { controller, facetQueryWorker } = seededController(Array.from({ length: 25 }, (_, index) => sessionAlert(index + 1, index + 1, {
      source: { ip: `10.0.1.${index + 1}`, value: `10.0.1.${index + 1}`, scope: 'Ip' },
    })));
    const allSpy = vi.spyOn(facetQueryWorker, 'all');
    const scanCount = () => allSpy.mock.calls.filter(([sql]) => sql.includes('source_scope, simulated, kind')).length;

    await fetchSessions(controller, '?page=1&page_size=10');
    expect(scanCount()).toBe(1);

    await fetchSessions(controller, '?page=2&page_size=10');
    await fetchSessions(controller, '?page=3&page_size=10');
    expect(scanCount()).toBe(1);
  });

  test('stops reading once a page of sessions is complete', async () => {
    const { controller, facetQueryWorker } = seededController([sessionAlert(1, 1)]);
    const allSpy = vi.spyOn(facetQueryWorker, 'all');
    const batch = Array.from({ length: ALERT_SESSION_SCAN_BATCH_SIZE }, (_, index) => ({
      id: ALERT_SESSION_SCAN_BATCH_SIZE - index,
      instance_id: 'default',
      created_at: new Date(now - index * 60_000).toISOString(),
      source_ip: `10.1.${Math.floor(index / 250)}.${index % 250}`,
      source_scope: 'Ip',
      simulated: 0,
      kind: 'crowdsec',
      scenario: 'crowdsecurity/ssh-bf',
      target: 'ssh',
    }));
    allSpy.mockResolvedValue(batch as never);

    const body = await fetchSessions(controller, '?page=1&page_size=10');

    expect(allSpy).toHaveBeenCalledTimes(1);
    expect(body.pagination.has_more).toBe(true);
  });

  test('leaves the raw alert list unchanged', async () => {
    const { controller } = seededController([sessionAlert(1, 2), sessionAlert(2, 1)]);

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts?page=1&page_size=10'));
    const body = await response.json() as PaginatedResponse<SlimAlert>;

    expect(body.data.map((alert) => alert.id)).toEqual([2, 1]);
    expect(body.pagination.total).toBe(2);
  });

  test('reports invalid searches', async () => {
    const { controller } = seededController([]);

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/sessions?q=%28'));

    expect(response.status).toBe(400);
  });

  test('maps query worker timeouts to 504', async () => {
    const { controller, facetQueryWorker } = seededController([sessionAlert(1, 1)]);
    vi.spyOn(facetQueryWorker, 'all').mockRejectedValue(new QueryWorkerTimeoutError(1));

    const response = await controller.fetch(new Request('http://localhost/crowdsec/api/alerts/sessions'));

    expect(response.status).toBe(504);
  });
});
