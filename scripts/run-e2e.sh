#!/usr/bin/env bash
# Orchestrates the E2E test run:
#   1. Ensures agent_saas_test DB is at head (prisma migrate deploy).
#   2. Boots the API against .env.test as a background process on port 3999.
#   3. Waits for /health/live.
#   4. Runs jest with jest-e2e.json.
#   5. Tears the API down, cleans Redis test DB, regardless of test outcome.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env.test ]; then
  echo "ERROR: .env.test missing" >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a
source .env.test
set +a

echo "── [1/4] Applying migrations to agent_saas_test ─────────────"
DATABASE_URL="$MIGRATION_DATABASE_URL" npx prisma migrate deploy >/dev/null

echo "── [2/4] Building app ───────────────────────────────────────"
npm run build --silent

echo "── [3/4] Booting API on port $PORT ──────────────────────────"
node --enable-source-maps dist/main > /tmp/e2e-api.log 2>&1 &
APP_PID=$!
trap 'kill $APP_PID 2>/dev/null || true; redis-cli -n "${REDIS_DB_QUEUES}" FLUSHDB > /dev/null 2>&1 || true' EXIT

# Poll /health/live until ready (max 20s)
for _ in {1..100}; do
  if curl -sf "http://localhost:${PORT}/health/live" > /dev/null; then
    break
  fi
  sleep 0.2
done

if ! curl -sf "http://localhost:${PORT}/health/live" > /dev/null; then
  echo "ERROR: API failed to start. Logs:" >&2
  tail -40 /tmp/e2e-api.log >&2
  exit 1
fi

echo "── [4/4] Running jest e2e suite ─────────────────────────────"
E2E_API_URL="http://localhost:${PORT}" \
  npx jest --config test/jest-e2e.json "$@"
