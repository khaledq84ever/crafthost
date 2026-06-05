#!/usr/bin/env bash
# Local smoke test: boots the server on a throwaway DB, runs the page sweep
# and the register→server e2e health check against it, then tears down.
# Exit 0 only if both suites pass. Used by `npm test`.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-4099}"
export PORT
export NODE_ENV=test
export JWT_SECRET="${JWT_SECRET:-smoke-test-secret-not-for-prod}"
export DATABASE_PATH="$(mktemp -u /tmp/crafthost-smoke-XXXX.db)"
export AUTO_STARTER="${AUTO_STARTER:-1}"

echo "▶ booting server on :$PORT (db: $DATABASE_PATH)"
node backend/db/init.js >/dev/null 2>&1
node backend/server.js >/tmp/crafthost-smoke.log 2>&1 &
SRV_PID=$!
cleanup() { kill "$SRV_PID" 2>/dev/null; rm -f "$DATABASE_PATH"* 2>/dev/null; }
trap cleanup EXIT

# wait for it to listen
for i in $(seq 1 20); do
  curl -fsS -o /dev/null "http://localhost:$PORT/api/health" 2>/dev/null && break
  sleep 0.5
done

fail=0
BASE="http://localhost:$PORT" node scripts/test-pages.mjs || fail=1
BASE="http://localhost:$PORT" node scripts/test-health-check.mjs || fail=1

if [ "$fail" -ne 0 ]; then
  echo "✗ smoke tests FAILED — server log:"
  tail -30 /tmp/crafthost-smoke.log
  exit 1
fi
echo "✓ smoke tests PASSED"
