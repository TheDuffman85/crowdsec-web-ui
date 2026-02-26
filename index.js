import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { serveStatic } from 'hono/bun';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from './sqlite.js';
import {
  fetchLAPI,
  login as loginToLAPI,
  fetchAlerts as fetchAlertsFromLAPI,
  getAlertById,
  addDecision,
  deleteDecision,
  deleteAlert,
  getLapiStatus,
  updateLapiStatus,
  hasCredentials,
  hasToken,
  CROWDSEC_URL,
  CROWDSEC_LOOKBACK_PERIOD
} from './lapi.js';

// ESM replacement for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// BASE_PATH for reverse proxy deployments (e.g., /crowdsec)
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');

// ============================================================================
// CONSOLE LOGGING OVERRIDES (Add Timestamps)
// ============================================================================
const originalLog = console.log;
const originalError = console.error;

console.log = function (...args) {
  const timestamp = new Date().toISOString();
  originalLog.apply(console, [`[${timestamp}]`, ...args]);
};

console.error = function (...args) {
  const timestamp = new Date().toISOString();
  originalError.apply(console, [`[${timestamp}]`, ...args]);
};

// Persist refresh interval to database (meta table)
// Database is initialized via import

function loadPersistedConfig() {
  try {
    const intervalMsRow = db.getMeta.get('refresh_interval_ms');
    if (intervalMsRow && intervalMsRow.value !== undefined) {
      const config = {
        refresh_interval_ms: parseInt(intervalMsRow.value, 10)
      };
      console.log('Loaded persisted config from database:', config);
      return config;
    }
  } catch (error) {
    console.error('Error loading config from database:', error.message);
  }
  return {};
}

function savePersistedConfig(config) {
  try {
    if (config.refresh_interval_ms !== undefined) {
      db.setMeta.run('refresh_interval_ms', String(config.refresh_interval_ms));
    }
    if (config.refresh_interval_name !== undefined) {
      db.setMeta.run('refresh_interval_name', config.refresh_interval_name);
    }
    console.log('Saved config to database:', config);
  } catch (error) {
    console.error('Error saving config to database:', error.message);
  }
}

const app = new Hono();
app.use('*', compress());
// CORS disabled — the app is designed to run behind a reverse proxy on the same origin.
// Enabling cors() with wildcard would allow any website to make cross-origin requests.

// Security headers
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
});

const port = process.env.PORT || 3000;

if (!hasCredentials()) {
  console.warn('WARNING: CROWDSEC_USER and CROWDSEC_PASSWORD must be set for full functionality.');
}


// Historical Sync Status Tracker
const syncStatus = {
  isSyncing: false,
  progress: 0, // 0-100 percentage
  message: '',
  startedAt: null,
  completedAt: null
};

// Track first sync after startup - show overlay on every startup/restart
let isFirstSync = true;

function updateSyncStatus(updates) {
  Object.assign(syncStatus, updates);
}

// ============================================================================
// CACHE SYSTEM (SQLite Backed)
// ============================================================================

// Cache initialization state
const cache = {
  isInitialized: false,
  lastUpdate: null
};

// Synchronization lock for cache initialization
let initializationPromise = null;

// Parse lookback period to milliseconds
function parseLookbackToMs(lookbackPeriod) {
  const match = lookbackPeriod.match(/^(\d+)([hmd])$/);
  if (!match) return 7 * 24 * 60 * 60 * 1000; // Default 7 days

  const val = parseInt(match[1]);
  const unit = match[2];

  if (unit === 'h') return val * 60 * 60 * 1000;
  if (unit === 'd') return val * 24 * 60 * 60 * 1000;
  if (unit === 'm') return val * 60 * 1000;

  return 7 * 24 * 60 * 60 * 1000; // Default 7 days
}

// Parse refresh interval to milliseconds
// Parse refresh interval to milliseconds
function parseRefreshInterval(intervalStr) {
  if (!intervalStr) return 0;
  const str = intervalStr.toLowerCase();

  // Specific keywords
  if (str === 'manual' || str === '0') return 0;

  // Generic parsing
  const match = str.match(/^(\d+)([smhd])$/);
  if (match) {
    const val = parseInt(match[1]);
    const unit = match[2];
    if (unit === 's') return val * 1000;
    if (unit === 'm') return val * 60 * 1000;
    if (unit === 'h') return val * 60 * 60 * 1000;
    if (unit === 'd') return val * 24 * 60 * 60 * 1000;
  }

  // Fallback for hardcoded values if regex somehow fails or for back-compat
  switch (str) {
    case '5s': return 5000;
    case '30s': return 30000;
    case '1m': return 60000;
    case '5m': return 300000;
    default: return 0;
  }
}

const LOOKBACK_MS = parseLookbackToMs(CROWDSEC_LOOKBACK_PERIOD);

// Load persisted config (overrides env var if previously changed by user)
const persistedConfig = loadPersistedConfig();
let REFRESH_INTERVAL_MS = persistedConfig.refresh_interval_ms !== undefined
  ? persistedConfig.refresh_interval_ms
  : parseRefreshInterval(process.env.CROWDSEC_REFRESH_INTERVAL || '30s');
let refreshTimer = null; // Track the background refresh interval timer

console.log(`Cache Configuration:
  Lookback Period: ${CROWDSEC_LOOKBACK_PERIOD} (${LOOKBACK_MS}ms)
  Refresh Interval: ${getIntervalName(REFRESH_INTERVAL_MS)} (${persistedConfig.refresh_interval_ms !== undefined ? 'from saved config' : 'from env'})
`);

// Helper to parse Go duration strings (e.g. "1h2m3s") to milliseconds
function parseGoDuration(str) {
  if (!str) return 0;
  let multiplier = 1;
  let s = str.trim();
  if (s.startsWith('-')) {
    multiplier = -1;
    s = s.substring(1);
  }
  const regex = /(\d+)(h|m|s)/g;
  let totalMs = 0;
  let match;
  while ((match = regex.exec(s)) !== null) {
    const val = parseInt(match[1]);
    const unit = match[2];
    if (unit === 'h') totalMs += val * 3600000;
    if (unit === 'm') totalMs += val * 60000;
    if (unit === 's') totalMs += val * 1000;
  }
  return totalMs * multiplier;
}

// Helper to convert a timestamp to a Go-style relative duration from now
// e.g., a timestamp 2 hours ago becomes "2h0m0s"
function toDuration(timestampMs) {
  const now = Date.now();
  const diffMs = now - timestampMs;
  const hours = Math.floor(diffMs / 3600000);
  const minutes = Math.floor((diffMs % 3600000) / 60000);
  const seconds = Math.floor((diffMs % 60000) / 1000);
  return `${hours}h${minutes}m${seconds}s`;
}

/**
 * Helper to extract target from alert events
 * Prioritizes: target_fqdn > target_host > service > scenario_service > machine_alias > machine_id
 * This is the SINGLE SOURCE OF TRUTH for target extraction.
 */
function getAlertTarget(alert) {
  if (!alert) return "Unknown";

  // Try to find target in events
  if (alert.events && Array.isArray(alert.events)) {
    for (const event of alert.events) {
      if (event.meta && Array.isArray(event.meta)) {
        const targetFqdn = event.meta.find(m => m.key === 'target_fqdn')?.value;
        if (targetFqdn) return targetFqdn;

        const targetHost = event.meta.find(m => m.key === 'target_host')?.value;
        if (targetHost) return targetHost;

        const service = event.meta.find(m => m.key === 'service')?.value;
        if (service) return service;
      }
    }
  }

  // Try to extract service name from scenario (e.g., "crowdsecurity/proftpd-bf" -> "proftpd")
  if (alert.scenario) {
    const scenarioParts = alert.scenario.split('/');
    if (scenarioParts.length > 1) {
      // Get the part after the slash (e.g., "proftpd-bf", "ssh-bf", "nginx-http-400")
      const scenarioName = scenarioParts[1];
      // Extract the service name (first part before any dash)
      const serviceName = scenarioName.split('-')[0];
      if (serviceName && serviceName.length > 0) {
        return serviceName;
      }
    }
  }

  // Fallback
  return alert.machine_alias || alert.machine_id || "Unknown";
}

// Helper to process an alert and store in SQLite
function processAlertForDb(alert) {
  if (!alert || !alert.id) return;

  const decisions = alert.decisions || [];

  // Extract source info from alert for country/AS data
  const alertSource = alert.source || {};

  // Pre-compute target using the single helper function
  const target = getAlertTarget(alert);

  // Enrich alert with pre-computed target
  const enrichedAlert = {
    ...alert,
    target: target
  };

  // Insert Alert with pre-computed target parameters prefixed with $
  const alertData = {
    $id: alert.id,
    $uuid: alert.uuid || String(alert.id),
    $created_at: alert.created_at,
    $scenario: alert.scenario,
    $source_ip: alertSource.ip || alertSource.value,
    $message: alert.message || '',
    $raw_data: JSON.stringify(enrichedAlert)
  };

  try {
    db.insertAlert.run(alertData);
  } catch (err) {
    // Ignore duplicate errors (UNIQUE constraint)
    if (!err.message.includes('UNIQUE constraint')) {
      console.error(`Failed to insert alert ${alert.id}:`, err.message);
    }
  }

  // Insert Decisions
  decisions.forEach(decision => {
    if (decision.origin === 'CAPI') return; // Skip CAPI decisions

    // Calculate stop_at from duration if available
    // LAPI provides 'duration' as remaining time for active decisions
    const createdAt = decision.created_at || alert.created_at;
    let stopAt;
    if (decision.duration) {
      const ms = parseGoDuration(decision.duration);
      stopAt = new Date(Date.now() + ms).toISOString();
    } else {
      stopAt = decision.stop_at || createdAt;
    }

    // Enrich decision details from Alert where possible
    const enrichedDecision = {
      ...decision,
      created_at: createdAt,
      stop_at: stopAt,
      scenario: decision.scenario || alert.scenario || 'unknown',
      origin: decision.origin || decision.scenario || alert.scenario || 'unknown',
      alert_id: alert.id,
      value: decision.value || alertSource.ip,
      type: decision.type || 'ban',
      country: alertSource.cn,
      as: alertSource.as_name,
      target: target,
      is_duplicate: false // Real decisions are not duplicates
    };

    const decisionData = {
      $id: String(decision.id),
      $uuid: String(decision.id),
      $alert_id: alert.id,
      $created_at: enrichedDecision.created_at,
      $stop_at: enrichedDecision.stop_at,
      $value: decision.value,
      $type: decision.type,
      $origin: enrichedDecision.origin,
      $scenario: enrichedDecision.scenario,
      $raw_data: JSON.stringify(enrichedDecision)
    };

    try {
      db.insertDecision.run(decisionData);
    } catch (err) {
      console.error(`Failed to insert decision ${decision.id}:`, err.message);
    }
  });

  // NOTE: Alerts with empty decisions array (like AppSec/WAF alerts) do NOT create
  // decision entries. They block traffic directly without creating CrowdSec bans.
}


// Chunked Historical Sync - fetches data in 6-hour chunks with progress updates
async function syncHistory() {
  console.log('Starting historical data sync...');

  // Only show the sync overlay modal on the first sync after startup
  const showOverlay = isFirstSync;
  isFirstSync = false;

  updateSyncStatus({
    isSyncing: showOverlay, // Only true on first sync
    progress: 0,
    message: 'Starting historical data sync...',
    startedAt: new Date().toISOString(),
    completedAt: null
  });

  const now = Date.now();
  const lookbackStart = now - LOOKBACK_MS;
  const chunkSizeMs = 6 * 60 * 60 * 1000; // 6 hours
  const totalDuration = now - lookbackStart;

  let currentStart = lookbackStart;
  let totalAlerts = 0;

  while (currentStart < now) {
    const currentEnd = Math.min(currentStart + chunkSizeMs, now);

    // Calculate progress percentage
    const progress = Math.round(((currentEnd - lookbackStart) / totalDuration) * 100);

    // Convert to relative durations for LAPI
    const sinceDuration = toDuration(currentStart);
    const untilDuration = toDuration(currentEnd);

    const progressMessage = `Syncing: ${sinceDuration} → ${untilDuration} ago (${totalAlerts} alerts)`;
    console.log(progressMessage);
    updateSyncStatus({ progress: Math.min(progress, 90), message: progressMessage });
    try {
      // Fetch alerts for this chunk (bounded by since and until)
      const alerts = await fetchAlertsFromLAPI(sinceDuration, untilDuration);

      if (alerts.length > 0) {
        const insertTransaction = db.transaction((items) => {
          for (const alert of items) {
            try {
              processAlertForDb(alert);
            } catch (e) {
              console.error(`Error processing alert ${alert.id}:`, e);
            }
          }
        });
        insertTransaction(alerts);
        totalAlerts += alerts.length;
        console.log(`  -> Imported ${alerts.length} alerts.`);
      }
    } catch (err) {
      console.error(`Failed to sync chunk:`, err.message);
      // Continue to next chunk to get partial data
    }

    currentStart = currentEnd;

    // Small pause to prevent overwhelming LAPI
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`Historical sync complete. Total imported: ${totalAlerts}`);

  // Sync active decisions at the end
  updateSyncStatus({ progress: 95, message: 'Syncing active decisions...' });

  try {
    const activeDecisionAlerts = await fetchAlertsFromLAPI(null, null, true);
    if (activeDecisionAlerts.length > 0) {
      const refreshTransaction = db.transaction((alerts) => {
        for (const alert of alerts) processAlertForDb(alert);
      });
      refreshTransaction(activeDecisionAlerts);
      console.log(`  -> Synced ${activeDecisionAlerts.length} alerts with active decisions.`);
    }
  } catch (err) {
    console.error('Failed to sync active decisions:', err.message);
  }

  updateSyncStatus({
    isSyncing: false,
    progress: 100,
    message: `Sync complete. ${totalAlerts} alerts imported.`,
    completedAt: new Date().toISOString()
  });

  return totalAlerts;
}

// Initial cache load - uses chunked sync for progress feedback
// Uses synchronization lock to prevent concurrent initialization
async function initializeCache() {
  // If initialization is already in progress, wait for it to complete
  if (initializationPromise) {
    console.log('Cache initialization already in progress, waiting...');
    return initializationPromise;
  }

  // Create a new promise for this initialization
  initializationPromise = (async () => {
    try {
      console.log('Initializing cache with chunked data load...');

      // Use chunked sync for progress tracking
      const totalAlerts = await syncHistory();

      cache.lastUpdate = new Date().toISOString();
      cache.isInitialized = true;

      // Get counts from database
      const alertCount = db.countAlerts.get().count;

      console.log(`Cache initialized successfully:
  - ${alertCount} alerts in database
  - Last update: ${cache.lastUpdate}
`);
      updateLapiStatus(true);

    } catch (error) {
      console.error('Failed to initialize cache:', error.message);
      cache.isInitialized = false;
      updateLapiStatus(false, error);
      updateSyncStatus({
        isSyncing: false,
        progress: 0,
        message: `Sync failed: ${error.message}`,
        completedAt: new Date().toISOString()
      });
    } finally {
      // Clear the promise so future calls can initialize again if needed
      initializationPromise = null;
    }
  })();

  return initializationPromise;
}

// Delta update - fetch only new data since last update
async function updateCacheDelta() {
  if (!cache.isInitialized || !cache.lastUpdate) {
    console.log('Cache not initialized, performing full load...');
    await initializeCache();
    return;
  }

  try {
    // Calculate duration since last update for LAPI 'since' parameter
    // LAPI expects duration format like '5m', '1h', etc., NOT ISO timestamps
    const lastUpdateTime = new Date(cache.lastUpdate).getTime();
    const now = Date.now();
    const diffMs = now - lastUpdateTime;

    // Convert to seconds and add a buffer of 10 seconds for safety
    const diffSeconds = Math.ceil(diffMs / 1000) + 10;
    const sinceDuration = `${diffSeconds}s`;

    console.log(`Fetching delta updates (since: ${sinceDuration})...`);

    // Fetch both new alerts AND alerts with active decisions
    // Active decisions need their stop_at refreshed based on updated duration
    const [newAlerts, activeDecisionAlerts] = await Promise.all([
      fetchAlertsFromLAPI(sinceDuration, null),
      fetchAlertsFromLAPI(null, null, true)  // has_active_decision=true to get fresh duration
    ]);

    // Process new alerts
    if (newAlerts.length > 0) {
      console.log(`Delta update: ${newAlerts.length} new alerts`);
      const insertNewTransaction = db.transaction((alerts) => {
        for (const alert of alerts) {
          processAlertForDb(alert);
        }
      });
      insertNewTransaction(newAlerts);
    }

    // Refresh active decisions with updated stop_at from duration
    if (activeDecisionAlerts.length > 0) {
      const refreshTransaction = db.transaction((alerts) => {
        for (const alert of alerts) {
          // Only process the decisions (to update their stop_at)
          const decisions = alert.decisions || [];
          decisions.forEach(decision => {
            if (decision.origin === 'CAPI') return;

            const alertSource = alert.source || {};
            const createdAt = decision.created_at || alert.created_at;

            // Calculate fresh stop_at from duration
            let stopAt;
            if (decision.duration) {
              const ms = parseGoDuration(decision.duration);
              stopAt = new Date(Date.now() + ms).toISOString();
            } else {
              stopAt = decision.stop_at || createdAt;
            }

            const enrichedDecision = {
              ...decision,
              created_at: createdAt,
              stop_at: stopAt,
              scenario: decision.scenario || alert.scenario || 'unknown',
              origin: decision.origin || decision.scenario || alert.scenario || 'unknown',
              alert_id: alert.id,
              value: decision.value || alertSource.ip,
              type: decision.type || 'ban',
              country: alertSource.cn,
              as: alertSource.as_name
            };

            try {
              // Use UPDATE only - don't insert new entries from enriched alert data
              // This prevents creating phantom decisions from alerts that originally had empty decisions
              db.updateDecision.run({
                $id: String(decision.id),
                $stop_at: stopAt,
                $raw_data: JSON.stringify(enrichedDecision) // Use stringified data
              });
            } catch (err) {
              // Ignore errors on refresh
            }
          });
        }
      });
      refreshTransaction(activeDecisionAlerts);
    }

    cache.lastUpdate = new Date().toISOString();

    const alertCount = db.countAlerts.get().count;
    console.log(`Delta update complete: ${alertCount} alerts, ${activeDecisionAlerts.length} active decision alerts refreshed`);
    updateLapiStatus(true);

  } catch (error) {
    console.error('Failed to update cache delta:', error.message);
    updateLapiStatus(false, error);
  }
}

// Cleanup old data beyond lookback period
function cleanupOldData() {
  const cutoffDate = new Date(Date.now() - LOOKBACK_MS).toISOString();

  try {
    // Remove old alerts
    const alertResult = db.deleteOldAlerts.run({ $cutoff: cutoffDate }); // Note $ prefix

    // Remove old decisions (by stop_at for expired decisions)
    const decisionResult = db.deleteOldDecisions.run({ $cutoff: cutoffDate }); // Note $ prefix

    if (alertResult.changes > 0 || decisionResult.changes > 0) {
      console.log(`Cleanup: Removed ${alertResult.changes} old alerts, ${decisionResult.changes} old decisions`);
    }
  } catch (error) {
    console.error('Cleanup failed:', error.message);
  }
}

// Combined update function: delta + cleanup
async function updateCache() {
  await updateCacheDelta();
  cleanupOldData();
}

// Idle & Full Refresh Configuration
const IDLE_REFRESH_INTERVAL_MS = parseRefreshInterval(process.env.CROWDSEC_IDLE_REFRESH_INTERVAL || '5m');
const IDLE_THRESHOLD_MS = parseRefreshInterval(process.env.CROWDSEC_IDLE_THRESHOLD || '2m');
const FULL_REFRESH_INTERVAL_MS = parseRefreshInterval(process.env.CROWDSEC_FULL_REFRESH_INTERVAL || '5m');

// Activity Tracker
let lastRequestTime = Date.now();
let lastFullRefreshTime = Date.now();

// Scheduler management functions
let schedulerTimeout = null;
let isSchedulerRunning = false;

async function runSchedulerLoop() {
  if (!isSchedulerRunning) return;

  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  const isIdle = timeSinceLastRequest > IDLE_THRESHOLD_MS;
  const timeSinceLastFull = now - lastFullRefreshTime;

  // Decide Update Type
  // We do Full Refresh if:
  // 1. Not Idle (we don't do full refresh when idle to save resources)
  // 2. Full Refresh interval exceeded
  // 3. OR manually forced? (not implemented here yet)

  let doFullRefresh = !isIdle && (FULL_REFRESH_INTERVAL_MS > 0 && timeSinceLastFull > FULL_REFRESH_INTERVAL_MS);

  try {
    if (doFullRefresh) {
      console.log(`Triggering FULL refresh (last full: ${Math.round(timeSinceLastFull / 1000)}s ago)...`);
      await initializeCache();
      lastFullRefreshTime = Date.now();
      console.log('Full refresh completed.');
    } else {
      console.log(`Background refresh triggered (${isIdle ? 'IDLE' : 'ACTIVE'})...`);
      await updateCache(); // Delta + Cleanup
    }
  } catch (err) {
    console.error("Scheduler update failed:", err);
  }

  if (!isSchedulerRunning) return;

  // 2. Determine Next Interval
  // Re-check idle status as it might have changed during await
  const currentIdle = (Date.now() - lastRequestTime) > IDLE_THRESHOLD_MS;

  let currentTargetInterval = REFRESH_INTERVAL_MS;

  if (currentTargetInterval > 0) {
    if (currentIdle) {
      if (currentTargetInterval < IDLE_REFRESH_INTERVAL_MS) {
        // Slow down
        currentTargetInterval = IDLE_REFRESH_INTERVAL_MS;
        console.log(`Idle mode active. Next refresh in ${getIntervalName(currentTargetInterval)}.`);
      }
    }
  } else {
    console.log("Scheduler in manual mode. Stopping loop.");
    isSchedulerRunning = false;
    return;
  }

  // 3. Schedule Next Run
  schedulerTimeout = setTimeout(runSchedulerLoop, currentTargetInterval);
}

function startRefreshScheduler() {
  stopRefreshScheduler();

  if (REFRESH_INTERVAL_MS > 0) {
    console.log(`Starting smart scheduler (active: ${getIntervalName(REFRESH_INTERVAL_MS)}, idle: ${getIntervalName(IDLE_REFRESH_INTERVAL_MS)})...`);
    isSchedulerRunning = true;
    // Wait for first interval before first run
    schedulerTimeout = setTimeout(runSchedulerLoop, REFRESH_INTERVAL_MS);
  } else {
    console.log('Manual refresh mode - cache will update on each request');
  }
}

function stopRefreshScheduler() {
  isSchedulerRunning = false;
  if (schedulerTimeout) {
    console.log('Stopping refresh scheduler...');
    clearTimeout(schedulerTimeout);
    schedulerTimeout = null;
  }
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } // Cleanup old
}

// Helper to convert interval string to name for display
function getIntervalName(intervalMs) {
  if (intervalMs === 0) return 'Off';
  if (intervalMs === 5000) return '5s';
  if (intervalMs === 30000) return '30s';
  if (intervalMs === 60000) return '1m';
  if (intervalMs === 300000) return '5m';
  return `${intervalMs}ms`;
}

// ============================================================================
// END CACHE SYSTEM
// ============================================================================

// ============================================================================
// UPDATE CHECKER (GHCR)
// ============================================================================

const UPDATE_CHECK_CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours
let updateCheckCache = {
  lastCheck: 0,
  data: null
};

// Check once at startup if update checking is enabled
const UPDATE_CHECK_ENABLED = !!(process.env.VITE_COMMIT_HASH || process.env.VITE_VERSION);
if (!UPDATE_CHECK_ENABLED) {
  console.log('Update checking disabled: VITE_COMMIT_HASH and VITE_VERSION not set.');
}

const DOCKER_IMAGE_REF = (process.env.DOCKER_IMAGE_REF || 'theduffman85/crowdsec-web-ui').toLowerCase();



async function checkForUpdates() {
  if (!UPDATE_CHECK_ENABLED) {
    return { update_available: false, reason: 'no_local_hash' };
  }

  // Return cached result if valid
  const now = Date.now();
  if (updateCheckCache.data && (now - updateCheckCache.lastCheck < UPDATE_CHECK_CACHE_DURATION)) {
    return updateCheckCache.data;
  }

  const currentBranch = process.env.VITE_BRANCH || 'main';
  const currentHash = process.env.VITE_COMMIT_HASH;
  const currentVersion = process.env.VITE_VERSION || null;
  const tag = currentBranch === 'dev' ? 'dev' : 'latest';

  try {
    // Extract owner and repo from DOCKER_IMAGE_REF
    const parts = DOCKER_IMAGE_REF.split('/');
    let owner, repo;

    if (parts.length === 2) {
      owner = parts[0];
      repo = parts[1];
    } else if (parts.length === 3) {
      owner = parts[1];
      repo = parts[2];
    } else {
      console.error(`Invalid DOCKER_IMAGE_REF format: ${DOCKER_IMAGE_REF}`);
      return { update_available: false, reason: 'invalid_image_ref' };
    }

    let result;

    if (currentBranch === 'dev') {
      // Dev: get exact build number from GHCR container tags
      let remoteBuildNumber = null;

      try {
        // Get anonymous token for public GHCR package
        const tokenUrl = `https://ghcr.io/token?scope=repository:${owner}/${repo}:pull`;
        const tokenResp = await fetch(tokenUrl, {
          headers: { 'User-Agent': 'crowdsec-web-ui-update-check' },
          signal: AbortSignal.timeout(10000)
        });

        if (tokenResp.ok) {
          const { token } = await tokenResp.json();

          const tagsUrl = `https://ghcr.io/v2/${owner}/${repo}/tags/list`;
          const tagsResp = await fetch(tagsUrl, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'User-Agent': 'crowdsec-web-ui-update-check'
            },
            signal: AbortSignal.timeout(10000)
          });

          if (tagsResp.ok) {
            const { tags } = await tagsResp.json();
            // Find latest dev-YYYYMMDDHHMM tag (matches the VITE_VERSION format exactly)
            const devTags = (tags || [])
              .filter(t => /^dev-\d{12}$/.test(t))
              .sort();
            if (devTags.length > 0) {
              remoteBuildNumber = devTags[devTags.length - 1].replace('dev-', '');
            }
          }
        }
      } catch (ghcrError) {
        console.warn('GHCR tag lookup failed, falling back to workflow API:', ghcrError.message);
      }

      // Fallback: derive build number from workflow run's creation timestamp
      if (!remoteBuildNumber) {
        const runsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/dev-build.yml/runs?branch=dev&status=success&per_page=1`;
        const response = await fetch(runsUrl, {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'crowdsec-web-ui-update-check'
          },
          signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        if (!data.workflow_runs || data.workflow_runs.length === 0) {
          return { update_available: false, reason: 'no_runs_found' };
        }

        const latestRun = data.workflow_runs[0];
        const runDate = new Date(latestRun.run_started_at || latestRun.created_at);
        remoteBuildNumber = `${runDate.getUTCFullYear()}${String(runDate.getUTCMonth() + 1).padStart(2, '0')}${String(runDate.getUTCDate()).padStart(2, '0')}${String(runDate.getUTCHours()).padStart(2, '0')}${String(runDate.getUTCMinutes()).padStart(2, '0')}`;
      }

      // Compare build numbers (timestamps: lexicographic comparison works)
      let updateAvailable;
      if (currentVersion) {
        updateAvailable = remoteBuildNumber > currentVersion;
      } else {
        updateAvailable = false;
      }

      result = {
        update_available: updateAvailable,
        local_version: currentVersion || currentHash,
        remote_version: remoteBuildNumber,
        tag: tag
      };
    } else {
      // Prod: compare versions via GitHub Releases API
      const releasesUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;

      const response = await fetch(releasesUrl, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'crowdsec-web-ui-update-check'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const release = await response.json();

      const latestVersion = release.tag_name.replace(/^v/i, '').trim();
      const normalizedCurrent = currentVersion ? currentVersion.replace(/^v/i, '').trim() : null;
      const updateAvailable = normalizedCurrent ? (latestVersion !== normalizedCurrent) : false;

      result = {
        update_available: updateAvailable,
        local_version: currentVersion,
        remote_version: latestVersion,
        release_url: release.html_url,
        tag: tag
      };
    }

    // Update cache
    updateCheckCache = { lastCheck: now, data: result };

    if (result.update_available) {
      console.log(`Update check: New version available (local: ${currentVersion || currentHash}, remote: ${result.remote_version || result.remote_hash})`);
    }

    return result;

  } catch (error) {
    console.error('Update check failed:', error.message);
    return { update_available: false, error: 'Update check failed' };
  }
}

// ============================================================================
// END UPDATE CHECKER
// ============================================================================

// Activity tracker middleware - Hono style
app.use('*', activityTrackerMiddleware);

/**
 * Activity tracker as Hono middleware
 */
async function activityTrackerMiddleware(c, next) {
  const now = Date.now();
  const wasIdle = (now - lastRequestTime) > IDLE_THRESHOLD_MS;
  lastRequestTime = now;

  if (wasIdle && isSchedulerRunning) {
    console.log("System waking up from idle mode. Triggering immediate refresh...");
    if (schedulerTimeout) clearTimeout(schedulerTimeout);
    runSchedulerLoop();
  }

  await next();
}

/**
 * Middleware to ensure we have a token or try to get one
 */
const ensureAuth = async (c, next) => {
  if (!hasToken()) {
    const success = await loginToLAPI();
    if (!success) {
      return c.json({ error: 'Failed to authenticate with CrowdSec LAPI' }, 502);
    }
  }
  await next();
};

/**
 * Helper to handle API errors with intelligent retry for 401
 * Returns a Response or null if replay succeeded
 */
const handleApiError = async (error, c, action, replayCallback) => {
  if (error.response && error.response.status === 401) {
    console.log(`Received 401 during ${action}, attempting re-login...`);
    const success = await loginToLAPI();
    if (success && replayCallback) {
      try {
        return await replayCallback();
      } catch (retryError) {
        console.error(`Retry failed for ${action}: ${retryError.message}`);
        error = retryError;
      }
    }
  }

  if (error.response) {
    console.error(`Error ${action}: ${error.response.status}`);
    const status = error.response.status;
    return c.json({ error: `Request failed with status ${status}` }, status);
  } else if (error.request) {
    console.error(`Error ${action}: No response received`);
    return c.json({ error: 'Bad Gateway: No response from CrowdSec LAPI' }, 502);
  } else {
    console.error(`Error ${action}: ${error.message}`);
    return c.json({ error: 'Internal server error' }, 500);
  }
};

/**
 * Helper to hydrate an alert's decisions with fresh data from SQLite database
 * This ensures even stale alerts (from delta updates) show current decision status
 */
const hydrateAlertWithDecisions = (alert) => {
  // Clone to safe mutate
  const alertClone = { ...alert };

  if (alertClone.decisions && Array.isArray(alertClone.decisions)) {
    alertClone.decisions = alertClone.decisions.map(decision => {
      // Look up the decision in SQLite to get the correct stop_at
      const dbDecision = db.getDecisionById.get({ $id: String(decision.id) }); // Note $id for bun:sqlite

      const now = new Date();
      let stopAt;

      if (dbDecision && dbDecision.stop_at) {
        // Use the updated stop_at from SQLite (calculated from duration)
        stopAt = new Date(dbDecision.stop_at);
      } else {
        // Fallback to original stop_at from the alert's decision
        stopAt = decision.stop_at ? new Date(decision.stop_at) : null;
      }

      const isExpired = !stopAt || stopAt < now;

      // Recalculate duration from the fresh stop_at
      let duration = decision.duration;
      if (stopAt && !isExpired) {
        const remainingMs = stopAt.getTime() - now.getTime();
        const hours = Math.floor(remainingMs / 3600000);
        const minutes = Math.floor((remainingMs % 3600000) / 60000);
        const seconds = Math.floor((remainingMs % 60000) / 1000);

        let durationStr = '';
        if (hours > 0) durationStr += `${hours}h`;
        if (minutes > 0 || hours > 0) durationStr += `${minutes}m`;
        durationStr += `${seconds}s`;
        duration = durationStr;
      } else if (isExpired) {
        duration = '0s';
      }

      return {
        ...decision,
        stop_at: stopAt ? stopAt.toISOString() : decision.stop_at,
        duration: duration,
        expired: isExpired
      };
    });
  }
  return alertClone;
};

/**
 * Create a slim version of an alert for list views
 * Only includes fields necessary for the Alerts table and Dashboard statistics
 */
const slimAlert = (alert) => {
  // Create lightweight decision summary
  const decisions = (alert.decisions || []).map(d => ({
    id: d.id,
    type: d.type,
    value: d.value,
    duration: d.duration,
    stop_at: d.stop_at,
    origin: d.origin,
    expired: d.expired
  }));

  return {
    id: alert.id,
    created_at: alert.created_at,
    scenario: alert.scenario,
    message: alert.message,
    events_count: alert.events_count,
    machine_id: alert.machine_id,
    machine_alias: alert.machine_alias,
    source: alert.source ? {
      ip: alert.source.ip,
      value: alert.source.value,
      cn: alert.source.cn,
      as_name: alert.source.as_name,
      as_number: alert.source.as_number
    } : null,
    // Use pre-computed target from database import
    target: alert.target,
    decisions
  };
};

/**
 * GET /api/health
 * Unauthenticated health check for Docker/orchestrator liveness probes
 */
app.get(`${BASE_PATH}/api/health`, (c) => {
  return c.json({ status: 'ok' });
});

/**
 * GET /api/alerts
 * Returns alerts from SQLite database (slim payload for list views)
 */
app.get(`${BASE_PATH}/api/alerts`, ensureAuth, async (c) => {
  try {
    // If in manual mode (REFRESH_INTERVAL_MS === 0), update cache on every request
    if (REFRESH_INTERVAL_MS === 0) {
      await updateCache();
    }

    // Ensure cache is initialized
    if (!cache.isInitialized) {
      await initializeCache();
    }

    // Get lookback cutoff
    const since = new Date(Date.now() - LOOKBACK_MS).toISOString();

    // Query alerts from SQLite
    const rawAlerts = db.getAlerts.all({ $since: since });

    // Parse raw_data, hydrate with decision status, then slim for list view
    const alerts = rawAlerts.map(row => {
      const alert = JSON.parse(row.raw_data);
      const hydrated = hydrateAlertWithDecisions(alert);
      return slimAlert(hydrated);
    });

    alerts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return c.json(alerts);
  } catch (error) {
    console.error('Error serving alerts from database:', error.message);
    return c.json({ error: 'Failed to retrieve alerts' }, 500);
  }
});

/**
 * GET /api/alerts/:id
 */
app.get(`${BASE_PATH}/api/alerts/:id`, ensureAuth, async (c) => {
  const alertId = c.req.param('id');
  if (!/^\d+$/.test(alertId)) return c.json({ error: 'Invalid alert ID' }, 400);

  const doRequest = async () => {
    const alertData = await getAlertById(alertId);

    // Process response to sync decisions with active cache
    let processedData = alertData;

    if (Array.isArray(processedData)) {
      processedData = processedData.map(hydrateAlertWithDecisions);
    } else {
      processedData = hydrateAlertWithDecisions(processedData);
    }

    return c.json(processedData);
  };

  try {
    return await doRequest();
  } catch (error) {
    return handleApiError(error, c, 'fetching alert details', doRequest);
  }
});

/**
 * DELETE /api/alerts/:id
 * Deletes an alert by ID from LAPI and local cache
 */
app.delete(`${BASE_PATH}/api/alerts/:id`, ensureAuth, async (c) => {
  const alertId = c.req.param('id');
  if (!/^\d+$/.test(alertId)) return c.json({ error: 'Invalid alert ID' }, 400);

  const doRequest = async () => {
    const result = await deleteAlert(alertId);

    // Remove alert from SQLite cache
    db.deleteAlert.run({ $id: alertId });
    // Also remove associated decisions from cache
    db.deleteDecisionsByAlertId.run({ $alert_id: alertId });

    console.log(`Deleted alert #${alertId} from LAPI and local cache`);

    return c.json(result || { message: 'Deleted' });
  };

  try {
    return await doRequest();
  } catch (error) {
    return handleApiError(error, c, 'deleting alert', doRequest);
  }
});

/**
 * GET /api/decisions
 * Returns decisions from SQLite database (active by default, or all including expired with ?include_expired=true)
 */
app.get(`${BASE_PATH}/api/decisions`, ensureAuth, async (c) => {
  try {
    // If in manual mode, update cache on every request
    if (REFRESH_INTERVAL_MS === 0) {
      await updateCache();
    }

    // Ensure cache is initialized
    if (!cache.isInitialized) {
      await initializeCache();
    }

    const includeExpired = c.req.query('include_expired') === 'true';
    const now = new Date().toISOString();
    const since = new Date(Date.now() - LOOKBACK_MS).toISOString();

    let decisions;
    if (includeExpired) {
      // Get all active decisions PLUS expired ones within lookback period
      const rawDecisions = db.getDecisionsSince.all({ $since: since, $now: now }); // Note $ prefix
      decisions = rawDecisions.map(row => {
        const d = JSON.parse(row.raw_data);
        const isExpired = d.stop_at && new Date(d.stop_at) < new Date();
        return {
          id: d.id,
          created_at: d.created_at,
          scenario: d.scenario,
          value: d.value,
          expired: isExpired,
          is_duplicate: d.is_duplicate === true, // Read from raw_data, set at insert time
          detail: {
            origin: d.origin || "manual",
            type: d.type,
            reason: d.scenario,
            action: d.type,
            country: d.country || "Unknown",
            as: d.as || "Unknown",
            events_count: d.events_count || 0,
            duration: d.duration || "N/A",
            expiration: d.stop_at,
            alert_id: d.alert_id,
            target: d.target || null
          }
        };
      });
    } else {
      // Get only active decisions (stop_at > now)
      const rawDecisions = db.getActiveDecisions.all({ $now: now });
      decisions = rawDecisions.map(row => {
        const d = JSON.parse(row.raw_data);
        return {
          id: d.id,
          created_at: d.created_at,
          scenario: d.scenario,
          value: d.value,
          expired: false,
          is_duplicate: d.is_duplicate === true, // Read from raw_data, set at insert time
          detail: {
            origin: d.origin || "manual",
            type: d.type,
            reason: d.scenario,
            action: d.type,
            country: d.country || "Unknown",
            as: d.as || "Unknown",
            events_count: d.events_count || 0,
            duration: d.duration || "N/A",
            expiration: d.stop_at,
            alert_id: d.alert_id,
            target: d.target || null
          }
        };
      });
    }

    // Compute duplicates: for each IP, only the decision with the LOWEST ID is non-duplicate
    // This works because CrowdSec assigns ascending IDs, so the first decision for an IP has the lowest ID
    // IMPORTANT: Only apply duplicate detection to ACTIVE decisions - expired ones should all be visible for history
    const ipPrimaryMap = new Map(); // Maps IP -> lowest decision ID for that IP (active decisions only)
    for (const decision of decisions) {
      // Skip expired decisions - they are never considered for duplicate detection
      if (decision.expired) continue;

      const ip = decision.value;
      const decisionIdStr = String(decision.id);
      const numericId = decisionIdStr.startsWith('dup_')
        ? Infinity  // Virtual duplicates always lose to real decisions
        : parseInt(decisionIdStr, 10) || Infinity;

      const existing = ipPrimaryMap.get(ip);
      if (!existing || numericId < existing) {
        ipPrimaryMap.set(ip, numericId);
      }
    }

    // Mark duplicates - only active decisions can be duplicates
    decisions = decisions.map(decision => {
      // Expired decisions are never duplicates
      if (decision.expired) {
        return { ...decision, is_duplicate: false };
      }

      const ip = decision.value;
      const primaryId = ipPrimaryMap.get(ip);
      const decisionIdStr = String(decision.id);
      const numericId = decisionIdStr.startsWith('dup_')
        ? Infinity
        : parseInt(decisionIdStr, 10) || Infinity;

      return {
        ...decision,
        is_duplicate: numericId !== primaryId
      };
    });

    decisions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return c.json(decisions);
  } catch (error) {
    console.error('Error serving decisions from database:', error.message);
    return c.json({ error: 'Failed to retrieve decisions' }, 500);
  }
});


/**
 * GET /api/config
 * Returns the public configuration for the frontend
 */
app.get(`${BASE_PATH}/api/config`, ensureAuth, async (c) => {
  // Simple parser to estimate days/hours for display
  // Supports h, d. Default 168h.
  let hours = 168;
  let duration = CROWDSEC_LOOKBACK_PERIOD;

  const match = duration.match(/^(\d+)([hmd])$/);
  if (match) {
    const val = parseInt(match[1]);
    const unit = match[2];
    if (unit === 'h') hours = val;
    if (unit === 'd') hours = val * 24;
  }

  // Return current runtime state (not env var)
  return c.json({
    lookback_period: CROWDSEC_LOOKBACK_PERIOD,
    lookback_hours: hours,
    lookback_days: Math.max(1, Math.round(hours / 24)),
    refresh_interval: REFRESH_INTERVAL_MS,
    current_interval_name: getIntervalName(REFRESH_INTERVAL_MS),
    lapi_status: getLapiStatus(),
    sync_status: syncStatus
  });
});

/**
 * PUT /api/config/refresh-interval
 * Updates the refresh interval at runtime and restarts the scheduler
 */
app.put(`${BASE_PATH}/api/config/refresh-interval`, ensureAuth, async (c) => {
  try {
    const body = await c.req.json();
    const { interval } = body;

    if (!interval) {
      return c.json({ error: 'interval is required' }, 400);
    }

    // Validate interval value
    const validIntervals = ['manual', '0', '5s', '30s', '1m', '5m'];
    if (!validIntervals.includes(interval)) {
      return c.json({
        error: `Invalid interval. Must be one of: ${validIntervals.join(', ')}`
      }, 400);
    }

    // Parse and update interval
    const newIntervalMs = parseRefreshInterval(interval);
    const oldIntervalName = getIntervalName(REFRESH_INTERVAL_MS);

    REFRESH_INTERVAL_MS = newIntervalMs;

    // Persist to database
    savePersistedConfig({ refresh_interval_ms: newIntervalMs, refresh_interval_name: interval });

    // Restart scheduler with new interval
    startRefreshScheduler();

    console.log(`Refresh interval changed: ${oldIntervalName} → ${interval} (${newIntervalMs}ms)`);

    return c.json({
      success: true,
      old_interval: oldIntervalName,
      new_interval: interval,
      new_interval_ms: newIntervalMs,
      message: `Refresh interval updated to ${interval}`
    });
  } catch (error) {
    console.error('Error updating refresh interval:', error.message);
    return c.json({ error: 'Failed to update refresh interval' }, 500);
  }
});

/**
 * POST /api/cache/clear
 * Manually clears the local alert/decision cache and triggers a full re-sync from LAPI.
 * Historical data will be re-fetched within CROWDSEC_LOOKBACK_PERIOD.
 */
app.post(`${BASE_PATH}/api/cache/clear`, ensureAuth, async (c) => {
  try {
    console.log('Manual cache clear requested');

    db.clearSyncData();

    cache.isInitialized = false;
    cache.lastUpdate = null;
    isFirstSync = true;

    await initializeCache();
    startRefreshScheduler();

    return c.json({
      success: true,
      message: 'Cache cleared and re-synced',
      alert_count: db.countAlerts.get().count
    });
  } catch (error) {
    console.error('Error clearing cache:', error.message);
    return c.json({ error: 'Failed to clear cache' }, 500);
  }
});


/**
 * GET /api/stats/alerts
 * Returns minimal alert data for Dashboard statistics (optimized payload)
 */
app.get(`${BASE_PATH}/api/stats/alerts`, ensureAuth, async (c) => {
  try {
    // If in manual mode, update cache on every request
    if (REFRESH_INTERVAL_MS === 0) {
      await updateCache();
    }

    // Ensure cache is initialized
    if (!cache.isInitialized) {
      await initializeCache();
    }

    // Get lookback cutoff
    const since = new Date(Date.now() - LOOKBACK_MS).toISOString();

    // Query alerts from SQLite
    const rawAlerts = db.getAlerts.all({ $since: since });

    // Parse raw_data and extract only stats-relevant fields with pre-computed target
    const alerts = rawAlerts.map(row => {
      const alert = JSON.parse(row.raw_data);
      return {
        created_at: alert.created_at,
        scenario: alert.scenario,
        source: alert.source ? {
          ip: alert.source.ip,
          cn: alert.source.cn,
          as_name: alert.source.as_name
        } : null,
        target: alert.target
      };
    });

    alerts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return c.json(alerts);
  } catch (error) {
    console.error('Error serving stats alerts from database:', error.message);
    return c.json({ error: 'Failed to retrieve alert statistics' }, 500);
  }
});

/**
 * GET /api/stats/decisions
 * Returns ALL decisions (including expired) for statistics purposes from SQLite database
 */
app.get(`${BASE_PATH}/api/stats/decisions`, ensureAuth, async (c) => {
  try {
    // If in manual mode, update cache on every request
    if (REFRESH_INTERVAL_MS === 0) {
      await updateCache();
    }

    // Ensure cache is initialized
    if (!cache.isInitialized) {
      await initializeCache();
    }

    // Get all decisions within lookback period (plus any still active)
    const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
    const now = new Date().toISOString();
    const rawDecisions = db.getDecisionsSince.all({ $since: since, $now: now }); // Note $ prefix

    const decisions = rawDecisions.map(row => {
      const d = JSON.parse(row.raw_data);
      return {
        id: d.id,
        created_at: d.created_at,
        scenario: d.scenario,
        value: d.value,
        stop_at: d.stop_at,
        target: d.target  // Pre-computed during import
      };
    });

    decisions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return c.json(decisions);
  } catch (error) {
    console.error('Error serving stats decisions from database:', error.message);
    return c.json({ error: 'Failed to retrieve decision statistics' }, 500);
  }
});

/**
 * POST /api/decisions
 * Creates a manual decision via POST /v1/alerts
 */
app.post(`${BASE_PATH}/api/decisions`, ensureAuth, async (c) => {
  const doRequest = async () => {
    const body = await c.req.json();
    const { ip, duration = "4h", reason = "manual", type = "ban" } = body;

    if (!ip) {
      return c.json({ error: 'IP address is required' }, 400);
    }

    // Validate IP address format (IPv4, IPv6, or CIDR notation)
    const ipv4Re = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
    const ipv6Re = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(\/\d{1,3})?$/;
    if (!ipv4Re.test(ip) && !ipv6Re.test(ip)) {
      return c.json({ error: 'Invalid IP address format' }, 400);
    }

    // Validate decision type
    const validTypes = ['ban', 'captcha'];
    if (!validTypes.includes(type)) {
      return c.json({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` }, 400);
    }

    // Validate duration format (e.g. "4h", "30m", "1d", "3600s")
    if (!/^\d+[smhd]$/.test(duration)) {
      return c.json({ error: 'Invalid duration format. Use e.g. "4h", "30m", "1d"' }, 400);
    }

    // Limit reason length
    const sanitizedReason = reason ? reason.slice(0, 256) : 'manual';

    const result = await addDecision(ip, type, duration, sanitizedReason);

    // Immediately refresh cache to include new decision (delta only)
    console.log('Refreshing cache after adding decision...');
    await updateCacheDelta();

    return c.json({ message: 'Decision added (via Alert)', result });
  };

  try {
    return await doRequest();
  } catch (error) {
    return handleApiError(error, c, 'adding decision', doRequest);
  }
});

/**
 * DELETE /api/decisions/:id
 */
app.delete(`${BASE_PATH}/api/decisions/:id`, ensureAuth, async (c) => {
  const decisionId = c.req.param('id');
  if (!/^\d+$/.test(decisionId)) return c.json({ error: 'Invalid decision ID' }, 400);

  const doRequest = async () => {
    const result = await deleteDecision(decisionId);

    // Remove decision from local SQLite cache immediately
    // This ensures the decision disappears from the UI right away,
    // rather than waiting for it to naturally expire
    console.log(`Removing decision ${decisionId} from local cache...`);
    db.deleteDecision.run({ $id: decisionId });

    return c.json(result || { message: 'Deleted' });
  };

  try {
    return await doRequest();
  } catch (error) {
    return handleApiError(error, c, 'deleting decision', doRequest);
  }
});

/**
 * GET /api/update-check
 */
app.get(`${BASE_PATH}/api/update-check`, ensureAuth, async (c) => {
  try {
    const status = await checkForUpdates();
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    c.header('Pragma', 'no-cache');
    return c.json(status);
  } catch (error) {
    console.error('Error checking for updates:', error.message);
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    c.header('Pragma', 'no-cache');
    return c.json({ error: 'Update check failed' }, 500);
  }
});

// Serve static files from the "frontend/dist" directory.
// When BASE_PATH is set, we need to strip it from the request path before looking up files
app.use(`${BASE_PATH}/assets/*`, serveStatic({
  root: './frontend/dist',
  rewriteRequestPath: (path) => BASE_PATH ? path.replace(BASE_PATH, '') : path
}));

// Also serve individual files from dist root (logo.svg, favicon.ico, etc)
// This prevents them from being shadowed by the greedy catch-all SPA route below
const staticFiles = ['/logo.svg', '/favicon.ico', '/robots.txt', '/world-50m.json', '/favicon-96x96.png', '/apple-touch-icon.png', '/android-chrome-192x192.png', '/android-chrome-512x512.png'];
staticFiles.forEach(file => {
  app.use(`${BASE_PATH}${file}`, serveStatic({ path: `./frontend/dist${file}` }));
});

// Dynamic site.webmanifest endpoint with BASE_PATH-aware icon paths
app.get(`${BASE_PATH}/site.webmanifest`, (c) => {
  return c.json({
    name: "CrowdSec Web UI",
    short_name: "CrowdSec",
    icons: [
      { src: `${BASE_PATH}/android-chrome-192x192.png`, sizes: "192x192", type: "image/png" },
      { src: `${BASE_PATH}/android-chrome-512x512.png`, sizes: "512x512", type: "image/png" }
    ],
    theme_color: "#ffffff",
    background_color: "#ffffff",
    display: "standalone",
    start_url: BASE_PATH || "/"
  });
});

// Catch-all handler: serve index.html for SPA routing
app.get(`${BASE_PATH}/*`, async (c) => {
  try {
    const indexPath = path.join(__dirname, 'frontend/dist/index.html');
    let html = fs.readFileSync(indexPath, 'utf-8');

    // Inject runtime configuration for BASE_PATH
    // Sanitize BASE_PATH to prevent script injection via environment variable
    const safePath = BASE_PATH.replace(/[^a-zA-Z0-9/_-]/g, '');
    const configScript = `<script>window.__BASE_PATH__="${safePath}";</script>`;
    html = html.replace('</head>', `${configScript}\n</head>`);

    // Fix asset paths in index.html when BASE_PATH is set
    if (BASE_PATH) {
      html = html.replace(/href="\.\//g, `href="${BASE_PATH}/`);
      html = html.replace(/src="\.\//g, `src="${BASE_PATH}/`);
    }

    return c.html(html);
  } catch (error) {
    return c.text('Not Found', 404);
  }
});

// Redirect root to BASE_PATH if configured
if (BASE_PATH) {
  app.get('/', (c) => c.redirect(BASE_PATH + '/'));
}

// ============================================================================
// CACHE INITIALIZATION AND SCHEDULER
// ============================================================================

// Initialize cache on startup
(async () => {
  // First, ensure we're logged in
  if (hasCredentials()) {
    console.log('Ensuring authentication before cache initialization...');
    const loginSuccess = await loginToLAPI();

    if (!loginSuccess) {
      console.error('Failed to login - cache initialization aborted');
      return;
    }

    console.log('Starting cache initialization...');
    await initializeCache();

    // Start background refresh scheduler
    startRefreshScheduler();
  } else {
    console.warn('Cache initialization skipped - credentials not configured');
  }
})();

// ============================================================================
// SERVER STARTUP
// ============================================================================

console.log(`CrowdSec Web UI backend running at http://localhost:${port}${BASE_PATH || ''}/`);
if (BASE_PATH) {
  console.log(`BASE_PATH configured: ${BASE_PATH}`);
}

export default {
  port,
  fetch: app.fetch,
};
