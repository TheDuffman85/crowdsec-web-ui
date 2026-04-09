#!/bin/bash

# Configuration
SCRIPT_DIR="$(dirname "$0")"
PROJECT_ROOT="$(realpath "$SCRIPT_DIR")"
ENV_FILE="$SCRIPT_DIR/.env"
BACKEND_PORT=3000
FRONTEND_PORT=5173
PNPM_SHIM_DIR=""
PNPM_CMD=("pnpm")

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
        log "Please install pnpm 10.33.0 or enable corepack for Node.js 24.14.1."
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
        log "Try: corepack enable && corepack prepare pnpm@10.33.0 --activate"
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

# 1. Shutdown existing services
log "Checking for running services..."
shutdown_service $BACKEND_PORT "backend"
shutdown_service $FRONTEND_PORT "frontend"

# 2. Load environment variables
if [ -f "$ENV_FILE" ]; then
    log "Loading environment variables from $ENV_FILE..."
    set -a
    source "$ENV_FILE"
    set +a
else
    log "No .env file found at $ENV_FILE. Proceeding with default environment."
fi

trap cleanup_pnpm_shim EXIT

# Check for Node.js and pnpm
if ! command -v node &> /dev/null; then
    log "Error: 'node' is not installed."
    log "Please install Node.js 24.14.1 to run this application locally."
    log "Alternatively, use Docker to run the containerized application."
    exit 1
fi

ensure_pnpm

# 3. Determine mode
MODE="${1:-normal}"

cd "$PROJECT_ROOT" || exit 1

if [ "$MODE" == "dev" ]; then
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
