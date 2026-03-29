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

# Bun's standard x64 runtime requires CPU support for AVX2. Check for that
# before handing off to Bun so unsupported VMs fail with a clear message.
ARCH="$(uname -m)"
case "$ARCH" in
    x86_64|amd64)
        if [ -r "/proc/cpuinfo" ] && ! grep -qw avx2 /proc/cpuinfo; then
            echo "ERROR: This x64 container requires CPU support for AVX2 to run Bun."
            echo "If this is a VM, expose host CPU features (for example Proxmox: use 'host' instead of 'kvm64')."
            exit 1
        fi
        ;;
esac

# Switch to 'bun' user and execute the command (if root)
if [ "$UID" == "0" ]; then
    exec gosu bun "$@"
else
    exec "$@"
fi
