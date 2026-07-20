#!/bin/bash

# Configuration
SCRIPT_DIR="$(dirname "$0")"
PROJECT_ROOT="$(realpath "$SCRIPT_DIR")"
ENV_FILE="$SCRIPT_DIR/.env"
BACKEND_PORT=3000
FRONTEND_PORT=5173
PNPM_SHIM_DIR=""
PNPM_CMD=("pnpm")
MODE="${1:-normal}"
LOADTEST_PROFILE="${2:-default}"
LOADTEST_PROFILE_DIR="$SCRIPT_DIR/scripts/load-test-profiles"

# Keep corepack-managed pnpm non-interactive on first use.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Helper functions
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

cleanup_pnpm_shim() {
    if [ -n "$PNPM_SHIM_DIR" ] && [ -d "$PNPM_SHIM_DIR" ]; then
        rm -rf "$PNPM_SHIM_DIR"
    fi
}

ensure_pnpm() {
    if command -v pnpm >/dev/null 2>&1; then
        PNPM_CMD=("pnpm")
        return 0
    fi

    if ! command -v corepack >/dev/null 2>&1; then
        log "Error: neither 'pnpm' nor 'corepack' is installed."
        log "Please install pnpm 11.9.0 or enable corepack for Node.js 24.18.0."
        log "Alternatively, use Docker to run the containerized application."
        exit 1
    fi

    log "'pnpm' was not found on PATH. Falling back to corepack-managed pnpm..."
    PNPM_SHIM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/crowdsec-pnpm-XXXXXX")"
    cat > "$PNPM_SHIM_DIR/pnpm" <<'EOF'
#!/bin/sh
exec corepack pnpm "$@"
EOF
    chmod +x "$PNPM_SHIM_DIR/pnpm"
    export PATH="$PNPM_SHIM_DIR:$PATH"

    if ! pnpm --version >/dev/null 2>&1; then
        log "Error: failed to start pnpm via corepack."
        log "Try: corepack enable && corepack prepare pnpm@11.9.0 --activate"
        exit 1
    fi

    PNPM_CMD=("pnpm")
    log "Using pnpm via corepack."
}

shutdown_service() {
    local port=$1
    local name=$2
    if command -v fuser >/dev/null 2>&1; then
        if fuser -k "$port/tcp" >/dev/null 2>&1; then
            log "Stopped $name running on port $port (via fuser)."
        else
            log "No $name found on port $port."
        fi
    else
        # Fallback if fuser is missing (less reliable but usually works for simple cases)
        log "Warning: 'fuser' not found. Attempting fallback kill via lsof/netstat..."
        local pid=$(lsof -t -i:$port 2>/dev/null)
        if [ -n "$pid" ]; then
             kill $pid
             log "Stopped $name running on port $port (PID: $pid)."
        fi
    fi
}

LOADTEST_ENV_NAMES=(
    LOADTEST_ALERTS
    LOADTEST_DECISIONS
    LOADTEST_SEED
    LOADTEST_DB_DIR
    LOADTEST_BACKEND_PORT
    LOADTEST_ACTIVE_DECISION_RATIO
    LOADTEST_SIMULATION_RATIO
    LOADTEST_DUPLICATE_VALUE_RATIO
    LOADTEST_BLOCKLIST_DECISIONS
    LOADTEST_BLOCKLIST_SIZES
    LOADTEST_EMPTY_ALERTS
    LOADTEST_EXPIRED_ALERTS
    LOADTEST_EXPIRING_SOON_DECISIONS
    LOADTEST_REFRESH_ALERTS
    LOADTEST_REFRESH_DECISIONS
    LOADTEST_REFRESH_DECISIONS_MIN_PER_ALERT
    LOADTEST_REFRESH_DECISIONS_MAX_PER_ALERT
    LOADTEST_REFRESH_DECISION_ORIGINS
    LOADTEST_MULTI_INSTANCE
    LOADTEST_FAILING_LAPI
    LOADTEST_SECONDARY_ALERTS
    LOADTEST_SECONDARY_DECISIONS
    LOADTEST_SECONDARY_BLOCKLIST_DECISIONS
    LOADTEST_EDGE_ALERTS
    LOADTEST_EDGE_DECISIONS
    LOADTEST_EDGE_BLOCKLIST_DECISIONS
    CONFIG_UI_TIME_FORMAT
    CONFIG_AUTH_ENABLED
    CONFIG_AUTH_SESSION_SECRET
    CONFIG_AUTH_SESSION_SECRET_FILE
    CONFIG_AUTH_TOTP_SECRET
    CONFIG_AUTH_TOTP_SECRET_FILE
    CONFIG_AUTH_TOTP_SEED
    CONFIG_AUTH_TOTP_SEED_FILE
    CONFIG_AUTH_OIDC_ISSUER_URL
    CONFIG_AUTH_OIDC_CLIENT_ID
    CONFIG_AUTH_OIDC_CLIENT_SECRET
    CONFIG_AUTH_OIDC_CLIENT_SECRET_FILE
    CONFIG_AUTH_OIDC_SCOPE
    CONFIG_AUTH_OIDC_GROUPS_CLAIM
    CONFIG_AUTH_OIDC_ADMIN_GROUPS
    CONFIG_AUTH_OIDC_READ_ONLY_GROUPS
    CONFIG_AUTH_OIDC_UNMATCHED_ROLE
    CONFIG_CROWDSEC_SYNC_REFRESH_INTERVAL
    CONFIG_CROWDSEC_SYNC_IDLE_REFRESH_INTERVAL
    CONFIG_CROWDSEC_SYNC_IDLE_THRESHOLD
    CONFIG_CROWDSEC_SYNC_LOOKBACK
    CONFIG_CROWDSEC_SYNC_ALERT_SYNC_CHUNK
    CONFIG_CROWDSEC_SYNC_ALERT_SYNC_MIN_CHUNK
    CONFIG_CROWDSEC_ALERT_FILTERS_INCLUDE_CAPI
    CONFIG_CROWDSEC_SYNC_RECONCILE_WINDOW
    CONFIG_CROWDSEC_SYNC_RECONCILE_RECENT_AGE
    CONFIG_CROWDSEC_SYNC_RECONCILE_RECENT_INTERVAL
    CONFIG_CROWDSEC_SYNC_RECONCILE_ACTIVE_INTERVAL
    CONFIG_CROWDSEC_SYNC_RECONCILE_OLD_INTERVAL
    CONFIG_CROWDSEC_SYNC_RECONCILE_WINDOWS_PER_REFRESH
    CONFIG_CROWDSEC_SIMULATIONS_ENABLED
)

capture_loadtest_overrides() {
    LOADTEST_ENV_OVERRIDES=()
    for name in "${LOADTEST_ENV_NAMES[@]}"; do
        if [ "${!name+x}" ]; then
            LOADTEST_ENV_OVERRIDES+=("$name=${!name}")
        fi
    done
    for name in "${!CONFIG_@}"; do
        LOADTEST_ENV_OVERRIDES+=("$name=${!name}")
    done
}

configure_loadtest_profile() {
    case "$LOADTEST_PROFILE" in
        default)
            profile_file="$LOADTEST_PROFILE_DIR/default.sh"
            ;;
        blocklist)
            profile_file="$LOADTEST_PROFILE_DIR/blocklist.sh"
            ;;
        blocklists-mixed)
            profile_file="$LOADTEST_PROFILE_DIR/blocklists-mixed.sh"
            ;;
        multi-instance)
            profile_file="$LOADTEST_PROFILE_DIR/multi-instance.sh"
            ;;
        multi-instance-medium)
            profile_file="$LOADTEST_PROFILE_DIR/multi-instance-medium.sh"
            ;;
        *)
            log "Error: unknown load-test profile '$LOADTEST_PROFILE'."
            log "Available profiles: default, blocklist, blocklists-mixed, multi-instance, multi-instance-medium"
            exit 1
            ;;
    esac

    # Profile values only fill unset variables, so command-line and .env
    # overrides retain precedence. Non-default profiles then inherit any
    # shared values they do not specialize from the explicit default profile.
    source "$profile_file"
    if [ "$LOADTEST_PROFILE" != "default" ]; then
        source "$LOADTEST_PROFILE_DIR/default.sh"
    fi
}

restore_loadtest_overrides() {
    for entry in "${LOADTEST_ENV_OVERRIDES[@]}"; do
        export "$entry"
    done
}

load_env_file() {
    if [ -f "$ENV_FILE" ]; then
        log "Loading environment variables from $ENV_FILE..."
        if [ "$MODE" == "loadtest" ]; then
            capture_loadtest_overrides
        fi
        set -a
        source "$ENV_FILE"
        set +a
        if [ "$MODE" == "loadtest" ]; then
            restore_loadtest_overrides
        fi
    else
        log "No .env file found at $ENV_FILE. Proceeding with default environment."
    fi
}

export_loadtest_config() {
    export LOADTEST_PROFILE
    export LOADTEST_ALERTS
    export LOADTEST_DECISIONS
    export LOADTEST_SEED
    export LOADTEST_DB_DIR
    export LOADTEST_BACKEND_PORT
    export LOADTEST_ACTIVE_DECISION_RATIO
    export LOADTEST_SIMULATION_RATIO
    export LOADTEST_DUPLICATE_VALUE_RATIO
    export LOADTEST_BLOCKLIST_DECISIONS
    export LOADTEST_BLOCKLIST_SIZES
    export LOADTEST_EMPTY_ALERTS
    export LOADTEST_EXPIRED_ALERTS
    export LOADTEST_EXPIRING_SOON_DECISIONS
    export LOADTEST_REFRESH_ALERTS
    export LOADTEST_REFRESH_DECISIONS
    export LOADTEST_REFRESH_DECISIONS_MIN_PER_ALERT
    export LOADTEST_REFRESH_DECISIONS_MAX_PER_ALERT
    export LOADTEST_REFRESH_DECISION_ORIGINS
    export LOADTEST_MULTI_INSTANCE
    export LOADTEST_FAILING_LAPI
    export LOADTEST_SECONDARY_ALERTS
    export LOADTEST_SECONDARY_DECISIONS
    export LOADTEST_SECONDARY_BLOCKLIST_DECISIONS
    export LOADTEST_EDGE_ALERTS
    export LOADTEST_EDGE_DECISIONS
    export LOADTEST_EDGE_BLOCKLIST_DECISIONS
    export CONFIG_CROWDSEC_SYNC_REFRESH_INTERVAL
    export CONFIG_CROWDSEC_SYNC_IDLE_REFRESH_INTERVAL
    export CONFIG_CROWDSEC_SYNC_IDLE_THRESHOLD
    export CONFIG_CROWDSEC_SYNC_LOOKBACK
    export CONFIG_CROWDSEC_SYNC_ALERT_SYNC_CHUNK
    export CONFIG_CROWDSEC_SYNC_ALERT_SYNC_MIN_CHUNK
    export CONFIG_CROWDSEC_ALERT_FILTERS_INCLUDE_CAPI
    export CONFIG_CROWDSEC_SYNC_RECONCILE_WINDOW
    export CONFIG_CROWDSEC_SYNC_RECONCILE_RECENT_AGE
    export CONFIG_CROWDSEC_SYNC_RECONCILE_RECENT_INTERVAL
    export CONFIG_CROWDSEC_SYNC_RECONCILE_ACTIVE_INTERVAL
    export CONFIG_CROWDSEC_SYNC_RECONCILE_OLD_INTERVAL
    export CONFIG_CROWDSEC_SYNC_RECONCILE_WINDOWS_PER_REFRESH
    export CONFIG_CROWDSEC_SIMULATIONS_ENABLED
    export BACKEND_URL="http://127.0.0.1:$LOADTEST_BACKEND_PORT"

    BACKEND_PORT="$LOADTEST_BACKEND_PORT"
}

wait_for_url() {
    local url="$1"
    local label="$2"
    local attempts=120

    for _ in $(seq 1 "$attempts"); do
        if node -e "fetch(process.argv[1]).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" "$url"; then
            return 0
        fi
        sleep 0.25
    done

    log "Timed out waiting for $label at $url"
    return 1
}

start_loadtest_backend() {
    if command -v setsid >/dev/null 2>&1; then
        setsid node --import tsx scripts/load-test-server.ts &
    else
        node --import tsx scripts/load-test-server.ts &
    fi
    BACKEND_PID=$!
}

stop_loadtest_backend() {
    if [ -z "${BACKEND_PID:-}" ]; then
        return
    fi

    if command -v setsid >/dev/null 2>&1; then
        kill -TERM "-$BACKEND_PID" 2>/dev/null || kill "$BACKEND_PID" 2>/dev/null
    else
        kill "$BACKEND_PID" 2>/dev/null
    fi

    for _ in 1 2 3 4 5; do
        if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
            wait "$BACKEND_PID" 2>/dev/null
            return
        fi
        sleep 1
    done

    log "Load-test backend did not stop after SIGTERM; forcing shutdown..."
    if command -v setsid >/dev/null 2>&1; then
        kill -KILL "-$BACKEND_PID" 2>/dev/null || kill -KILL "$BACKEND_PID" 2>/dev/null
    else
        kill -KILL "$BACKEND_PID" 2>/dev/null
    fi
    wait "$BACKEND_PID" 2>/dev/null
}

# 1. Shutdown existing services
if [ "$MODE" != "loadtest" ]; then
    log "Checking for running services..."
    shutdown_service $BACKEND_PORT "backend"
    shutdown_service $FRONTEND_PORT "frontend"
fi

# 2. Load environment variables
load_env_file

if [ "$MODE" != "loadtest" ] && [ -z "${CONFIG_FILE:-}" ] && [ -z "${DB_DIR:-}" ]; then
    export DB_DIR="$PROJECT_ROOT/data"
    log "Using default configuration path $DB_DIR/config.yaml."
fi

if [ "$MODE" == "loadtest" ]; then
    configure_loadtest_profile
    export_loadtest_config
    log "Checking for running load-test services..."
    shutdown_service $BACKEND_PORT "load-test backend"
fi

trap cleanup_pnpm_shim EXIT

# Check for Node.js and pnpm
if ! command -v node &> /dev/null; then
    log "Error: 'node' is not installed."
    log "Please install Node.js 24.18.0 to run this application locally."
    log "Alternatively, use Docker to run the containerized application."
    exit 1
fi

ensure_pnpm

cd "$PROJECT_ROOT" || exit 1

if [ "$MODE" == "loadtest" ]; then
    log "Starting in LOAD TEST mode..."
    log "Profile: $LOADTEST_PROFILE"
    log "Workload: $LOADTEST_PROFILE_DESCRIPTION"
    log "DB directory: $LOADTEST_DB_DIR"
    log "Alerts: $LOADTEST_ALERTS"
    log "Decisions: $LOADTEST_DECISIONS"
    log "Blocklist decision sizes: ${LOADTEST_BLOCKLIST_SIZES:-$LOADTEST_BLOCKLIST_DECISIONS}"
    log "Alerts without decisions: $LOADTEST_EMPTY_ALERTS"
    log "Alerts with expired decisions: $LOADTEST_EXPIRED_ALERTS"
    log "Decisions expiring 5-15 minutes after seed: $LOADTEST_EXPIRING_SOON_DECISIONS"
    if [ "$LOADTEST_REFRESH_DECISIONS_MAX_PER_ALERT" -gt 0 ]; then
        log "Refresh additions: $LOADTEST_REFRESH_ALERTS alerts, $LOADTEST_REFRESH_DECISIONS_MIN_PER_ALERT-$LOADTEST_REFRESH_DECISIONS_MAX_PER_ALERT decisions per alert"
    else
        log "Refresh additions: $LOADTEST_REFRESH_ALERTS alerts, $LOADTEST_REFRESH_DECISIONS decisions"
    fi
    log "Refresh decision origins: ${LOADTEST_REFRESH_DECISION_ORIGINS:-mixed}"
    log "Refresh interval: $CONFIG_CROWDSEC_SYNC_REFRESH_INTERVAL"
    log "Reconciliation: $CONFIG_CROWDSEC_SYNC_RECONCILE_WINDOWS_PER_REFRESH window(s) of $CONFIG_CROWDSEC_SYNC_RECONCILE_WINDOW per refresh"
    log "Seed: $LOADTEST_SEED"
    log "Seeding load-test database..."
    log "The UI will not be available until seeding, the frontend build, and backend startup finish."
    "${PNPM_CMD[@]}" run loadtest:seed

    if [ $? -ne 0 ]; then
        log "Load-test database seed failed. Aborting."
        exit 1
    fi

    log "Building load-test frontend..."
    "${PNPM_CMD[@]}" run loadtest:build-client

    if [ $? -ne 0 ]; then
        log "Load-test frontend build failed. Aborting."
        exit 1
    fi

    log "Starting load-test backend on port $LOADTEST_BACKEND_PORT..."
    start_loadtest_backend
    if ! wait_for_url "http://127.0.0.1:${LOADTEST_BACKEND_PORT}/api/health" "load-test backend"; then
        stop_loadtest_backend
        exit 1
    fi

    log "Load-test UI is ready: http://127.0.0.1:${LOADTEST_BACKEND_PORT}/"
    log "Load-test UI is also available at: http://localhost:${LOADTEST_BACKEND_PORT}/"
    auth_enabled_value="${CONFIG_AUTH_ENABLED:-true}"
    case "${auth_enabled_value,,}" in
        0|false|no|off) log "Authentication is disabled in load-test mode." ;;
        *) log "Authentication is enabled. Default login: load / test" ;;
    esac
    log "Service started. Backend PID: $BACKEND_PID"

    cleanup() {
        trap '' SIGINT SIGTERM
        log "Stopping load-test service..."
        stop_loadtest_backend
        cleanup_pnpm_shim
        exit 0
    }
    trap cleanup SIGINT SIGTERM

    wait $BACKEND_PID
elif [ "$MODE" == "dev" ]; then
    log "Starting in DEVELOPMENT mode..."
    
    # Start Backend in background
    log "Starting backend (tsx watch)..."
    "${PNPM_CMD[@]}" run dev:server &
    BACKEND_PID=$!

    # Start Client in background
    log "Starting client (vite)..."
    "${PNPM_CMD[@]}" run dev:client &
    FRONTEND_PID=$!
    
    log "Services started. Backend PID: $BACKEND_PID, Frontend PID: $FRONTEND_PID"
    
    # Trap for cleanup
    cleanup() {
        log "Stopping services..."
        kill $BACKEND_PID 2>/dev/null
        kill $FRONTEND_PID 2>/dev/null
        wait $BACKEND_PID 2>/dev/null
        wait $FRONTEND_PID 2>/dev/null
        cleanup_pnpm_shim
        exit 0
    }
    trap cleanup SIGINT SIGTERM
    
    # Wait for both processes, re-wait if interrupted by signal
    while kill -0 $BACKEND_PID 2>/dev/null || kill -0 $FRONTEND_PID 2>/dev/null; do
        wait
    done
else
    log "Starting in PRODUCTION mode..."
    
    # Build application
    log "Building application..."
    "${PNPM_CMD[@]}" run build

    if [ $? -eq 0 ]; then
        log "Application build successful."
        log "Starting backend..."
        "${PNPM_CMD[@]}" start
    else
        log "Application build failed. Aborting."
        exit 1
    fi
fi
