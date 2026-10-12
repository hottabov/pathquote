#!/bin/bash
#
# Emails the tail of a failed job's log
# (OnFailure=pq-backup-alert@%n.service passes the failed unit's name). Sends through the app's own SMTP
# account (SMTP_* and EMAIL_FROM in /opt/pathquote/.env -- Resend today).
#
# Several different jobs now fail into this script, and the mail has to be true
# for each, so the wording and the log it tails come from that unit name:
#
#   pq-backup-db.service / pq-backup-files.service
#       backup wording, /var/log/pq-backup.log
#   pq-act-sync.service
#       sync wording, /var/log/pq-act-sync.log
#   pq-act-drain.service
#       drain wording, /var/log/pq-act-drain.log
#   pq-act-weekly-report.service
#       weekly-report wording, /var/log/pq-act-weekly-report.log
#
# Anything else is named as itself and the mail says it has no wording for it.
# Telling the director his backup failed when it was the ACT! sync is the bug
# this flavouring exists to fix, so an unknown unit must not fall through to the
# backup text.
#
# The script keeps the name it had when the backup was the only thing that could
# fail. Renaming it means editing OnFailure= in every unit and moving the file in
# the same breath, and a half-finished rename is a failure that emails nobody.
#
# `pq-backup-alert.sh --test` sends a clearly marked test message, of the backup
# flavour; `pq-backup-alert.sh --test pq-act-sync.service` tests the sync's, and
# so on for each unit above.
#
# ONE A DAY, FOR THE DRAIN ONLY. pq-act-drain.service runs every 15 minutes, so
# a fault that needs a person fails it about 96 times a day, and an email each
# time is how people learn to ignore this address. Its flavour sets
# REPEAT_HOURS and a stamp file: an alert is not sent while the stamp is
# younger than that, and the stamp is touched only once curl has sent one. The
# drain's own script removes the stamp after a pass that got writes into ACT!
# (pq-act-drain.sh), so a fault that comes back after a recovery emails at
# once. Every other flavour has no REPEAT_HOURS and emails every failure, as
# before; a --test is never held back and never stamps.
#
set -euo pipefail

TO="${PQ_ALERT_TO:-marketing@pathfindercut.com}"
ENV_FILE=/opt/pathquote/.env

# `--test` on its own still means the backup email, so the line in the runbook
# keeps doing what it says. A unit name after it picks the other flavour.
TEST=no
UNIT="${1:-pq-backup}"
if [ "$UNIT" = "--test" ]; then
  TEST=yes
  UNIT="${2:-pq-backup}"
fi

case "$UNIT" in
  pq-act-weekly-report*)
    LOG=/var/log/pq-act-weekly-report.log
    WHAT="Monday ACT! activity report"
    WHAT_SUBJECT="Weekly ACT! activity report"
    WHAT_TEST="weekly report"
    CONSEQUENCE="Some or all sales managers did not get this week's activity report. The
log below names each manager and whether their email went. Re-send by hand
on the VPS (it reports the last finished Mon-Sun week whatever day it runs):
  systemctl start pq-act-weekly-report.service"
    ;;
  pq-act-drain*)
    LOG=/var/log/pq-act-drain.log
    WHAT="ACT! quote drain"
    WHAT_SUBJECT="ACT! quote drain"
    WHAT_TEST="ACT! drain"
    # Says it will repeat, because it will: the unit runs every 15 minutes and
    # fails only on what does not mend itself (scripts/act-drain.ts, its exit
    # table), so it fails every tick until somebody fixes it -- and this
    # email goes once a day of that (REPEAT_HOURS, below). Better the first
    # one says so than the second arrives unexplained.
    CONSEQUENCE="Queued quotes are not reaching ACT!: quotes finalised, signed or accepted
in PathQuote since the last good pass are waiting in PathQuote's queue, not in
ACT!. Nothing is lost -- they go once this is fixed. This runs every 15 minutes,
and you get this once a day while it stays broken. The log below says why."
    # The stamp is named after the unit, as OnFailure= hands it over
    # (pq-act-drain.service); pq-act-drain.sh removes the same path.
    REPEAT_HOURS=24
    STAMP=/var/lib/pathquote/alert-stamps/$UNIT.last-sent
    ;;
  pq-act-sync*)
    LOG=/var/log/pq-act-sync.log
    WHAT="nightly ACT! sync"
    WHAT_SUBJECT="Nightly ACT! sync"
    WHAT_TEST="ACT! sync"
    # No promise that Settings shows this. The run records itself only once it
    # has the sync lock, so every failure before that point -- a stale or
    # missing image, compose down, no DATABASE_URL, ACT! not answering -- leaves
    # no record at all and the page goes on showing the previous run. Sending
    # the director to a page that says "No changes" about tonight is the same
    # class of lie this flavouring exists to stop, so the mail points at the log
    # it is already carrying.
    CONSEQUENCE="ACT! and PathQuote have drifted: contacts and companies changed in ACT!
since the last good run are not in PathQuote. Nothing is lost -- the next run
picks them up. Backups are unaffected. The Settings page may still show the
previous run, because a failure before the sync starts leaves no record of
itself; the log below is what happened."
    ;;
  pq-backup*)
    LOG=/var/log/pq-backup.log
    WHAT="production backup"
    WHAT_SUBJECT="Production backup"
    WHAT_TEST="backup"
    CONSEQUENCE="Off-site copies in Google Drive (PathQuote/backups) may not be up to date."
    ;;
  *)
    LOG=
    WHAT="unit"
    # The unit goes in the subject here, not just the body: with no wording of
    # its own, its name is the only thing the subject line can usefully carry.
    WHAT_SUBJECT="Unit $UNIT"
    WHAT_TEST="unit"
    CONSEQUENCE="Nothing here knows what $UNIT does, so this mail cannot say what has
stopped working or what it costs. Its own output is below."
    ;;
esac

# Held back while the last alert for this unit is younger than REPEAT_HOURS.
# Only for a flavour that sets STAMP and REPEAT_HOURS; a --test always goes.
if [ "$TEST" = no ] && [ -n "${STAMP:-}" ] && [ -e "$STAMP" ] &&
  [ -n "$(find "$STAMP" -mmin -$((REPEAT_HOURS * 60)))" ]; then
  echo "$(date -Is) alert for $UNIT suppressed: one was sent $(date -Is -r "$STAMP"), less than $REPEAT_HOURS hours ago"
  exit 0
fi

if [ -n "$LOG" ]; then
  CHECK="systemctl status $UNIT ; tail -100 $LOG"
else
  CHECK="systemctl status $UNIT ; journalctl -u $UNIT -n 100"
fi

# Read only the keys this needs; values may be quoted in .env.
env_value() {
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}
HOST=$(env_value SMTP_HOST); PORT=$(env_value SMTP_PORT); USER=$(env_value SMTP_USER)
PASS=$(env_value SMTP_PASS); FROM_HEADER=$(env_value EMAIL_FROM)
FROM_ADDR=$(printf '%s' "$FROM_HEADER" | sed -n 's/.*<\(.*\)>.*/\1/p')
FROM_ADDR=${FROM_ADDR:-$FROM_HEADER}

if [ "$TEST" = yes ]; then
  SUBJECT="[PathQuote] TEST: $WHAT_TEST alert works"
  INTRO="This is a test of the $WHAT_TEST failure alert. Nothing is wrong."
else
  SUBJECT="[PathQuote] $WHAT_SUBJECT FAILED on $(hostname)"
  INTRO="The $WHAT $UNIT failed at $(date -u '+%Y-%m-%d %H:%M UTC').
$CONSEQUENCE
Check: $CHECK"
fi

MSG=$(mktemp)
trap 'rm -f "$MSG"' EXIT
{
  printf 'From: %s\r\nTo: %s\r\nSubject: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' \
    "$FROM_HEADER" "$TO" "$SUBJECT"
  printf '%s\n\nLast log lines:\n\n' "$INTRO"
  # A unit with no log of its own still has a journal, which is where its output
  # went; journalctl ships with the systemd that called this script, so reaching
  # for it adds nothing to install.
  if [ -n "$LOG" ]; then
    tail -40 "$LOG" 2>/dev/null || echo "(no log)"
  else
    journalctl -u "$UNIT" -n 40 --no-pager 2>/dev/null || echo "(no log)"
  fi
} > "$MSG"

curl -sS --ssl-reqd --url "smtp://$HOST:${PORT:-587}" \
  --user "$USER:$PASS" --mail-from "$FROM_ADDR" --mail-rcpt "$TO" --upload-file "$MSG"
echo "$(date -Is) alert sent to $TO: $SUBJECT"

# After curl, and only after: under `set -e` a curl that failed has already
# ended the script, so an alert that never left starts no quiet day. The
# directory is made here too, in case the install has not made it -- a stamp
# that cannot be written costs a repeat email, not a missing one.
if [ "$TEST" = no ] && [ -n "${STAMP:-}" ]; then
  mkdir -p "$(dirname "$STAMP")"
  touch "$STAMP"
fi
