#!/bin/bash

# Configuration
SCRIPT_DIR="$(dirname "$0")"
PROJECT_ROOT="$(realpath "$SCRIPT_DIR")"
ENV_FILE="$SCRIPT_DIR/.env"
BACKEND_PORT=3000
FRONTEND_PORT=5173

# Keep corepack-managed pnpm non-interactive on first use.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Helper functions
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
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

# Check for Node.js and pnpm
if ! command -v node &> /dev/null; then
    log "Error: 'node' is not installed."
    log "Please install Node.js 24.14.1 to run this application locally."
    log "Alternatively, use Docker to run the containerized application."
    exit 1
fi

if ! command -v pnpm &> /dev/null; then
    log "Error: 'pnpm' is not installed."
    log "Please install pnpm 10.33.0 (for example via corepack)."
    log "Example: corepack enable && corepack prepare pnpm@10.33.0 --activate"
    log "Alternatively, use Docker to run the containerized application."
    exit 1
fi

# Use a writable fallback cache when corepack shims are active.
if [ -z "${COREPACK_HOME:-}" ]; then
    export COREPACK_HOME="${TMPDIR:-/tmp}/corepack"
fi

# 3. Determine mode
MODE="${1:-normal}"

cd "$PROJECT_ROOT" || exit 1

if [ "$MODE" == "dev" ]; then
    log "Starting in DEVELOPMENT mode..."
    
    # Start Backend in background
    log "Starting backend (tsx watch)..."
    pnpm run dev &
    BACKEND_PID=$!
    
    # Start Frontend in background
    log "Starting frontend (vite)..."
    pnpm --dir frontend run dev &
    FRONTEND_PID=$!
    
    log "Services started. Backend PID: $BACKEND_PID, Frontend PID: $FRONTEND_PID"
    
    # Trap for cleanup
    cleanup() {
        log "Stopping services..."
        kill $BACKEND_PID 2>/dev/null
        kill $FRONTEND_PID 2>/dev/null
        wait $BACKEND_PID 2>/dev/null
        wait $FRONTEND_PID 2>/dev/null
        exit 0
    }
    trap cleanup SIGINT SIGTERM
    
    # Wait for both processes, re-wait if interrupted by signal
    while kill -0 $BACKEND_PID 2>/dev/null || kill -0 $FRONTEND_PID 2>/dev/null; do
        wait
    done
else
    log "Starting in PRODUCTION mode..."
    
    # Build Frontend
    log "Building frontend..."
    pnpm run build-ui
    
    if [ $? -eq 0 ]; then
        log "Frontend build successful."
        log "Starting backend..."
        pnpm start
    else
        log "Frontend build failed. Aborting."
        exit 1
    fi
fi
