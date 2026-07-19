#!/bin/bash
set -e

# DB_DIR commonly points at the regular image's mounted /app/data directory.
# Deliberately do not inherit it: load-test seeding removes and recreates its
# database, so it must use a separate container-local path by default.
LOADTEST_PROFILE="${LOADTEST_PROFILE:-default}"
LOADTEST_PROFILE_DIR="${LOADTEST_PROFILE_DIR:-/app/scripts/load-test-profiles}"
LOADTEST_DB_DIR="${LOADTEST_DB_DIR:-/tmp/crowdsec-web-ui-load-test}"

case "$LOADTEST_PROFILE" in
    default|blocklist|blocklists-mixed|multi-instance|multi-instance-medium)
        profile_file="$LOADTEST_PROFILE_DIR/$LOADTEST_PROFILE.sh"
        ;;
    *)
        echo "Error: unknown load-test profile '$LOADTEST_PROFILE'." >&2
        echo "Available profiles: default, blocklist, blocklists-mixed, multi-instance, multi-instance-medium" >&2
        exit 1
        ;;
esac

# Export profile defaults for the seed and server processes. Values explicitly
# supplied to the container remain set because profile files only fill unset
# variables. Specialized profiles inherit shared defaults from the baseline.
set -a
source "$profile_file"
if [ "$LOADTEST_PROFILE" != "default" ]; then
    source "$LOADTEST_PROFILE_DIR/default.sh"
fi
set +a

export LOADTEST_PROFILE
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
