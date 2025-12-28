#!/bin/bash
set -e

# Fix permissions for the data directory
# This is necessary because when Docker binds a volume that doesn't exist on host,
# it creates it as root, which prevents the non-root 'bun' user from writing to it.
if [ -d "/app/data" ]; then
    echo "Fixing permissions for /app/data..."
    chown -R bun:bun /app/data

    # Clean up stale SQLite WAL/SHM files to prevent locking/compatibility issues
    # when switching between runtimes (e.g. Node.js -> Bun)
    if [ -f "/app/data/crowdsec.db-wal" ]; then
        echo "Removing stale WAL file..."
        rm -f /app/data/crowdsec.db-wal
    fi
    if [ -f "/app/data/crowdsec.db-shm" ]; then
        echo "Removing stale SHM file..."
        rm -f /app/data/crowdsec.db-shm
    fi
fi

# Switch to 'bun' user and execute the command
exec gosu bun "$@"
