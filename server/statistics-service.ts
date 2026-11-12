import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_STATISTICS_SETTINGS, addStatisticsDays, statisticsCutoff, statisticsDay, validateStatisticsSettings,
  type StatisticsConfiguration, type StatisticsDetailRequest, type StatisticsDetails, type StatisticsFilters, type StatisticsResponse, type StatisticsSettings,
} from '../shared/statistics';
import { parseDurationMs } from '../shared/duration';
import { parseLookbackToMs, resolveManagedSettingSource, type RuntimeConfig } from './config';
import type { CrowdsecDatabase } from './database';
import type { DatabaseSyncWorker } from './sync-worker-client';
import { acknowledgeStatisticsBatch, configureStatisticsCapture, readStatisticsBatch, resetStatisticsCapture, statisticsPendingFrom } from './statistics-capture';
import { StatisticsWorkerClient } from './statistics-worker-client';
import type { StoredStatistics } from './statistics-store';

type SyncQueue = Pick<DatabaseSyncWorker, 'runExclusive'> & Partial<Pick<DatabaseSyncWorker, 'configureStatistics' | 'resetStatistics' | 'statisticsBatch' | 'acknowledgeStatistics' | 'statisticsPendingFrom'>>;
/** How a job run ended: it yielded before reading anything, caught up, made progress with work left, or failed. */
type RunOutcome = 'idle' | 'done' | 'more' | 'failed';
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
// Settings are validated before use, so an unparsable value cannot reach here.
const durationMs = (value: string): number => parseDurationMs(value) ?? 0;

/**
 * Reads persisted settings without letting a damaged or foreign value stop the
 * server: unknown keys (other versions) and invalid values are skipped, and
 * unreadable JSON falls back to the configured defaults.
 */
function loadSavedSettings(raw: string | undefined): StatisticsSettings | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('Ignoring unreadable saved statistics settings; using configured defaults');
    return null;
  }
  const saved: Partial<StatisticsSettings> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_STATISTICS_SETTINGS, key)) continue;
    const name = key as keyof StatisticsSettings;
    try { Object.assign(saved, { [name]: validateStatisticsSettings({ [name]: value })[name] }); }
    catch (error) { console.warn(`Ignoring saved statistics.${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { ...DEFAULT_STATISTICS_SETTINGS, ...saved };
}

export class StatisticsService {
  private settings: StatisticsSettings;
  private readonly managed: StatisticsConfiguration['managed'];
  private readonly writer: StatisticsWorkerClient;
  private readonly reader: StatisticsWorkerClient;
  private readonly file: string;
  /** Days are calendar days of the configured TZ, or of the server's own zone. */
  readonly timeZone: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private started = false;
  private epoch = randomUUID();
  private epochStartedAt = new Date().toISOString();
  private coverageFrom: Record<string, string> = {};
  /** Previous coverage end per instance when capture stayed on across a restart. */
  private resumeFrom: Record<string, string> = {};
  private readonly resumable: boolean;
  private statusLoaded: Promise<void> = Promise.resolve();
  private updating = false;
  private lastRun = 0;
  /** The last run made progress but left work behind, so the next tick continues it. */
  private draining = false;
  /**
   * Earliest UTC day that pending observations add to, over the outbox rows up
   * to `pendingSeq`. Acknowledgements only move the true value later, so it
   * stays a lower bound; queries extend it with rows captured since, and each
   * run replaces it with a fresh scan so it moves forward as rows are processed.
   */
  private pendingFrom: string | null = null;
  private pendingSeq = 0;
  private active: Promise<void> | null = null;
  private maintaining: Promise<void> | null = null;
  /** Retention cutoff that maintenance last finished pruning to. */
  private prunedCutoff: string | null = null;
  private updateQueue: Promise<void> = Promise.resolve();
  private readonly status: StatisticsConfiguration['status'] = { running: false, lastSuccess: null, backlog: 0, backfillPending: false, error: null, revision: 0 };

  constructor(private readonly options: { config: RuntimeConfig; database: CrowdsecDatabase; sync: SyncQueue; ready: () => boolean; busy: () => boolean; complete?: () => boolean }) {
    const { config, database } = options;
    // Without saved settings, new installations collect by default and existing
    // ones stay opt-in. Programmatic RuntimeConfig users can still enable it
    // without managed YAML, and configured values (applied below) take precedence.
    this.settings = loadSavedSettings(database.getMeta('statistics_settings')?.value)
      ?? { ...config.statistics, enabled: config.statistics.enabled || !database.isStatisticsMigrationDefaultDisabled() };
    this.managed = {};
    for (const key of config.statisticsManaged) {
      Object.assign(this.settings, { [key]: config.statistics[key] });
      this.managed[key] = resolveManagedSettingSource(config.configEnvironmentOverrides, `statistics.${key}`);
    }
    this.settings = validateStatisticsSettings(this.settings);
    // Capture was running before this process started, so the cache holds
    // every row since the last job and coverage can continue from it.
    this.resumable = this.settings.enabled && database.getMeta('statistics_capture_enabled')?.value === 'true';
    // This runs before application background work starts. Later changes use the
    // shared write queue, never competing with an in-flight source transaction.
    if (this.settings.enabled || database.getMeta('statistics_capture_enabled')?.value === 'true') configureStatisticsCapture(database.db, this.settings.enabled);
    this.status.backfillPending = this.settings.enabled;
    this.file = path.join(path.dirname(database.statePath || database.cachePath), 'statistics.db');
    this.timeZone = config.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const workerOptions = { dbPath: this.file, timeZone: this.timeZone, walEnabled: config.sqliteWalEnabled, incrementalVacuumEnabled: config.sqliteIncrementalVacuumEnabled, journalSizeLimitBytes: config.sqliteJournalSizeLimitBytes };
    this.writer = new StatisticsWorkerClient(workerOptions);
    this.reader = new StatisticsWorkerClient({ ...workerOptions, readonly: true });
  }

  configuration(): StatisticsConfiguration {
    return { settings: { ...this.settings }, managed: { ...this.managed }, status: { ...this.status }, timeZone: this.timeZone };
  }

  update(value: unknown): Promise<StatisticsConfiguration> {
    const result = this.updateQueue.then(() => this.applySettings(value));
    this.updateQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Deletes all statistics; enabled collection starts over from the cached alerts and decisions. */
  reset(): Promise<StatisticsConfiguration> {
    const result = this.updateQueue.then(() => this.deleteAll());
    this.updateQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async deleteAll(): Promise<StatisticsConfiguration> {
    this.updating = true;
    try {
      while (this.active || this.maintaining) await (this.active || this.maintaining);
      const { database, sync } = this.options;
      // The source goes first: if the archive then fails to clear, its
      // deduplication identities still keep re-captured rows from counting twice.
      if (sync.resetStatistics) await sync.resetStatistics();
      else await sync.runExclusive(() => resetStatisticsCapture(database.db));
      if (fs.existsSync(this.file)) this.status.revision = Math.max(this.status.revision + 1, await this.writer.request<number>({ type: 'reset' }));
      this.epoch = randomUUID(); this.epochStartedAt = new Date().toISOString(); this.coverageFrom = {}; this.resumeFrom = {};
      Object.assign(this.status, { lastSuccess: null, backlog: 0, backfillPending: this.settings.enabled, error: null });
      this.prunedCutoff = null;
      this.lastRun = 0; this.draining = false; this.pendingFrom = null; this.pendingSeq = 0;
    } finally { this.updating = false; }
    if (this.started) { if (!this.timer) this.start(); else void this.tick(); }
    return this.configuration();
  }

  private async applySettings(value: unknown): Promise<StatisticsConfiguration> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('statistics must be an object');
    const input = value as Partial<StatisticsSettings>;
    const next = validateStatisticsSettings({ ...this.settings, ...input });
    for (const key of Object.keys(input) as Array<keyof StatisticsSettings>) {
      if (this.managed[key] && input[key] !== this.settings[key]) throw new Error(`MANAGED_BY_CONFIG: statistics.${key}`);
    }
    const changedEnabled = next.enabled !== this.settings.enabled;
    // Finish running work and keep ticks from starting more before toggling
    // capture or changing retention.
    this.updating = true;
    try { await this.saveSettings(next, changedEnabled); }
    finally { this.updating = false; }
    if (this.started) { if (!this.timer) this.start(); else void this.tick(); }
    return this.configuration();
  }

  private async saveSettings(next: StatisticsSettings, changedEnabled: boolean): Promise<void> {
    while (this.active || this.maintaining) await (this.active || this.maintaining);
    const { database, sync } = this.options;
    if (changedEnabled) {
      if (sync.configureStatistics) await sync.configureStatistics(next.enabled);
      else await sync.runExclusive(() => configureStatisticsCapture(database.db, next.enabled));
    }
    try { await sync.runExclusive(() => database.setMeta('statistics_settings', JSON.stringify(next))); }
    catch (error) {
      if (changedEnabled) {
        try {
          if (sync.configureStatistics) await sync.configureStatistics(this.settings.enabled);
          else await sync.runExclusive(() => configureStatisticsCapture(database.db, this.settings.enabled));
        } catch (rollbackError) { this.recordError(rollbackError); }
      }
      throw error;
    }
    this.settings = next;
    if (changedEnabled && next.enabled) { this.epoch = randomUUID(); this.epochStartedAt = new Date().toISOString(); this.coverageFrom = {}; this.resumeFrom = {}; this.status.backfillPending = true; }
    this.lastRun = 0;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.started = true;
    if (!this.settings.enabled && !fs.existsSync(this.file) && !this.options.database.db.prepare('SELECT 1 FROM statistics_outbox LIMIT 1').get()) return;
    if (fs.existsSync(this.file)) {
      const epoch = this.epoch;
      this.statusLoaded = this.writer.request<{ lastSuccess: string | null; revision: number; coverageThrough: Record<string, string> }>({ type: 'status' })
        .then((value) => {
          this.status.lastSuccess = value.lastSuccess; this.status.revision = Math.max(this.status.revision, value.revision);
          if (this.resumable && this.epoch === epoch) this.resumeFrom = value.coverageThrough;
        })
        .catch((error) => this.recordError(error));
    }
    this.timer = setInterval(() => { void this.tick(); }, 60_000);
    this.timer.unref();
    void this.tick();
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.writer.close(); this.reader.close();
  }

  async query(filters: StatisticsFilters): Promise<StatisticsResponse> {
    if (!fs.existsSync(this.file)) throw new Error('Statistics are not available yet; enable collection and wait for the first background job');
    // Return the settings used by the query even if they change while it runs.
    const settings = this.settings;
    const { lastSuccess, ...data } = await this.reader.request<StoredStatistics>({ type: 'query', filters, retentionDays: settings.retentionDays,
      instances: this.options.config.instances.map((i) => i.id),
      // Allow one missed or delayed job before the latest coverage counts as stale.
      freshnessMs: 2 * durationMs(settings.jobInterval) });
    if (lastSuccess && (!this.status.lastSuccess || lastSuccess > this.status.lastSuccess)) this.status.lastSuccess = lastSuccess;
    if (data.revision > this.status.revision) this.status.revision = data.revision;
    // Pending observations only change days from the earliest one they add to.
    const pendingFrom = this.status.backlog > 0 ? this.pendingDay() : null;
    const pending = pendingFrom !== null && filters.to >= pendingFrom;
    return { ...data, coverage: { ...data.coverage, partial: data.coverage.partial || this.status.backfillPending || pending },
      configuration: { ...this.configuration(), settings: { ...settings } } };
  }

  /**
   * Earliest day of the configured zone that pending observations add to,
   * including rows captured since the last run. Outbox days are UTC dates:
   * zones behind UTC put the start of one on the previous calendar day.
   */
  private pendingDay(): string | null {
    const added = statisticsPendingFrom(this.options.database.db, this.pendingSeq);
    if (added.day && (!this.pendingFrom || added.day < this.pendingFrom)) this.pendingFrom = added.day;
    this.pendingSeq = added.seq;
    return this.pendingFrom && statisticsDay(Date.parse(`${this.pendingFrom}T00:00:00.000Z`), this.timeZone);
  }

  async details(filters: StatisticsFilters, request: StatisticsDetailRequest): Promise<StatisticsDetails> {
    if (!fs.existsSync(this.file)) throw new Error('Statistics are not available yet; enable collection and wait for the first background job');
    return this.reader.request<StatisticsDetails>({ type: 'details', filters, request, retentionDays: this.settings.retentionDays,
      instances: this.options.config.instances.map((i) => i.id) });
  }

  run(): Promise<void> {
    if (this.active) return this.active;
    // A settings change is waiting for running work; it schedules a run itself.
    if (this.updating) return Promise.resolve();
    this.active = (async () => {
      if (this.maintaining) await this.maintaining;
      await this.statusLoaded;
      // A run that yielded to source sync before doing anything is retried
      // on the next tick instead of waiting a full job interval. So is one
      // that made progress but ran out of time with work left: the budget
      // bounds each run, not how quickly a large import is processed. A failed
      // run waits for the next interval instead of retrying every minute.
      const outcome = await this.collect();
      // Yielding leaves the previous run's continuation in place.
      if (outcome !== 'idle') { this.lastRun = Date.now(); this.draining = outcome === 'more'; }
    })().finally(() => { this.active = null; });
    return this.active;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.updating || this.active || this.maintaining || this.options.busy()) return;
    if ((this.options.ready() || !this.settings.enabled) && (this.draining || Date.now() - this.lastRun >= durationMs(this.settings.jobInterval))) await this.run();
    else if (this.maintenanceDue()) {
      this.maintaining = this.maintain().catch((error) => this.recordError(error)).finally(() => { this.maintaining = null; });
      await this.maintaining;
    }
  }

  /** Pruning is only needed after the day or the retention changes, or to finish a bounded pass. */
  private maintenanceDue(): boolean {
    return (this.settings.enabled || fs.existsSync(this.file)) && this.cutoff() !== this.prunedCutoff;
  }

  private cutoff(): string { return statisticsCutoff(this.settings.retentionDays, Date.now(), this.timeZone); }

  /** Source rows are dated by UTC day, which may be one day before the zone's day. */
  private static sourceCutoff(cutoff: string): string { return addStatisticsDays(cutoff, -1); }

  private recordError(error: unknown): void {
    if (this.stopped) return;
    this.status.error = error instanceof Error ? error.message : String(error);
    console.error('Statistics background job failed:', this.status.error);
  }

  private async maintain(): Promise<void> {
    const deadline = Date.now() + 30_000;
    do {
      const cutoff = this.cutoff();
      const { sync, database } = this.options;
      const sourceCutoff = StatisticsService.sourceCutoff(cutoff);
      const sourceRemains = sync.acknowledgeStatistics
        ? await sync.acknowledgeStatistics([], sourceCutoff)
        : await sync.runExclusive(() => acknowledgeStatisticsBatch(database.db, [], sourceCutoff));
      const archiveRemains = fs.existsSync(this.file) && await this.writer.request<boolean>({ type: 'prune', cutoff });
      if (!sourceRemains && !archiveRemains) { this.prunedCutoff = cutoff; break; }
      await pause();
    } while (!this.stopped && Date.now() < deadline);
  }

  private async collect(): Promise<RunOutcome> {
    const { sync, database, config } = this.options;
    if (this.stopped) return 'done';
    // While disabled there is nothing to do once pending observations are consumed.
    if (!this.settings.enabled && !database.db.prepare('SELECT 1 FROM statistics_outbox LIMIT 1').get()) return 'done';
    this.status.running = true;
    const deadline = Date.now() + durationMs(this.settings.jobTimeBudget);
    let batches = 0;
    let acknowledged = 0;
    try {
      do {
        if (this.options.busy()) break;
        batches += 1;
        const batch = sync.statisticsBatch
          ? await sync.statisticsBatch(this.settings.enabled)
          : await sync.runExclusive(() => readStatisticsBatch(database.db, this.settings.enabled));
        for (const [instance, at] of Object.entries(batch.coverageFrom)) {
          if (!this.coverageFrom[instance] || at < this.coverageFrom[instance]) this.coverageFrom[instance] = at;
        }
        this.status.backfillPending = batch.backfillPending;
        this.status.backlog = batch.backlog;
        if (!this.settings.enabled && !batch.rows.length) break;
        const cutoff = this.cutoff();
        const result = await this.writer.request<{ lastSuccess: string | null; revision: number }>({ type: 'consolidate', rows: batch.rows,
          context: { cutoff, epoch: this.epoch, enabled: this.settings.enabled,
            caughtUp: !batch.backfillPending && batch.backlog <= batch.rows.length,
            sourceComplete: this.options.complete?.() ?? true,
            coverageFrom: Object.fromEntries(config.instances.map((instance) => {
              const floor = new Date(Date.now() - (instance.sync.lookbackPeriod ? parseLookbackToMs(instance.sync.lookbackPeriod) : config.lookbackMs)).toISOString();
              const start = [this.coverageFrom[instance.id], this.resumeFrom[instance.id], this.epochStartedAt].filter(Boolean).sort()[0];
              return [instance.id, start > floor ? start : floor];
            })), instances: config.instances.map((i) => i.id), now: new Date().toISOString() } });
        const sourceCutoff = StatisticsService.sourceCutoff(cutoff);
        if (sync.acknowledgeStatistics) await sync.acknowledgeStatistics(batch.rows.map((r) => r.seq), sourceCutoff);
        else await sync.runExclusive(() => acknowledgeStatisticsBatch(database.db, batch.rows.map((r) => r.seq), sourceCutoff));
        acknowledged += 1;
        this.status.lastSuccess = result.lastSuccess;
        this.status.revision = result.revision;
        this.status.backlog = Math.max(0, batch.backlog - batch.rows.length);
        if (!batch.backfillPending && !this.status.backlog) break;
        await pause();
      } while (!this.stopped && Date.now() < deadline);
      if (!this.stopped && batches) {
        // A full scan lets the bound move forward past processed rows.
        const bound = sync.statisticsPendingFrom ? await sync.statisticsPendingFrom()
          : await sync.runExclusive(() => statisticsPendingFrom(database.db));
        this.pendingFrom = bound.day; this.pendingSeq = bound.seq;
      }
      if (!this.stopped && this.maintenanceDue()) await this.maintain();
      this.status.error = null;
    } catch (error) { this.recordError(error); return batches ? 'failed' : 'idle'; }
    finally { this.status.running = false; }
    if (!batches) return 'idle';
    return acknowledged && (this.status.backfillPending || this.status.backlog > 0) ? 'more' : 'done';
  }
}
