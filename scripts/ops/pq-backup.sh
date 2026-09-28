#!/bin/bash
#
# The one production backup: weekly, kept locally and mirrored to Google Drive.
#
# Installed on the VPS as /usr/local/bin/pq-backup.sh, run by pq-backup.timer
# (Saturdays 04:00 Australia/Melbourne). If it fails, pq-backup-alert.service
# emails marketing@pathfindercut.com.
#
#   1. fresh pg_dump + tar of the uploads volume into /opt/backups, each
#      integrity-checked before it gets its final name;
#   2. local files older than 30 days are deleted;
#   3. /opt/backups is mirrored to gdrive:PathQuote/backups (Google account
#      pathfindermarketingdept@gmail.com): Drive holds exactly the files that
#      are on the disk, no more, no fewer.
#
# The mirror bypasses the Drive trash -- trashed files still count against
# the 15 GB quota -- and refuses to delete more than MAX_DELETE files in one
# run, so an emptied /opt/backups can never wipe the off-site copies with it.
#
set -euo pipefail

BACKUP_DIR=/opt/backups
REMOTE="${PQ_BACKUP_REMOTE:-gdrive:PathQuote/backups}"
KEEP_DAYS=30
MAX_DELETE=6
COMPOSE=/opt/pathquote/docker-compose.yml
VOLUME=pathquote_uploads
STAMP=$(date -u +%Y-%m-%dT%H%MZ)

exec 9>/run/pq-backup.lock
flock -n 9 || { echo "$(date -Is) another backup is running" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
trap 'rm -f "$BACKUP_DIR"/*.tmp' EXIT

DB="$BACKUP_DIR/pq-$STAMP.sql.gz"
UP="$BACKUP_DIR/uploads-$STAMP.tar.gz"

docker compose -f "$COMPOSE" exec -T postgres pg_dump -U pathquote pathquote </dev/null \
  | gzip > "$DB.tmp"
gunzip -t "$DB.tmp"
# A dump with hardly any tables is a dump of the wrong (or an empty) database.
TABLES=$(zcat "$DB.tmp" | grep -c '^CREATE TABLE' || true)
if [ "$TABLES" -lt 10 ]; then
  echo "$(date -Is) dump has only $TABLES tables, refusing to keep it" >&2
  exit 1
fi
mv "$DB.tmp" "$DB"

docker run --rm -v "$VOLUME":/data:ro -v "$BACKUP_DIR":/backup alpine \
  tar czf "/backup/$(basename "$UP").tmp" -C /data . </dev/null
gunzip -t "$UP.tmp"
mv "$UP.tmp" "$UP"

find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'pq-*.sql.gz' -o -name 'uploads-*.tar.gz' \) \
  -mtime +"$KEEP_DAYS" -delete

rclone sync "$BACKUP_DIR" "$REMOTE" \
  --include 'pq-*.sql.gz' --include 'uploads-*.tar.gz' \
  --drive-use-trash=false --max-delete "$MAX_DELETE" --log-level NOTICE

echo "$(date -Is) backup ok: $(basename "$DB") ($TABLES tables), $(basename "$UP") -> $REMOTE"
