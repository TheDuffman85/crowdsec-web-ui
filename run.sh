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

# 3. Determine mode
MODE="${1:-normal}"

cd "$PROJECT_ROOT" || exit 1

if [ "$MODE" == "dev" ]; then
    log "Starting in DEVELOPMENT mode..."
    
    # Start Agent in background
    log "Starting agent (nodemon)..."
    cd agent
    npm run dev &
    AGENT_PID=$!
    cd ..

    # Wait for Agent to be ready
    log "Waiting for Agent to be ready on port 3001..."
    while ! nc -z localhost 3001; do   
      sleep 1
    done
    log "Agent is ready!"

    # Start Backend in background
    log "Starting backend (nodemon)..."
    # Ensure backend knows about agent
    if [ -z "$AGENT_URL" ]; then
        export AGENT_URL="https://localhost:3001"
    fi
    if [ -z "$AGENT_TLS_VERIFY" ]; then
        export AGENT_TLS_VERIFY="false"
    fi
    npm run dev &
    BACKEND_PID=$!
    
    # Start Frontend in background
    log "Starting frontend (vite)..."
    cd frontend
    npm run dev &
    FRONTEND_PID=$!
    
    log "Services started. Agent PID: $AGENT_PID, Backend PID: $BACKEND_PID, Frontend PID: $FRONTEND_PID"
    
    # Trap for cleanup
    cleanup() {
        log "Stopping services..."
        kill $AGENT_PID 2>/dev/null
        kill $BACKEND_PID 2>/dev/null
        kill $FRONTEND_PID 2>/dev/null
        exit
    }
    trap cleanup SIGINT SIGTERM
    
    wait
else
    log "Starting in PRODUCTION mode..."
    
    # Check if we should run lapi or new mode based on args or env? 
    # For local production-like run, we usually just run the main app.
    # The 'agent' functionality relies on a separate process. 
    # run.sh is typically for "Monolithic" local dev.
    # If we want to run "Production" locally with agent, we need to start agent too.
    
    log "Building frontend..."
    npm run build-ui
    
    if [ $? -eq 0 ]; then
        log "Frontend build successful."
        
        log "Starting agent..."
        cd agent
        npm install --only=production
        npm start & 
        AGENT_PID=$!
        cd ..
        
        log "Starting backend..."
        if [ -z "$AGENT_URL" ]; then
            export AGENT_URL="https://localhost:3001"
        fi
        if [ -z "$AGENT_TOKEN" ]; then
            log "Warning: AGENT_TOKEN not set in environment."
        fi
        npm start &
        BACKEND_PID=$!
        
        cleanup_prod() {
            kill $AGENT_PID 2>/dev/null
            kill $BACKEND_PID 2>/dev/null
            exit
        }
        trap cleanup_prod SIGINT SIGTERM
        
        wait
    else
        log "Frontend build failed. Aborting."
        exit 1
    fi
fi
