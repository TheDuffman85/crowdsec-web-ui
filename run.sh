#!/bin/bash

# Configuration
SCRIPT_DIR="$(dirname "$0")"
PROJECT_ROOT="$(realpath "$SCRIPT_DIR")"
ENV_FILE="$SCRIPT_DIR/.env"
BACKEND_PORT=3000
FRONTEND_PORT=5173

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

# Check for Bun
if ! command -v bun &> /dev/null; then
    log "Error: 'bun' run-time is not installed."
    log "Please install Bun to run this application locally: https://bun.sh"
    log "Example: curl -fsSL https://bun.sh/install | bash"
    log "Alternatively, use Docker to run the containerized application."
    exit 1
fi

# 3. Determine mode
MODE="${1:-normal}"

cd "$PROJECT_ROOT" || exit 1

if [ "$MODE" == "dev" ]; then
    log "Starting in DEVELOPMENT mode..."
    
    # Start Backend in background
    log "Starting backend (bun --watch)..."
    bun run dev &
    BACKEND_PID=$!
    
    # Start Frontend in background
    log "Starting frontend (vite)..."
    cd frontend
    bun run dev &
    FRONTEND_PID=$!
    
    log "Services started. Backend PID: $BACKEND_PID, Frontend PID: $FRONTEND_PID"
    
    # Trap for cleanup
    cleanup() {
        log "Stopping services..."
        kill $BACKEND_PID 2>/dev/null
        kill $FRONTEND_PID 2>/dev/null
        exit
    }
    trap cleanup SIGINT SIGTERM
    
    wait
else
    log "Starting in PRODUCTION mode..."
    
    # Build Frontend
    log "Building frontend..."
    bun run build-ui
    
    if [ $? -eq 0 ]; then
        log "Frontend build successful."
        log "Starting backend..."
        bun start
    else
        log "Frontend build failed. Aborting."
        exit 1
    fi
fi
