#!/usr/bin/env bash
# Automated fixer: when the daily QA run fails, qa-cron.sh calls this to run a
# headless Claude Code session that diagnoses the failure, fixes it, re-tests,
# and deploys ONLY if the full live QA suite passes afterwards.
#
# Guards:
#   • kill switch — `touch ~/crafthost/.no-auto-claude` disables all automated
#     Claude runs (this script and auto-improve.sh)
#   • flock — never two automated sessions at once (also excludes auto-improve)
#   • 40-minute hard timeout
#   • everything logged to /tmp/crafthost-autofix-<date>.log
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
QA_LOG="${1:-}"
LOG="/tmp/crafthost-autofix-$(date +%Y%m%d-%H%M).log"
LOCK="/tmp/crafthost-claude-auto.lock"
HIST="/tmp/crafthost-autofix-history.log"

[ -f "$DIR/.no-auto-claude" ] && { echo "disabled by .no-auto-claude $(date -u)" >>"$HIST"; exit 0; }
command -v claude >/dev/null 2>&1 || { echo "claude CLI missing $(date -u)" >>"$HIST"; exit 0; }

exec 9>"$LOCK"
flock -n 9 || { echo "another automated session running $(date -u)" >>"$HIST"; exit 0; }

cd "$DIR"
FAIL_EXCERPT=""
[ -n "$QA_LOG" ] && [ -f "$QA_LOG" ] && FAIL_EXCERPT=$(grep -E "FAIL|✗" "$QA_LOG" | head -30)

PROMPT="You are the automated maintainer of CraftHost (~/crafthost), a free Minecraft hosting site. The daily QA suite against the live site (https://crafthost-production.up.railway.app) FAILED. Your job: diagnose and fix it.

Failing excerpt from $QA_LOG:
$FAIL_EXCERPT

Rules (owner directives — do not violate):
- Fix ONLY what the failing tests point at. No refactors, no new features, no admin/billing work.
- Never touch the production database, the backups repo, or delete user data.
- Read the full QA log at $QA_LOG first, reproduce locally where possible (local Java is 17 → MC <=1.20.x only; use SOFT_BOOT=1 for the journey test).
- After fixing, deploy with 'railway up --detach' from ~/crafthost, wait for /api/health uptime to reset, then run 'bash scripts/qa-live.sh'.
- If live QA passes: comment on the open qa-failure GitHub issue (repo khaledq84ever/crafthost) with what was fixed and close it.
- If you cannot make live QA pass, DO NOT leave the site worse than you found it (revert your deploy by redeploying the last known-good commit if needed) and comment your findings on the qa-failure issue instead.
- Commit messages: prefix 'autofix:'. An autosave cron also commits every 2 min — that is normal."

echo "autofix start $(date -u) (qa log: $QA_LOG)" >>"$HIST"
timeout 2400 claude -p "$PROMPT" --dangerously-skip-permissions >"$LOG" 2>&1
RC=$?
echo "autofix done $(date -u) rc=$RC log=$LOG" >>"$HIST"
exit 0
