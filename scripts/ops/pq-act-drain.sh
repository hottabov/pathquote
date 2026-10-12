#!/bin/bash
#
# The periodic ActOutbox drain: quotes queued for ACT! are sent to it.
#
#   pq-act-drain.sh   one pass over every due row -- every 15 minutes
#                     (pq-act-drain.timer)
#
# Installed on the VPS as /usr/local/bin/pq-act-drain.sh. A failure starts
# pq-backup-alert@<unit>.service, which emails marketing@pathfindercut.com --
# and a failure is only what needs a person: the pass stopped on a fault that
# will not mend itself, the pass threw, or it could not start. Another drain
# busy, sending switched off, ACT! busy or away, quotes held back or backing
# off all exit 0 (the exit table in scripts/act-drain.ts), because a unit that
# runs every 15 minutes fails every 15 minutes about whatever it fails on.
# The alert sends one email a day of a failure that goes on (its stamp, in
# pq-backup-alert.sh); this script removes the stamp after a pass that got
# writes into ACT!, so the next fault emails at once rather than waiting out
# the day.
#
# No flock here, for the reason pq-act-sync.sh has none: mutual exclusion for
# the drain lives in the worker, as a Postgres advisory lock (DRAIN_LOCK_KEY in
# src/lib/act/drain.ts), because drains also start inside the app container --
# after a finalise, a signature or an acceptance, and before every inbound
# sync. A file lock on this box would hold off a second copy of this script
# and nothing else.
#
set -euo pipefail

cd /opt/pathquote

# TAG is not optional, and is assigned on its own line: see pq-act-sync.sh,
# which says why at length. In short -- unset, compose runs the stale `latest`
# image with no error; and `export TAG="$(git rev-parse HEAD)"` would hand the
# exit status to `export`, so a failing rev-parse would export an empty TAG
# and send us straight back to `latest`.
TAG=$(git rev-parse HEAD)
export TAG

# Start and finish lines with the image SHA, as pq-act-sync.sh writes: this log
# gets a pass every 15 minutes, and without a marker there is no telling where
# one ends and the next begins.
echo "$(date -Is) act:drain start: image $TAG"

# -T and the update notifier off, for pq-act-sync.sh's reasons: no terminal
# under systemd, and the failure email tails only the last forty lines of this
# log, which must not be spent on an advert for npm.
#
# The output also goes to a file of its own, for the re-arm below to read: tee
# writes it on to stdout, which is this unit's log, unchanged. pipefail keeps
# the pipeline's status the drain's, so a failed pass still fails here.
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
docker compose run --rm -T -e NPM_CONFIG_UPDATE_NOTIFIER=false \
  tools npm run act:drain | tee "$OUT"

echo "$(date -Is) act:drain ok: image $TAG"

# Recovered: re-arm the alert -- but only after a pass that wrote to ACT!,
# which the drain says with exactly this line (ALERT_REARM_LINE in
# src/lib/act/drain-args.ts; the two change together). Not after every exit
# 0: while a fault stands, its row backs off further each time, and the ticks
# in between find nothing due and exit 0 having asked ACT! nothing --
# drainRearmsAlert says so in full. Re-armed by those, the alert would email
# at each failure after them, not once a day.
#
# The path is the one pq-backup-alert.sh stamps for this unit -- its name as
# OnFailure= passes it, pq-act-drain.service -- and the two must change
# together. -f: no stamp, because nothing has failed, is the ordinary case.
if grep -qxF "act:drain: ACT! took writes on this pass -- pq-act-drain.sh re-arms the failure alert" "$OUT"; then
  rm -f /var/lib/pathquote/alert-stamps/pq-act-drain.service.last-sent
fi
