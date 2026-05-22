#!/bin/bash
# Continuous test loop. Rotates through all 5 E2E + unit suites against
# production and reports every iteration. Stops after DURATION_SECONDS.
#
#   DURATION_SECONDS=1800 bash scripts/test-loop.sh    # 30 min
#   DURATION_SECONDS=300  bash scripts/test-loop.sh    # 5 min smoke
#
# Output: one line per suite per iteration. Failures are clearly marked.

set -u
cd "$(dirname "$0")/.."

DURATION=${DURATION_SECONDS:-1800}
BASE=${BASE:-https://crafthost-production.up.railway.app}
END=$(( $(date +%s) + DURATION ))
ITER=0
TOTAL_PASS=0
TOTAL_FAIL=0
declare -A SUITE_PASS SUITE_FAIL

SUITES=(
  "auto-fix:node scripts/test-auto-fix.mjs"
  "pages:BASE=$BASE node scripts/test-pages.mjs"
  "health-check:BASE=$BASE node scripts/test-health-check.mjs"
  "file-save:BASE=$BASE node scripts/test-file-save.mjs"
  "clone:BASE=$BASE node scripts/test-clone.mjs"
  "deploy-plugins:BASE=$BASE node scripts/test-deploy-plugins.mjs"
)

echo "=== CraftHost continuous-test loop ==="
echo "Base: $BASE"
echo "Duration: ${DURATION}s ($((DURATION / 60))min)"
echo "Suites: ${#SUITES[@]}"
echo "Starting at $(date +%H:%M:%S), ending at $(date -d "+${DURATION} seconds" +%H:%M:%S 2>/dev/null || date -v+${DURATION}S +%H:%M:%S)"
echo

while [ "$(date +%s)" -lt "$END" ]; do
  ITER=$((ITER + 1))
  for entry in "${SUITES[@]}"; do
    NAME="${entry%%:*}"
    CMD="${entry#*:}"
    [ "$(date +%s)" -ge "$END" ] && break
    T0=$(date +%s)
    # Capture both stdout/stderr; only emit one line per suite
    OUTPUT=$(eval "$CMD" 2>&1)
    RC=$?
    T1=$(date +%s)
    DUR=$((T1 - T0))
    if [ $RC -eq 0 ]; then
      TOTAL_PASS=$((TOTAL_PASS + 1))
      SUITE_PASS[$NAME]=$(( ${SUITE_PASS[$NAME]:-0} + 1 ))
      echo "[$(date +%H:%M:%S)] iter $ITER · $NAME · PASS · ${DUR}s"
    else
      TOTAL_FAIL=$((TOTAL_FAIL + 1))
      SUITE_FAIL[$NAME]=$(( ${SUITE_FAIL[$NAME]:-0} + 1 ))
      echo "[$(date +%H:%M:%S)] iter $ITER · $NAME · FAIL · rc=$RC · ${DUR}s"
      # Dump last 10 lines of failure output for triage
      echo "$OUTPUT" | tail -10 | sed 's/^/    /'
    fi
  done
done

echo
echo "=== Summary ==="
echo "Iterations: $ITER · Total runs: $((TOTAL_PASS + TOTAL_FAIL)) · ${TOTAL_PASS} pass / ${TOTAL_FAIL} fail"
for entry in "${SUITES[@]}"; do
  NAME="${entry%%:*}"
  P=${SUITE_PASS[$NAME]:-0}
  F=${SUITE_FAIL[$NAME]:-0}
  printf "  %-15s  %d pass · %d fail\n" "$NAME" "$P" "$F"
done

if [ $TOTAL_FAIL -eq 0 ]; then
  echo
  echo "ALL GREEN across $TOTAL_PASS runs over ${DURATION}s"
  exit 0
else
  echo
  echo "$TOTAL_FAIL failures detected — see lines above"
  exit 1
fi
