#!/bin/bash
#
# Production backups, kept locally and mirrored to Google Drive.
#
#   pq-backup.sh db      database dump   -- daily    (pq-backup-db.timer)
#   pq-backup.sh files   uploads volume  -- weekly   (pq-backup-files.timer)
#
# Installed on the VPS as /usr/local/bin/pq-backup.sh. Both timers fire at
# Melbourne local time; a failure starts pq-backup-alert@<unit>.service, which
# emails marketing@pathfindercut.com.
#
# Each run:
#   1. writes a fresh artifact into /opt/backups, integrity-checked before it
#      gets its final name (a .tmp never looks like a valid backup);
#   2. deletes local artifacts of the same kind older than 30 days;
#   3. mirrors /opt/backups to gdrive:PathQuote/backups (Google account
#      pathfindermarketingdept@gmail.com): Drive holds exactly the files on
#      the disk, so rotation on the disk is rotation on Drive.
#
# The mirror bypasses the Drive trash -- trashed files still count against
# the 15 GB quota -- and refuses to delete more than MAX_DELETE files in one
# run, so an emptied /opt/backups can never wipe the off-site copies with it.
#
set -euo pipefail

KIND="${1:-}"
case "$KIND" in
  db|files) ;;
  *) echo "usage: $0 db|files" >&2; exit 2 ;;
esac

BACKUP_DIR=/opt/backups
REMOTE="${PQ_BACKUP_REMOTE:-gdrive:PathQuote/backups}"
KEEP_DAYS=30
MAX_DELETE=6
COMPOSE=/opt/pathquote/docker-compose.yml
VOLUME=pathquote_uploads
STAMP=$(date -u +%Y-%m-%dT%H%MZ)

# The two jobs share the mirror step, so they take turns rather than race.
exec 9>/run/pq-backup.lock
flock -w 3600 9 || { echo "$(date -Is) $KIND: waited an hour for the other backup" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
trap 'rm -f "$BACKUP_DIR"/*.tmp' EXIT

if [ "$KIND" = db ]; then
  OUT="$BACKUP_DIR/pq-$STAMP.sql.gz"
  PATTERN='pq-*.sql.gz'
  docker compose -f "$COMPOSE" exec -T postgres pg_dump -U pathquote pathquote </dev/null \
    | gzip > "$OUT.tmp"
  gunzip -t "$OUT.tmp"
  # A dump with hardly any tables is a dump of the wrong (or an empty) database.
  TABLES=$(zcat "$OUT.tmp" | grep -c '^CREATE TABLE' || true)
  if [ "$TABLES" -lt 10 ]; then
    echo "$(date -Is) db: dump has only $TABLES tables, refusing to keep it" >&2
    exit 1
  fi
  DETAIL="$TABLES tables"
else
  OUT="$BACKUP_DIR/uploads-$STAMP.tar.gz"
  PATTERN='uploads-*.tar.gz'
  docker run --rm -v "$VOLUME":/data:ro -v "$BACKUP_DIR":/backup alpine \
    tar czf "/backup/$(basename "$OUT").tmp" -C /data . </dev/null
  gunzip -t "$OUT.tmp"
  DETAIL="$(du -h "$OUT.tmp" | cut -f1)"
fi
mv "$OUT.tmp" "$OUT"

find "$BACKUP_DIR" -maxdepth 1 -type f -name "$PATTERN" -mtime +"$KEEP_DAYS" -delete

rclone sync "$BACKUP_DIR" "$REMOTE" \
  --include 'pq-*.sql.gz' --include 'uploads-*.tar.gz' \
  --drive-use-trash=false --max-delete "$MAX_DELETE" --log-level NOTICE

echo "$(date -Is) $KIND backup ok: $(basename "$OUT") ($DETAIL) -> $REMOTE"
