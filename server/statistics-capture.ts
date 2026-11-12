// The outbox belongs to cache.db so capture commits or rolls back with the
// source mutation. It has no foreign keys: deleting an alert must not erase it.
export function initStatisticsCaptureSchema(db: any): void {
  for (const table of ['alerts', 'decisions']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'statistics_captured')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN statistics_captured INTEGER NOT NULL DEFAULT 0`);
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS statistics_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    identity TEXT NOT NULL UNIQUE,
    day TEXT NOT NULL,
    payload TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_statistics_outbox_day ON statistics_outbox(day)`);
}

const alertIdentity = (row: string) => `json_array('alert', ${row}.instance_id, CASE WHEN ${row}.uuid IS NOT NULL AND ${row}.uuid != ${row}.upstream_id THEN json_array('uuid', ${row}.uuid) ELSE json_array('id', ${row}.upstream_id, ${row}.created_at) END)`;
// Decisions only use columns of their own row so the identity does not depend on
// whether the parent alert is cached when the decision is captured.
const decisionIdentity = (row: string) => `json_array('decision', ${row}.instance_id, ${row}.upstream_id, ${row}.alert_upstream_id, ${row}.created_at)`;

// Versioned tuples avoid repeating field names in the transient journal.
const alertPayload = (row: string) => `json_array(1, 'a',
  ${row}.created_at, ${row}.instance_id, ${row}.source_ip, ${row}.country, ${row}.source_as_number,
  ${row}.as_name, ${row}.machine_id, ${row}.machine, ${row}.scenario, ${row}.simulated, ${row}.events_count, ${row}.target
)`;

const decisionPayload = (row: string) => `json_array(1, 'd',
  ${row}.created_at, ${row}.instance_id, a.source_ip, a.country, a.source_as_number,
  a.as_name, a.machine_id, a.machine, a.scenario, ${row}.simulated,
  a.created_at, a.simulated, COALESCE(${row}.type, 'ban'), ${row}.origin, ${alertIdentity('a')}, a.target
)`;

export function configureStatisticsCapture(db: any, enabled: boolean): void {
  db.transaction(() => {
    const wasEnabled = db.prepare("SELECT value FROM meta WHERE key = 'statistics_capture_enabled'").get()?.value === 'true';
    for (const table of ['alerts', 'decisions']) {
      for (const event of ['insert', 'update', 'delete']) db.exec(`DROP TRIGGER IF EXISTS statistics_${table}_${event}`);
    }
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('statistics_capture_enabled', ?)").run(String(enabled));
    db.exec('DROP TRIGGER IF EXISTS statistics_alerts_children_delete');
    if (!enabled) return;
    db.exec(`CREATE TRIGGER statistics_alerts_children_delete BEFORE DELETE ON alerts BEGIN
      UPDATE decisions SET statistics_captured = 1 WHERE alert_id = OLD.id AND statistics_captured = 0;
    END`);
    for (const table of ['alerts', 'decisions']) {
      // Rows written while capture was off are unflagged and need a rescan.
      // Restarting with capture already on must resume the existing cursor.
      if (!wasEnabled) db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(`statistics_backfill_${table}`, '0');
      const alert = table === 'alerts';
      // Emission happens exactly once per row: the first change of an
      // uncaptured row (insert, sync update, backfill touch or parent delete)
      // emits it and flags it. Recursive triggers are off, so the flag update
      // in the UPDATE trigger does not fire that trigger again.
      db.exec(`CREATE TRIGGER statistics_${table}_insert AFTER INSERT ON ${table} WHEN NEW.statistics_captured = 0 BEGIN
        UPDATE ${table} SET statistics_captured = 1 WHERE rowid = NEW.rowid;
      END`);
      for (const event of ['update', 'delete']) {
        const row = event === 'delete' ? 'OLD' : 'NEW';
        const identity = alert ? alertIdentity(row) : decisionIdentity(row);
        const select = alert
          ? `SELECT ${identity}, substr(${row}.created_at, 1, 10), ${alertPayload(row)}`
          : `SELECT ${identity}, max(substr(${row}.created_at, 1, 10), COALESCE(substr(a.created_at, 1, 10), '')), ${decisionPayload(row)}
             FROM (SELECT 1) LEFT JOIN alerts a ON a.id = ${row}.alert_id AND a.instance_id = ${row}.instance_id`;
        db.exec(`CREATE TRIGGER statistics_${table}_${event}
          ${event === 'delete' ? 'BEFORE' : 'AFTER'} ${event.toUpperCase()} ON ${table}
          WHEN OLD.statistics_captured = 0
          BEGIN
            ${alert ? '' : `INSERT INTO statistics_outbox(identity, day, payload) SELECT ${alertIdentity('a')}, substr(a.created_at, 1, 10), ${alertPayload('a')} FROM alerts a WHERE a.id = ${row}.alert_id AND a.instance_id = ${row}.instance_id AND a.statistics_captured = 0 ON CONFLICT(identity) DO NOTHING;`}
            INSERT INTO statistics_outbox(identity, day, payload) ${select} WHERE 1 ON CONFLICT(identity) DO NOTHING;
            ${event === 'update' ? `UPDATE ${table} SET statistics_captured = 1 WHERE rowid = NEW.rowid AND statistics_captured = 0;` : ''}
          END`);
      }
    }
  })();
}

const BACKFILL_DONE = 'done';

/**
 * Forgets every captured observation: pending ones are dropped and all cached
 * rows become uncaptured again, so enabled collection backfills them anew.
 */
export function resetStatisticsCapture(db: any): void {
  db.transaction(() => {
    db.exec('DELETE FROM statistics_outbox');
    for (const table of ['alerts', 'decisions']) {
      // The update triggers only fire for uncaptured rows, so this emits nothing.
      db.exec(`UPDATE ${table} SET statistics_captured = 0 WHERE statistics_captured != 0`);
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(`statistics_backfill_${table}`, '0');
    }
  })();
}

export interface StatisticsOutboxRow { seq: number; identity: string; day: string; payload: string }

export function readStatisticsBatch(db: any, backfill: boolean, limit = 500): {
  rows: StatisticsOutboxRow[]; backlog: number; backfillPending: boolean; coverageFrom: Record<string, string>;
} {
  let backfillPending = false;
  const coverageFrom: Record<string, string> = {};
  if (backfill) {
    db.transaction(() => {
      for (const table of ['decisions', 'alerts']) {
        const key = `statistics_backfill_${table}`;
        const stored = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
        // Once a scan reaches the end, triggers capture every later row, so
        // later batches skip the scan until capture is re-enabled or reset.
        if (stored === BACKFILL_DONE) continue;
        const cursor = Number(stored || 0);
        // Decisions are captured first while their owning alerts still exist.
        const rows = db.prepare(`SELECT rowid AS rid, instance_id, created_at, statistics_captured FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`).all(cursor, Math.floor(limit / 2)) as Array<{ rid: number; instance_id: string; created_at: string; statistics_captured: number }>;
        const touch = db.prepare(`UPDATE ${table} SET statistics_captured = 1 WHERE rowid = ? AND statistics_captured = 0`);
        for (const row of rows) {
          if (!row.statistics_captured) touch.run(row.rid);
          const previous = coverageFrom[row.instance_id];
          if (!previous || row.created_at < previous) coverageFrom[row.instance_id] = row.created_at;
        }
        const last = rows.at(-1)?.rid ?? cursor;
        const more = Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE rowid > ? LIMIT 1`).get(last));
        if (rows.length || !more) db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, more ? String(last) : BACKFILL_DONE);
        backfillPending ||= more;
      }
    })();
  }
  return {
    rows: db.prepare('SELECT seq, identity, day, payload FROM statistics_outbox ORDER BY seq LIMIT ?').all(limit),
    backlog: Number(db.prepare('SELECT COUNT(*) AS n FROM statistics_outbox').get().n),
    backfillPending, coverageFrom,
  };
}

export interface StatisticsPendingBound {
  /** Earliest UTC day the scanned observations add to, or null when none was scanned. */
  day: string | null;
  /** Highest outbox sequence ever assigned; rows above it were not scanned. */
  seq: number;
}

/**
 * Earliest UTC day that pending observations after `afterSeq` still add to. A
 * decision also counts on its alert's day, which can be earlier than the outbox
 * `day` (the later of both, kept for retention). Sequences only grow, so callers
 * can extend a bound with the rows captured since they last scanned.
 */
export function statisticsPendingFrom(db: any, afterSeq = 0): StatisticsPendingBound {
  // One statement reads both from the same snapshot.
  const row = db.prepare(`SELECT
      (SELECT MIN(min(day, substr(json_extract(payload, '$[2]'), 1, 10),
        CASE WHEN json_extract(payload, '$[1]') = 'd' THEN COALESCE(substr(json_extract(payload, '$[12]'), 1, 10), day) ELSE day END))
        FROM statistics_outbox WHERE seq > ?) AS day,
      (SELECT seq FROM sqlite_sequence WHERE name = 'statistics_outbox') AS seq`).get(afterSeq) as { day: string | null; seq: number | null };
  return { day: row.day, seq: Math.max(afterSeq, Number(row.seq) || 0) };
}

export function acknowledgeStatisticsBatch(db: any, ids: number[], cutoff: string): boolean {
  return db.transaction(() => {
    const remove = db.prepare('DELETE FROM statistics_outbox WHERE seq = ?');
    for (const id of ids) remove.run(id);
    // Bound maintenance work just like capture and acknowledgement.
    db.prepare('DELETE FROM statistics_outbox WHERE seq IN (SELECT seq FROM statistics_outbox WHERE day < ? LIMIT 500)').run(cutoff);
    return Boolean(db.prepare('SELECT 1 FROM statistics_outbox WHERE day < ? LIMIT 1').get(cutoff));
  })();
}
