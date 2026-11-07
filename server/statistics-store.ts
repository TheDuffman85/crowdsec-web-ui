import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { normalizeMachineId } from '../shared/machine';
import { statisticsCutoff, type StatisticsFilters, type StatisticsRanking, type StatisticsResponse } from '../shared/statistics';
import type { StatisticsOutboxRow } from './statistics-capture';

interface Observation {
  kind: 'alert' | 'decision'; at: string; instance: string;
  ip?: string; country?: string; asn?: string; network?: string;
  machineId?: string; machineName?: string; scenario?: string;
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
  if (observation.kind === 'alert') observation.events = value[12];
  else Object.assign(observation, { alertAt: value[12], alertSimulated: value[13], type: value[14], origin: value[15], alertIdentity: value[16] });
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
const text = (value: unknown): string => typeof value === 'string' ? value : '';

export function canonicalStatisticsIP(value: unknown): string {
  if (typeof value !== 'string' || !isIP(value)) return '';
  try { return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value; }
  catch { return ''; }
}

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
      CREATE TABLE IF NOT EXISTS cells (
        key BLOB PRIMARY KEY, kind TEXT NOT NULL, day TEXT NOT NULL,
        instance TEXT NOT NULL, simulated INTEGER NOT NULL, alert_simulated INTEGER NOT NULL,
        ip TEXT NOT NULL, machine TEXT NOT NULL, machine_id TEXT NOT NULL, machine_name TEXT NOT NULL,
        scenario TEXT NOT NULL, country TEXT NOT NULL, asn TEXT NOT NULL, network TEXT NOT NULL,
        type TEXT NOT NULL, origin TEXT NOT NULL,
        count INTEGER NOT NULL, events INTEGER NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL,
        hours TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_statistics_cells_date ON cells(kind, day, instance);
      CREATE INDEX IF NOT EXISTS idx_statistics_cells_expiry ON cells(day);
      CREATE INDEX IF NOT EXISTS idx_statistics_cells_ip ON cells(ip, kind, day);
      CREATE INDEX IF NOT EXISTS idx_statistics_cells_machine ON cells(machine, kind, day);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS coverage (
        epoch TEXT NOT NULL, instance TEXT NOT NULL, start TEXT NOT NULL, through TEXT,
        PRIMARY KEY(epoch, instance)
      ) WITHOUT ROWID;
    `);
    if (!(this.db.prepare('PRAGMA table_info(seen)').all() as Array<{ name: string }>).some((column) => column.name === 'cell_key')) this.db.exec('ALTER TABLE seen ADD COLUMN cell_key BLOB');
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
    const getCell = this.db.prepare('SELECT hours FROM cells WHERE key = ?');
    const getParent = this.db.prepare('SELECT c.* FROM seen s JOIN cells c ON c.key = s.cell_key WHERE s.identity = ?');
    const linkParent = this.db.prepare('UPDATE seen SET cell_key = ? WHERE identity = ?');
    const upsert = this.db.prepare(`INSERT INTO cells VALUES (${Array(21).fill('?').join(',')})
      ON CONFLICT(key) DO UPDATE SET count = count + excluded.count, events = events + excluded.events,
        first_at = min(first_at, excluded.first_at), last_at = max(last_at, excluded.last_at), hours = excluded.hours`);
    const putMeta = this.db.prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)');
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
            scenario: parent.scenario, country: parent.country, asn: parent.asn, network: parent.network,
            alertAt: `${parent.day}T00:00:00.000Z`, alertSimulated: parent.simulated });
        }
        const ip = canonicalStatisticsIP(o.ip);
        const machineId = normalizeMachineId(o.machineId) || normalizeMachineId(o.machineName) || '';
        const machine = machineId ? JSON.stringify([o.instance, machineId]) : '';
        const add = (kind: string, at: string) => {
          if (!withinRetention(at)) return null;
          const dims = [kind, day(at), o.instance, o.simulated ? 1 : 0, o.alertSimulated ? 1 : 0,
            ip, machine, machineId, text(o.machineName) || machineId, text(o.scenario), text(o.country),
            o.asn == null ? '' : String(o.asn), text(o.network), kind === 'alert' ? '' : text(o.type) || 'ban', kind === 'alert' ? '' : text(o.origin)];
          const key = digest(JSON.stringify(dims));
          const stored = kind === 'alert' ? getCell.get(key) : null;
          const hours = stored ? JSON.parse(stored.hours) as Record<string, number> : {};
          if (kind === 'alert') { const hour = String(new Date(at).getUTCHours()); hours[hour] = (hours[hour] || 0) + 1; }
          const events = kind === 'alert' && Number.isSafeInteger(o.events) && Number(o.events) >= 0 ? Number(o.events) : 0;
          upsert.run(key, ...dims, 1, events, at, at, JSON.stringify(hours));
          return key;
        };
        if (o.kind === 'alert') {
          const cell = add('alert', o.at);
          if (cell) linkParent.run(cell, digest(row.identity));
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
      const revision = Number(this.metadata('revision') || 0) + 1;
      putMeta.run('revision', String(revision));
      if (context.caughtUp) putMeta.run('lastSuccess', context.now);
    })();
    return { revision: Number(this.metadata('revision')), lastSuccess: this.metadata('lastSuccess') };
  }

  prune(cutoff: string): void {
    this.db.transaction(() => {
      // Each table is bounded independently; subsequent maintenance ticks resume.
      this.db.prepare('DELETE FROM cells WHERE key IN (SELECT key FROM cells WHERE day < ? LIMIT 500)').run(cutoff);
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

  private read(f: StatisticsFilters, retentionDays: number, instances: string[], now: number, freshnessMs: number): StoredStatistics {
    const cutoff = statisticsCutoff(retentionDays, now);
    const start = f.from > cutoff ? f.from : cutoff;
    const conditions = ['day >= ?', 'day BETWEEN ? AND ?'];
    const params: unknown[] = [cutoff, start, f.to];
    if (f.instance !== 'all') { conditions.push('instance = ?'); params.push(f.instance); }
    else if (instances.length) { conditions.push(`instance IN (${instances.map(() => '?').join(',')})`); params.push(...instances); }
    else conditions.push('0');
    if (f.simulation !== 'all') { conditions.push('simulated = ?'); params.push(f.simulation === 'simulated' ? 1 : 0); }
    if (f.ip) { conditions.push('ip = ?'); params.push(canonicalStatisticsIP(f.ip)); }
    if (f.machine) { conditions.push('machine = ?'); params.push(f.machine); }
    const where = conditions.join(' AND ');
    const all = (sql: string, args: unknown[] = params): any[] => this.db.prepare(sql).all(...args);
    const get = (sql: string, args: unknown[] = params): any => this.db.prepare(sql).get(...args);
    const bansWhere = `${where}${f.simulation === 'all' ? '' : ` AND alert_simulated = ${f.simulation === 'simulated' ? 1 : 0}`}`;
    const sum = (kind: string, condition = where): number => Number(get(`SELECT COALESCE(SUM(count), 0) AS n FROM cells WHERE kind = '${kind}' AND ${condition}`).n);
    const list = (field: string, kind = 'alert') => all(`SELECT COALESCE(NULLIF(${field}, ''), 'Unknown') AS label, SUM(count) AS count
      FROM cells WHERE kind = '${kind}' AND ${where} GROUP BY ${field} ORDER BY count DESC, label LIMIT ${f.limit}`);
    const ranking = (field: 'ip' | 'machine'): StatisticsRanking[] => {
      const ranked = all(`SELECT ${field} AS value, MAX(${field === 'machine' ? "COALESCE(NULLIF(machine_name, ''), machine_id)" : 'ip'}) AS label,
        MAX(instance) AS instance, MAX(machine_id) AS machineId, SUM(count) AS alerts, SUM(events) AS events,
        COUNT(DISTINCT NULLIF(ip, '')) AS uniqueIPs, COUNT(DISTINCT NULLIF(machine, '')) AS machines,
        COUNT(DISTINCT day) AS activeDays, MIN(first_at) AS firstActivity, MAX(last_at) AS lastActivity,
        MAX(country) AS country, MAX(asn) AS asn, MAX(network) AS network
        FROM cells WHERE kind = 'alert' AND ${field} != '' AND ${where}
        GROUP BY ${field} ORDER BY alerts DESC, value LIMIT ${f.limit}`);
      if (!ranked.length) return [];
      // Details for all ranked values are fetched with one grouped query each
      // instead of one query per ranked row.
      const values = ranked.map((row) => row.value as string);
      const placeholders = values.map(() => '?').join(',');
      const scoped = `${where} AND ${field} IN (${placeholders})`;
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
        FROM cells WHERE kind = 'alert' AND ${scoped}) WHERE position = 1`, args).map((row) => [row.owner, row]));
      const bans = new Map(all(`SELECT ${field} AS owner, SUM(count) AS n FROM cells
        WHERE kind = 'ban' AND ${bansWhere} AND ${field} IN (${placeholders}) GROUP BY ${field}`, args).map((row) => [row.owner, Number(row.n)]));
      const scenarios = byOwner<{ label: string; count: number }>(all(`SELECT owner, label, count FROM (
        SELECT ${field} AS owner, COALESCE(NULLIF(scenario, ''), 'Unknown') AS label, SUM(count) AS count,
          ROW_NUMBER() OVER (PARTITION BY ${field} ORDER BY SUM(count) DESC, COALESCE(NULLIF(scenario, ''), 'Unknown')) AS position
        FROM cells WHERE kind = 'alert' AND ${scoped} GROUP BY ${field}, scenario) WHERE position <= 3 ORDER BY owner, position`, args));
      const targetedMachines = byOwner<{ value: string; label: string; count: number }>(all(`SELECT owner, value, label, count FROM (
        SELECT ${field} AS owner, machine AS value, MAX(machine_name) AS label, SUM(count) AS count,
          ROW_NUMBER() OVER (PARTITION BY ${field} ORDER BY SUM(count) DESC, machine) AS position
        FROM cells WHERE kind = 'alert' AND machine != '' AND ${scoped} GROUP BY ${field}, machine) WHERE position <= 3 ORDER BY owner, position`, args));
      return ranked.map((row) => {
        const top = latest.get(row.value);
        return {
          ...row, country: top.country, asn: top.asn, network: top.network,
          ...(field === 'machine' ? { label: top.machine_name || row.machineId } : {}),
          bans: bans.get(row.value) || 0,
          scenarios: scenarios.get(row.value) || [],
          targetedMachines: targetedMachines.get(row.value) || [],
        };
      });
    };
    const totals = get(`SELECT COALESCE(SUM(count), 0) AS alerts, COALESCE(SUM(events), 0) AS events,
      COUNT(DISTINCT NULLIF(ip, '')) AS uniqueIPs FROM cells WHERE kind = 'alert' AND ${where}`);
    const repeatAttackers = Number(get(`SELECT COUNT(*) AS n FROM (SELECT ip FROM cells WHERE kind = 'alert' AND ip != '' AND ${where} GROUP BY ip HAVING COUNT(DISTINCT day) > 1)`).n);
    const hours = Array<number>(24).fill(0);
    const weekdays = Array<number>(7).fill(0);
    // Aggregate histograms in SQLite to avoid transferring every relationship.
    for (const row of all(`SELECT j.key AS hour, SUM(j.value) AS n FROM cells, json_each(cells.hours) j WHERE kind = 'alert' AND ${where} GROUP BY j.key`)) hours[Number(row.hour)] = row.n;
    for (const row of all(`SELECT strftime('%w', day) AS weekday, SUM(count) AS n FROM cells WHERE kind = 'alert' AND ${where} GROUP BY weekday`)) weekdays[Number(row.weekday)] = row.n;
    const daily = new Map<string, { alerts: number; decisions: number }>();
    for (const row of all(`SELECT day, SUM(CASE WHEN kind = 'alert' THEN count ELSE 0 END) AS alerts,
      SUM(CASE WHEN kind = 'issued' THEN count ELSE 0 END) AS decisions FROM cells WHERE kind IN ('alert', 'issued') AND ${where} GROUP BY day`)) daily.set(row.day, row);
    const scopes = f.instance === 'all' ? instances : [f.instance];
    const spans = this.db.prepare('SELECT instance, start, through FROM coverage WHERE through IS NOT NULL AND through >= ?').all(cutoff) as Array<{ instance: string; start: string; through: string }>;
    const spansByInstance = new Map(scopes.map((instance) => [instance, spans.filter((s) => s.instance === instance).sort((a, b) => a.start.localeCompare(b.start))]));
    // Coverage written by a job that ran within the expected schedule reaches
    // the present: the time since that job is pending, not missing.
    const nowIso = new Date(now).toISOString();
    const freshSince = new Date(now - freshnessMs).toISOString();
    const reach = (through: string) => (through >= freshSince && through < nowIso ? nowIso : through);
    const covered = (date: string): boolean => {
      if (date < cutoff || !scopes.length) return false;
      const start = `${date}T00:00:00.000Z`;
      const end = new Date(Math.min(Date.parse(date) + 86_400_000, now)).toISOString();
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
    const series: StoredStatistics['series'] = [];
    const days = Math.round((Date.parse(f.to) - Date.parse(f.from)) / 86_400_000) + 1;
    const previousFrom = new Date(Date.parse(f.from) - days * 86_400_000).toISOString().slice(0, 10);
    const previousTo = new Date(Date.parse(f.from) - 86_400_000).toISOString().slice(0, 10);
    for (let stamp = Date.parse(f.from); stamp <= Date.parse(f.to); stamp += 86_400_000) {
      const date = new Date(stamp).toISOString().slice(0, 10);
      const counts = daily.get(date);
      series.push({ date, alerts: counts?.alerts ?? (covered(date) ? 0 : null), decisions: counts?.decisions ?? (covered(date) ? 0 : null) });
    }
    const previousParams = [...params]; previousParams[1] = previousFrom; previousParams[2] = previousTo;
    const previous = new Map(all(`SELECT machine, MAX(machine_name) AS label, SUM(count) AS n FROM cells WHERE kind = 'alert' AND ${where} GROUP BY machine`, previousParams).map((r) => [r.machine, r.n as number]));
    const increases = all(`SELECT machine AS value, MAX(machine_name) AS label, SUM(count) AS current FROM cells WHERE kind = 'alert' AND machine != '' AND ${where} GROUP BY machine`)
      .map((r) => ({ ...r, previous: previous.get(r.value) || 0, change: r.current - (previous.get(r.value) || 0) }))
      .filter((r) => r.change > 0).sort((a, b) => b.change - a.change || a.value.localeCompare(b.value)).slice(0, f.limit);
    const relevant = spans.filter((span) => scopes.includes(span.instance));
    let comparisonPartial = previousFrom < cutoff;
    for (let stamp = Date.parse(previousFrom); stamp <= Date.parse(previousTo); stamp += 86_400_000) comparisonPartial ||= !covered(new Date(stamp).toISOString().slice(0, 10));
    return {
      lastSuccess: this.metadata('lastSuccess'),
      filters: f, revision: Number(this.metadata('revision') || 0),
      coverage: { from: relevant.length ? [relevant.map((s) => s.start).sort()[0], `${cutoff}T00:00:00.000Z`].sort().at(-1)! : null,
        through: scopes.every((i) => spansByInstance.get(i)?.length) ? scopes.map((i) => spansByInstance.get(i)!.map((s) => s.through).sort().at(-1)!).sort()[0] : null,
        partial: series.some((s) => !covered(s.date)) || relevant.some((s) => s.start > `${f.from}T00:00:00.000Z` && day(s.start) === f.from), comparisonPartial },
      totals: { ...totals, bans: sum('ban', bansWhere), decisions: sum('issued'), repeatAttackers },
      attackers: ranking('ip'), machines: ranking('machine'), series,
      scenarios: list('scenario'), countries: list('country'), networks: list("COALESCE(NULLIF(network, ''), NULLIF(asn, ''))"),
      decisionTypes: list('type', 'issued'), decisionOrigins: list('origin', 'issued'), hours, weekdays, increases,
    };
  }
}
