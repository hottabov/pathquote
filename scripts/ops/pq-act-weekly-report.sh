#!/bin/bash
#
# Monday ACT! activity report: one email per sales manager with last week's
# calls completed, e-mails sent, meetings held and new prospects.
#
# Installed on the VPS as /usr/local/bin/pq-act-weekly-report.sh, started by
# pq-act-weekly-report.timer. Recipients live in
# src/lib/act/weekly-report-recipients.ts, so they ship with the image like the
# code does. A failure starts pq-backup-alert@<unit>.service, which emails
# marketing@pathfindercut.com with the tail of the log below.
#
# Read-only against ACT! and touches no database, so there is no lock here: two
# copies would only send the managers the same email twice, and the timer is the
# only thing that starts it.
#
set -euo pipefail

cd /opt/pathquote

# Pinned to HEAD's image for the reason spelled out in pq-act-sync.sh: left
# unset, compose falls back to a `latest` tag nothing refreshes. Two lines so a
# failing rev-parse stops the run instead of exporting an empty TAG.
TAG=$(git rev-parse HEAD)
export TAG

echo "$(date -Is) act:weekly-report start: image $TAG"

docker compose run --rm -T -e NPM_CONFIG_UPDATE_NOTIFIER=false \
  tools npm run act:weekly-report

echo "$(date -Is) act:weekly-report ok: image $TAG"
