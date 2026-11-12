import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CrowdsecDatabase } from '../../database';
import { StatisticsService } from '../../statistics-service';
import { acknowledgeStatisticsBatch, configureStatisticsCapture, readStatisticsBatch, statisticsPendingFrom } from '../../statistics-capture';
import type { RuntimeConfig } from '../../config';
import { addStatisticsDays, statisticsDay, type StatisticsFilters } from '../../../shared/statistics';

const DAY_MS = 86_400_000;
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/**
 * A service over a real cache and statistics worker. The sync queue runs in
 * process, so a test can end a run after a number of batches (as source sync
 * does) or make acknowledgement fail.
 */
function fixture(timeZone = 'UTC') {
  const dir = mkdtempSync(path.join(tmpdir(), 'statistics-service-'));
  const database = new CrowdsecDatabase({ dataDir: dir });
  configureStatisticsCapture(database.db, true);
  const config = {
    statistics: { enabled: true, retentionDays: 30, jobInterval: '1h', jobTimeBudget: '30s' },
    statisticsManaged: [], configEnvironmentOverrides: {}, timeZone, lookbackMs: 10 * DAY_MS,
    instances: [{ id: 'default', name: 'default', sync: {} }],
    sqliteWalEnabled: true, sqliteIncrementalVacuumEnabled: true, sqliteJournalSizeLimitBytes: 128 * 1024 * 1024,
  } as unknown as RuntimeConfig;
  const control = { batchLimit: Infinity, batchesRead: 0, failAcknowledge: false, failBatch: false };
  const sync = {
    runExclusive: async <T>(operation: () => T | Promise<T>) => operation(),
    statisticsBatch: async (backfill: boolean) => {
      if (control.failBatch) throw new Error('Simulated batch failure');
      control.batchesRead += 1;
      return readStatisticsBatch(database.db, backfill);
    },
    acknowledgeStatistics: async (ids: number[], cutoff: string) => {
      if (control.failAcknowledge) throw new Error('Simulated acknowledgement failure');
      return acknowledgeStatisticsBatch(database.db, ids, cutoff);
    },
  };
  const service = new StatisticsService({ config, database, sync, ready: () => true, busy: () => control.batchesRead >= control.batchLimit });
  cleanups.push(() => { service.close(); database.close(); rmSync(dir, { recursive: true, force: true }); });

  const now = Date.now();
  const iso = (daysAgo: number) => new Date(now - daysAgo * DAY_MS).toISOString();
  /** UTC day, as the outbox dates observations. */
  const day = (daysAgo: number) => statisticsDay(now - daysAgo * DAY_MS, 'UTC');
  const alert = (id: number, daysAgo: number) => {
    const record = { id, uuid: `a-${id}`, created_at: iso(daysAgo), scenario: 'ssh', source: { ip: `192.0.2.${id % 250}` }, machine_id: 'm-1', events_count: 1 };
    database.insertAlert({ $id: id, $uuid: record.uuid, $created_at: record.created_at, $message: '', $record: record as never, $instance_id: 'default' });
  };
  const decisions = (alertId: number, count: number, daysAgo = 0, first = 1) => database.transaction(() => {
    for (let id = first; id < first + count; id++) {
      const record = { id, type: 'ban', origin: 'lists', value: `10.0.${id >> 8 & 255}.${id & 255}`, created_at: iso(daysAgo) };
      database.insertDecision({ $id: String(id), $uuid: String(id), $alert_id: alertId, $created_at: record.created_at, $stop_at: iso(-1), $record: record as never, $instance_id: 'default' });
    }
  })(undefined);
  /** Runs the job, ending it after `batches` batches like a source sync would. */
  const run = async (batches = Infinity) => {
    Object.assign(control, { batchLimit: batches, batchesRead: 0 });
    await service.run();
    control.batchLimit = Infinity;
  };
  const tick = () => (service as unknown as { tick(): Promise<void> }).tick();
  /** Whether a range of days of the configured zone, given as dates or as UTC days ago, is partial. */
  const partial = async (from: number | string, to: number | string) => {
    const filters: StatisticsFilters = { from: typeof from === 'number' ? day(from) : from, to: typeof to === 'number' ? day(to) : to, instance: 'all', simulation: 'all', limit: 10 };
    return (await service.query(filters)).coverage.partial;
  };
  const backlog = () => service.configuration().status.backlog;
  return { database, service, control, day, alert, decisions, run, tick, partial, backlog };
}

describe('statistics background job', () => {
  it('finds the earliest day pending observations add to, including the alert day of a decision', () => {
    const f = fixture();
    expect(statisticsPendingFrom(f.database.db)).toEqual({ day: null, seq: 0 });
    f.alert(1, 1);
    f.decisions(1, 1);
    expect(statisticsPendingFrom(f.database.db)).toEqual({ day: f.day(1), seq: 2 });
    // The decision is dated today, but its alert six days ago, so the outbox
    // keeps it under today while it still adds to that earlier day.
    f.alert(2, 6);
    f.database.db.exec('DELETE FROM statistics_outbox WHERE identity LIKE \'["alert"%\'');
    f.decisions(2, 1, 0, 100);
    expect(f.database.db.prepare('SELECT MIN(day) AS day FROM statistics_outbox').get()).toEqual({ day: f.day(0) });
    expect(statisticsPendingFrom(f.database.db).day).toBe(f.day(6));
    // Only rows after a sequence are scanned when extending a bound.
    expect(statisticsPendingFrom(f.database.db, 3)).toEqual({ day: f.day(6), seq: 4 });
    expect(statisticsPendingFrom(f.database.db, 4)).toEqual({ day: null, seq: 4 });
  });

  it('marks only ranges that reach days with pending observations as partial', async () => {
    const f = fixture();
    f.alert(1, 5);
    await f.run();
    expect(await f.partial(4, 2)).toBe(false);

    // A large import today is only partly processed in this run.
    f.alert(2, 0);
    f.decisions(2, 1200);
    await f.run(1);
    expect(f.backlog()).toBeGreaterThan(0);
    expect(await f.partial(4, 2)).toBe(false);
    expect(await f.partial(4, 0)).toBe(true);
    expect(await f.partial(4, 1)).toBe(false);

    await f.run();
    expect(f.backlog()).toBe(0);
    expect(await f.partial(4, 0)).toBe(false);

    // A new decision for the five-day-old alert changes that alert's day. It
    // is captured after a batch's worth of today's rows, so it is still pending.
    f.decisions(2, 600, 0, 6000);
    f.decisions(1, 1, 0, 5000);
    await f.run(1);
    expect(f.backlog()).toBeGreaterThan(0);
    expect(await f.partial(4, 2)).toBe(true);
  });

  it('extends pending UTC days to the previous calendar day in zones behind UTC', async () => {
    const f = fixture('America/New_York');
    f.alert(1, 5);
    await f.run();
    f.alert(2, 0);
    f.decisions(2, 1200);
    await f.run(1);
    // The UTC day of today's rows begins on the previous New York day.
    const pendingFrom = addStatisticsDays(f.day(0), -1);
    expect(await f.partial(addStatisticsDays(pendingFrom, -3), addStatisticsDays(pendingFrom, -1))).toBe(false);
    expect(await f.partial(addStatisticsDays(pendingFrom, -3), pendingFrom)).toBe(true);
  });

  it('includes older observations captured after a job in the next query', async () => {
    const f = fixture();
    f.alert(1, 5);
    await f.run();
    f.alert(2, 0);
    f.decisions(2, 1200);
    await f.run(1);
    expect(await f.partial(4, 2)).toBe(false);
    // An alert from three days ago is captured before the next job runs.
    f.alert(3, 3);
    expect(await f.partial(4, 2)).toBe(true);
    expect(await f.partial(4, 4)).toBe(false);
    await f.run();
    expect(await f.partial(4, 2)).toBe(false);
  });

  it('keeps older pending observations in the bound when a run fails', async () => {
    const f = fixture();
    f.alert(1, 5);
    await f.run();
    f.alert(2, 0);
    f.decisions(2, 1200);
    await f.run(1);
    expect(await f.partial(4, 2)).toBe(false);
    // A decision for the five-day-old alert arrives, and the next run fails.
    f.decisions(1, 1, 0, 5000);
    f.control.failBatch = true;
    await f.run();
    expect(f.service.configuration().status.error).toBe('Simulated batch failure');
    expect(await f.partial(4, 2)).toBe(true);
  });

  it('keeps continuing a backlog after a run yields to source sync before reading anything', async () => {
    const f = fixture();
    await f.run();
    f.alert(1, 0);
    f.decisions(1, 1600);
    await f.run(1);
    const remaining = f.backlog();
    await f.run(0);
    expect(f.backlog()).toBe(remaining);
    f.control.batchLimit = 1; f.control.batchesRead = 0;
    await f.tick();
    expect(f.backlog()).toBeLessThan(remaining);
  });

  it('continues a run that ran out of time on the next tick, but waits for the interval after a failure', async () => {
    const f = fixture();
    await f.run();
    f.alert(1, 0);
    f.decisions(1, 1600);
    await f.run(1);
    const remaining = f.backlog();
    expect(remaining).toBeGreaterThan(0);

    // The next tick continues instead of waiting for the hourly interval.
    f.control.batchLimit = 1; f.control.batchesRead = 0;
    await f.tick();
    expect(f.backlog()).toBeLessThan(remaining);

    // A failed run records its error and does not retry every minute.
    f.control.batchLimit = Infinity; f.control.failAcknowledge = true;
    await f.tick();
    expect(f.service.configuration().status.error).toBe('Simulated acknowledgement failure');
    f.control.failAcknowledge = false;
    const afterFailure = f.backlog();
    await f.tick();
    expect(f.backlog()).toBe(afterFailure);

    // The next successful run catches up and clears the error.
    await f.run();
    expect(f.service.configuration().status).toMatchObject({ backlog: 0, error: null });
  });
});
