/**
 * CrowdSec LAPI Client Module
 * 
 * Handles all communication with the CrowdSec Local API (LAPI).
 * Uses native fetch for Bun compatibility.
 */

// CrowdSec LAPI Configuration
const CROWDSEC_URL = process.env.CROWDSEC_URL || 'http://crowdsec:8080';
const CROWDSEC_USER = process.env.CROWDSEC_USER;
const CROWDSEC_PASSWORD = process.env.CROWDSEC_PASSWORD;
const CROWDSEC_LOOKBACK_PERIOD = process.env.CROWDSEC_LOOKBACK_PERIOD || '168h';

// Token state (module-level)
let requestToken = null;

// LAPI connection status
const lapiStatus = {
    isConnected: false,
    lastCheck: null,
    lastError: null
};

/**
 * Update LAPI connection status
 */
function updateLapiStatus(isConnected, error = null) {
    lapiStatus.isConnected = isConnected;
    lapiStatus.lastCheck = new Date().toISOString();
    lapiStatus.lastError = error ? error.message : null;
}

/**
 * Get current LAPI status
 */
function getLapiStatus() {
    return { ...lapiStatus };
}

/**
 * Check if we have valid credentials configured
 */
function hasCredentials() {
    return !!(CROWDSEC_USER && CROWDSEC_PASSWORD);
}

/**
 * Get current token (for status checks)
 */
function hasToken() {
    return !!requestToken;
}

// ============================================================================
// CORE FETCH HELPER
// ============================================================================

/**
 * Make a request to the CrowdSec LAPI using native fetch.
 * Handles authentication, timeouts, and automatic 401 retry with re-login.
 * 
 * @param {string} endpoint - API endpoint (e.g., '/v1/alerts')
 * @param {Object} options - Fetch options (method, body, timeout, headers)
 * @param {boolean} isRetry - Internal flag to prevent infinite retry loops
 * @returns {Promise<{data: any, status: number, headers: Headers}>}
 */
async function fetchLAPI(endpoint, options = {}, isRetry = false) {
    const controller = new AbortController();
    const timeout = options.timeout || 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const url = `${CROWDSEC_URL}${endpoint}`;
    const isLoginRequest = endpoint.includes('/watchers/login');

    const headers = {
        'User-Agent': 'crowdsec-web-ui/1.0.0',
        'Connection': 'close',
        'Content-Type': 'application/json',
        ...options.headers
    };

    // Add auth token for non-login requests
    if (requestToken && !isLoginRequest) {
        headers['Authorization'] = `Bearer ${requestToken}`;
    }

    try {
        const response = await fetch(url, {
            method: options.method || 'GET',
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        // Handle 401 Unauthorized - attempt re-authentication once
        if (response.status === 401 && !isRetry && !isLoginRequest) {
            console.log('Detected 401 Unauthorized. Attempting to re-authenticate...');
            const success = await login();
            if (success) {
                console.log('Re-authentication successful. Retrying original request...');
                return await fetchLAPI(endpoint, options, true);
            } else {
                const error = new Error('HTTP 401: Re-authentication failed');
                error.status = 401;
                throw error;
            }
        }

        // Parse response
        let data = null;
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            data = await response.json();
        } else {
            data = await response.text();
        }

        if (!response.ok) {
            const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
            error.status = response.status;
            error.response = { data, status: response.status, headers: response.headers };
            throw error;
        }

        return { data, status: response.status, headers: response.headers };
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            const error = new Error('Request timeout');
            error.code = 'ETIMEDOUT';
            throw error;
        }
        throw err;
    }
}

// ============================================================================
// AUTHENTICATION
// ============================================================================

/**
 * Login to CrowdSec LAPI and obtain authentication token
 * @returns {Promise<boolean>} True if login successful
 */
async function login() {
    try {
        console.log(`Attempting login to CrowdSec LAPI at ${CROWDSEC_URL} as ${CROWDSEC_USER}...`);
        const response = await fetchLAPI('/v1/watchers/login', {
            method: 'POST',
            body: {
                machine_id: CROWDSEC_USER,
                password: CROWDSEC_PASSWORD,
                scenarios: ["manual/web-ui"]
            }
        });

        if (response.data && response.data.code === 200 && response.data.token) {
            requestToken = response.data.token;
            console.log('Successfully logged in to CrowdSec LAPI');
            updateLapiStatus(true);
            return true;
        } else if (response.data && response.data.token) {
            // Some versions might just return the token object directly
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
}

// ============================================================================
// ALERT FETCHING
// ============================================================================

/**
 * Fetch alerts from LAPI with optional filters.
 * Aggregates results from multiple origin and scope queries.
 * 
 * @param {string|null} since - Duration string (e.g., '1h', '30s') or null for default lookback
 * @param {string|null} until - Duration string for end of range or null
 * @param {boolean} hasActiveDecision - If true, only fetch alerts with active decisions
 * @returns {Promise<Array>} Array of unique alerts
 */
async function fetchAlerts(since = null, until = null, hasActiveDecision = false) {
    const sinceParam = since || CROWDSEC_LOOKBACK_PERIOD;
    const origins = ['cscli', 'crowdsec', 'cscli-import', 'manual', 'appsec'];
    const scopes = ['Ip', 'Range'];
    const limit = 10000;

    const activeDecisionParam = hasActiveDecision ? '&has_active_decision=true' : '';
    const untilParam = until ? `&until=${until}` : '';

    let alertMap = new Map();

    // Helper to process response
    const processResponse = (data) => {
        if (data && Array.isArray(data)) {
            data.forEach(alert => {
                alertMap.set(alert.id, alert);
            });
            return data.length;
        }
        return 0;
    };

    // Helper to make a fetch request with auth, timeout, and 401 retry
    const fetchWithAuth = async (url, isRetry = false) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        try {
            const response = await fetch(`${CROWDSEC_URL}${url}`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${requestToken}`,
                    'User-Agent': 'crowdsec-web-ui/1.0.0',
                    'Connection': 'close'
                },
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            // Handle 401 Unauthorized - attempt re-authentication once
            if (response.status === 401 && !isRetry) {
                console.log('Detected 401 Unauthorized in fetchAlerts. Attempting to re-authenticate...');
                const success = await login();
                if (success) {
                    console.log('Re-authentication successful. Retrying request...');
                    return await fetchWithAuth(url, true);
                } else {
                    throw new Error('HTTP 401: Re-authentication failed');
                }
            }

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            return await response.json();
        } catch (err) {
            clearTimeout(timeoutId);
            throw err;
        }
    };

    // Execute requests SEQUENTIALLY to avoid overwhelming LAPI
    for (const o of origins) {
        try {
            const url = `/v1/alerts?since=${sinceParam}${untilParam}&origin=${o}&limit=${limit}${activeDecisionParam}`;
            const data = await fetchWithAuth(url);
            processResponse(data);
        } catch (err) {
            console.error(`Failed to fetch alerts from origin=${o}: ${err.message}`);
        }
    }

    for (const s of scopes) {
        try {
            const url = `/v1/alerts?since=${sinceParam}${untilParam}&scope=${s}&limit=${limit}${activeDecisionParam}`;
            const data = await fetchWithAuth(url);
            processResponse(data);
        } catch (err) {
            console.error(`Failed to fetch alerts from scope=${s}: ${err.message}`);
        }
    }

    return Array.from(alertMap.values());
}

// ============================================================================
// SINGLE ALERT FETCH
// ============================================================================

/**
 * Fetch a single alert by ID from LAPI
 * @param {string|number} alertId - The alert ID
 * @returns {Promise<Object>} The alert data
 */
async function getAlertById(alertId) {
    const response = await fetchLAPI(`/v1/alerts/${alertId}`);
    return response.data;
}

// ============================================================================
// DECISION MANAGEMENT
// ============================================================================

/**
 * Add a new decision by creating an alert with a decision attached.
 * This is how CrowdSec LAPI works - decisions are created via alerts.
 * 
 * @param {string} ip - IP address to ban
 * @param {string} type - Decision type (e.g., 'ban', 'captcha')
 * @param {string} duration - Duration string (e.g., '24h', '1h')
 * @param {string} reason - Reason for the decision
 * @returns {Promise<Object>} Response from LAPI
 */
async function addDecision(ip, type, duration, reason = 'Manual decision from Web UI') {
    const now = new Date().toISOString();

    const alertPayload = [{
        scenario: "manual/web-ui",
        campaign_name: "manual/web-ui",
        message: `Manual decision from Web UI: ${reason}`,
        events_count: 1,
        start_at: now,
        stop_at: now,
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

    const response = await fetchLAPI('/v1/alerts', {
        method: 'POST',
        body: alertPayload
    });

    return response.data;
}

/**
 * Delete a decision by ID
 * @param {string|number} decisionId - The decision ID to delete
 * @returns {Promise<Object>} Response from LAPI
 */
async function deleteDecision(decisionId) {
    const response = await fetchLAPI(`/v1/decisions/${decisionId}`, {
        method: 'DELETE'
    });
    return response.data;
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
    // Core functions
    fetchLAPI,
    login,
    fetchAlerts,

    // Single alert fetch
    getAlertById,

    // Decision management
    addDecision,
    deleteDecision,

    // Status functions
    getLapiStatus,
    updateLapiStatus,
    hasCredentials,
    hasToken,

    // Config values (read-only exports)
    CROWDSEC_URL,
    CROWDSEC_LOOKBACK_PERIOD
};

export default {
    fetchLAPI,
    login,
    fetchAlerts,
    getAlertById,
    addDecision,
    deleteDecision,
    getLapiStatus,
    updateLapiStatus,
    hasCredentials,
    hasToken,
    CROWDSEC_URL,
    CROWDSEC_LOOKBACK_PERIOD
};
