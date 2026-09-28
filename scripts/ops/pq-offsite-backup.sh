#!/bin/bash
#
# Weekly off-site backup of production to Google Drive.
#
# Installed on the VPS as /usr/local/bin/pq-offsite-backup.sh and run by
# pq-offsite-backup.timer (Saturdays 04:00 Australia/Melbourne). Takes a FRESH
# database dump and uploads archive (not the nightly copies in /opt/backups,
# which sit on the same disk as the database), uploads both to
# gdrive:PathQuote/backups (Google account pathfindermarketingdept@gmail.com,
# rclone remote `gdrive` in /root/.config/rclone/rclone.conf), then deletes
# anything there older than 30 days.
#
# Deletes skip the Drive trash: trashed files still count against the 15 GB
# quota, so "delete old backups to save space" would otherwise save nothing.
#
set -euo pipefail

REMOTE="${PQ_OFFSITE_REMOTE:-gdrive:PathQuote/backups}"
KEEP="${PQ_OFFSITE_KEEP:-30d}"
COMPOSE=/opt/pathquote/docker-compose.yml
VOLUME=pathquote_uploads
STAGE=/opt/backups/offsite
STAMP=$(date -u +%Y-%m-%dT%H%MZ)

# One run at a time: a slow upload must not overlap the next one.
exec 9>/run/pq-offsite-backup.lock
flock -n 9 || { echo "$(date -Is) another run is in progress"; exit 1; }

mkdir -p "$STAGE"
trap 'rm -f "$STAGE"/*.tmp' EXIT

DB="$STAGE/pq-$STAMP.sql.gz"
UP="$STAGE/uploads-$STAMP.tar.gz"

docker compose -f "$COMPOSE" exec -T postgres pg_dump -U pathquote pathquote </dev/null \
  | gzip > "$DB.tmp"
gunzip -t "$DB.tmp"
# A dump with no tables is a dump of the wrong (or an empty) database.
if [ "$(zcat "$DB.tmp" | grep -c '^CREATE TABLE')" -lt 10 ]; then
  echo "$(date -Is) dump has too few tables, refusing to upload it" >&2
  exit 1
fi
mv "$DB.tmp" "$DB"

docker run --rm -v "$VOLUME":/data:ro -v "$STAGE":/backup alpine \
  tar czf "/backup/$(basename "$UP").tmp" -C /data . </dev/null
gunzip -t "$UP.tmp"
mv "$UP.tmp" "$UP"

# `copy` verifies each upload against Drive's MD5 before reporting success.
rclone copy "$DB" "$REMOTE" --log-level NOTICE
rclone copy "$UP" "$REMOTE" --log-level NOTICE

rclone delete "$REMOTE" --min-age "$KEEP" --drive-use-trash=false --log-level NOTICE

# The local staging copies have done their job; the nightly pq-backup.sh keeps
# its own 14 days in /opt/backups.
rm -f "$DB" "$UP"

echo "$(date -Is) offsite backup ok: $(basename "$DB") $(basename "$UP") -> $REMOTE"
