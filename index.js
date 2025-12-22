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

// CrowdSec LAPI Configuration
// Agent Configuration
const AGENT_URL = process.env.AGENT_URL; // e.g., http://crowdsec-agent:3001
const AGENT_TOKEN = process.env.AGENT_TOKEN;

// Agent Client (REQUIRED)
let agentClient = null;
if (AGENT_URL && AGENT_TOKEN) {
  console.log(`Agent configured at ${AGENT_URL}`);
  agentClient = axios.create({
    baseURL: AGENT_URL,
    timeout: 30000, // Higher timeout for cscli operations
    headers: {
      'Authorization': `Bearer ${AGENT_TOKEN}`
    }
  });
} else {
  console.error("FATAL: Agent not configured. AGENT_URL and AGENT_TOKEN are required in pure Agent mode.");
  process.exit(1);
}

// Global LAPI Status Tracker (Mocked or Agent Status)
const lapiStatus = {
  isConnected: true, // Optimistic, will rely on failures to set false
  lastCheck: new Date().toISOString(),
  lastError: null
};

// Helper to update LAPI status (now Agent status really)
function updateLapiStatus(isConnected, error = null) {
  lapiStatus.isConnected = isConnected;
  lapiStatus.lastCheck = new Date().toISOString();
  lapiStatus.lastError = error ? error.message : null;
}


// Login helper
// Default lookback period (default 7 days / 168h)
const CROWDSEC_LOOKBACK_PERIOD = process.env.CROWDSEC_LOOKBACK_PERIOD || '168h';

// ============================================================================
// CACHE SYSTEM
// ============================================================================

// In-memory cache for alerts and decisions
const cache = {
  alerts: new Map(),           // Map<id, alert>
  decisions: new Map(),        // Map<id, decision>
  decisionsForStats: new Map(), // Map<id, decision> (all including expired)
  lastUpdate: null,            // ISO timestamp of last successful fetch
  isInitialized: false         // Whether initial load is complete
};



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
  Refresh Interval: ${getIntervalName ? getIntervalName(REFRESH_INTERVAL_MS) : REFRESH_INTERVAL_MS}ms (${persistedConfig.refresh_interval_ms !== undefined ? 'from saved config' : 'from env'})
`);

// Fetch alerts from LAPI with optional 'since' parameter and active decision filter
// Fetch alerts from Agent
async function fetchAlertsFromAgent(since = null) {
  const params = {};
  if (since) params.since = since;
  params.limit = 5000; // Cap to avoid massive payloads

  try {
    console.log(`Fetching alerts from Agent (since: ${since || 'all'})...`);
    const response = await agentClient.get('/alerts', { params });
    // Assuming Agent returns standard LAPI-like array of alerts
    return response.data || [];
  } catch (error) {
    console.error('Error fetching alerts from Agent:', error.message);
    throw error;
  }
}

// Initial cache load - fetch full dataset
async function initializeCache() {
  try {
    console.log('Initializing cache with full data load...');

    // Fetch all alerts from Agent
    const allAlerts = await fetchAlertsFromAgent(CROWDSEC_LOOKBACK_PERIOD);
    console.log(`Loaded ${allAlerts.length} alerts into cache`);

    // In Agent mode, we don't have a direct "alerts with active decisions" filter easily via cscli list unless we parse everything.
    // However, we can use the main alerts list if it's comprehensive.
    // OR we can explicitly fetch decisions which we need anyway for decisions cache.

    // Fetch ALL decisions for accurate decision cache
    // Note: cscli decisions list -a returns all including expired? By default active.
    // We want active for sure.
    const activeDecisionsRes = await agentClient.get('/decisions', { params: { limit: 10000 } });
    const activeDecisions = activeDecisionsRes.data || [];
    console.log(`Loaded ${activeDecisions.length} active decisions from Agent`);

    // Populate alerts cache
    allAlerts.forEach(alert => {
      cache.alerts.set(alert.id, alert);

      // Extract all decisions for stats
      if (Array.isArray(alert.decisions)) {
        alert.decisions.forEach(decision => {
          if (decision.origin !== 'CAPI') {
            cache.decisionsForStats.set(String(decision.id), {
              id: decision.id,
              created_at: decision.created_at || alert.created_at,
              scenario: decision.scenario || alert.scenario || "N/A",
              value: decision.value,
              stop_at: decision.stop_at
            });
          }
        });
      }
    });

    // Populate active decisions cache directly from the decisions list
    // Ensure data structure matches
    activeDecisions.forEach(decision => {
      // cscli json output for decisions might be slightly different or missing alert details if not expanded.
      // But usually it contains enough info.
      // We map it to our internal structure.
      const decisionData = {
        id: decision.id,
        created_at: decision.created_at,
        scenario: decision.scenario || "N/A",
        value: decision.value,
        expired: false,
        detail: {
          origin: decision.origin || "manual",
          type: decision.type,
          reason: decision.scenario || "manual",
          action: decision.type,
          country: decision.scenario?.includes("geo") ? "Unknown" : "Unknown", // Enriched data might be missing in simple list
          as: "Unknown",
          events_count: decision.events_count || 0,
          duration: decision.duration || "N/A",
          expiration: decision.stop_at,
          alert_id: decision.alert_id, // Important for linking
          message: "", // Might be missing
        }
      };

      // Try to enrich from alerts cache if possible
      if (decision.alert_id && cache.alerts.has(decision.alert_id)) {
        const alert = cache.alerts.get(decision.alert_id);
        decisionData.detail.country = alert.source?.cn || "Unknown";
        decisionData.detail.as = alert.source?.as_name || "Unknown";
        decisionData.detail.message = alert.message;
        decisionData.detail.events = alert.events;
      }

      cache.decisions.set(String(decision.id), decisionData);
    });

    cache.lastUpdate = new Date().toISOString();
    cache.isInitialized = true;

    console.log(`Cache initialized successfully:
  - ${cache.alerts.size} alerts
  - ${cache.decisions.size} active decisions
  - ${cache.decisionsForStats.size} total decisions
  - Last update: ${cache.lastUpdate}
`);
    updateLapiStatus(true);

  } catch (error) {
    console.error('Failed to initialize cache:', error.message);
    cache.isInitialized = false;
    updateLapiStatus(false, error);
  }
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

    // Fetch new alerts from Agent
    const newAlerts = await fetchAlertsFromAgent(sinceDuration);

    // Refresh active decisions fully to catch expirations/deletions
    // Optimization: In pure agent mode with cscli, we can just list active decisions.
    const activeDecisionsRes = await agentClient.get('/decisions', { params: { limit: 10000 } });
    const activeDecisions = activeDecisionsRes.data || [];

    // Rebuild active decisions cache
    cache.decisions.clear();
    activeDecisions.forEach(decision => {
      const decisionData = {
        id: decision.id,
        created_at: decision.created_at,
        scenario: decision.scenario || "N/A",
        value: decision.value,
        expired: false,
        detail: {
          origin: decision.origin || "manual",
          type: decision.type,
          reason: decision.scenario || "manual",
          action: decision.type,
          country: "Unknown",
          as: "Unknown",
          events_count: decision.events_count || 0,
          duration: decision.duration || "N/A",
          expiration: decision.stop_at,
          alert_id: decision.alert_id,
        }
      };
      if (decision.alert_id && cache.alerts.has(decision.alert_id)) {
        const alert = cache.alerts.get(decision.alert_id);
        decisionData.detail.country = alert.source?.cn || "Unknown";
        decisionData.detail.as = alert.source?.as_name || "Unknown";
        decisionData.detail.message = alert.message;
      }
      cache.decisions.set(String(decision.id), decisionData);
    });

    // Add new alerts and their stats decisions
    if (newAlerts.length > 0) {
      console.log(`Delta update: ${newAlerts.length} new alerts`);

      newAlerts.forEach(alert => {
        cache.alerts.set(alert.id, alert);

        if (Array.isArray(alert.decisions)) {
          alert.decisions.forEach(decision => {
            if (decision.origin !== 'CAPI' && !cache.decisionsForStats.has(decision.id)) {
              cache.decisionsForStats.set(String(decision.id), {
                id: decision.id,
                created_at: decision.created_at || alert.created_at,
                scenario: decision.scenario || alert.scenario || "N/A",
                value: decision.value,
                stop_at: decision.stop_at
              });
            }
          });
        }
      });
    }

    cache.lastUpdate = new Date().toISOString();

    console.log(`Delta update complete: ${cache.alerts.size} alerts, ${cache.decisions.size} active decisions`);
    updateLapiStatus(true);

  } catch (error) {
    console.error('Failed to update cache delta:', error.message);
    updateLapiStatus(false, error);
  }
}

// Cleanup old data beyond lookback period
function cleanupOldData() {
  const cutoffDate = new Date(Date.now() - LOOKBACK_MS);

  let removedAlerts = 0;
  let removedDecisions = 0;
  let removedStatsDecisions = 0;

  // Remove old alerts
  for (const [id, alert] of cache.alerts.entries()) {
    if (alert.created_at && new Date(alert.created_at) < cutoffDate) {
      cache.alerts.delete(id);
      removedAlerts++;
    }
  }

  // Remove old decisions
  for (const [id, decision] of cache.decisions.entries()) {
    if (decision.created_at && new Date(decision.created_at) < cutoffDate) {
      cache.decisions.delete(id);
      removedDecisions++;
    }
  }

  // Remove old stats decisions
  for (const [id, decision] of cache.decisionsForStats.entries()) {
    if (decision.created_at && new Date(decision.created_at) < cutoffDate) {
      cache.decisionsForStats.delete(id);
      removedStatsDecisions++;
    }
  }

  if (removedAlerts > 0 || removedDecisions > 0 || removedStatsDecisions > 0) {
    console.log(`Cleanup: Removed ${removedAlerts} old alerts, ${removedDecisions} old decisions, ${removedStatsDecisions} old stats decisions`);
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
  const tag = currentBranch === 'dev' ? 'dev' : 'latest';

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

// API: Config / Capabilities
app.get('/api/config', (req, res) => {
  res.json({
    online: lapiStatus.isConnected,
    last_check: lapiStatus.lastCheck,
    update_available: updateCheckCache.data ? updateCheckCache.data.update_available : false,
    update_info: updateCheckCache.data,
    capabilities: {
      agent: !!agentClient,
    }
  });
});

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
app.delete('/api/alerts/:id', (req, res) => {
  proxyToAgent(req, res, 'DELETE', `/alerts/${req.params.id}`);
});

// Add Decision
app.post('/api/decisions', (req, res) => {
  proxyToAgent(req, res, 'POST', '/decisions', req.body);
});

// Delete Decision
app.delete('/api/decisions/:id', (req, res) => {
  proxyToAgent(req, res, 'DELETE', `/decisions/${req.params.id}`);
});

// Add Allowlist (Add Decision with type=allow)
app.post('/api/allowlist', (req, res) => {
  proxyToAgent(req, res, 'POST', '/allowlist', req.body);
});

// --- End Agent Proxy Routes ---

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
 * Helper to hydrate an alert's decisions with fresh data from the active cache
 * This ensures even stale alerts (from delta updates) show current decision loops
 */
const hydrateAlertWithDecisions = (alert) => {
  // Clone to safe mutate
  const alertClone = { ...alert };

  if (alertClone.decisions && Array.isArray(alertClone.decisions)) {
    alertClone.decisions = alertClone.decisions.map(decision => {
      // Check if we have fresh data for this decision in our active cache
      // The cache.decisions map contains the LATEST data from LAPI
      const cachedDecision = cache.decisions.get(String(decision.id));

      if (cachedDecision) {
        // Hydrate with fresh details where applicable
        // We preserve the original ID/structure but update mutable fields
        return {
          ...decision,
          duration: cachedDecision.detail?.duration || decision.duration, // Update duration string
          stop_at: cachedDecision.detail?.expiration || decision.stop_at, // Update expiration time
          type: cachedDecision.detail?.type || decision.type,
          value: cachedDecision.value || decision.value,
          origin: cachedDecision.detail?.origin || decision.origin,
          expired: cachedDecision.expired // Add expired status from cache (LAPI truth)
        };
      } else {
        // Not in active cache = Expired or Deleted
        // Force it to look expired if it doesn't already
        const now = new Date();
        const stopAt = decision.stop_at ? new Date(decision.stop_at) : null;

        if (!stopAt || stopAt > now) {
          return {
            ...decision,
            stop_at: new Date(Date.now() - 1000).toISOString() // Set to 1s ago
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
 * Returns alerts from cache
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

    // Return alerts from cache, hydrated with fresh decision status
    const cachedAlerts = Array.from(cache.alerts.values());
    const alerts = cachedAlerts.map(hydrateAlertWithDecisions);

    alerts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json(alerts);
  } catch (error) {
    console.error('Error serving alerts from cache:', error.message);
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
 * Returns decisions from cache (active by default, or all including expired with ?include_expired=true)
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

    // Return decisions from cache
    let decisions;
    if (includeExpired) {
      // Convert decisionsForStats to full decision object format
      decisions = Array.from(cache.decisionsForStats.values()).map(d => {
        // OPTIMIZATION: Check if we have fresh data in the active decisions cache
        // This ensures that active decisions returned in this list have up-to-date durations
        const activeDecision = cache.decisions.get(String(d.id));
        if (activeDecision) {
          return activeDecision;
        }

        // Find matching alert to get full details
        const alert = Array.from(cache.alerts.values()).find(a =>
          a.decisions && a.decisions.some(dec => dec.id === d.id)
        );

        const isExpired = d.stop_at && new Date(d.stop_at) < new Date();

        return {
          id: d.id,
          created_at: d.created_at,
          scenario: d.scenario,
          value: d.value,
          expired: isExpired,
          detail: alert ? {
            origin: alert.decisions.find(dec => dec.id === d.id)?.origin || "manual",
            type: alert.decisions.find(dec => dec.id === d.id)?.type,
            reason: d.scenario,
            action: alert.decisions.find(dec => dec.id === d.id)?.type,
            country: alert.source?.cn || "Unknown",
            as: alert.source?.as_name || "Unknown",
            events_count: alert.events_count || 0,
            duration: alert.decisions.find(dec => dec.id === d.id)?.duration || "N/A",
            expiration: d.stop_at,
            alert_id: alert.id,
            message: alert.message,
            events: alert.events,
            machine_alias: alert.machine_alias,
            machine_id: alert.machine_id
          } : {}
        };
      });
    } else {
      // Return only active decisions from cache
      // Cache already filters expired decisions during initialization and delta updates
      decisions = Array.from(cache.decisions.values());
    }

    decisions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json(decisions);
  } catch (error) {
    console.error('Error serving decisions from cache:', error.message);
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
    lookback_days: Math.max(1, Math.round(hours / 24)),
    refresh_interval: REFRESH_INTERVAL_MS,
    current_interval_name: getIntervalName(REFRESH_INTERVAL_MS),
    lapi_status: lapiStatus
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
 * GET /api/stats/decisions
 * Returns ALL decisions (including expired) for statistics purposes from cache
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

    // Return all decisions from decisionsForStats
    const decisions = Array.from(cache.decisionsForStats.values());
    decisions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json(decisions);
  } catch (error) {
    console.error('Error serving stats decisions from cache:', error.message);
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

    // Measure duration to calculate stop_at
    // Simple parsing for 4h, 1d etc.
    let stopAt = new Date();
    const durationMatch = duration.match(/^(\d+)([hmds])$/);
    if (durationMatch) {
      const val = parseInt(durationMatch[1]);
      const unit = durationMatch[2];
      if (unit === 'h') stopAt.setHours(stopAt.getHours() + val);
      if (unit === 'm') stopAt.setMinutes(stopAt.getMinutes() + val);
      if (unit === 'd') stopAt.setDate(stopAt.getDate() + val);
      if (unit === 's') stopAt.setSeconds(stopAt.getSeconds() + val);
    } else {
      // default 4 hours if parsing fails
      stopAt.setHours(stopAt.getHours() + 4);
    }

    // Construct Alert Object with required fields
    const alertPayload = [{
      scenario: "manual/web-ui",
      campaign_name: "manual/web-ui", // optional but good practice
      message: `Manual decision from Web UI: ${reason}`,
      events_count: 1,
      start_at: new Date().toISOString(),
      stop_at: stopAt.toISOString(),
      capacity: 0,
      leakspeed: "0",
      simulated: false,
      events: [], // Required by LAPI strict validation
      scenario_hash: "", // Required
      scenario_version: "", // Required
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

// ============================================================================



const server = app.listen(port, '0.0.0.0', () => { console.log(`Server listening on port ${port}`); });
