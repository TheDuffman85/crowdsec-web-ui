import express from 'express';
import axios from 'axios';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from './sqlite.js';

// ESM replacement for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const app = express();
const port = process.env.PORT || 3000;

// CrowdSec LAPI Configuration
const CROWDSEC_URL = process.env.CROWDSEC_URL || 'http://crowdsec:8080';
const CROWDSEC_USER = process.env.CROWDSEC_USER;
const CROWDSEC_PASSWORD = process.env.CROWDSEC_PASSWORD;
// Default lookback period (default 7 days / 168h) - used for alerts, decisions and stats defaults
const CROWDSEC_LOOKBACK_PERIOD = process.env.CROWDSEC_LOOKBACK_PERIOD || '168h';

// Token state
let requestToken = null;

if (!CROWDSEC_USER || !CROWDSEC_PASSWORD) {
  console.warn('WARNING: CROWDSEC_USER and CROWDSEC_PASSWORD must be set for full functionality.');
}

const apiClient = axios.create({
  baseURL: CROWDSEC_URL,
  timeout: 5000,
  headers: {
    'User-Agent': 'crowdsec-web-ui/1.0.0'
  }
});

// Add interceptor to inject token
apiClient.interceptors.request.use(config => {
  if (requestToken && !config.url.includes('/watchers/login')) {
    config.headers.Authorization = `Bearer ${requestToken}`;
  }
  return config;
});

// Add interceptor to retry requests on 401 (Token Expired)
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Check if error is 401 and we haven't already retried
    if (error.response && error.response.status === 401 && !originalRequest._retry) {
      // Avoid infinite loops for login requests themselves
      if (originalRequest.url.includes('/watchers/login')) {
        return Promise.reject(error);
      }

      console.log('Detected 401 Unauthorized. Attempting to re-authenticate...');
      originalRequest._retry = true;

      const success = await loginToLAPI();
      if (success) {
        console.log('Re-authentication successful. Retrying original request...');
        // Update the token in the original request header
        originalRequest.headers.Authorization = `Bearer ${requestToken}`;
        // Retry the request
        return apiClient(originalRequest);
      } else {
        console.error('Re-authentication failed.');
      }
    }

    return Promise.reject(error);
  }
);


// Login helper
const loginToLAPI = async () => {
  try {
    console.log(`Attempting login to CrowdSec LAPI at ${CROWDSEC_URL} as ${CROWDSEC_USER}...`);
    const response = await apiClient.post('/v1/watchers/login', {
      machine_id: CROWDSEC_USER,
      password: CROWDSEC_PASSWORD,
      scenarios: ["manual/web-ui"] // Informative only
    });

    if (response.data && response.data.code === 200 && response.data.token) {
      requestToken = response.data.token;
      console.log('Successfully logged in to CrowdSec LAPI');
      return true;
    } else if (response.data && response.data.token) {
      // Some versions might just return the token object directly or differently
      requestToken = response.data.token;
      console.log('Successfully logged in to CrowdSec LAPI');
      updateLapiStatus(true);
      return true;
    } else {
      console.error('Login response did not contain token:', response.data);
      updateLapiStatus(false, { message: 'Login response invalid' });
      return false;
    }
  } catch (error) {
    console.error(`Login failed: ${error.message}`);
    updateLapiStatus(false, error);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
    return false;
  }
};

// Login will be called during cache initialization

// Historical Sync Status Tracker
const syncStatus = {
  isSyncing: false,
  progress: 0, // 0-100 percentage
  message: '',
  startedAt: null,
  completedAt: null
};

// Track first sync after startup - show modal only on first sync
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

// Global LAPI Status Tracker
const lapiStatus = {
  isConnected: false,
  lastCheck: null,
  lastError: null
};

// Helper to update LAPI status
function updateLapiStatus(isConnected, error = null) {
  lapiStatus.isConnected = isConnected;
  lapiStatus.lastCheck = new Date().toISOString();
  lapiStatus.lastError = error ? error.message : null;
}

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
 * Prioritizes: target_fqdn > target_host > service > machine_alias > machine_id
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

// Fetch alerts from LAPI with optional 'since'/'until' parameters and active decision filter
async function fetchAlertsFromLAPI(since = null, until = null, hasActiveDecision = false) {
  const sinceParam = since || CROWDSEC_LOOKBACK_PERIOD;
  const origins = ['cscli', 'crowdsec', 'cscli-import', 'manual', 'appsec', 'lists'];
  const scopes = ['Ip', 'Range'];
  const limit = 10000;

  const activeDecisionParam = hasActiveDecision ? '&has_active_decision=true' : '';
  const untilParam = until ? `&until=${until}` : '';

  const originPromises = origins.map(o =>
    apiClient.get(`/v1/alerts?since=${sinceParam}${untilParam}&origin=${o}&limit=${limit}${activeDecisionParam}`)
  );
  const scopePromises = scopes.map(s =>
    apiClient.get(`/v1/alerts?since=${sinceParam}${untilParam}&scope=${s}&limit=${limit}${activeDecisionParam}`)
  );

  const responses = await Promise.all([...originPromises, ...scopePromises]);

  let alertMap = new Map();
  responses.forEach(r => {
    if (r.data && Array.isArray(r.data)) {
      r.data.forEach(alert => {
        alertMap.set(alert.id, alert);
      });
    }
  });

  return Array.from(alertMap.values());
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
          for (const alert of items) processAlertForDb(alert);
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

const activityTracker = (req, res, next) => {
  const now = Date.now();
  const wasIdle = (now - lastRequestTime) > IDLE_THRESHOLD_MS;
  lastRequestTime = now;

  if (wasIdle && isSchedulerRunning) {
    console.log("System waking up from idle mode. Triggering immediate refresh...");
    // Cancel pending sleep and run immediately
    if (schedulerTimeout) clearTimeout(schedulerTimeout);
    runSchedulerLoop();
  }

  next();
};

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
const UPDATE_CHECK_ENABLED = !!process.env.VITE_COMMIT_HASH;
if (!UPDATE_CHECK_ENABLED) {
  console.log('Update checking disabled: VITE_COMMIT_HASH not set.');
}

async function getGhcrToken() {
  try {
    const response = await axios.get('https://ghcr.io/token?service=ghcr.io&scope=repository:theduffman85/crowdsec-web-ui:pull', {
      timeout: 5000
    });
    return response.data.token;
  } catch (error) {
    console.error('Failed to get GHCR token:', error.message);
    return null;
  }
}

async function checkForUpdates() {
  // Skip if update checking is disabled (no commit hash set)
  if (!UPDATE_CHECK_ENABLED) {
    return { update_available: false, reason: 'no_local_hash' };
  }

  // Return cached result if valid
  const now = Date.now();
  if (updateCheckCache.data && (now - updateCheckCache.lastCheck < UPDATE_CHECK_CACHE_DURATION)) {
    return updateCheckCache.data;
  }

  const currentBranch = process.env.VITE_BRANCH || 'main'; // Default to main if not set (which maps to latest)
  const currentHash = process.env.VITE_COMMIT_HASH;

  // Map branch to tag
  const tag = currentBranch === 'dev' ? 'dev' : 'latest';

  try {
    const token = await getGhcrToken();
    if (!token) throw new Error('No GHCR token obtained');

    // 1. Get Manifest (or Index)
    const manifestUrl = `https://ghcr.io/v2/theduffman85/crowdsec-web-ui/manifests/${tag}`;

    let manifestResponse = await axios.get(manifestUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json'
      },
      timeout: 10000
    });

    // Handle OCI Index or Manifest List (Multi-arch)
    const mediaType = manifestResponse.headers['content-type'];
    if (mediaType === 'application/vnd.docker.distribution.manifest.list.v2+json' || mediaType === 'application/vnd.oci.image.index.v1+json') {
      const manifests = manifestResponse.data.manifests;
      const targetPlatform = manifests.find(m => m.platform?.architecture === 'amd64' && m.platform?.os === 'linux');

      if (!targetPlatform) {
        throw new Error('No linux/amd64 manifest found in index');
      }

      const resolvedDigest = targetPlatform.digest;

      // Fetch the specific manifest
      const specificManifestUrl = `https://ghcr.io/v2/theduffman85/crowdsec-web-ui/manifests/${resolvedDigest}`;
      manifestResponse = await axios.get(specificManifestUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json'
        },
        timeout: 10000
      });
    }

    const configDigest = manifestResponse.data.config?.digest;
    if (!configDigest) throw new Error('Config digest not found in manifest');

    // 2. Get Config Blob to find Labels
    const blobUrl = `https://ghcr.io/v2/theduffman85/crowdsec-web-ui/blobs/${configDigest}`;
    const blobResponse = await axios.get(blobUrl, {
      headers: {
        'Authorization': `Bearer ${token}`
      },
      timeout: 10000
    });

    const remoteRevision = blobResponse.data.config?.Labels?.['org.opencontainers.image.revision'];

    if (!remoteRevision) {
      console.log('Update check: Remote image has no revision label.');
      return { update_available: false, reason: 'no_remote_label' };
    }

    // Check if remote revision starts with local hash (remote is full SHA, local is short 8 chars)
    const isMismatch = !remoteRevision.startsWith(currentHash);

    const result = {
      update_available: isMismatch,
      local_hash: currentHash,
      remote_hash: remoteRevision.substring(0, 8), // Shorten for display
      tag: tag
    };

    // Update cache
    updateCheckCache = {
      lastCheck: now,
      data: result
    };

    console.log(`Update check complete. Update available: ${isMismatch} (Local: ${currentHash}, Remote: ${remoteRevision.substring(0, 8)})`);
    return result;

  } catch (error) {
    console.error('Update check failed:', error.message);
    return { update_available: false, error: error.message };
  }
}

// ============================================================================
// END UPDATE CHECKER
// ============================================================================

app.use(cors());
app.use(express.json());
app.use(activityTracker); // Apply to all routes

/**
 * Middleware to ensure we have a token or try to get one
 */
const ensureAuth = async (req, res, next) => {
  if (!requestToken) {
    const success = await loginToLAPI();
    if (!success) {
      return res.status(502).json({ error: 'Failed to authenticate with CrowdSec LAPI' });
    }
  }
  next();
};

/**
 * Helper to handle Axios errors with intelligent retry for 401
 */
const handleApiError = async (error, res, action, replayCallback) => {
  if (error.response && error.response.status === 401) {
    console.log(`Received 401 during ${action}, attempting re-login...`);
    const success = await loginToLAPI();
    if (success && replayCallback) {
      try {
        await replayCallback();
        return; // Successful replay
      } catch (retryError) {
        // Replay failed, fall through to error handling
        console.error(`Retry failed for ${action}: ${retryError.message}`);
        error = retryError;
      }
    }
  }

  if (error.response) {
    console.error(`Error ${action}: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    res.status(error.response.status).json(error.response.data);
  } else if (error.request) {
    console.error(`Error ${action}: No response received`);
    res.status(502).json({ error: 'Bad Gateway: No response from CrowdSec LAPI' });
  } else {
    console.error(`Error ${action}: ${error.message}`);
    res.status(500).json({ error: `Internal Server Error: ${error.message}` });
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
 * GET /api/alerts
 * Returns alerts from SQLite database (slim payload for list views)
 */
app.get('/api/alerts', ensureAuth, async (req, res) => {
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
    const rawAlerts = db.getAlerts.all({ $since: since, $limit: 10000 }); // Note $ prefix for bun

    // Parse raw_data, hydrate with decision status, then slim for list view
    const alerts = rawAlerts.map(row => {
      const alert = JSON.parse(row.raw_data);
      const hydrated = hydrateAlertWithDecisions(alert);
      return slimAlert(hydrated);
    });

    alerts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json(alerts);
  } catch (error) {
    console.error('Error serving alerts from database:', error.message);
    res.status(500).json({ error: 'Failed to retrieve alerts' });
  }
});

/**
 * GET /api/alerts/:id
 */
app.get('/api/alerts/:id', ensureAuth, async (req, res) => {
  const doRequest = async () => {
    const response = await apiClient.get(`/v1/alerts/${req.params.id}`);

    // Process response to sync decisions with active cache
    let alertData = response.data;

    if (Array.isArray(alertData)) {
      alertData = alertData.map(hydrateAlertWithDecisions);
    } else {
      alertData = hydrateAlertWithDecisions(alertData);
    }

    res.json(alertData);
  };

  try {
    await doRequest();
  } catch (error) {
    handleApiError(error, res, 'fetching alert details', doRequest);
  }
});

/**
 * GET /api/decisions
 * Returns decisions from SQLite database (active by default, or all including expired with ?include_expired=true)
 */
app.get('/api/decisions', ensureAuth, async (req, res) => {
  try {
    // If in manual mode, update cache on every request
    if (REFRESH_INTERVAL_MS === 0) {
      await updateCache();
    }

    // Ensure cache is initialized
    if (!cache.isInitialized) {
      await initializeCache();
    }

    const includeExpired = req.query.include_expired === 'true';
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
      const rawDecisions = db.getActiveDecisions.all({ $now: now, $limit: 10000 }); // Note $ prefix
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

    res.json(decisions);
  } catch (error) {
    console.error('Error serving decisions from database:', error.message);
    res.status(500).json({ error: 'Failed to retrieve decisions' });
  }
});


/**
 * GET /api/config
 * Returns the public configuration for the frontend
 */
app.get('/api/config', ensureAuth, (req, res) => {
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
  res.json({
    lookback_period: CROWDSEC_LOOKBACK_PERIOD,
    lookback_hours: hours,
    lookback_days: Math.max(1, Math.round(hours / 24)),
    refresh_interval: REFRESH_INTERVAL_MS,
    current_interval_name: getIntervalName(REFRESH_INTERVAL_MS),
    lapi_status: lapiStatus,
    sync_status: syncStatus
  });
});

/**
 * PUT /api/config/refresh-interval
 * Updates the refresh interval at runtime and restarts the scheduler
 */
app.put('/api/config/refresh-interval', ensureAuth, (req, res) => {
  try {
    const { interval } = req.body;

    if (!interval) {
      return res.status(400).json({ error: 'interval is required' });
    }

    // Validate interval value
    const validIntervals = ['manual', '0', '5s', '30s', '1m', '5m'];
    if (!validIntervals.includes(interval)) {
      return res.status(400).json({
        error: `Invalid interval. Must be one of: ${validIntervals.join(', ')}`
      });
    }

    // Parse and update interval
    const newIntervalMs = parseRefreshInterval(interval);
    const oldIntervalName = getIntervalName(REFRESH_INTERVAL_MS);

    REFRESH_INTERVAL_MS = newIntervalMs;

    // Persist to config file
    savePersistedConfig({ refresh_interval_ms: newIntervalMs, refresh_interval_name: interval });

    // Restart scheduler with new interval
    startRefreshScheduler();

    console.log(`Refresh interval changed: ${oldIntervalName} → ${interval} (${newIntervalMs}ms)`);

    res.json({
      success: true,
      old_interval: oldIntervalName,
      new_interval: interval,
      new_interval_ms: newIntervalMs,
      message: `Refresh interval updated to ${interval}`
    });
  } catch (error) {
    console.error('Error updating refresh interval:', error.message);
    res.status(500).json({ error: 'Failed to update refresh interval' });
  }
});


/**
 * GET /api/stats/alerts
 * Returns minimal alert data for Dashboard statistics (optimized payload)
 */
app.get('/api/stats/alerts', ensureAuth, async (req, res) => {
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
    const rawAlerts = db.getAlerts.all({ $since: since, $limit: 10000 }); // Note $ prefix

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

    res.json(alerts);
  } catch (error) {
    console.error('Error serving stats alerts from database:', error.message);
    res.status(500).json({ error: 'Failed to retrieve alert statistics' });
  }
});

/**
 * GET /api/stats/decisions
 * Returns ALL decisions (including expired) for statistics purposes from SQLite database
 */
app.get('/api/stats/decisions', ensureAuth, async (req, res) => {
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

    res.json(decisions);
  } catch (error) {
    console.error('Error serving stats decisions from database:', error.message);
    res.status(500).json({ error: 'Failed to retrieve decision statistics' });
  }
});

/**
 * POST /api/decisions
 * Creates a manual decision via POST /v1/alerts
 */
app.post('/api/decisions', ensureAuth, async (req, res) => {
  const doRequest = async () => {
    const { ip, duration = "4h", reason = "manual", type = "ban" } = req.body;

    if (!ip) {
      return res.status(400).json({ error: 'IP address is required' });
    }

    const now = new Date().toISOString();

    // Construct Alert Object with required fields
    // Note: The decision's duration field is used by LAPI to calculate the actual stop_at
    // We don't set stop_at on the alert itself to avoid double-counting
    const alertPayload = [{
      scenario: "manual/web-ui",
      campaign_name: "manual/web-ui",
      message: `Manual decision from Web UI: ${reason}`,
      events_count: 1,
      start_at: now,
      stop_at: now, // Alert stop_at - LAPI uses decision.duration for actual expiration
      capacity: 0,
      leakspeed: "0",
      simulated: false,
      events: [],
      scenario_hash: "",
      scenario_version: "",
      source: {
        scope: "ip",
        value: ip
      },
      decisions: [{
        type: type,
        duration: duration,
        value: ip,
        origin: "cscli",
        scenario: "manual/web-ui",
        scope: "ip"
      }]
    }];

    const response = await apiClient.post('/v1/alerts', alertPayload);

    // Immediately refresh cache to include new decision
    console.log('Refreshing cache after adding decision...');
    await initializeCache();

    res.json({ message: 'Decision added (via Alert)', result: response.data });
  };

  try {
    await doRequest();
  } catch (error) {
    handleApiError(error, res, 'adding decision', doRequest);
  }
});

/**
 * DELETE /api/decisions/:id
 */
app.delete('/api/decisions/:id', ensureAuth, async (req, res) => {
  const doRequest = async () => {
    const response = await apiClient.delete(`/v1/decisions/${req.params.id}`);

    // Immediately refresh cache to reflect deleted decision
    console.log('Refreshing cache after deleting decision...');
    await initializeCache();

    res.json(response.data || { message: 'Deleted' });
  };

  try {
    await doRequest();
  } catch (error) {
    handleApiError(error, res, 'deleting decision', doRequest);
  }
});

/**
 * GET /api/update-check
 */
app.get('/api/update-check', ensureAuth, async (req, res) => {
  try {
    const status = await checkForUpdates();
    res.json(status);
  } catch (error) {
    console.error('Error checking for updates:', error.message);
    res.status(500).json({ error: 'Update check failed' });
  }
});

// Serve static files from the "frontend/dist" directory.
app.use(express.static(path.join(__dirname, 'frontend/dist')));

// Catch-all handler for any request that doesn't match an API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend/dist/index.html'));
});

// ============================================================================
// CACHE INITIALIZATION AND SCHEDULER
// ============================================================================

// Initialize cache on startup
(async () => {
  // First, ensure we're logged in
  if (CROWDSEC_USER && CROWDSEC_PASSWORD) {
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

app.listen(port, () => {
  console.log(`CrowdSec Web UI backend running at http://localhost:${port}`);
});
