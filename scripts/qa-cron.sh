#!/usr/bin/env bash
# Cron wrapper for the daily live QA run. On failure it files a GitHub issue
# (repo watchers get emailed by GitHub) with the failing output attached.
# Skips filing if an open qa-failure issue already exists, so a broken site
# doesn't spam one issue per day.
#
# crontab: 17 9 * * * bash /home/khaled/crafthost/scripts/qa-cron.sh
set -u
REPO="khaledq84ever/crafthost"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="/tmp/crafthost-qa-$(date +%Y%m%d).log"

cd "$DIR"
if bash scripts/qa-live.sh >"$LOG" 2>&1; then
  echo "QA passed $(date -u)" >>/tmp/crafthost-qa-history.log
  exit 0
fi

echo "QA FAILED $(date -u)" >>/tmp/crafthost-qa-history.log

# Don't stack duplicate issues while a failure is already being tracked.
if gh issue list -R "$REPO" --state open --label qa-failure --json number -q '.[0].number' 2>/dev/null | grep -q .; then
  exit 1
fi

# Failing suites + their ✗ lines, trimmed to keep the issue readable.
SUMMARY=$(grep -E "FAIL|✗" "$LOG" | head -40)
gh issue create -R "$REPO" \
  --title "Daily QA failed — $(date -u +%Y-%m-%d)" \
  --label qa-failure \
  --body "$(printf 'Automated daily QA against the live site failed.\n\n```\n%s\n```\n\nFull log: `%s` on the QA machine.\n' "$SUMMARY" "$LOG")" \
  2>>/tmp/crafthost-qa-history.log
exit 1
