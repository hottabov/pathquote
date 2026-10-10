#!/bin/bash
#
# Nightly ACT! -> PathQuote contact sync.
#
#   pq-act-sync.sh   one sync run, recorded as trigger "schedule"
#                    -- daily (pq-act-sync.timer)
#
# Installed on the VPS as /usr/local/bin/pq-act-sync.sh. The timer fires at
# Melbourne local time, an hour before the database dump; a failure starts
# pq-backup-alert@<unit>.service, which emails marketing@pathfindercut.com.
#
# The run reads contacts and companies from ACT! and writes what changed into
# the production database. Nothing here reads its output: the run writes its own
# record (Settings -> ACT! sync reads it), so this script only has to start the
# right image and let a failure be a failure.
#
# No flock here, unlike pq-backup.sh. Mutual exclusion for the sync lives in the
# worker instead, as a Postgres advisory lock (SYNC_LOCK_KEY in
# src/lib/act/sync.ts), because the "Sync now" button in Settings starts the
# same work from inside the app container. A file lock on this box would only
# hold off a second copy of this script and would leave the button free to run
# on top of the nightly import -- it would cover the two things that happen
# here and miss the one that does not.
#
set -euo pipefail

cd /opt/pathquote

# TAG is not optional. Every deploy builds and runs an image tagged with the
# deploying commit's SHA (.github/workflows/deploy.yml), and nothing on this box
# ever refreshes the `latest` tag that docker-compose.yml falls back to. Left
# unset, compose resolves `latest` and the run silently uses whatever image was
# built months ago -- no error, just the wrong code. That trap cost an afternoon
# on 2026-10-08, when a `tools` container from a build older than the script it
# was asked for answered `Missing script: act:sync-preflight`.
#
# Two lines rather than `export TAG="$(git rev-parse HEAD)"`: in that form the
# exit status belongs to `export`, which succeeds whatever the substitution did,
# so a failing rev-parse would export an empty TAG and send us straight back to
# `latest`. Assigned on its own, a failure here stops the run instead.
#
# A dirty checkout is deliberately not refused. HEAD is what picks the image, and
# an uncommitted file does not move HEAD, so the pinned image still runs; the
# box's own .env and any local compose edit would make `git status` dirty every
# night and turn a working sync into a nightly failure email about nothing.
TAG=$(git rev-parse HEAD)
export TAG

# A start line as well as a finish line, which pq-backup.sh does not need: the
# sync writes many lines of its own into this log, so without a marker there is
# no telling where tonight's run begins. The SHA is on both, because "which
# image ran" is the first question when the output does not match the code.
echo "$(date -Is) act:sync start: image $TAG"

# -T because this runs under systemd with no terminal: compose would otherwise
# try for a TTY and fill the log with progress redraws. No check that the image
# exists first -- compose pulls it if it is missing, and its own error is a
# better one than anything written here, carried into the alert email as-is.
#
# npm's update notifier is turned off because it is not free here. It printed
# five lines about npm 12 at the end of the first production run, and the
# failure email tails only the last forty lines of this log -- so on the night
# that matters, an eighth of what the reader sees would be an advert. The
# container's npm is whatever the image pins; a notice in a log nobody acts on
# cannot change that.
docker compose run --rm -T -e NPM_CONFIG_UPDATE_NOTIFIER=false \
  tools npm run act:sync -- --trigger=schedule

echo "$(date -Is) act:sync ok: image $TAG"
