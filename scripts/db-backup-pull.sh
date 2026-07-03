#!/usr/bin/env bash
# Pull tonight's DB snapshot from the live box and commit it to the private
# crafthost-db-backup repo. Keeps the last 30 dated snapshots (git history
# keeps everything anyway; the prune just keeps checkouts small).
#
# Key: ~/.crafthost-backup-key (chmod 600) — must match BACKUP_KEY on Railway.
# crontab: 23 3 * * * bash /home/khaled/crafthost/scripts/db-backup-pull.sh
set -u
BASE="${BASE:-https://crafthost-production.up.railway.app}"
DEST="$HOME/crafthost-db-backup"
KEYFILE="$HOME/.crafthost-backup-key"
HIST=/tmp/crafthost-dbbackup.log

[ -f "$KEYFILE" ] || { echo "no key file" >>"$HIST"; exit 1; }
[ -d "$DEST/.git" ] || { echo "backup repo missing" >>"$HIST"; exit 1; }

STAMP=$(date -u +%Y-%m-%d)
OUT="$DEST/crafthost-$STAMP.db.gz"
code=$(curl -s --max-time 120 -H "X-Backup-Key: $(cat "$KEYFILE")" \
  "$BASE/api/platform/db-backup" -o "$OUT" -w "%{http_code}")

# Sanity: HTTP 200 and the payload really is a gzip'd SQLite file.
if [ "$code" != "200" ] || ! zcat "$OUT" 2>/dev/null | head -c 15 | grep -q "SQLite format"; then
  echo "FAIL $(date -u): http=$code" >>"$HIST"
  rm -f "$OUT"
  # Reuse the qa-failure label so GitHub emails the owner.
  if ! gh issue list -R khaledq84ever/crafthost --state open --label qa-failure --json number -q '.[0].number' 2>/dev/null | grep -q .; then
    gh issue create -R khaledq84ever/crafthost --label qa-failure \
      --title "DB off-site backup FAILED — $STAMP" \
      --body "Nightly DB snapshot pull returned http=$code or invalid payload. Check BACKUP_KEY env and /api/platform/db-backup." 2>>"$HIST"
  fi
  exit 1
fi

cd "$DEST"
ls -1t crafthost-*.db.gz 2>/dev/null | tail -n +31 | xargs -r rm --
git add -A
git commit -m "snapshot $STAMP" >>"$HIST" 2>&1
git push origin HEAD >>"$HIST" 2>&1
echo "ok $(date -u) $(du -h "$OUT" | cut -f1)" >>"$HIST"
