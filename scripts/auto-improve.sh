#!/usr/bin/env bash
# Weekly automated improvement pass: a headless Claude Code session reviews the
# platform's week (QA history, watchdog log, live health) and ships 1-3 SMALL,
# safe improvements aligned with the owner's standing priorities:
# server reliability, zero errors, easy UX, tunnels, up-to-date jars, bug-free pages.
#
# Same guards as auto-fix-qa.sh: kill switch ~/crafthost/.no-auto-claude,
# shared flock, hard timeout, logs to /tmp.
#
# crontab: 7 10 * * 0 bash /home/khaled/crafthost/scripts/auto-improve.sh
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="/tmp/crafthost-improve-$(date +%Y%m%d).log"
LOCK="/tmp/crafthost-claude-auto.lock"
HIST="/tmp/crafthost-improve-history.log"

[ -f "$DIR/.no-auto-claude" ] && { echo "disabled by .no-auto-claude $(date -u)" >>"$HIST"; exit 0; }
command -v claude >/dev/null 2>&1 || { echo "claude CLI missing $(date -u)" >>"$HIST"; exit 0; }

exec 9>"$LOCK"
flock -n 9 || { echo "another automated session running $(date -u)" >>"$HIST"; exit 0; }

cd "$DIR"

PROMPT="You are the automated weekly maintainer of CraftHost (~/crafthost), a free Minecraft hosting site, live at https://crafthost-production.up.railway.app.

Do ONE improvement pass, in this order:
1. Review the week: /tmp/crafthost-qa-history.log, /tmp/crafthost-watchdog.log, /tmp/crafthost-autofix-history.log, latest /tmp/crafthost-qa-*.log, and GET /api/health (note the capacity + disk snapshot).
2. Check jar freshness: compare the version pickers (GET /api/jars/... endpoints) against upstream latest (PaperMC fill.papermc.io/v3 — NOT the sunset v2 API — plus Purpur/Fabric/NeoForge/vanilla). If a new stable MC version or build is missing, that is your top priority.
3. Pick 1-3 SMALL, safe improvements strictly within the owner's priorities: server reliability, zero errors, easy UX, tunnel stability (Java + Bedrock), up-to-date jars, bug-free pages. Prefer fixing anything the week's logs show recurring.
4. Implement, test locally (local Java is 17 → MC <=1.20.x only; SOFT_BOOT=1 for the journey test), deploy with 'railway up --detach', wait for /api/health uptime reset, then run 'bash scripts/qa-live.sh'.
5. If live QA fails after your deploy, revert (redeploy last known-good commit) — never leave the site worse.

Hard rules (owner directives):
- NO admin features, NO billing/payments (free site forever), NO large refactors, NO new dependencies unless unavoidable.
- Never touch the production database or backups repo.
- dashboard.js uses section-level DOM patching (patchCard) — never switch back to outerHTML swaps.
- When adding Material Symbols icons, update icon_names in the HTML font links.
- Commit messages: prefix 'improve:'. Autosave cron commits every 2 min — normal.
- Finish by writing a summary of what you changed (or 'nothing needed') to /tmp/crafthost-improve-summary-$(date +%Y%m%d).md."

echo "improve start $(date -u)" >>"$HIST"
timeout 3600 claude -p "$PROMPT" --dangerously-skip-permissions >"$LOG" 2>&1
RC=$?
echo "improve done $(date -u) rc=$RC log=$LOG" >>"$HIST"
exit 0
