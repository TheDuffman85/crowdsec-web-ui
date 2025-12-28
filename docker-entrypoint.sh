#!/bin/bash
set -e

# Fix permissions for the data directory
# This is necessary because when Docker binds a volume that doesn't exist on host,
# it creates it as root, which prevents the non-root 'bun' user from writing to it.
if [ -d "/app/data" ]; then
    echo "Fixing permissions for /app/data..."
    chown -R bun:bun /app/data
fi

# Switch to 'bun' user and execute the command
exec gosu bun "$@"
