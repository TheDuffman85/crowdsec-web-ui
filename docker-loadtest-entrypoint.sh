#!/bin/bash
set -e

# DB_DIR commonly points at the regular image's mounted /app/data directory.
# Deliberately do not inherit it: load-test seeding removes and recreates its
# database, so it must use a separate container-local path by default.
LOADTEST_DB_DIR="${LOADTEST_DB_DIR:-/tmp/crowdsec-web-ui-load-test}"
export LOADTEST_DB_DIR
export DB_DIR="$LOADTEST_DB_DIR"

if [ "$UID" == "0" ]; then
    mkdir -p "$LOADTEST_DB_DIR"
    chown -R node:node "$LOADTEST_DB_DIR"
    gosu node node dist/server/seed-load-test-data.js
    exec gosu node "$@"
fi

mkdir -p "$LOADTEST_DB_DIR"
node dist/server/seed-load-test-data.js
exec "$@"
