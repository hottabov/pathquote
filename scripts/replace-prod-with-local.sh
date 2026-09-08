#!/usr/bin/env bash
#
# Replace production with the local database and uploads.
#
# This is docs/runbook.md §4b as one command. It makes the VPS an exact copy of
# this machine: catalogue, users, clients, quotes, uploaded files, and every
# generated/signed PDF. Everything currently on production is destroyed,
# including the accounts people sign in with — afterwards the only logins that
# exist are the local ones.
#
# Usage:
#   VPS=user@host ./scripts/replace-prod-with-local.sh
#
# Optional:
#   SSH_PORT=22                 non-default sshd port
#   SSH_KEY=~/.ssh/id_ed25519   private key, when the VPS is key-only and the
#                               key is not the one ssh picks by default
#   VPS_DIR=/opt/pathquote      deploy checkout on the VPS
#   UPLOADS_VOLUME=pathquote_uploads
#   LOCAL_UPLOADS=data/uploads
#
set -euo pipefail

VPS="${VPS:?set VPS=user@host}"
SSH_PORT="${SSH_PORT:-22}"
VPS_DIR="${VPS_DIR:-/opt/pathquote}"
UPLOADS_VOLUME="${UPLOADS_VOLUME:-pathquote_uploads}"
LOCAL_UPLOADS="${LOCAL_UPLOADS:-data/uploads}"

# ssh takes -p, scp takes -P. Same port, different flag.
SSH=(ssh -p "$SSH_PORT")
SCP=(scp -P "$SSH_PORT")
if [ -n "${SSH_KEY:-}" ]; then
  # IdentitiesOnly stops the agent from offering other keys first and
  # tripping the server's MaxAuthTries before this one is ever tried.
  SSH+=(-i "$SSH_KEY" -o IdentitiesOnly=yes)
  SCP+=(-i "$SSH_KEY" -o IdentitiesOnly=yes)
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="/tmp/pq-local-$STAMP.sql.gz"
UPL="/tmp/uploads-local-$STAMP.tar.gz"

echo "==> Target: $VPS:$VPS_DIR  (port $SSH_PORT, volume $UPLOADS_VOLUME)"
echo "==> This DESTROYS the production database, uploads and every PDF on it."
read -r -p "Type REPLACE to continue: " ANSWER
[ "$ANSWER" = "REPLACE" ] || { echo "aborted"; exit 1; }

# --- preflight -------------------------------------------------------------
# The dump carries _prisma_migrations, so the VPS must be running the same
# commit (or later) or `migrate deploy` after the restore is not a no-op.
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$("${SSH[@]}" "$VPS" "cd '$VPS_DIR' && git rev-parse HEAD")"
if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  echo "!! local HEAD  $LOCAL_SHA"
  echo "!! VPS   HEAD  $REMOTE_SHA"
  echo "!! Deploy this commit first, or the restored schema and the running app disagree."
  read -r -p "Continue anyway? [y/N] " GO
  [ "$GO" = "y" ] || exit 1
fi

# --- local: dump -----------------------------------------------------------
echo "==> Dumping local Postgres"
docker compose exec -T postgres pg_dump -U pathquote pathquote | gzip > "$DUMP"
[ -s "$DUMP" ] || { echo "empty dump — is the local postgres container up?"; exit 1; }

echo "==> Packing local uploads ($LOCAL_UPLOADS)"
tar czf "$UPL" -C "$LOCAL_UPLOADS" .

echo "==> dump $(du -h "$DUMP" | cut -f1)   uploads $(du -h "$UPL" | cut -f1)"

echo "==> Copying to $VPS"
"${SCP[@]}" "$DUMP" "$UPL" "$VPS:/tmp/"

# --- remote: replace -------------------------------------------------------
"${SSH[@]}" "$VPS" bash -s -- "$VPS_DIR" "$(basename "$DUMP")" "$(basename "$UPL")" "$UPLOADS_VOLUME" <<'REMOTE'
set -euo pipefail
VPS_DIR="$1"; DUMP="/tmp/$2"; UPL="/tmp/$3"; VOL="$4"
cd "$VPS_DIR"

echo "==> Backing up what is about to be replaced"
if [ -x /usr/local/bin/pq-backup.sh ]; then
  sudo /usr/local/bin/pq-backup.sh
else
  mkdir -p /opt/backups
  docker compose exec -T postgres pg_dump -U pathquote pathquote \
    | gzip > "/opt/backups/pq-prereplace-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
fi

echo "==> Stopping app (nothing may hold a connection)"
docker compose stop app

echo "==> Recreating the database"
docker compose exec -T postgres psql -U pathquote -d postgres \
  -c "DROP DATABASE pathquote WITH (FORCE);" \
  -c "CREATE DATABASE pathquote OWNER pathquote;"

echo "==> Restoring dump"
gunzip -c "$DUMP" | docker compose exec -T postgres psql -q -U pathquote -d pathquote

echo "==> Replacing uploads volume $VOL (wipes every stored + signed PDF)"
docker volume inspect "$VOL" >/dev/null
docker run --rm -v "$VOL:/data" -v /tmp:/backup alpine \
  sh -c "rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/$(basename "$UPL") -C /data"

echo "==> migrate deploy (expected: no pending migrations)"
docker compose run --rm tools npx prisma migrate deploy

echo "==> Starting app"
docker compose up -d app
sleep 5
curl -fsS http://127.0.0.1:3010/api/health && echo

rm -f "$DUMP" "$UPL"
REMOTE

rm -f "$DUMP" "$UPL"

echo
echo "==> Done. Sign in on production NOW with a LOCAL account and confirm it works."
echo "    The only credentials that exist there are the ones from this machine."
