#!/bin/bash
set -e

# Fix permissions for the config directory
# This is necessary because when Docker binds a volume that doesn't exist on host,
# it creates it as root, which prevents the non-root 'node' user from writing to it.
if [ -d "/app/config" ]; then
    echo "Fixing permissions for /app/config..."
    chown -R node:node /app/config
fi

# Switch to 'node' user and execute the command
exec gosu node "$@"
