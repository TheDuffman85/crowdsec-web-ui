#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

export CROWDSEC_SCREENSHOT_FRONTEND_HOST="${CROWDSEC_SCREENSHOT_FRONTEND_HOST:-127.0.0.1}"
export CROWDSEC_SCREENSHOT_FRONTEND_PORT="${CROWDSEC_SCREENSHOT_FRONTEND_PORT:-5173}"
export CROWDSEC_SCREENSHOT_BACKEND_PORT="${CROWDSEC_SCREENSHOT_BACKEND_PORT:-3001}"
export CROWDSEC_SCREENSHOT_BASE_URL="${CROWDSEC_SCREENSHOT_BASE_URL:-http://${CROWDSEC_SCREENSHOT_FRONTEND_HOST}:${CROWDSEC_SCREENSHOT_FRONTEND_PORT}}"
export CROWDSEC_SCREENSHOT_OUTPUT_DIR="${CROWDSEC_SCREENSHOT_OUTPUT_DIR:-$SCRIPT_DIR}"
export CROWDSEC_SCREENSHOT_CHROME_PORT="${CROWDSEC_SCREENSHOT_CHROME_PORT:-9224}"

export DB_DIR="${DB_DIR:-${TMPDIR:-/tmp}/crowdsec-web-ui-screenshots}"
export PORT="$CROWDSEC_SCREENSHOT_BACKEND_PORT"
export CROWDSEC_SIMULATIONS_ENABLED="${CROWDSEC_SIMULATIONS_ENABLED:-true}"
export CROWDSEC_REFRESH_INTERVAL="${CROWDSEC_REFRESH_INTERVAL:-5m}"
export CROWDSEC_LOOKBACK_PERIOD="${CROWDSEC_LOOKBACK_PERIOD:-6h}"
export CROWDSEC_HEARTBEAT_INTERVAL="${CROWDSEC_HEARTBEAT_INTERVAL:-0}"
export CROWDSEC_BOOTSTRAP_RETRY_ENABLED="${CROWDSEC_BOOTSTRAP_RETRY_ENABLED:-false}"

export VITE_VERSION="${VITE_VERSION:-2026.06.05}"
export VITE_BRANCH="${VITE_BRANCH:-main}"
export VITE_COMMIT_HASH="${VITE_COMMIT_HASH:-screenshot}"
export VITE_REPO_URL="${VITE_REPO_URL:-https://github.com/TheDuffman85/crowdsec-web-ui}"
export VITE_BUILD_DATE="${VITE_BUILD_DATE:-2026-06-05}"
export BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:${CROWDSEC_SCREENSHOT_BACKEND_PORT}}"

if [[ -z "${CHROME_PATH:-}" ]]; then
  for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      export CHROME_PATH="$(command -v "$candidate")"
      break
    fi
  done
fi

if [[ -z "${CHROME_PATH:-}" ]]; then
  echo "Unable to find Chrome/Chromium. Set CHROME_PATH in screenshots/.env." >&2
  exit 1
fi

BACKEND_PID=""
FRONTEND_PID=""

stop_pid() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  stop_pid "$FRONTEND_PID"
  stop_pid "$BACKEND_PID"
}
trap cleanup EXIT INT TERM

wait_for_url() {
  local url="$1"
  local label="$2"
  local attempts=120

  for _ in $(seq 1 "$attempts"); do
    if node -e "fetch(process.argv[1]).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" "$url"; then
      return 0
    fi
    sleep 0.25
  done

  echo "Timed out waiting for $label at $url" >&2
  return 1
}

cd "$REPO_ROOT"

echo "Seeding screenshot database: $DB_DIR/crowdsec.db"
pnpm exec tsx "$SCRIPT_DIR/seed-demo-data.ts"

echo "Starting screenshot backend on port $CROWDSEC_SCREENSHOT_BACKEND_PORT"
pnpm exec tsx "$SCRIPT_DIR/demo-server.ts" &
BACKEND_PID="$!"
wait_for_url "http://127.0.0.1:${CROWDSEC_SCREENSHOT_BACKEND_PORT}/api/health" "backend"

echo "Starting frontend on ${CROWDSEC_SCREENSHOT_FRONTEND_HOST}:${CROWDSEC_SCREENSHOT_FRONTEND_PORT}"
pnpm exec vite --host "$CROWDSEC_SCREENSHOT_FRONTEND_HOST" --port "$CROWDSEC_SCREENSHOT_FRONTEND_PORT" &
FRONTEND_PID="$!"
wait_for_url "$CROWDSEC_SCREENSHOT_BASE_URL" "frontend"

echo "Capturing screenshots with $CHROME_PATH"
node "$SCRIPT_DIR/capture-screenshots.mjs"

echo "Screenshots written to $CROWDSEC_SCREENSHOT_OUTPUT_DIR"
