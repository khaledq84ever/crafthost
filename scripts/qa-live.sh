#!/usr/bin/env bash
# Full automated QA against the LIVE site. Runs every suite that matters and
# prints one summary line per suite; exits non-zero if anything failed.
#
# Usage: bash scripts/qa-live.sh            (defaults to production)
#        BASE=https://... bash scripts/qa-live.sh
set -u
BASE="${BASE:-https://crafthost-production.up.railway.app}"
cd "$(dirname "$0")/.."

declare -A RESULTS
FAILED=0

run() {
  local name="$1"; shift
  echo ""
  echo "━━━━━━ $name ━━━━━━"
  if "$@"; then
    RESULTS[$name]="PASS"
  else
    RESULTS[$name]="FAIL"
    FAILED=1
  fi
}

run "pages-assets"    env BASE="$BASE" node scripts/test-pages.mjs
run "pages-js"        env BASE="$BASE" node scripts/test-pages-js.mjs
run "journey-desktop" env BASE="$BASE" node scripts/test-e2e-user-journey.mjs
run "journey-mobile"  env BASE="$BASE" MOBILE=1 node scripts/test-e2e-user-journey.mjs
run "console-e2e"     env BASE="$BASE" node scripts/test-e2e-console.mjs
# Engines matrix boots 5 real servers (~5 min). SKIP_MATRIX=1 for a quick run.
if [ "${SKIP_MATRIX:-0}" != "1" ]; then
  run "engines-matrix" env BASE="$BASE" node scripts/test-all-engines.mjs
fi

echo ""
echo "━━━━━━ QA SUMMARY ($BASE) ━━━━━━"
for k in "${!RESULTS[@]}"; do printf "  %-16s %s\n" "$k" "${RESULTS[$k]}"; done
exit $FAILED
