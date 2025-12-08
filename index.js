// index.js
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
    // Fetch alerts and filter CAPI after
    const response = await apiClient.get('/v1/alerts?limit=1000');
    let alertArray = response.data || [];

    // Filter out CAPI alerts
    alertArray = alertArray.filter(alert => {
      // Check if any decision is from CAPI
      const hasCapiDecision = alert.decisions?.some(d => d.origin === 'CAPI' || d.origin === 'capi');
      return !hasCapiDecision;
    });

    console.log(`Fetched ${alertArray.length} alerts (excluding CAPI)`);
    alertArray.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Limit to 1000 after filtering
    res.json(alertArray.slice(0, 1000));
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

    // Fetch alerts that have decisions
    // Filtering by origin at LAPI level to reduce payload and avoid OOM from CAPI
    // origin: cscli (manual), crowdsec (scenarios), cscli-import (imported)
    // We run parallel requests because LAPI might not support OR logic with "origin" parameter reliably.
    // Added 'manual' to origins to capture Web UI decisions.
    const origins = ['cscli', 'crowdsec', 'cscli-import', 'manual'];

    // Execute requests in parallel
    const queryParam = includeExpired ? 'limit=100' : 'has_active_decision=true&limit=100';
    const responses = await Promise.all(
      origins.map(o => apiClient.get(`/v1/alerts?${queryParam}&origin=${o}`))
    );

    // Combine all alerts flattened
    let alerts = [];
    responses.forEach(r => {
      if (r.data && Array.isArray(r.data)) {
        alerts = alerts.concat(r.data);
      }
    });

    console.log(`Fetched ${alerts.length} alerts with ${includeExpired ? 'all' : 'active'} decisions (combined origins)`);

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
 * GET /api/stats/decisions
 * Retrieves ALL decisions from alerts (not just active ones) for statistics purposes.
 * This includes expired decisions to show accurate historical data.
 */
app.get('/api/stats/decisions', ensureAuth, async (req, res) => {
  const doRequest = async () => {
    // Fetch recent alerts (not filtering by has_active_decision)
    const origins = ['cscli', 'crowdsec', 'cscli-import', 'manual'];

    // Execute requests in parallel
    const responses = await Promise.all(
      origins.map(o => apiClient.get(`/v1/alerts?limit=250&origin=${o}`))
    );

    // Combine all alerts
    let alerts = [];
    responses.forEach(r => {
      if (r.data && Array.isArray(r.data)) {
        alerts = alerts.concat(r.data);
      }
    });

    console.log(`Fetched ${alerts.length} alerts for statistics (combined origins)`);

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
            value: decision.value
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
