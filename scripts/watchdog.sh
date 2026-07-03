#!/usr/bin/env bash
# Hourly platform watchdog. Cheap checks only (no server boots):
#   1. /api/health returns ok:true
#   2. the landing page serves HTML
# On failure: file ONE deduped GitHub issue (label platform-down). On
# recovery: close it with a comment.
#
# crontab: 41 * * * * bash /home/khaled/crafthost/scripts/watchdog.sh
set -u
REPO="khaledq84ever/crafthost"
BASE="${BASE:-https://crafthost-production.up.railway.app}"
HIST=/tmp/crafthost-watchdog.log

fail_reason=""
health=$(curl -s --max-time 20 "$BASE/api/health" || true)
if ! grep -q '"ok":true' <<<"$health"; then
  fail_reason="/api/health bad or unreachable: ${health:0:200}"
elif ! curl -s --max-time 20 "$BASE/" | grep -qi "<html"; then
  fail_reason="/ did not serve HTML"
fi

open_issue=$(gh issue list -R "$REPO" --state open --label platform-down --json number -q '.[0].number' 2>/dev/null || true)

if [ -z "$fail_reason" ]; then
  echo "ok $(date -u)" >>"$HIST"
  # Recovered? Close the outage issue so the next outage files a fresh one.
  if [ -n "$open_issue" ]; then
    gh issue close "$open_issue" -R "$REPO" \
      -c "Watchdog: site is reachable again as of $(date -u). Auto-closing." 2>>"$HIST"
  fi
  exit 0
fi

echo "FAIL $(date -u): $fail_reason" >>"$HIST"
if [ -z "$open_issue" ]; then
  gh issue create -R "$REPO" \
    --title "Platform DOWN — $(date -u +'%Y-%m-%d %H:%M UTC')" \
    --label platform-down \
    --body "$(printf 'Hourly watchdog failed.\n\n```\n%s\n```\nChecked from the QA machine; will auto-close when the site responds again.\n' "$fail_reason")" \
    2>>"$HIST"
fi
exit 1
