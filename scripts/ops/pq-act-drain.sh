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
# runs every 15 minutes emails every 15 minutes about whatever it fails on.
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
docker compose run --rm -T -e NPM_CONFIG_UPDATE_NOTIFIER=false \
  tools npm run act:drain

echo "$(date -Is) act:drain ok: image $TAG"
