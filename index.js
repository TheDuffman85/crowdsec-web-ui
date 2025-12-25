const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

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

// Persist refresh interval to a config file
// Allow overriding via env var (for Docker persistence), otherwise default to local .config.json
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, '.config.json');

function loadPersistedConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      console.log('Loaded persisted config:', data);
      return data;
    } else {
      // Create empty config file if it doesn't exist
      console.log(`Config file not found at ${CONFIG_FILE}. Creating default...`);
      const defaultConfig = {};
      savePersistedConfig(defaultConfig);
      return defaultConfig;
    }
  } catch (error) {
    console.error('Error loading config file:', error.message);
  }
  return {};
}

function savePersistedConfig(config) {
  try {
    const configDir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log('Saved config to file:', config);
  } catch (error) {
    console.error('Error saving config file:', error.message);
  }
}

const app = express();
const port = process.env.PORT || 3000;

// CrowdSec Agent Configuration
// Agent Configuration
const AGENT_URL = process.env.AGENT_URL; // e.g., http://crowdsec-agent:3001
const AGENT_TOKEN = process.env.AGENT_TOKEN;

// Agent Client (REQUIRED)
let agentClient = null;
if (AGENT_URL && AGENT_TOKEN) {
  console.log(`Agent configured at ${AGENT_URL}`);

  const https = require('https');
  const agentTlsVerify = process.env.AGENT_TLS_VERIFY !== 'false';

  const httpsAgent = new https.Agent({
    rejectUnauthorized: agentTlsVerify
  });

  if (!agentTlsVerify) {
    console.warn('WARNING: Agent TLS validation is DISABLED (AGENT_TLS_VERIFY=false)');
  }

  agentClient = axios.create({
    baseURL: AGENT_URL,
    timeout: 30000,
    httpsAgent: httpsAgent,
    headers: {
      'Authorization': `Bearer ${AGENT_TOKEN}`
    }
  });
} else {
  console.error("FATAL: Agent not configured. AGENT_URL and AGENT_TOKEN are required in pure Agent mode.");
  process.exit(1);
}

// Global Agent Status Tracker
const agentStatus = {
  isConnected: true, // Optimistic, will rely on failures to set false
  lastCheck: new Date().toISOString(),
  lastError: null
};

// Helper to update Agent status
function updateAgentStatus(isConnected, error = null) {
  agentStatus.isConnected = isConnected;
  agentStatus.lastCheck = new Date().toISOString();
  agentStatus.lastError = error ? error.message : null;
}

// Historical Sync Status Tracker
const syncStatus = {
  isSyncing: false,
  progress: 0, // 0-100 percentage
  message: '',
  startedAt: null,
  completedAt: null
};

function updateSyncStatus(updates) {
  Object.assign(syncStatus, updates);
}

// Login helper
// Default lookback period (default 7 days / 168h)
const CROWDSEC_LOOKBACK_PERIOD = process.env.CROWDSEC_LOOKBACK_PERIOD || '168h';
console.log(`CrowdSec Lookback Period configured as: "${CROWDSEC_LOOKBACK_PERIOD}"`);

// Helper Functions
function parseLookbackToMs(lookback) {
  if (!lookback) return 7 * 24 * 60 * 60 * 1000; // Default 7d
  const match = lookback.match(/^(\d+)([dhms])$/);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const val = parseInt(match[1]);
  const unit = match[2];
  if (unit === 'd') return val * 24 * 60 * 60 * 1000;
  if (unit === 'h') return val * 60 * 60 * 1000;
  if (unit === 'm') return val * 60 * 1000;
  if (unit === 's') return val * 1000;
  return 7 * 24 * 60 * 60 * 1000;
}

function parseRefreshInterval(interval) {
  if (!interval || interval === 'manual' || interval === '0') return 0;
  const match = interval.match(/^(\d+)([sm])$/);
  if (!match) return 30000; // Default 30s
  const val = parseInt(match[1]);
  const unit = match[2];
  if (unit === 's') return val * 1000;
  if (unit === 'm') return val * 60 * 1000;
  return 30000;
}

function getIntervalName(ms) {
  if (ms === 0) return 'Manual';
  if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

function toDuration(targetTime) {
  const now = Date.now();
  const diff = now - new Date(targetTime).getTime();
  if (diff <= 0) return '0s';
  const minutes = Math.ceil(diff / 60000);
  return `${minutes}m`;
}

/**
 * Calculate the remaining duration from stop_at timestamp
 * Returns a Go-style duration string (e.g., "3h2m15s" or "-1h30m5s" for expired)
 */
function calculateRemainingDuration(stopAt) {
  if (!stopAt) return '0s';
  const now = Date.now();
  const stopTime = new Date(stopAt).getTime();
  let diffMs = stopTime - now;

  const isNegative = diffMs < 0;
  if (isNegative) diffMs = -diffMs;

  const hours = Math.floor(diffMs / 3600000);
  const minutes = Math.floor((diffMs % 3600000) / 60000);
  const seconds = Math.floor((diffMs % 60000) / 1000);

  let result = '';
  if (hours > 0) result += `${hours}h`;
  if (minutes > 0 || hours > 0) result += `${minutes}m`;
  result += `${seconds}s`;

  return isNegative ? `-${result}` : result;
}


const db = require('./sqlite');

// ============================================================================
// CACHE SYSTEM (SQLite Backed)
// ============================================================================

const LOOKBACK_MS = parseLookbackToMs(CROWDSEC_LOOKBACK_PERIOD);

// Load persisted config
const persistedConfig = loadPersistedConfig();
let REFRESH_INTERVAL_MS = persistedConfig.refresh_interval_ms !== undefined
  ? persistedConfig.refresh_interval_ms
  : parseRefreshInterval(process.env.CROWDSEC_REFRESH_INTERVAL || '30s');
let refreshTimer = null;

console.log(`Cache Configuration:
  Lookback Period: ${CROWDSEC_LOOKBACK_PERIOD} (${LOOKBACK_MS}ms)
  Refresh Interval: ${getIntervalName(REFRESH_INTERVAL_MS)}ms
`);

// --- Data Processing Helpers ---

function processDecisionItem(decision) {
  // Ensure we have a valid timestamp and scenario
  // Even for independent decisions, we want to ensure these fields exist
  const enrichedDecision = {
    ...decision,
    uuid: decision.uuid || String(decision.id),
    created_at: decision.created_at || new Date().toISOString(), // Fallback if absolutely missing
    stop_at: decision.stop_at || decision.created_at,
    origin: decision.origin || decision.scenario || 'unknown',
    scenario: decision.scenario || 'unknown',
    // Polyfill value if missing (e.g. if it's an Alert-like object)
    value: decision.value || (decision.source && decision.source.value) || (decision.source && decision.source.ip) || 'unknown'
  };

  // Aggressive Sanitization
  delete enrichedDecision.events;
  delete enrichedDecision.decisions;
  delete enrichedDecision.source;

  const decisionData = {
    id: decision.id,
    uuid: enrichedDecision.uuid,
    alert_id: decision.alert_id || null,
    created_at: enrichedDecision.created_at,
    stop_at: enrichedDecision.stop_at,
    value: decision.value,
    type: decision.type,
    origin: enrichedDecision.origin,
    scenario: enrichedDecision.scenario,
    raw_data: JSON.stringify(enrichedDecision)
  };

  try {
    db.insertDecision.run(decisionData);
  } catch (err) {
    console.error(`Failed to insert decision ${decision.id}:`, err.message);
  }
}

function processAlertForDb(alert) {
  const decisions = alert.decisions || [];

  if (decisions.length > 0 && decisions[0].events) {
    console.error("CRITICAL: Decision object looks like an Alert inside processAlertForDb!", JSON.stringify(decisions[0]).substring(0, 500));
  }

  // Insert Decisions
  decisions.forEach(decision => {
    // SECURITY GUARD: If decision object looks like an Alert (has events or decisions array), SKIP IT.
    // This handles the case where alert.decisions contains the alert itself or recurses.
    if (decision.events || decision.decisions) {
      console.warn(`SKIPPING SUSPICIOUS DECISION: Object has 'events' or 'decisions'. ID: ${decision.id}`);
      console.warn("Keys:", Object.keys(decision));
      return;
    }

    if (decision.id == alert.id) {
      return;
    }

    // Extract source info from alert for country/AS data
    const alertSource = alert.source || {};

    // Enrich decision details from Alert where possible
    // CRITICAL: We must include these enriched fields in raw_data for the frontend
    const enrichedDecision = {
      ...decision,
      created_at: decision.created_at || alert.created_at,
      stop_at: decision.stop_at || decision.created_at || alert.created_at,
      scenario: decision.scenario || alert.scenario || 'unknown',
      origin: decision.origin || decision.scenario || alert.scenario || 'unknown',
      alert_id: alert.id,
      // Ensure values needed for filtering are present
      // If decision is actually the Alert (missing value), use source.value
      value: decision.value || (decision.source && decision.source.value) || (decision.source && decision.source.ip) || alertSource.ip,
      type: decision.type || 'ban',
      // Add country and AS from alert source
      country: decision.country || alertSource.cn,
      as: decision.as || alertSource.as_name
    };


    // Sanitize: Remove Alert-specific fields that might cause confusion or bloat
    delete enrichedDecision.events;
    delete enrichedDecision.decisions;
    delete enrichedDecision.source;

    const decisionData = {
      id: decision.id,
      uuid: decision.id, // Assuming ID is unique enough, or use a composite
      alert_id: alert.id,
      created_at: enrichedDecision.created_at, // Use Alert timestamp if missing
      stop_at: enrichedDecision.stop_at, // Fallback
      value: decision.value,
      type: decision.type,
      origin: enrichedDecision.origin,
      scenario: enrichedDecision.scenario,
      raw_data: JSON.stringify(enrichedDecision) // Store the ENRICHED object
    };

    try {
      db.insertDecision.run(decisionData);
    } catch (err) {
      console.error(`Failed to insert decision ${decision.id}:`, err.message);
    }
  });

  // Insert Alert
  const alertData = {
    id: alert.id,
    uuid: alert.uuid || String(alert.id),
    created_at: alert.created_at,
    scenario: alert.scenario || 'unknown',
    source_ip: alert.source ? alert.source.ip : 'unknown',
    message: alert.message || '',
    raw_data: JSON.stringify(alert)
  };

  try {
    db.insertAlert.run(alertData);
  } catch (err) {
    console.error(`Failed to insert alert ${alert.id}:`, err.message);
  }
}

// Fetch alerts helper
async function fetchAlertsFromAgent(params) {
  try {
    const response = await agentClient.get('/alerts', { params });
    return response.data || [];
  } catch (error) {
    console.error('Error fetching alerts from Agent:', error.message);
    throw error;
  }
}

// Chunked Historical Sync
async function syncHistory() {
  console.log('Starting historical data sync...');

  updateSyncStatus({
    isSyncing: true,
    progress: 0,
    message: 'Starting historical data sync...',
    startedAt: new Date().toISOString(),
    completedAt: null
  });

  const now = Date.now();
  const lookbackStart = now - LOOKBACK_MS;
  const chunkSizeMs = 6 * 60 * 60 * 1000; // 6 hours
  const totalDuration = now - lookbackStart;

  // We sync from lookbackStart up to now in 6h chunks
  // BUT: The "since" and "until" parameters in LAPI are usually cleaner if we go chronological.
  // Let's go from Oldest -> Newest.

  let currentStart = lookbackStart;
  let totalAlerts = 0;

  while (currentStart < now) {
    const currentEnd = Math.min(currentStart + chunkSizeMs, now);

    // Calculate progress percentage
    const progress = Math.round(((currentEnd - lookbackStart) / totalDuration) * 100);

    // cscli expects relative duration for 'since'
    // since = duration ago from NOW.
    // until = duration ago from NOW.

    // For a chunk [start, end]:
    // since: (now - start)
    // until: (now - end)

    // Example: Now=12:00. Chunk 10:00-11:00.
    // since(10:00) = 2h
    // until(11:00) = 1h

    const sinceDuration = toDuration(currentStart);
    const untilDuration = toDuration(currentEnd);

    const progressMessage = `Syncing chunk: ${sinceDuration} ago → ${untilDuration} ago (${totalAlerts} alerts imported)`;
    console.log(progressMessage);
    updateSyncStatus({ progress, message: progressMessage });

    try {
      const alerts = await fetchAlertsFromAgent({
        since: sinceDuration,
        until: untilDuration,
        limit: 5000 // Large limit for chunks
      });

      if (alerts.length > 0) {
        const insertTransaction = db.db.transaction((items) => {
          for (const alert of items) processAlertForDb(alert);
        });
        insertTransaction(alerts);
        totalAlerts += alerts.length;
        console.log(`  -> Imported ${alerts.length} alerts.`);
      }
    } catch (err) {
      console.error(`Failed to sync chunk ${sinceDate}-${untilDate}:`, err.message);
      // Continue to next chunk? Or fail? 
      // Retrying might be better but let's continue for now to get partial data.
    }

    currentStart = currentEnd;

    // Small pause to prevent overwhelming agent?
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`Historical sync complete. Total imported: ${totalAlerts}`);

  // Sync active decisions before marking complete
  updateSyncStatus({ progress: 95, message: 'Syncing active decisions...' });
  await syncActiveDecisions();

  updateSyncStatus({
    isSyncing: false,
    progress: 100,
    message: `Sync complete. ${totalAlerts} alerts imported.`,
    completedAt: new Date().toISOString()
  });

  // Update last sync time
  db.setMeta.run('last_sync', new Date().toISOString());
}

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

// Sync active decisions from agent
async function syncActiveDecisions() {
  try {
    const decisionsRes = await agentClient.get('/decisions', { params: { limit: 10000 } });
    const rawResponse = decisionsRes.data || [];

    const activeDecisions = rawResponse.flatMap(alert => {
      const decisions = alert.decisions || [];
      return decisions.map(d => {
        const createdAt = d.created_at || alert.created_at || new Date().toISOString();
        let stopAt;

        // ALWAYS calculate stop_at from duration when available, as duration represents
        // the remaining time for active decisions. This fixes the regression where
        // decisions with old stop_at values from historical alerts weren't being updated.
        if (d.duration) {
          const ms = parseGoDuration(d.duration);
          stopAt = new Date(Date.now() + ms).toISOString();
        } else {
          stopAt = d.stop_at || alert.stop_at || createdAt;
        }

        const source = alert.source || {};
        return {
          ...d,
          alert_id: alert.id,
          created_at: createdAt,
          stop_at: stopAt,
          scenario: d.scenario || alert.scenario,
          country: source.cn,
          as: source.as_name
        };
      });
    });

    const nowStr = new Date().toISOString();
    if (activeDecisions.length > 0 || db.getActiveDecisions.all({ limit: 1, now: nowStr }).length > 0) {
      const activeIds = new Set(activeDecisions.map(d => String(d.id)));
      const dbActive = db.getActiveDecisions.all({ limit: 10000, now: nowStr });

      console.log(`Reconcile: Agent has ${activeIds.size} active, DB has ${dbActive.length} active.`);

      const upsertTransaction = db.transaction((agentDecisions) => {
        agentDecisions.forEach(item => processDecisionItem(item));
      });

      upsertTransaction(activeDecisions);

      let expiredCount = 0;
      dbActive.forEach(row => {
        try {
          const d = JSON.parse(row.raw_data);
          if (!activeIds.has(String(d.id))) {
            d.stop_at = nowStr;
            const info = db.insertDecision.run({
              id: d.id,
              uuid: d.uuid,
              alert_id: d.alert_id,
              created_at: d.created_at || row.created_at,
              stop_at: nowStr,
              value: d.value,
              type: d.type,
              origin: d.origin,
              scenario: d.scenario,
              raw_data: JSON.stringify(d)
            });

            if (info.changes > 0) {
              expiredCount++;
            }
          }
        } catch (e) {
          console.error(`Failed to expire decision ${row.id}`, e);
        }
      });

      if (expiredCount > 0) console.log(`Reconcile: Expired ${expiredCount} stale decisions.`);
      console.log(`Reconciliation complete. Active decisions synced.`);
    }
  } catch (err) {
    console.error("Failed to sync active decisions:", err.message);
  }
}

// Global Sync Function
async function updateCache() {
  const lastSyncMeta = db.getMeta.get('last_sync');
  const lastSyncTime = lastSyncMeta ? lastSyncMeta.value : null;

  // Cleanup Stale Data first
  const cutoffDate = new Date(Date.now() - LOOKBACK_MS).toISOString();
  db.deleteOldAlerts.run({ cutoff: cutoffDate });
  db.deleteOldDecisions.run({ cutoff: cutoffDate });

  // Check if we have any data
  const alertCount = db.countAlerts.get().count;

  // If no last sync OR no alerts in DB (corruption/flush), force full sync
  if (!lastSyncTime || alertCount === 0) {
    if (alertCount === 0 && lastSyncTime) {
      console.warn("Database appears empty but has last_sync. Forcing re-sync...");
    }
    // First run or reset
    await syncHistory();
  } else {
    // Delta Sync
    // We calculate time since last sync
    // LAPI 'since' excludes the exact timestamp usually, so maybe subtract a few seconds overlapping?
    // Delta Sync
    // We calculate time since last sync
    // LAPI 'since' excludes the exact timestamp usually, so maybe subtract a few seconds overlapping?
    // Use slightly larger window to be safe
    const sinceTime = new Date(lastSyncTime).getTime() - 60000; // 1m overlap
    const sinceDuration = toDuration(sinceTime);

    // console.log(`Fetching delta since ${since}...`);
    try {
      const alerts = await fetchAlertsFromAgent({ since: sinceDuration, limit: 5000 });
      if (alerts.length > 0) {
        console.log(`Delta sync: ${alerts.length} new alerts`);
        const insertTransaction = db.db.transaction((items) => {
          for (const alert of items) processAlertForDb(alert);
        });
        insertTransaction(alerts);
      }

      // Sync active decisions
      await syncActiveDecisions();

    } catch (err) {
      console.error("Delta sync failed:", err.message);
    }

    db.setMeta.run('last_sync', new Date().toISOString());
  }
}


// Scheduler Configuration
const IDLE_REFRESH_INTERVAL_MS = parseRefreshInterval(process.env.CROWDSEC_IDLE_REFRESH_INTERVAL || '5m');
const IDLE_THRESHOLD_MS = parseRefreshInterval(process.env.CROWDSEC_IDLE_THRESHOLD || '2m');
const FULL_REFRESH_INTERVAL_MS = parseRefreshInterval(process.env.CROWDSEC_FULL_REFRESH_INTERVAL || '1h'); // Default to 1h for full re-sync checks?

// Activity Tracker
let lastRequestTime = Date.now();
const activityTracker = (req, res, next) => {
  const now = Date.now();
  const wasIdle = (now - lastRequestTime) > IDLE_THRESHOLD_MS;
  lastRequestTime = now;

  if (wasIdle && isSchedulerRunning) {
    console.log("System waking up. Triggering refresh...");
    if (schedulerTimeout) clearTimeout(schedulerTimeout);
    runSchedulerLoop();
  }
  next();
};

// Scheduler Loop
let schedulerTimeout = null;
let isSchedulerRunning = false;

async function runSchedulerLoop() {
  if (!isSchedulerRunning) return;

  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  const isIdle = timeSinceLastRequest > IDLE_THRESHOLD_MS;

  try {
    if (!isIdle) {
      await updateCache();
    }
  } catch (err) {
    console.error("Scheduler error:", err);
  }

  if (!isSchedulerRunning) return;

  // Determine next interval
  let currentTargetInterval = REFRESH_INTERVAL_MS;
  if (isIdle) {
    currentTargetInterval = IDLE_REFRESH_INTERVAL_MS;
  }

  if (currentTargetInterval > 0) {
    schedulerTimeout = setTimeout(runSchedulerLoop, currentTargetInterval);
  } else {
    isSchedulerRunning = false;
  }
}

function startRefreshScheduler() {
  stopRefreshScheduler();
  if (REFRESH_INTERVAL_MS > 0) {
    console.log(`Starting scheduler (Active: ${getIntervalName(REFRESH_INTERVAL_MS)}, Idle: ${getIntervalName(IDLE_REFRESH_INTERVAL_MS)})`);
    isSchedulerRunning = true;
    runSchedulerLoop(); // Run immediately on start
  }
}

function stopRefreshScheduler() {
  isSchedulerRunning = false;
  if (schedulerTimeout) clearTimeout(schedulerTimeout);
  schedulerTimeout = null;
}

// API Functions need to change to read from DB
// ... they will be in the routes below ...

// ============================================================================
// UPDATE CHECKER (GHCR)
// ============================================================================

const UPDATE_CHECK_CACHE_DURATION = 6 * 60 * 60 * 1000; // 6 hours
let updateCheckCache = {
  lastCheck: 0,
  data: null
};

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
  // Return cached result if valid
  const now = Date.now();
  if (updateCheckCache.data && (now - updateCheckCache.lastCheck < UPDATE_CHECK_CACHE_DURATION)) {
    return updateCheckCache.data;
  }

  const currentBranch = process.env.VITE_BRANCH || 'main'; // Default to main if not set (which maps to latest)
  const currentHash = process.env.VITE_COMMIT_HASH;

  // Map branch to tag
  let tag = 'latest';
  if (currentBranch === 'dev') {
    tag = 'dev';
  } else if (currentBranch === 'feature/agent' || currentBranch === 'agent') {
    tag = 'agent';
  }

  if (!currentHash) {
    console.log('Update check skipped: VITE_COMMIT_HASH not set.');
    return { update_available: false, reason: 'no_local_hash' };
  }

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

// ============================================================================
// END UPDATE CHECKER
// ============================================================================

app.use(cors());
app.use(express.json());
app.use(activityTracker); // Apply to all routes



// Allowlist Management Proxies
app.get('/api/allowlist', (req, res) => proxyToAgent(req, res, 'get', '/allowlist'));
app.post('/api/allowlist', (req, res) => proxyToAgent(req, res, 'post', '/allowlist', req.body));
app.delete('/api/allowlist', (req, res) => proxyToAgent(req, res, 'delete', '/allowlist', req.body));

// Helper for Agent Proxy
const proxyToAgent = async (req, res, method, path, data = null) => {
  if (!agentClient) {
    return res.status(501).json({ error: 'Agent not configured' });
  }
  try {
    const response = await agentClient.request({
      method: method,
      url: path,
      data: data,
      params: req.query // Forward query params like 'limit'
    });
    res.json(response.data);
  } catch (error) {
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(502).json({ error: 'Agent communication failed' });
    }
  }
};

// --- Agent Proxy Routes ---

// Delete Alert
app.delete('/api/alerts/:id', async (req, res) => {
  try {
    // 1. Send delete request to Agent
    await agentClient.delete(`/alerts/${req.params.id}`);

    // 2. Clear from local cache if successful
    const alertId = req.params.id;

    // SQLite Delete
    try {
      db.transaction(() => {
        // Delete decisions linked to this alert
        db.deleteDecisionsByAlertId.run({ alert_id: alertId });
        // Delete the alert
        db.deleteAlert.run({ id: alertId });
      })();
      console.log(`Deleted alert ${alertId} and associated decisions from DB`);
    } catch (err) {
      console.error(`Failed to delete alert ${alertId} locally:`, err.message);
    }

    res.json({ success: true, message: `Alert ${alertId} deleted` });
  } catch (error) {
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      console.error(`Error deleting alert ${req.params.id}: ${error.message}`);
      res.status(502).json({ error: 'Agent communication failed' });
    }
  }
});

// Add Decision
app.post('/api/decisions', (req, res) => {
  proxyToAgent(req, res, 'POST', '/decisions', req.body);
});

// Delete Decision
app.delete('/api/decisions/:id', async (req, res) => {
  try {
    // 1. Send delete request to Agent
    await agentClient.delete(`/decisions/${req.params.id}`);

    // 2. Clear from local cache if successful
    const decisionId = req.params.id;

    try {
      db.deleteDecision.run({ id: decisionId });
      console.log(`Deleted decision ${decisionId} from DB`);
    } catch (err) {
      console.error(`Failed to delete decision ${decisionId} locally:`, err.message);
    }

    res.json({ success: true, message: `Decision ${decisionId} deleted` });
  } catch (error) {
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      console.error(`Error deleting decision ${req.params.id}: ${error.message}`);
      res.status(502).json({ error: 'Agent communication failed' });
    }
  }
});

// Add Allowlist (Add Decision with type=allow)
app.post('/api/allowlist', (req, res) => {
  proxyToAgent(req, res, 'POST', '/allowlist', req.body);
});

// --- End Agent Proxy Routes ---



/**
 * Helper to hydrate an alert's decisions with fresh data from the active cache
 * This ensures even stale alerts (from delta updates) show current decision loops
 */
/**
 * Helper to hydrate an alert's decisions with fresh data from the active decisions map
 */
const hydrateAlertWithDecisions = (alert, activeDecisionsMap) => {
  const alertClone = { ...alert };

  if (alertClone.decisions && Array.isArray(alertClone.decisions)) {
    alertClone.decisions = alertClone.decisions.map(decision => {
      const cachedDecision = activeDecisionsMap.get(String(decision.id));

      if (cachedDecision) {
        return {
          ...decision,
          duration: cachedDecision.detail?.duration || decision.duration,
          stop_at: cachedDecision.detail?.expiration || decision.stop_at,
          type: cachedDecision.detail?.type || decision.type,
          value: cachedDecision.value || decision.value,
          origin: cachedDecision.detail?.origin || decision.origin,
          expired: false
        };
      } else {
        // Not in active map = Expired or Deleted
        const now = new Date();
        const stopAt = decision.stop_at ? new Date(decision.stop_at) : null;

        if (!stopAt || stopAt > now) {
          return {
            ...decision,
            stop_at: new Date(Date.now() - 1000).toISOString()
          };
        }
      }
      return decision;
    });
  }
  return alertClone;
};

/**
 * GET /api/alerts
 * Returns alerts from DB
 */
app.get('/api/alerts', async (req, res) => {
  try {
    if (REFRESH_INTERVAL_MS === 0) await updateCache();

    // Fetch alerts within lookback
    const cutoffDate = new Date(Date.now() - LOOKBACK_MS).toISOString();
    const rawAlerts = db.getAlerts.all({ since: cutoffDate, limit: 5000 });

    // Fetch active decisions for hydration
    const rawDecisions = db.getActiveDecisions.all({ limit: 10000, now: new Date().toISOString() });
    const activeDecisionsMap = new Map();

    rawDecisions.forEach(row => {
      try {
        const d = JSON.parse(row.raw_data);
        activeDecisionsMap.set(String(d.id), d);
      } catch (e) { }
    });

    const alerts = rawAlerts.map(row => {
      try {
        const a = JSON.parse(row.raw_data);
        return hydrateAlertWithDecisions(a, activeDecisionsMap);
      } catch (e) { return null; }
    }).filter(a => a !== null);

    // Sort by created_at desc (already sorted by SQL but JSON parse might need check? SQL order is reliable)
    // SQL: ORDER BY created_at DESC

    res.json(alerts);
  } catch (error) {
    console.error('Error serving alerts from db:', error.message);
    res.status(500).json({ error: 'Failed to retrieve alerts' });
  }
});

/**
 * GET /api/alerts/:id
 */
app.get('/api/alerts/:id', async (req, res) => {
  try {
    console.log(`Fetching alert details from Agent: ${req.params.id}`);
    const response = await agentClient.get(`/alerts/${req.params.id}`);
    let alertData = response.data;

    // We can try to hydrate with DB active decisions too, but for single alert agent fetch is usually fresh.
    // However, consistency? 
    // Let's just return what Agent gave us, or hydrate if we want to force local decision state.
    // For now, simple return involves less complexity.
    res.json(alertData);
  } catch (error) {
    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      console.error(`Error fetching alert details: ${error.message}`);
      res.status(502).json({ error: 'Agent communication failed' });
    }
  }
});

/**
 * GET /api/decisions
 */
app.get('/api/decisions', async (req, res) => {
  try {
    if (REFRESH_INTERVAL_MS === 0) await updateCache();

    const includeExpired = req.query.include_expired === 'true';
    const cutoffDate = new Date(Date.now() - LOOKBACK_MS).toISOString();

    let rawDecisions;
    if (includeExpired) {
      // Fetch all within lookback
      rawDecisions = db.getDecisionsSince.all({ since: cutoffDate });
    } else {
      // Active only
      rawDecisions = db.getActiveDecisions.all({ limit: 10000, now: new Date().toISOString() });
    }

    const decisions = rawDecisions.map(row => {
      try {
        const decision = JSON.parse(row.raw_data);
        // Recalculate duration dynamically from stop_at
        // This ensures expired decisions show negative durations like "-1h30m5s"
        // and active decisions show accurate remaining time
        if (decision.stop_at) {
          decision.duration = calculateRemainingDuration(decision.stop_at);
        }
        return decision;
      } catch (e) { return null; }
    }).filter(d => d !== null);

    res.json(decisions);

  } catch (error) {
    console.error('Error serving decisions from db:', error.message);
    res.status(500).json({ error: 'Failed to retrieve decisions' });
  }
});


/**
 * GET /api/config
 * Returns the public configuration for the frontend
 */
app.get('/api/config', (req, res) => {
  // Simple parser to estimate days/hours for display
  // Supports h, d. Default 168h.
  let hours = 168;
  const rawDuration = CROWDSEC_LOOKBACK_PERIOD || '';
  const duration = rawDuration.toLowerCase().trim();

  const match = duration.match(/^(\d+)([a-z]*)$/);
  if (match) {
    const val = parseInt(match[1]);
    const unit = match[2];

    if (unit === 'd' || unit === 'day' || unit === 'days') hours = val * 24;
    else if (unit === 'h' || unit === 'hour' || unit === 'hours') hours = val;
    else if (unit === '') {
      // Fallback: If no unit, assume days if value is small (< 100), else hours? 
      // Or just assume days as that's the primary dashboard metric.
      // Let's assume Days for user convenience in this customized dashboard context.
      if (val < 1000) hours = val * 24;
      else hours = val; // Large number likely hours (e.g. 720)
    }
  }

  // Return current runtime state
  res.json({
    lookback_period: CROWDSEC_LOOKBACK_PERIOD,
    lookback_hours: hours,
    lookback_days: Math.max(1, Math.round(hours / 24)),
    refresh_interval: REFRESH_INTERVAL_MS,
    current_interval_name: getIntervalName(REFRESH_INTERVAL_MS),
    agent_status: agentStatus,
    online: agentStatus.isConnected,
    last_check: agentStatus.lastCheck,
    update_available: updateCheckCache.data ? updateCheckCache.data.update_available : false,
    update_info: updateCheckCache.data,
    sync_status: syncStatus,
    capabilities: {
      agent: !!agentClient,
    }
  });
});

/**
 * PUT /api/config/refresh-interval
 * Updates the refresh interval at runtime and restarts the scheduler
 */
app.put('/api/config/refresh-interval', (req, res) => {
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
 * GET /api/stats/decisions
 * Returns ALL decisions (including expired) for statistics purposes from DB
 */
app.get('/api/stats/decisions', async (req, res) => {
  try {
    if (REFRESH_INTERVAL_MS === 0) await updateCache();

    // Fetch decisions since lookback
    const cutoffDate = new Date(Date.now() - LOOKBACK_MS).toISOString();
    const rawDecisions = db.getDecisionsSince.all({ since: cutoffDate });

    const decisions = rawDecisions.map(row => {
      try {
        const decision = JSON.parse(row.raw_data);
        // Recalculate duration dynamically from stop_at (same as /api/decisions)
        if (decision.stop_at) {
          decision.duration = calculateRemainingDuration(decision.stop_at);
        }
        return decision;
      } catch (e) { return null; }
    }).filter(d => d !== null);

    res.json(decisions);
  } catch (error) {
    console.error('Error serving stats decisions from db:', error.message);
    res.status(500).json({ error: 'Failed to retrieve decision statistics' });
  }
});





/**
 * GET /api/update-check
 */
app.get('/api/update-check', async (req, res) => {
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
  if (agentClient) {
    console.log('Starting cache initialization...');
    try {
      await updateCache();
    } catch (e) {
      console.error('Initial cache update failed:', e);
    }

    // Start background refresh scheduler
    startRefreshScheduler();
  } else {
    console.warn('Cache initialization skipped - agent not configured');
  }
})();

// ============================================================================

const server = app.listen(port, '0.0.0.0', () => { console.log(`Server listening on port ${port}`); });
