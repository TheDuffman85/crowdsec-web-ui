#!/bin/bash
set -e

# Fix permissions for the data directory
# This is necessary because when Docker binds a volume that doesn't exist on host,
# it creates it as root, which prevents the non-root 'bun' user from writing to it.
if [ -d "/app/data" ]; then
    if [ "$UID" == "0" ]; then
        echo "Fixing permissions for /app/data..."
        chown -R bun:bun /app/data
    elif [ ! -w "/app/data" ]; then
        echo "ERROR: /app/data is not writable by user $(id -u)."
        echo "Either remove 'user: \"1000:1000\"' from your compose file to let the container fix permissions automatically,"
        echo "or fix permissions on the host: chown -R $(id -u):$(id -g) /path/to/your/data"
        exit 1
    fi

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

# Switch to 'bun' user and execute the command (if root)
if [ "$UID" == "0" ]; then
    exec gosu bun "$@"
else
    exec "$@"
fi