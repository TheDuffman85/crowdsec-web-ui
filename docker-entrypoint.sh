#!/bin/bash
set -e

# Fix permissions for the config directory
# This is necessary because when Docker binds a volume that doesn't exist on host,
# it creates it as root, which prevents the non-root 'node' user from writing to it.
if [ -d "/app/config" ]; then
    echo "Fixing permissions for /app/config..."
    chown -R node:node /app/config
fi

# Determine Mode
if [ -z "$AGENT_URL" ]; then
    echo "AGENT_URL is not set. Starting LAPI mode..."
    cd /app/lapi
else
    echo "AGENT_URL is set ($AGENT_URL). Starting NEW mode..."
    cd /app
fi

# Switch to 'node' user and execute the command
exec gosu node "$@"
