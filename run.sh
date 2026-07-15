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
    LOADTEST_REFRESH_ALERTS
    LOADTEST_REFRESH_DECISIONS
    TIME_FORMAT
    AUTH_ENABLED
    AUTH_SECRET
    AUTH_SECRET_FILE
    AUTH_TOTP_SECRET
    AUTH_TOTP_SECRET_FILE
    AUTH_TOTP_SEED
    AUTH_TOTP_SEED_FILE
    AUTH_OIDC_ISSUER_URL
    AUTH_OIDC_CLIENT_ID
    AUTH_OIDC_CLIENT_SECRET
    AUTH_OIDC_CLIENT_SECRET_FILE
    AUTH_OIDC_SCOPE
    AUTH_OIDC_GROUPS_CLAIM
    AUTH_OIDC_ADMIN_GROUPS
    AUTH_OIDC_READ_ONLY_GROUPS
    AUTH_OIDC_UNMATCHED_ROLE
    CROWDSEC_AUTH_SECRET
    CROWDSEC_AUTH_SECRET_FILE
    CROWDSEC_AUTH_TOTP_SECRET
    CROWDSEC_AUTH_TOTP_SECRET_FILE
    CROWDSEC_AUTH_TOTP_SEED
    CROWDSEC_AUTH_TOTP_SEED_FILE
    CROWDSEC_AUTH_OIDC_ISSUER_URL
    CROWDSEC_AUTH_OIDC_CLIENT_ID
    CROWDSEC_AUTH_OIDC_CLIENT_SECRET
    CROWDSEC_AUTH_OIDC_CLIENT_SECRET_FILE
    CROWDSEC_AUTH_OIDC_SCOPE
    CROWDSEC_AUTH_OIDC_GROUPS_CLAIM
    CROWDSEC_AUTH_OIDC_ADMIN_GROUPS
    CROWDSEC_AUTH_OIDC_READ_ONLY_GROUPS
    CROWDSEC_AUTH_OIDC_UNMATCHED_ROLE
    CROWDSEC_TIME_FORMAT
    CROWDSEC_REFRESH_INTERVAL
    CROWDSEC_IDLE_REFRESH_INTERVAL
    CROWDSEC_IDLE_THRESHOLD
    CROWDSEC_LOOKBACK_PERIOD
    CROWDSEC_ALERT_SYNC_CHUNK
    CROWDSEC_ALERT_SYNC_MIN_CHUNK
    CROWDSEC_RECONCILE_WINDOW
    CROWDSEC_RECONCILE_RECENT_AGE
    CROWDSEC_RECONCILE_RECENT_INTERVAL
    CROWDSEC_RECONCILE_ACTIVE_INTERVAL
    CROWDSEC_RECONCILE_OLD_INTERVAL
    CROWDSEC_RECONCILE_WINDOWS_PER_REFRESH
    CROWDSEC_SIMULATIONS_ENABLED
)

capture_loadtest_overrides() {
    LOADTEST_ENV_OVERRIDES=()
    for name in "${LOADTEST_ENV_NAMES[@]}"; do
        if [ "${!name+x}" ]; then
            LOADTEST_ENV_OVERRIDES+=("$name=${!name}")
        fi
    done
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

configure_loadtest_defaults() {
    : "${LOADTEST_ALERTS:=300000}"
    : "${LOADTEST_DECISIONS:=300000}"
    : "${LOADTEST_SEED:=1337}"
    : "${LOADTEST_DB_DIR:=${TMPDIR:-/tmp}/crowdsec-web-ui-load-test}"
    : "${LOADTEST_BACKEND_PORT:=3000}"
    : "${LOADTEST_ACTIVE_DECISION_RATIO:=0.7}"
    : "${LOADTEST_SIMULATION_RATIO:=0.1}"
    : "${LOADTEST_DUPLICATE_VALUE_RATIO:=0.15}"
    : "${LOADTEST_BLOCKLIST_DECISIONS:=100000}"
    : "${LOADTEST_REFRESH_ALERTS:=100}"
    : "${LOADTEST_REFRESH_DECISIONS:=100}"
    : "${CROWDSEC_REFRESH_INTERVAL:=1m}"
    : "${CROWDSEC_IDLE_REFRESH_INTERVAL:=10m}"
    : "${CROWDSEC_IDLE_THRESHOLD:=2m}"
    : "${CROWDSEC_LOOKBACK_PERIOD:=30d}"
    : "${CROWDSEC_ALERT_SYNC_CHUNK:=12h}"
    : "${CROWDSEC_ALERT_SYNC_MIN_CHUNK:=15m}"
    : "${CROWDSEC_RECONCILE_WINDOW:=1h}"
    : "${CROWDSEC_RECONCILE_RECENT_AGE:=24h}"
    : "${CROWDSEC_RECONCILE_RECENT_INTERVAL:=15m}"
    : "${CROWDSEC_RECONCILE_ACTIVE_INTERVAL:=5m}"
    : "${CROWDSEC_RECONCILE_OLD_INTERVAL:=3h}"
    : "${CROWDSEC_RECONCILE_WINDOWS_PER_REFRESH:=2}"
    : "${CROWDSEC_SIMULATIONS_ENABLED:=true}"

    export LOADTEST_ALERTS
    export LOADTEST_DECISIONS
    export LOADTEST_SEED
    export LOADTEST_DB_DIR
    export LOADTEST_BACKEND_PORT
    export LOADTEST_ACTIVE_DECISION_RATIO
    export LOADTEST_SIMULATION_RATIO
    export LOADTEST_DUPLICATE_VALUE_RATIO
    export LOADTEST_BLOCKLIST_DECISIONS
    export LOADTEST_REFRESH_ALERTS
    export LOADTEST_REFRESH_DECISIONS
    export CROWDSEC_REFRESH_INTERVAL
    export CROWDSEC_IDLE_REFRESH_INTERVAL
    export CROWDSEC_IDLE_THRESHOLD
    export CROWDSEC_LOOKBACK_PERIOD
    export CROWDSEC_ALERT_SYNC_CHUNK
    export CROWDSEC_ALERT_SYNC_MIN_CHUNK
    export CROWDSEC_RECONCILE_WINDOW
    export CROWDSEC_RECONCILE_RECENT_AGE
    export CROWDSEC_RECONCILE_RECENT_INTERVAL
    export CROWDSEC_RECONCILE_ACTIVE_INTERVAL
    export CROWDSEC_RECONCILE_OLD_INTERVAL
    export CROWDSEC_RECONCILE_WINDOWS_PER_REFRESH
    export CROWDSEC_SIMULATIONS_ENABLED
    export DB_DIR="$LOADTEST_DB_DIR"
    export PORT="$LOADTEST_BACKEND_PORT"
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

if [ "$MODE" == "loadtest" ]; then
    configure_loadtest_defaults
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
    log "DB directory: $LOADTEST_DB_DIR"
    log "Alerts: $LOADTEST_ALERTS"
    log "Decisions: $LOADTEST_DECISIONS"
    log "Decisions in blocklist alert: $LOADTEST_BLOCKLIST_DECISIONS"
    log "Refresh additions: $LOADTEST_REFRESH_ALERTS alerts, $LOADTEST_REFRESH_DECISIONS decisions"
    log "Refresh interval: $CROWDSEC_REFRESH_INTERVAL"
    log "Reconciliation: $CROWDSEC_RECONCILE_WINDOWS_PER_REFRESH window(s) of $CROWDSEC_RECONCILE_WINDOW per refresh"
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
    auth_enabled_value="${AUTH_ENABLED:-true}"
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
