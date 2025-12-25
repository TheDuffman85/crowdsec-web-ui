const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Database path calculation
const DB_DIR = process.env.DB_DIR || '/app/data';
let dbPath = path.join(DB_DIR, 'crowdsec.db');

// Ensure directory exists
if (!fs.existsSync(DB_DIR)) {
  try {
    fs.mkdirSync(DB_DIR, { recursive: true });
    console.log(`Created database directory: ${DB_DIR}`);
  } catch (err) {
    console.error(`Failed to create database directory ${DB_DIR}. Falling back to local file.`);
    // Fallback to local file in current directory
    dbPath = path.join(__dirname, 'crowdsec.db');
  }
}

// Initialize Database
let db;
try {
  console.log(`Opening SQLite database at ${dbPath}...`);
  db = new Database(dbPath, { verbose: null }); // Set verbose: console.log for debugging
  db.pragma('journal_mode = WAL');
  console.log('Database opened successfully.');
} catch (error) {
  console.error('Failed to open database:', error);
  // If we can't open the DB, we might want to exit or fallback to memory (but memory is what we are moving away from)
  // For now, let's treat it as fatal or fallback to ./crowdsec.db if permission denied on /app/data
  if (DB_DIR === '/app/data' && error.code === 'EACCES') {
    console.warn('Permission denied for /app/data. Falling back to ./crowdsec.db');
    db = new Database('crowdsec.db');
  } else {
    throw error;
  }
}

// Initialize Schema
function initSchema() {
  const createAlertsTable = `
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY,
      uuid TEXT UNIQUE, -- Some alerts use string IDs
      created_at TEXT NOT NULL,
      scenario TEXT,
      source_ip TEXT, 
      message TEXT,
      raw_data TEXT -- JSON Stringified full alert object
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at);
  `;

  const createDecisionsTable = `
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY,
      uuid TEXT UNIQUE,
      alert_id INTEGER,
      created_at TEXT NOT NULL,
      stop_at TEXT NOT NULL,
      value TEXT,
      type TEXT,
      origin TEXT,
      scenario TEXT,
      raw_data TEXT -- JSON Stringified full decision object
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_stop_at ON decisions(stop_at);
    CREATE INDEX IF NOT EXISTS idx_decisions_alert_id ON decisions(alert_id);
  `;

  const createMetaTable = `
    CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
    );
  `;

  db.exec(createAlertsTable);
  db.exec(createDecisionsTable);
  db.exec(createMetaTable);
  console.log('Database schema initialized.');
}

// Run schema init on load
initSchema();

// --- Prepared Statements ---

// Alerts
const insertAlert = db.prepare(`
  INSERT OR REPLACE INTO alerts (id, uuid, created_at, scenario, source_ip, message, raw_data)
  VALUES (@id, @uuid, @created_at, @scenario, @source_ip, @message, @raw_data)
`);

const getAlerts = db.prepare(`
  SELECT raw_data FROM alerts 
  WHERE created_at >= @since 
  ORDER BY created_at DESC
  LIMIT @limit
`);

const countAlerts = db.prepare('SELECT COUNT(*) as count FROM alerts');

const deleteOldAlerts = db.prepare('DELETE FROM alerts WHERE created_at < @cutoff');

// Decisions
const insertDecision = db.prepare(`
  INSERT OR REPLACE INTO decisions (id, uuid, alert_id, created_at, stop_at, value, type, origin, scenario, raw_data)
  VALUES (@id, @uuid, @alert_id, @created_at, @stop_at, @value, @type, @origin, @scenario, @raw_data)
`);

const getActiveDecisions = db.prepare(`
  SELECT raw_data, created_at FROM decisions 
  WHERE stop_at > @now
  ORDER BY stop_at DESC
  LIMIT @limit
`);

// For "decisionsForStats" we might want all decisions within lookback, active or not
const getDecisionsSince = db.prepare(`
    SELECT raw_data, created_at FROM decisions
    WHERE created_at >= @since
    ORDER BY stop_at DESC
`);

const deleteOldDecisions = db.prepare('DELETE FROM decisions WHERE stop_at < @cutoff');
const deleteDecision = db.prepare('DELETE FROM decisions WHERE id = @id');
const deleteAlert = db.prepare('DELETE FROM alerts WHERE id = @id');
const deleteDecisionsByAlertId = db.prepare('DELETE FROM decisions WHERE alert_id = @alert_id');

// Bulk delete for reconciliation
// We can't easily prepare a variable list IN clause in better-sqlite3 without generating the string
// So we'll expose a helper for it or just iterate in a transaction

// Meta
const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');

const transaction = (cb) => db.transaction(cb);

module.exports = {
  db,
  insertAlert,
  getAlerts,
  countAlerts,
  deleteOldAlerts,
  insertDecision,
  getActiveDecisions,
  getDecisionsSince,
  deleteOldDecisions,
  deleteDecision,
  deleteAlert,
  deleteDecisionsByAlertId,
  transaction,
  getMeta,
  setMeta
};
