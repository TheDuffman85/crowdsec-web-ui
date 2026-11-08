import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { normalizeMachineId } from '../shared/machine';
import {
  STATISTICS_DETAIL_MAX, STATISTICS_DETAIL_PAGE, STATISTICS_HOURLY_DAYS, statisticsAddressRange, statisticsCutoff,
  type StatisticsDetailRequest, type StatisticsDetails, type StatisticsFilters, type StatisticsRanking, type StatisticsResponse,
} from '../shared/statistics';
import type { StatisticsOutboxRow } from './statistics-capture';

interface Observation {
  kind: 'alert' | 'decision'; at: string; instance: string;
  ip?: string; country?: string; asn?: string; network?: string;
  machineId?: string; machineName?: string; scenario?: string; target?: string;
  simulated: number; events?: number; alertAt?: string; alertSimulated?: number;
  type?: string; origin?: string; alertIdentity?: unknown[];
}

export function decodeStatisticsObservation(payload: string): Observation {
  const value = JSON.parse(payload);
  if (!Array.isArray(value)) return value as Observation;
  if (value[0] !== 1 || !['a', 'd'].includes(value[1])) throw new Error('Unsupported statistics observation version');
  const observation: Observation = { kind: value[1] === 'a' ? 'alert' : 'decision', at: value[2], instance: value[3],
    ip: value[4], country: value[5], asn: value[6], network: value[7], machineId: value[8], machineName: value[9],
    scenario: value[10], simulated: value[11] };
  if (observation.kind === 'alert') Object.assign(observation, { events: value[12], target: value[13] });
  else Object.assign(observation, { alertAt: value[12], alertSimulated: value[13], type: value[14], origin: value[15], alertIdentity: value[16], target: value[17] });
  return observation;
}

export interface ConsolidationContext {
  cutoff: string;
  epoch: string;
  enabled: boolean;
  caughtUp: boolean;
  sourceComplete?: boolean;
  coverageFrom: Record<string, string>;
  instances: string[];
  now: string;
}

export type StoredStatistics = Omit<StatisticsResponse, 'configuration'> & { lastSuccess: string | null };
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const day = (value: string): string => value.slice(0, 10);
// Source clocks can run slightly ahead of this server. Observations up to one
// UTC day ahead are kept on their own date instead of being dropped.
const CLOCK_SKEW_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** First UTC day that keeps hourly counts at `now`; see STATISTICS_HOURLY_DAYS. */
const hourlyFloor = (now: number): string => new Date(now - (STATISTICS_HOURLY_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
const text = (value: unknown): string => typeof value === 'string' ? value : '';

export function canonicalStatisticsIP(value: unknown): string {
  if (typeof value !== 'string' || !isIP(value)) return '';
  try { return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value; }
  catch { return ''; }
}

/** An IP address or CIDR range, like the source value the dashboard ranks in Top IPs. */
export function canonicalStatisticsSource(value: unknown): string {
  const ip = canonicalStatisticsIP(value);
  if (ip || typeof value !== 'string') return ip;
  const match = /^([^/]+)\/(\d{1,3})$/.exec(value.trim());
  const address = match ? canonicalStatisticsIP(match[1]) : '';
  const prefix = match ? Number(match[2]) : -1;
  return address && prefix <= (isIP(address) === 6 ? 128 : 32) ? `${address}/${prefix}` : '';
}
// Ranges are ranked like the dashboard does, but are not unique IP addresses.
const SINGLE_IP = "ip != '' AND instr(ip, '/') = 0";
// Lookups for a few IPs across the archive. Without the hint SQLite prefers the
// clustered (kind, day) key, which covers every column, and reads whole periods.
const CELLS_BY_IP = 'cells INDEXED BY idx_statistics_cells_ip';

export class StatisticsStore {
  readonly db: any;
  private readonly vacuumEnabled: boolean;

  constructor(file: string, options: { readonly?: boolean; walEnabled?: boolean; incrementalVacuumEnabled?: boolean; journalSizeLimitBytes?: number } = {}) {
    this.vacuumEnabled = options.incrementalVacuumEnabled !== false;
    this.db = new Database(file, { readonly: options.readonly ?? false, timeout: 1000 });
    this.db.pragma('busy_timeout = 1000');
    this.db.pragma('cache_size = -8000');
    if (options.readonly) return;
    const fresh = !this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cells'").get();
    if (fresh && options.incrementalVacuumEnabled !== false) this.db.pragma('auto_vacuum = INCREMENTAL');
    this.db.pragma(`journal_mode = ${options.walEnabled === false ? 'DELETE' : 'WAL'}`);
    this.db.pragma('synchronous = FULL');
    this.db.pragma(`journal_size_limit = ${options.journalSizeLimitBytes ?? 128 * 1024 * 1024}`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen (identity BLOB PRIMARY KEY, day TEXT NOT NULL, cell_key BLOB) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_statistics_seen_day ON seen(day);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS coverage (
        epoch TEXT NOT NULL, instance TEXT NOT NULL, start TEXT NOT NULL, through TEXT,
        PRIMARY KEY(epoch, instance)
      ) WITHOUT ROWID;
    `);
    const seenColumns = (this.db.prepare('PRAGMA table_info(seen)').all() as Array<{ name: string }>).map((column) => column.name);
    if (!seenColumns.includes('cell_key')) this.db.exec('ALTER TABLE seen ADD COLUMN cell_key BLOB');
    if (!seenColumns.includes('cell_day')) this.db.exec('ALTER TABLE seen ADD COLUMN cell_day TEXT');
    // Hourly counts for the chart of the latest days. An existing archive has
    // none for the time before this table was added.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hours'").get()) {
      this.db.exec(`CREATE TABLE hours (
        kind TEXT NOT NULL, hour TEXT NOT NULL, key BLOB NOT NULL,
        instance TEXT NOT NULL, simulated INTEGER NOT NULL, ip TEXT NOT NULL, machine TEXT NOT NULL, scenario TEXT NOT NULL,
        count INTEGER NOT NULL, PRIMARY KEY (kind, hour, key)
      ) WITHOUT ROWID`);
      if (!fresh) this.db.prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)').run('hourlySince', new Date().toISOString());
    }
    const cells = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cells'").get();
    if (!cells) this.db.transaction(() => { this.createCells(); this.createCellIndexes(); })();
    else if (!(this.db.prepare('PRAGMA table_info(cells)').all() as Array<{ name: string; pk: number }>).some((column) => column.name === 'kind' && column.pk === 1)) this.clusterCells();
    // Targets were not captured by older versions. Preserve their counts and
    // leave that dimension empty rather than inventing historical targets.
    if (!(this.db.prepare('PRAGMA table_info(cells)').all() as Array<{ name: string }>).some((column) => column.name === 'target')) {
      this.db.exec("ALTER TABLE cells ADD COLUMN target TEXT NOT NULL DEFAULT ''");
    }
    const hourColumns = (this.db.prepare('PRAGMA table_info(hours)').all() as Array<{ name: string }>).map((column) => column.name);
    for (const field of ['country', 'network', 'target']) {
      if (!hourColumns.includes(field)) this.db.exec(`ALTER TABLE hours ADD COLUMN ${field} TEXT NOT NULL DEFAULT ''`);
    }
    // Existing hourly cells lack these dimensions. Use daily data for filtered
    // charts until a whole requested day has the additional hourly dimensions.
    if (!fresh && !hourColumns.includes('target')) this.db.prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)').run('hourlyBreakdownsSince', new Date().toISOString());
  }

  /**
   * Cells are stored in (kind, day) order, so every period query reads one
   * contiguous range instead of looking up each matching row individually.
   */
  private createCells(): void {
    this.db.exec(`CREATE TABLE cells (
      kind TEXT NOT NULL, day TEXT NOT NULL, key BLOB NOT NULL,
      instance TEXT NOT NULL, simulated INTEGER NOT NULL, alert_simulated INTEGER NOT NULL,
      ip TEXT NOT NULL, machine TEXT NOT NULL, machine_id TEXT NOT NULL, machine_name TEXT NOT NULL,
      scenario TEXT NOT NULL, country TEXT NOT NULL, asn TEXT NOT NULL, network TEXT NOT NULL,
      type TEXT NOT NULL, origin TEXT NOT NULL,
      count INTEGER NOT NULL, events INTEGER NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (kind, day, key)
    ) WITHOUT ROWID`);
  }

  private createCellIndexes(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_statistics_cells_ip ON cells(ip, kind, day);
      CREATE INDEX IF NOT EXISTS idx_statistics_cells_machine ON cells(machine, kind, day);
    `);
  }

  /** One-time rewrite of the first archive layout, keyed by digest alone. Keys and counts are kept. */
  private clusterCells(): void {
    const started = Date.now();
    this.db.transaction(() => {
      this.db.exec(`
        DROP INDEX IF EXISTS idx_statistics_cells_date;
        DROP INDEX IF EXISTS idx_statistics_cells_expiry;
        DROP INDEX IF EXISTS idx_statistics_cells_ip;
        DROP INDEX IF EXISTS idx_statistics_cells_machine;
        ALTER TABLE cells RENAME TO cells_unclustered;
      `);
      this.createCells();
      this.db.exec(`
        INSERT INTO cells SELECT kind, day, key, instance, simulated, alert_simulated, ip, machine, machine_id, machine_name,
          scenario, country, asn, network, type, origin, count, events, first_at, last_at, '' FROM cells_unclustered;
        UPDATE seen SET cell_day = (SELECT day FROM cells_unclustered c WHERE c.key = seen.cell_key) WHERE cell_key IS NOT NULL AND cell_day IS NULL;
        DROP TABLE cells_unclustered;
      `);
      this.createCellIndexes();
    })();
    if (this.vacuumEnabled) this.db.pragma('incremental_vacuum');
    console.log(`Statistics archive reorganized by date in ${Date.now() - started}ms`);
  }

  /** Whether rows older than the cutoff remain, checked through the clustered key. */
  hasExpired(cutoff: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM cells WHERE kind IN ('alert', 'ban', 'issued') AND day < ? LIMIT 1").get(cutoff)
      || this.db.prepare('SELECT 1 FROM seen WHERE day < ? LIMIT 1').get(cutoff));
  }

  close(): void { this.db.close(); }

  /** Latest coverage end per instance, used to continue coverage across restarts. */
  latestCoverage(): Record<string, string> {
    const rows = this.db.prepare('SELECT instance, MAX(through) AS through FROM coverage WHERE through IS NOT NULL GROUP BY instance').all() as Array<{ instance: string; through: string }>;
    return Object.fromEntries(rows.map((row) => [row.instance, row.through]));
  }

  metadata(key: string): string | null {
    return this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value ?? null;
  }

  consolidate(rows: StatisticsOutboxRow[], context: ConsolidationContext): { revision: number; lastSuccess: string | null } {
    const insertSeen = this.db.prepare('INSERT OR IGNORE INTO seen(identity, day) VALUES (?, ?)');
    const getParent = this.db.prepare("SELECT c.* FROM seen s JOIN cells c ON c.kind = 'alert' AND c.day = s.cell_day AND c.key = s.cell_key WHERE s.identity = ?");
    const linkParent = this.db.prepare('UPDATE seen SET cell_day = ?, cell_key = ? WHERE identity = ?');
    const upsert = this.db.prepare(`INSERT INTO cells (kind, day, key, instance, simulated, alert_simulated, ip, machine, machine_id, machine_name,
        scenario, country, asn, network, type, origin, target, count, events, first_at, last_at) VALUES (${Array(21).fill('?').join(',')})
      ON CONFLICT(kind, day, key) DO UPDATE SET count = count + excluded.count, events = events + excluded.events,
        first_at = min(first_at, excluded.first_at), last_at = max(last_at, excluded.last_at)`);
    const putMeta = this.db.prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)');
    const upsertHour = this.db.prepare(`INSERT INTO hours (kind, hour, key, instance, simulated, ip, machine, scenario, country, network, target, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(kind, hour, key) DO UPDATE SET count = count + 1`);
    const pruneHours = this.db.prepare('DELETE FROM hours WHERE kind = ? AND hour < ?');
    const firstHourlyDay = hourlyFloor(Date.parse(context.now));
    const overlappingCoverage = this.db.prepare('SELECT MIN(start) AS start FROM coverage WHERE instance = ? AND through >= ? AND start <= ?');
    const deleteCoverage = this.db.prepare('DELETE FROM coverage WHERE instance = ? AND through >= ? AND start <= ?');
    const putCoverage = this.db.prepare('INSERT OR REPLACE INTO coverage(epoch, instance, start, through) VALUES (?, ?, ?, ?)');
    const today = day(context.now);
    const horizon = day(new Date(Date.parse(context.now) + CLOCK_SKEW_MS).toISOString());
    const withinRetention = (at: string | undefined) => Boolean(at && day(at) >= context.cutoff && day(at) <= horizon);
    this.db.transaction(() => {
      for (const row of rows) {
        if (row.day < context.cutoff) continue;
        const o = decodeStatisticsObservation(row.payload);
        if (!Number.isFinite(Date.parse(o.at))) throw new Error('Invalid statistics observation timestamp');
        if (!withinRetention(o.at) && !(o.kind === 'decision' && withinRetention(o.alertAt))) continue;
        // Future-dated source clocks must not bypass the maximum retention age.
        if (!insertSeen.run(digest(row.identity), row.day > today ? today : row.day).changes) continue;
        if (o.kind === 'decision' && o.alertIdentity) {
          const parent = getParent.get(digest(JSON.stringify(o.alertIdentity)));
          if (parent) Object.assign(o, { ip: parent.ip, machineId: parent.machine_id, machineName: parent.machine_name,
            scenario: parent.scenario, country: parent.country, asn: parent.asn, network: parent.network, target: parent.target,
            alertAt: `${parent.day}T00:00:00.000Z`, alertSimulated: parent.simulated });
        }
        const ip = canonicalStatisticsSource(o.ip);
        const machineId = normalizeMachineId(o.machineId) || normalizeMachineId(o.machineName) || '';
        const machine = machineId ? JSON.stringify([o.instance, machineId]) : '';
        const add = (kind: string, at: string) => {
          if (!withinRetention(at)) return null;
          const dims = [kind, day(at), o.instance, o.simulated ? 1 : 0, o.alertSimulated ? 1 : 0,
            ip, machine, machineId, text(o.machineName) || machineId, text(o.scenario), text(o.country),
            o.asn == null ? '' : String(o.asn), text(o.network), kind === 'alert' ? '' : text(o.type) || 'ban', kind === 'alert' ? '' : text(o.origin)];
          const target = text(o.target);
          // Keep legacy keys for observations without a target.
          const key = digest(JSON.stringify(target ? [...dims, target] : dims));
          const events = kind === 'alert' && Number.isSafeInteger(o.events) && Number(o.events) >= 0 ? Number(o.events) : 0;
          const [cellKind, cellDay, ...rest] = dims;
          upsert.run(cellKind, cellDay, key, ...rest, target, 1, events, at, at);
          // Only the chart uses hours, so they keep just the series dimensions.
          if (kind !== 'ban' && cellDay >= firstHourlyDay) {
            const hourDims = [kind, at.slice(0, 13), o.instance, o.simulated ? 1 : 0, ip, machine, text(o.scenario), text(o.country), text(o.network), target];
            upsertHour.run(kind, hourDims[1], digest(JSON.stringify(hourDims)), ...hourDims.slice(2));
          }
          return { day: cellDay as string, key };
        };
        if (o.kind === 'alert') {
          const cell = add('alert', o.at);
          if (cell) linkParent.run(cell.day, cell.key, digest(row.identity));
        }
        else {
          add('issued', o.at);
          if ((o.type || 'ban') === 'ban' && o.alertAt) add('ban', o.alertAt);
        }
      }
      if (context.enabled && context.caughtUp && context.sourceComplete !== false) {
        for (const instance of context.instances) {
          const floor = `${context.cutoff}T00:00:00.000Z`;
          const requestedStart = context.coverageFrom[instance] || context.now;
          const start = requestedStart < floor ? floor : requestedStart;
          // Merge only overlapping authoritative import windows. An outage
          // longer than LAPI lookback must leave a visible historical gap.
          const overlapping = overlappingCoverage.get(instance, start, context.now);
          const mergedStart = overlapping.start && overlapping.start < start ? overlapping.start : start;
          deleteCoverage.run(instance, start, context.now);
          putCoverage.run(`${context.epoch}:${context.now}`, instance, mergedStart, context.now);
        }
      }
      for (const kind of ['alert', 'issued']) pruneHours.run(kind, firstHourlyDay);
      const revision = Number(this.metadata('revision') || 0) + 1;
      putMeta.run('revision', String(revision));
      if (context.caughtUp) putMeta.run('lastSuccess', context.now);
    })();
    return { revision: Number(this.metadata('revision')), lastSuccess: this.metadata('lastSuccess') };
  }

  prune(cutoff: string): void {
    this.db.transaction(() => {
      // Each table is bounded independently; subsequent maintenance ticks resume.
      // Expired rows sit at the start of each kind's clustered range.
      let budget = 500;
      for (const kind of ['alert', 'ban', 'issued']) {
        if (budget <= 0) break;
        budget -= this.db.prepare('DELETE FROM cells WHERE kind = ? AND day < ? AND key IN (SELECT key FROM cells WHERE kind = ? AND day < ? LIMIT ?)')
          .run(kind, cutoff, kind, cutoff, budget).changes;
      }
      this.db.prepare('DELETE FROM seen WHERE identity IN (SELECT identity FROM seen WHERE day < ? LIMIT 500)').run(cutoff);
      this.db.prepare('DELETE FROM coverage WHERE through < ?').run(cutoff);
      this.db.prepare('UPDATE coverage SET start = ? WHERE start < ?').run(`${cutoff}T00:00:00.000Z`, cutoff);
    })();
    if (this.vacuumEnabled) this.db.pragma('incremental_vacuum(64)');
  }

  /**
   * `freshnessMs` is how old the newest coverage may be and still count as
   * current: the archive is only extended by scheduled jobs, so the time since
   * the last job is not a gap.
   */
  query(filters: StatisticsFilters, retentionDays: number, instances: string[], now = Date.now(), freshnessMs = 0): StoredStatistics {
    return this.db.transaction(() => this.read(filters, retentionDays, instances, now, freshnessMs))();
  }

  /** Drill-down for one finding. Each kind is a few indexed, bounded queries. */
  details(filters: StatisticsFilters, request: StatisticsDetailRequest, retentionDays: number, instances: string[], now = Date.now()): StatisticsDetails {
    return this.db.transaction(() => this.readDetails(filters, request, retentionDays, instances, now))();
  }

  private readDetails(f: StatisticsFilters, request: StatisticsDetailRequest, retentionDays: number, instances: string[], now: number): StatisticsDetails {
    const { cutoff, start, scoped, scopeParams, isBan, where, params, previousFrom } = this.scopeOf(f, retentionDays, instances, now);
    const all = (sql: string, args: unknown[]): any[] => this.db.prepare(sql).all(...args);
    const size = 'size' in request && request.size ? Math.min(Math.max(1, Math.floor(request.size)), STATISTICS_DETAIL_MAX) : STATISTICS_DETAIL_PAGE;
    // Listed rows are bounded; the window count adds the total from the same grouped pass.
    const total = (rows: any[]) => Number(rows[0]?.total ?? 0);
    const perIP = (condition: string) => `SELECT ip, SUM(CASE WHEN kind = 'alert' THEN count ELSE 0 END) AS alerts,
        SUM(CASE WHEN ${isBan} THEN count ELSE 0 END) AS bans,
        COUNT(DISTINCT CASE WHEN kind = 'alert' AND machine != '' THEN machine END) AS machines,
        COUNT(DISTINCT CASE WHEN kind = 'alert' THEN day END) AS activeDays,
        MAX(CASE WHEN kind = 'alert' THEN last_at END) AS lastActivity, MAX(CASE WHEN kind = 'alert' THEN day END) AS lastDay,
        MIN(CASE WHEN ${isBan} THEN day END) AS firstBan, MAX(country) AS country, MAX(asn) AS asn, MAX(network) AS network
      FROM cells WHERE kind IN ('alert', 'ban') AND ${SINGLE_IP} AND ${where}${condition} GROUP BY ip HAVING alerts > 0`;
    const toIP = (row: any) => ({
      ip: row.ip, alerts: Number(row.alerts), bans: Number(row.bans), machines: Number(row.machines), activeDays: Number(row.activeDays),
      country: row.country || '', asn: row.asn || '', network: row.network || '', lastActivity: row.lastActivity || null,
      firstBan: row.firstBan || null, bannedBefore: Boolean(row.bannedBefore),
    });
    if (request.kind === 'ips') {
      const network = request.network ? ' AND network = ?' : '';
      const args = request.network ? [...params, request.network] : params;
      const rows = all(`SELECT *, COUNT(*) OVER () AS total FROM (${perIP(network)}) ORDER BY alerts DESC, ip LIMIT ${size}`, args);
      const ips = rows.map(toIP);
      if (!request.network) return { kind: 'ips', ips, total: total(rows), ranges: [], rangeTotal: 0 };
      // Ranges come from up to 5000 of the network's busiest IPs.
      const ranges = new Map<string, { range: string; ips: number; alerts: number }>();
      for (const row of all(`SELECT ip, SUM(count) AS alerts FROM cells WHERE kind = 'alert' AND ${SINGLE_IP} AND ${where} AND network = ?
        GROUP BY ip ORDER BY alerts DESC LIMIT 5000`, args)) {
        const range = statisticsAddressRange(row.ip);
        if (!range) continue;
        const entry = ranges.get(range) ?? { range, ips: 0, alerts: 0 };
        entry.ips += 1; entry.alerts += Number(row.alerts);
        ranges.set(range, entry);
      }
      return { kind: 'ips', ips, total: total(rows), rangeTotal: ranges.size,
        ranges: [...ranges.values()].sort((a, b) => b.ips - a.ips || b.alerts - a.alerts || a.range.localeCompare(b.range)).slice(0, size) };
    }
    if (request.kind === 'returned') {
      // Same definition as the returned-after-ban total; the archive is only
      // searched for IPs that did not already return within the range.
      const history = request.history && start > cutoff;
      const before = history ? `CASE WHEN lastDay > firstBan THEN 0 ELSE EXISTS (SELECT 1 FROM ${CELLS_BY_IP} WHERE ${isBan} AND ip = p.ip AND day >= ? AND day < ? AND ${scoped}) END` : '0';
      const rows = all(`WITH p AS MATERIALIZED (${perIP('')})
        SELECT *, COUNT(*) OVER () AS total FROM (SELECT p.*, ${before} AS bannedBefore FROM p) WHERE lastDay > firstBan OR bannedBefore
        ORDER BY alerts DESC, ip LIMIT ${size}`, history ? [...params, cutoff, start, ...scopeParams] : params);
      return { kind: 'returned', ips: rows.map(toIP), total: total(rows) };
    }
    const machines = request.machines.slice(0, STATISTICS_DETAIL_PAGE);
    if (!machines.length) return { kind: 'machines', machines: [] };
    const placeholders = machines.map(() => '?').join(',');
    const last = new Map(all(`SELECT machine, MAX(last_at) AS lastActivity FROM cells WHERE kind = 'alert' AND day >= ? AND day <= ? AND ${scoped}
      AND machine IN (${placeholders}) GROUP BY machine`, [cutoff, f.to, ...scopeParams, ...machines]).map((row) => [row.machine, row.lastActivity]));
    const scenarios = new Map<string, Array<{ label: string; current: number; previous: number }>>();
    for (const row of all(`SELECT machine, COALESCE(NULLIF(scenario, ''), 'Unknown') AS label,
        SUM(CASE WHEN day >= ? THEN count ELSE 0 END) AS current, SUM(CASE WHEN day < ? THEN count ELSE 0 END) AS previous
      FROM cells WHERE kind = 'alert' AND day BETWEEN ? AND ? AND ${scoped} AND machine IN (${placeholders})
      GROUP BY machine, label ORDER BY current DESC, previous DESC, label`, [f.from, f.from, previousFrom > cutoff ? previousFrom : cutoff, f.to, ...scopeParams, ...machines])) {
      const list = scenarios.get(row.machine) ?? [];
      if (list.length < 5) list.push({ label: row.label, current: Number(row.current), previous: Number(row.previous) });
      scenarios.set(row.machine, list);
    }
    const ips = new Map<string, Array<{ ip: string; alerts: number }>>();
    for (const row of all(`SELECT machine, ip, alerts FROM (SELECT machine, ip, SUM(count) AS alerts,
        ROW_NUMBER() OVER (PARTITION BY machine ORDER BY SUM(count) DESC, ip) AS position
      FROM cells WHERE kind = 'alert' AND ip != '' AND ${where} AND machine IN (${placeholders}) GROUP BY machine, ip) WHERE position <= 5
      ORDER BY machine, position`, [...params, ...machines])) {
      const list = ips.get(row.machine) ?? [];
      list.push({ ip: row.ip, alerts: Number(row.alerts) });
      ips.set(row.machine, list);
    }
    return { kind: 'machines', machines: machines.map((value) => ({ value, lastActivity: last.get(value) || null, scenarios: scenarios.get(value) || [], ips: ips.get(value) || [] })) };
  }

  /** Shared filter scope; the day range is separate so other periods reuse the same scope. */
  private scopeOf(f: StatisticsFilters, retentionDays: number, instances: string[], now: number) {
    const cutoff = statisticsCutoff(retentionDays, now);
    const start = f.from > cutoff ? f.from : cutoff;
    const scope: string[] = [];
    const scopeParams: unknown[] = [];
    if (f.instance !== 'all') { scope.push('instance = ?'); scopeParams.push(f.instance); }
    else if (instances.length) { scope.push(`instance IN (${instances.map(() => '?').join(',')})`); scopeParams.push(...instances); }
    else scope.push('0');
    if (f.simulation !== 'all') { scope.push('simulated = ?'); scopeParams.push(f.simulation === 'simulated' ? 1 : 0); }
    if (f.ip) { scope.push('ip = ?'); scopeParams.push(canonicalStatisticsSource(f.ip)); }
    if (f.machine) { scope.push('machine = ?'); scopeParams.push(f.machine); }
    if (f.scenario) { scope.push('scenario = ?'); scopeParams.push(f.scenario); }
    if (f.country) { scope.push('upper(country) = ?'); scopeParams.push(f.country.toUpperCase()); }
    if (f.network) { scope.push('network = ?'); scopeParams.push(f.network); }
    if (f.target) { scope.push('target = ?'); scopeParams.push(f.target); }
    // Bans belong to the mode of the alert that caused them.
    const banFilter = f.simulation === 'all' ? '' : ` AND alert_simulated = ${f.simulation === 'simulated' ? 1 : 0}`;
    const days = Math.round((Date.parse(f.to) - Date.parse(f.from)) / 86_400_000) + 1;
    return {
      cutoff, start, scoped: scope.join(' AND '), scopeParams, banFilter, isBan: `kind = 'ban'${banFilter}`,
      // One lower bound only: with a second one (the retention cutoff) SQLite
      // may start the index range at the cutoff and scan the whole archive.
      where: `day BETWEEN ? AND ? AND ${scope.join(' AND ')}`, params: [start, f.to, ...scopeParams] as unknown[],
      previousFrom: new Date(Date.parse(f.from) - days * 86_400_000).toISOString().slice(0, 10),
      previousTo: new Date(Date.parse(f.from) - 86_400_000).toISOString().slice(0, 10),
    };
  }

  private read(f: StatisticsFilters, retentionDays: number, instances: string[], now: number, freshnessMs: number): StoredStatistics {
    const { cutoff, start, scoped, scopeParams, banFilter, isBan, where, params, previousFrom, previousTo } = this.scopeOf(f, retentionDays, instances, now);
    const all = (sql: string, args: unknown[] = params): any[] => this.db.prepare(sql).all(...args);
    const get = (sql: string, args: unknown[] = params): any => this.db.prepare(sql).get(...args);
    // Bans count attacks from a known source; blocklist imports have none and
    // appear under decisions by origin instead.
    const sum = (kind: string, condition = where, args = params): number => Number(get(`SELECT COALESCE(SUM(count), 0) AS n FROM cells WHERE kind = '${kind}' AND ${condition}`, args).n);
    const list = (field: string, kind = 'alert', filter = '') => all(`SELECT COALESCE(NULLIF(${field}, ''), 'Unknown') AS label, SUM(count) AS count
      ${kind === 'alert' ? `, COUNT(DISTINCT CASE WHEN ${SINGLE_IP} THEN ip END) AS uniqueIPs` : ''}
      FROM cells WHERE kind = '${kind}' AND ${filter}${where} GROUP BY ${field} ORDER BY count DESC, label LIMIT ${f.limit}`);
    /**
     * Per-IP outcomes in one grouped pass over alerts and their bans. Bans are
     * dated by their alert, so "returned" means alerts on a later UTC day than a
     * ban. With `history` (the archive before the range), each IP is also looked
     * up once by the IP index: absent means new, and a ban there means returned.
     */
    const attackerTotals = (args: unknown[], history?: { from: string; to: string }) => {
      const before = `ip = g.ip AND day >= ? AND day < ? AND ${scoped}`;
      const known = history ? `CASE WHEN NOT EXISTS (SELECT 1 FROM ${CELLS_BY_IP} WHERE kind = 'alert' AND ${before}) THEN 0
          WHEN EXISTS (SELECT 1 FROM ${CELLS_BY_IP} WHERE ${isBan} AND ${before}) THEN 2 ELSE 1 END` : '1';
      const knownArgs = history ? [history.from, history.to, ...scopeParams, history.from, history.to, ...scopeParams] : [];
      // Materialized so the history lookups run once per IP, not once per use.
      const row = get(`WITH per_ip AS MATERIALIZED (SELECT g.*, ${known} AS known FROM (SELECT ip, COUNT(DISTINCT CASE WHEN kind = 'alert' THEN day END) AS days,
          MIN(CASE WHEN ${isBan} THEN day END) AS firstBan, MAX(CASE WHEN kind = 'alert' THEN day END) AS lastAlert
          FROM cells WHERE kind IN ('alert', 'ban') AND ${SINGLE_IP} AND ${where} GROUP BY ip) g WHERE days > 0)
        SELECT COUNT(*) AS uniqueIPs, COALESCE(SUM(days > 1), 0) AS repeatAttackers,
          COALESCE(SUM(firstBan IS NOT NULL), 0) AS bannedIPs, COALESCE(SUM(lastAlert > firstBan OR known = 2), 0) AS returnedAfterBan,
          COALESCE(SUM(known = 0), 0) AS newIPs FROM per_ip`, [...knownArgs, ...args]);
      return {
        uniqueIPs: Number(row.uniqueIPs), bannedIPs: Number(row.bannedIPs), repeatAttackers: Number(row.repeatAttackers),
        returnedAfterBan: Number(row.returnedAfterBan), newIPs: history ? Number(row.newIPs) : null,
      };
    };
    const ranking = (field: 'ip' | 'machine'): StatisticsRanking[] => {
      const ranked = all(`SELECT ${field} AS value, MAX(${field === 'machine' ? "COALESCE(NULLIF(machine_name, ''), machine_id)" : 'ip'}) AS label,
        MAX(instance) AS instance, MAX(machine_id) AS machineId, SUM(count) AS alerts, SUM(events) AS events,
        COUNT(DISTINCT CASE WHEN ${SINGLE_IP} THEN ip END) AS uniqueIPs, COUNT(DISTINCT NULLIF(machine, '')) AS machines,
        COUNT(DISTINCT day) AS activeDays, MIN(first_at) AS firstActivity, MAX(last_at) AS lastActivity,
        MAX(country) AS country, MAX(asn) AS asn, MAX(network) AS network
        FROM cells WHERE kind = 'alert' AND ${field} != '' AND ${where}
        GROUP BY ${field} ORDER BY alerts DESC, value LIMIT ${f.limit}`);
      if (!ranked.length) return [];
      // Details for all ranked values are fetched with one grouped query each
      // instead of one query per ranked row.
      const values = ranked.map((row) => row.value as string);
      const placeholders = values.map(() => '?').join(',');
      const inRanked = `${where} AND ${field} IN (${placeholders})`;
      // Ranked IPs are a few rows each; ranked machines usually cover most of the period.
      const source = field === 'ip' ? CELLS_BY_IP : 'cells';
      const args = [...params, ...values];
      const byOwner = <T>(rows: Array<{ owner: string } & T>): Map<string, T[]> => {
        const result = new Map<string, T[]>();
        for (const { owner, ...rest } of rows) {
          const list = result.get(owner);
          if (list) list.push(rest as unknown as T); else result.set(owner, [rest as unknown as T]);
        }
        return result;
      };
      const latest = new Map(all(`SELECT owner, country, asn, network, machine_name FROM (
        SELECT ${field} AS owner, country, asn, network, machine_name,
          ROW_NUMBER() OVER (PARTITION BY ${field} ORDER BY last_at DESC, key) AS position
        FROM ${source} WHERE kind = 'alert' AND ${inRanked}) WHERE position = 1`, args).map((row) => [row.owner, row]));
      // Bans only: the latest alert day comes from the ranking itself.
      const outcomes = new Map(all(`SELECT ${field} AS owner, SUM(count) AS bans, MIN(day) AS firstBan FROM ${source}
        WHERE ${isBan} AND ${inRanked} GROUP BY ${field}`, args).map((row) => [row.owner, row]));
      // Ranked IPs banned earlier in the archive count as returning too.
      const bannedBefore = field === 'ip' && start > cutoff ? new Set(all(`SELECT DISTINCT ip FROM ${CELLS_BY_IP}
        WHERE ${isBan} AND day >= ? AND day < ? AND ${scoped} AND ip IN (${placeholders})`, [cutoff, start, ...scopeParams, ...values]).map((row) => row.ip as string)) : new Set<string>();
      const scenarios = byOwner<{ label: string; count: number }>(all(`SELECT owner, label, count FROM (
        SELECT ${field} AS owner, COALESCE(NULLIF(scenario, ''), 'Unknown') AS label, SUM(count) AS count,
          ROW_NUMBER() OVER (PARTITION BY ${field} ORDER BY SUM(count) DESC, COALESCE(NULLIF(scenario, ''), 'Unknown')) AS position
        FROM ${source} WHERE kind = 'alert' AND ${inRanked} GROUP BY ${field}, scenario) WHERE position <= 3 ORDER BY owner, position`, args));
      // Only attackers have targeted machines; for a machine it would be itself.
      const targetedMachines = field === 'machine' ? new Map<string, Array<{ value: string; label: string; count: number }>>() : byOwner<{ value: string; label: string; count: number }>(all(`SELECT owner, value, label, count FROM (
        SELECT ${field} AS owner, machine AS value, MAX(machine_name) AS label, SUM(count) AS count,
          ROW_NUMBER() OVER (PARTITION BY ${field} ORDER BY SUM(count) DESC, machine) AS position
        FROM ${source} WHERE kind = 'alert' AND machine != '' AND ${inRanked} GROUP BY ${field}, machine) WHERE position <= 3 ORDER BY owner, position`, args));
      return ranked.map((row) => {
        const top = latest.get(row.value);
        const outcome = outcomes.get(row.value);
        return {
          ...row, country: top.country, asn: top.asn, network: top.network,
          ...(field === 'machine' ? { label: top.machine_name || row.machineId } : {}),
          bans: Number(outcome?.bans || 0),
          ...(field === 'ip' ? { returnedAfterBan: bannedBefore.has(row.value) || Boolean(outcome?.firstBan && day(row.lastActivity) > outcome.firstBan) } : {}),
          scenarios: scenarios.get(row.value) || [],
          targetedMachines: targetedMachines.get(row.value) || [],
        };
      });
    };

    const scopes = f.instance === 'all' ? instances : [f.instance];
    const spans = this.db.prepare('SELECT instance, start, through FROM coverage WHERE through IS NOT NULL AND through >= ?').all(cutoff) as Array<{ instance: string; start: string; through: string }>;
    const spansByInstance = new Map(scopes.map((instance) => [instance, spans.filter((s) => s.instance === instance).sort((a, b) => a.start.localeCompare(b.start))]));
    // Coverage written by a job that ran within the expected schedule reaches
    // the present: the time since that job is pending, not missing.
    const nowIso = new Date(now).toISOString();
    const freshSince = new Date(now - freshnessMs).toISOString();
    const reach = (through: string) => (through >= freshSince && through < nowIso ? nowIso : through);
    /** Whether every scoped instance was observed from `start` to `end`. */
    const coveredSpan = (start: string, end: string): boolean => {
      if (!scopes.length || day(start) < cutoff) return false;
      return scopes.every((instance) => {
        let cursor = start;
        for (const span of spansByInstance.get(instance) || []) {
          if (span.start > cursor) break;
          if (reach(span.through) > cursor) cursor = reach(span.through);
          if (cursor >= end) return true;
        }
        return false;
      });
    };
    const covered = (date: string): boolean => coveredSpan(`${date}T00:00:00.000Z`, new Date(Math.min(Date.parse(date) + 86_400_000, now)).toISOString());
    let comparisonPartial = previousFrom < cutoff;
    for (let stamp = Date.parse(previousFrom); !comparisonPartial && stamp <= Date.parse(previousTo); stamp += 86_400_000) comparisonPartial = !covered(new Date(stamp).toISOString().slice(0, 10));
    const compare = !comparisonPartial;

    const totals = get(`SELECT COALESCE(SUM(count), 0) AS alerts, COALESCE(SUM(events), 0) AS events FROM cells WHERE kind = 'alert' AND ${where}`);
    // A complete preceding period means the archive also holds the history
    // needed to tell new attackers from known ones.
    const attackers = attackerTotals(params, compare ? { from: cutoff, to: start } : undefined);
    const dates: string[] = [];
    for (let stamp = Date.parse(f.from); stamp <= Date.parse(f.to); stamp += 86_400_000) dates.push(new Date(stamp).toISOString().slice(0, 10));
    // Ranges within the kept hourly days are charted by hour.
    const hourlySince = this.metadata('hourlySince');
    const hourlyBreakdownsSince = (f.country || f.network || f.target) && this.metadata('hourlyBreakdownsSince');
    const granularity = dates.length <= STATISTICS_HOURLY_DAYS && f.from >= hourlyFloor(now) && f.from <= day(new Date(now).toISOString())
      && (!hourlySince || hourlySince <= `${f.from}T00:00:00.000Z`)
      && (!hourlyBreakdownsSince || hourlyBreakdownsSince <= `${f.from}T00:00:00.000Z`)
      && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hours'").get() ? 'hour' : 'day';
    const series: StoredStatistics['series'] = [];
    if (granularity === 'hour') {
      const hourly = new Map<string, { alerts: number; decisions: number }>();
      for (const row of all(`SELECT hour, SUM(CASE WHEN kind = 'alert' THEN count ELSE 0 END) AS alerts,
        SUM(CASE WHEN kind = 'issued' THEN count ELSE 0 END) AS decisions FROM hours
        WHERE kind IN ('alert', 'issued') AND hour BETWEEN ? AND ? AND ${scoped} GROUP BY hour`, [`${f.from}T00`, `${f.to}T23`, ...scopeParams])) hourly.set(row.hour, row);
      // Hours after the current one have not happened yet.
      const last = Math.min(Date.parse(f.to) + 23 * HOUR_MS, Math.floor(now / HOUR_MS) * HOUR_MS);
      for (let stamp = Date.parse(f.from); stamp <= last; stamp += HOUR_MS) {
        const date = new Date(stamp).toISOString();
        const counts = hourly.get(date.slice(0, 13));
        const known = counts ? true : coveredSpan(date, new Date(Math.min(stamp + HOUR_MS, now)).toISOString());
        series.push({ date, alerts: counts ? Number(counts.alerts) : known ? 0 : null, decisions: counts ? Number(counts.decisions) : known ? 0 : null });
      }
    } else {
      const daily = new Map<string, { alerts: number; decisions: number }>();
      for (const row of all(`SELECT day, SUM(CASE WHEN kind = 'alert' THEN count ELSE 0 END) AS alerts,
        SUM(CASE WHEN kind = 'issued' THEN count ELSE 0 END) AS decisions FROM cells WHERE kind IN ('alert', 'issued') AND ${where} GROUP BY day`)) daily.set(row.day, row);
      for (const date of dates) {
        const counts = daily.get(date);
        series.push({ date, alerts: counts?.alerts ?? (covered(date) ? 0 : null), decisions: counts?.decisions ?? (covered(date) ? 0 : null) });
      }
    }

    // One grouped pass over the preceding period feeds previous totals, machine
    // changes and scenario trends. It is skipped when it could not be shown.
    const previousParams = [previousFrom > cutoff ? previousFrom : cutoff, previousTo, ...scopeParams];
    const previousMachines = new Map<string, { label: string; n: number }>();
    const previousScenarios = new Map<string, number>();
    let previousTotals: StoredStatistics['previousTotals'] = null;
    if (compare) {
      const counts = { alerts: 0, bans: 0, decisions: 0 };
      for (const row of all(`SELECT kind, machine, MAX(machine_name) AS label, scenario, SUM(count) AS n FROM cells
        WHERE kind IN ('alert', 'ban', 'issued') AND (kind != 'ban' OR (${isBan} AND ip != '')) AND ${where} GROUP BY kind, machine, scenario`, previousParams)) {
        const n = Number(row.n);
        if (row.kind === 'ban') { counts.bans += n; continue; }
        if (row.kind === 'issued') { counts.decisions += n; continue; }
        counts.alerts += n;
        const machine = previousMachines.get(row.machine);
        if (machine) { machine.n += n; if (!machine.label && row.label) machine.label = row.label; }
        else previousMachines.set(row.machine, { label: row.label || '', n });
        if (row.scenario) previousScenarios.set(row.scenario, (previousScenarios.get(row.scenario) || 0) + n);
      }
      const { uniqueIPs, bannedIPs, repeatAttackers } = attackerTotals(previousParams);
      previousTotals = { ...counts, uniqueIPs, bannedIPs, repeatAttackers };
    }
    const currentMachines = all(`SELECT machine AS value, MAX(machine_name) AS label, SUM(count) AS current FROM cells WHERE kind = 'alert' AND machine != '' AND ${where} GROUP BY machine`);
    const changes = currentMachines.map((r) => ({ ...r, previous: previousMachines.get(r.value)?.n || 0, change: r.current - (previousMachines.get(r.value)?.n || 0) }));
    const increases = changes.filter((r) => r.change > 0).sort((a, b) => b.change - a.change || a.value.localeCompare(b.value)).slice(0, f.limit);
    const decreases = changes.filter((r) => r.change < 0).sort((a, b) => a.change - b.change || a.value.localeCompare(b.value)).slice(0, f.limit);
    // A machine that stops reporting entirely may have a broken agent or
    // acquisition. With an IP or scenario filter, silence is expected.
    const active = new Set(currentMachines.map((r) => r.value as string));
    const quietMachines = f.ip || f.scenario || f.country || f.network || f.target ? [] : [...previousMachines]
      .filter(([value]) => value && !active.has(value))
      .map(([value, { label, n }]) => ({ value, label: label || value, previous: n }))
      .sort((a, b) => b.previous - a.previous || a.value.localeCompare(b.value)).slice(0, f.limit);

    const scenarios = all(`SELECT scenario AS label, SUM(CASE WHEN kind = 'alert' THEN count ELSE 0 END) AS count,
        COUNT(DISTINCT CASE WHEN kind = 'alert' AND ${SINGLE_IP} THEN ip END) AS uniqueIPs,
        COUNT(DISTINCT CASE WHEN kind = 'alert' AND machine != '' THEN machine END) AS machines,
        SUM(CASE WHEN ${isBan} THEN count ELSE 0 END) AS bans,
        COUNT(DISTINCT CASE WHEN ${isBan} AND ${SINGLE_IP} THEN ip END) AS bannedIPs
      FROM cells WHERE kind IN ('alert', 'ban') AND scenario != '' AND ${where}
      GROUP BY scenario HAVING count > 0 ORDER BY count DESC, label LIMIT ${f.limit}`)
      .map((row) => ({ ...row, previous: compare ? previousScenarios.get(row.label) || 0 : null }));

    const relevant = spans.filter((span) => scopes.includes(span.instance));
    return {
      lastSuccess: this.metadata('lastSuccess'),
      filters: f, revision: Number(this.metadata('revision') || 0),
      coverage: { from: relevant.length ? [relevant.map((s) => s.start).sort()[0], `${cutoff}T00:00:00.000Z`].sort().at(-1)! : null,
        through: scopes.every((i) => spansByInstance.get(i)?.length) ? scopes.map((i) => spansByInstance.get(i)!.map((s) => s.through).sort().at(-1)!).sort()[0] : null,
        partial: dates.some((date) => !covered(date)) || relevant.some((s) => s.start > `${f.from}T00:00:00.000Z` && day(s.start) === f.from), comparisonPartial },
      totals: { alerts: Number(totals.alerts), events: Number(totals.events), bans: sum('ban', `ip != '' AND ${where}${banFilter}`), decisions: sum('issued'), ...attackers },
      previousTotals,
      attackers: ranking('ip'), machines: ranking('machine'), series, granularity, scenarios,
      // Like the dashboard cards, top lists skip alerts without a known value.
      countries: list('country', 'alert', "country != '' AND upper(country) != 'UNKNOWN' AND "),
      targets: list('target', 'alert', "target NOT IN ('', 'Unknown', 'N/A') AND "),
      networks: list('network', 'alert', "network NOT IN ('', 'Unknown') AND "),
      decisionTypes: list('type', 'issued'), decisionOrigins: list('origin', 'issued'), increases, decreases, quietMachines,
    };
  }
}
