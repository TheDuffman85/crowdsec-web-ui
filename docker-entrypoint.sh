#!/bin/bash
set -e

# Fix permissions for the config directory
# This is necessary because when Docker binds a volume that doesn't exist on host,
# it creates it as root, which prevents the non-root 'node' user from writing to it.
if [ -d "/app/data" ]; then
    echo "Fixing permissions for /app/data..."
    chown -R node:node /app/data
fi

# Switch to 'node' user and execute the command
exec gosu node "$@"
