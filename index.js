const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

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
      return true;
    } else {
      console.error('Login response did not contain token:', response.data);
      return false;
    }
  } catch (error) {
    console.error(`Login failed: ${error.message}`);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
    return false;
  }
};

// Initial login
if (CROWDSEC_USER && CROWDSEC_PASSWORD) {
  loginToLAPI();
}

app.use(cors());
app.use(express.json());

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
 * GET /api/alerts
 */
app.get('/api/alerts', ensureAuth, async (req, res) => {
  const doRequest = async () => {
    // Default to configured lookback period if not specified
    const since = req.query.since || CROWDSEC_LOOKBACK_PERIOD;

    // Filter by origin at LAPI level
    // origin: cscli (manual), crowdsec (scenarios), cscli-import (imported)
    // Exclude CAPI by not requesting it.
    // ALSO fetch by scope (Ip, Range) to catch alerts with undefined origin (e.g. WAF logs without decisions)
    // CAPI usually uses specific scopes (like list names), so querying Scope=Ip/Range effectively filters CAPI too.
    const origins = ['cscli', 'crowdsec', 'cscli-import', 'manual', 'appsec', 'lists'];
    const scopes = ['Ip', 'Range'];

    // Execute requests in parallel
    const limit = 10000;
    const originPromises = origins.map(o => apiClient.get(`/v1/alerts?since=${since}&origin=${o}&limit=${limit}`));
    const scopePromises = scopes.map(s => apiClient.get(`/v1/alerts?since=${since}&scope=${s}&limit=${limit}`));

    const responses = await Promise.all([...originPromises, ...scopePromises]);

    let alertMap = new Map();
    responses.forEach(r => {
      if (r.data && Array.isArray(r.data)) {
        r.data.forEach(alert => {
          alertMap.set(alert.id, alert);
        });
      }
    });

    const alertArray = Array.from(alertMap.values());

    console.log(`Fetched ${alertArray.length} unique alerts (excluding CAPI) Since: ${since}`);
    alertArray.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json(alertArray);
  };

  try {
    await doRequest();
  } catch (error) {
    handleApiError(error, res, 'fetching alerts', doRequest);
  }
});

/**
 * GET /api/alerts/:id
 */
app.get('/api/alerts/:id', ensureAuth, async (req, res) => {
  const doRequest = async () => {
    const response = await apiClient.get(`/v1/alerts/${req.params.id}`);
    res.json(response.data);
  };

  try {
    await doRequest();
  } catch (error) {
    handleApiError(error, res, 'fetching alert details', doRequest);
  }
});

/**
 * GET /api/decisions
 * Retrieves decisions (active by default, or all including expired with ?include_expired=true).
 * Since Machines (Watchers) cannot access GET /v1/decisions, we fetch alerts with decisions.
 */
app.get('/api/decisions', ensureAuth, async (req, res) => {
  const doRequest = async () => {
    const includeExpired = req.query.include_expired === 'true';
    const since = req.query.since || CROWDSEC_LOOKBACK_PERIOD;

    // Fetch alerts that have decisions
    // Filtering by origin at LAPI level and Scope to include all relevant alerts
    const origins = ['cscli', 'crowdsec', 'cscli-import', 'manual', 'appsec', 'lists'];
    const scopes = ['Ip', 'Range'];

    // Execute requests in parallel
    // If includeExpired is true, we just want everything since X time.
    // If includeExpired is false (active only), technically we want decisions that haven't stopped yet.
    // LAPI 'alert' endpoint doesn't strictly filter 'active decisions' easily combined with 'since' in a way that excludes old alerts with still-active decisions if the alert is too old. 
    // However, usually decisions are recent. 
    // We will ask for alerts 'since' the duration, and then filter for active/expired.

    // Note: 'has_active_decision=true' is useful but if we want strictly time based, 'since' is better.
    // But for "Active Decisions" view, we probably want ALL active decisions regardless of when the alert started?
    // The user requested: "limit the data with the since parameter to 7 days by default".
    // So we will apply 'since' to this query as well.
    const queryParam = includeExpired ? `since=${since}` : `has_active_decision=true&since=${since}`;

    const limit = 10000;
    const originPromises = origins.map(o => apiClient.get(`/v1/alerts?${queryParam}&origin=${o}&limit=${limit}`));
    const scopePromises = scopes.map(s => apiClient.get(`/v1/alerts?${queryParam}&scope=${s}&limit=${limit}`));

    const responses = await Promise.all([...originPromises, ...scopePromises]);

    // Combine all alerts flattened and deduplicated
    let alertMap = new Map();
    responses.forEach(r => {
      if (r.data && Array.isArray(r.data)) {
        r.data.forEach(alert => {
          alertMap.set(alert.id, alert);
        });
      }
    });

    const alerts = Array.from(alertMap.values());

    console.log(`Fetched ${alerts.length} unique alerts with ${includeExpired ? 'all' : 'active'} decisions`);

    let combinedDecisions = [];
    const seenDecisionIds = new Set(); // specific deduplication just in case

    // Extract decisions from each alert
    alerts.forEach(alert => {
      if (Array.isArray(alert.decisions)) {
        // Double-check filter (though API should have handled it)
        const relevantDecisions = alert.decisions.filter(d => d.origin !== 'CAPI');

        const mapped = relevantDecisions.map(decision => {
          if (seenDecisionIds.has(decision.id)) return null;

          // Check if decision is expired
          const isExpired = decision.stop_at && new Date(decision.stop_at) < new Date();

          // Filter out expired decisions unless includeExpired is true
          if (isExpired && !includeExpired) {
            return null;
          }

          seenDecisionIds.add(decision.id);

          return {
            id: decision.id,
            created_at: decision.created_at || alert.created_at,
            scenario: decision.scenario || alert.scenario || "N/A",
            value: decision.value,
            expired: isExpired,
            // Rich details for CSCLI parity
            detail: {
              origin: decision.origin || alert.source?.scope || "manual",
              type: decision.type,
              reason: decision.scenario || alert.scenario || "manual",
              action: decision.type,
              country: alert.source?.cn || "Unknown",
              as: alert.source?.as_name || "Unknown",
              events_count: alert.events_count || 0,
              duration: decision.duration || "N/A",
              expiration: decision.stop_at || alert.stop_at,
              alert_id: alert.id,
              // Backwards compatibility if needed
              message: alert.message
            }
          };
        }).filter(Boolean);

        combinedDecisions = combinedDecisions.concat(mapped);
      }
    });

    combinedDecisions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(combinedDecisions);
  };

  try {
    await doRequest();
  } catch (error) {
    handleApiError(error, res, 'fetching decisions', doRequest);
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
    // m is minimal, treat as <1 hour or round up? For dashboard "days", 
    // we might need a better logic. 
    // Assuming hours/days are the main use cases.
  }

  // Parse Refresh Interval from Env
  // Default: Manual (0)
  // Supported: manual, 30s, 1m, 5m
  let refreshInterval = 0;
  const envRefresh = process.env.CROWDSEC_REFRESH_INTERVAL || 'manual';

  switch (envRefresh.toLowerCase()) {
    case '30s':
      refreshInterval = 30000;
      break;
    case '1m':
      refreshInterval = 60000;
      break;
    case '5m':
      refreshInterval = 300000;
      break;
    case 'manual':
    default:
      refreshInterval = 0;
      break;
  }

  res.json({
    lookback_period: CROWDSEC_LOOKBACK_PERIOD,
    lookback_hours: hours,
    lookback_days: Math.max(1, Math.round(hours / 24)),
    refresh_interval: refreshInterval
  });
});

/**
 * GET /api/stats/decisions
 * Retrieves ALL decisions from alerts (not just active ones) for statistics purposes.
 * This includes expired decisions to show accurate historical data.
 */
app.get('/api/stats/decisions', ensureAuth, async (req, res) => {
  const doRequest = async () => {
    // Default lookback period
    const since = req.query.since || CROWDSEC_LOOKBACK_PERIOD;
    const origins = ['cscli', 'crowdsec', 'cscli-import', 'manual', 'appsec', 'lists'];
    const scopes = ['Ip', 'Range'];

    // Execute requests in parallel
    const limit = 10000;
    const originPromises = origins.map(o => apiClient.get(`/v1/alerts?since=${since}&origin=${o}&limit=${limit}`));
    const scopePromises = scopes.map(s => apiClient.get(`/v1/alerts?since=${since}&scope=${s}&limit=${limit}`));

    const responses = await Promise.all([...originPromises, ...scopePromises]);

    // Combine all alerts and deduplicate by ID
    let alertMap = new Map();
    responses.forEach(r => {
      if (r.data && Array.isArray(r.data)) {
        r.data.forEach(alert => {
          alertMap.set(alert.id, alert);
        });
      }
    });

    const alerts = Array.from(alertMap.values());

    console.log(`Fetched ${alerts.length} unique alerts for statistics`);

    let allDecisions = [];
    const seenDecisionIds = new Set();

    // Extract ALL decisions from each alert (including expired ones)
    alerts.forEach(alert => {
      if (Array.isArray(alert.decisions)) {
        const relevantDecisions = alert.decisions.filter(d => d.origin !== 'CAPI');

        const mapped = relevantDecisions.map(decision => {
          if (seenDecisionIds.has(decision.id)) return null;
          seenDecisionIds.add(decision.id);

          return {
            id: decision.id,
            created_at: decision.created_at || alert.created_at,
            scenario: decision.scenario || alert.scenario || "N/A",
            value: decision.value,
            stop_at: decision.stop_at
          };
        }).filter(Boolean);

        allDecisions = allDecisions.concat(mapped);
      }
    });

    allDecisions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(allDecisions);
  };

  try {
    await doRequest();
  } catch (error) {
    handleApiError(error, res, 'fetching decision statistics', doRequest);
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
    res.json(response.data || { message: 'Deleted' });
  };

  try {
    await doRequest();
  } catch (error) {
    handleApiError(error, res, 'deleting decision', doRequest);
  }
});

// Serve static files from the "frontend/dist" directory.
app.use(express.static('frontend/dist'));

// Catch-all handler for any request that doesn't match an API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend/dist/index.html'));
});

app.listen(port, () => console.log(`Server listening on port ${port}`));
