#!/bin/bash
#
# Emails the tail of the backup log when pq-backup.service fails
# (OnFailure=pq-backup-alert.service). Sends through the app's own SMTP
# account (SMTP_* and EMAIL_FROM in /opt/pathquote/.env -- Resend today).
#
# `pq-backup-alert.sh --test` sends a clearly marked test message.
#
set -euo pipefail

TO="${PQ_ALERT_TO:-marketing@pathfindercut.com}"
ENV_FILE=/opt/pathquote/.env
LOG=/var/log/pq-backup.log

# Read only the keys this needs; values may be quoted in .env.
env_value() {
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}
HOST=$(env_value SMTP_HOST); PORT=$(env_value SMTP_PORT); USER=$(env_value SMTP_USER)
PASS=$(env_value SMTP_PASS); FROM_HEADER=$(env_value EMAIL_FROM)
FROM_ADDR=$(printf '%s' "$FROM_HEADER" | sed -n 's/.*<\(.*\)>.*/\1/p')
FROM_ADDR=${FROM_ADDR:-$FROM_HEADER}

if [ "${1:-}" = "--test" ]; then
  SUBJECT="[PathQuote] TEST: backup alert works"
  INTRO="This is a test of the backup failure alert. Nothing is wrong."
else
  SUBJECT="[PathQuote] Production backup FAILED on $(hostname)"
  INTRO="The weekly production backup (pq-backup.service) failed at $(date -u '+%Y-%m-%d %H:%M UTC').
Off-site copies in Google Drive (PathQuote/backups) were not updated.
Check: systemctl status pq-backup.service ; tail -100 $LOG"
fi

MSG=$(mktemp)
trap 'rm -f "$MSG"' EXIT
{
  printf 'From: %s\r\nTo: %s\r\nSubject: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' \
    "$FROM_HEADER" "$TO" "$SUBJECT"
  printf '%s\n\nLast log lines:\n\n' "$INTRO"
  tail -40 "$LOG" 2>/dev/null || echo "(no log)"
} > "$MSG"

curl -sS --ssl-reqd --url "smtp://$HOST:${PORT:-587}" \
  --user "$USER:$PASS" --mail-from "$FROM_ADDR" --mail-rcpt "$TO" --upload-file "$MSG"
echo "$(date -Is) alert sent to $TO: $SUBJECT"
