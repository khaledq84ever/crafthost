#!/usr/bin/env bash
# Auto-save: commit + push any working-tree changes so work is never lost.
# Runs from cron every 2 minutes. Silent no-op when the tree is clean, a git
# operation is already in progress, or another autosave is still running.
#
# crontab: */2 * * * * bash /home/khaled/crafthost/scripts/autosave.sh
set -u
DIR="/home/khaled/crafthost"
cd "$DIR" || exit 0

# Don't fight an in-flight git operation (mine or Claude's).
exec 9>"/tmp/crafthost-autosave.lock"
flock -n 9 || exit 0
[ -f .git/index.lock ] && exit 0
[ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || [ -f .git/MERGE_HEAD ] && exit 0

# Nothing changed → nothing to do.
git status --porcelain | grep -q . || {
  # Still push any local commits that haven't reached origin yet.
  ahead=$(git rev-list --count origin/main..main 2>/dev/null || echo 0)
  [ "$ahead" -gt 0 ] && git push origin main >>/tmp/crafthost-autosave.log 2>&1
  exit 0
}

git add -A
git commit -m "autosave: $(date -u +'%Y-%m-%d %H:%M UTC')" >>/tmp/crafthost-autosave.log 2>&1
git push origin main >>/tmp/crafthost-autosave.log 2>&1
