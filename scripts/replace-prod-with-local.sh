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
#   ALLOW_SHA_MISMATCH=1        run even though the VPS is on another commit
#
# The remote half is copied over as a file and run with stdin closed, never
# piped into `ssh ... bash -s`. Under `bash -s` the script itself arrives on
# stdin, and the first child process that reads stdin swallows whatever has
# not been parsed yet: `docker compose exec -T` attaches stdin by definition,
# so the backup step alone ate the rest of the run. Bash then hit EOF and
# exited 0, `set -e` saw a clean run, and production was left untouched while
# this script reported success. Do not turn this back into a heredoc.
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
FPSQL="/tmp/pq-fingerprint-$STAMP.sql"
REMOTE="/tmp/pq-replace-$STAMP.sh"
cleanup() { rm -f "$DUMP" "$UPL" "$FPSQL" "$REMOTE"; }
trap cleanup EXIT

echo "==> Target: $VPS:$VPS_DIR  (port $SSH_PORT, volume $UPLOADS_VOLUME)"
echo "==> This DESTROYS the production database, uploads and every PDF on it."
read -r -p "Type REPLACE to continue: " ANSWER
[ "$ANSWER" = "REPLACE" ] || { echo "aborted"; exit 1; }

# --- preflight -------------------------------------------------------------
# The dump carries the local schema and `_prisma_migrations` with it. Restore
# it under an app image built from an older commit and the running code meets
# a schema it was never compiled against — which is a broken production, not a
# copy of anything. Deploy first; this is a stop, not a warning.
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$("${SSH[@]}" "$VPS" "cd '$VPS_DIR' && git rev-parse HEAD" </dev/null)"
if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  echo "!! local HEAD  $LOCAL_SHA"
  echo "!! VPS   HEAD  $REMOTE_SHA"
  echo "!! Production runs different code than this dump's schema was built for."
  echo "!! Push and let the deploy workflow finish, then run this again."
  echo "!! (ALLOW_SHA_MISMATCH=1 overrides — only when you know the schema is equal.)"
  [ "${ALLOW_SHA_MISMATCH:-}" = "1" ] || exit 1
  echo "!! ALLOW_SHA_MISMATCH=1 — continuing."
fi

# A copy that is not checked is not a copy. This query runs on both machines
# and the two answers must match exactly. It is deliberately about content,
# not size: an empty restore, a restore into the wrong database and a restore
# that never ran all look identical from the outside. It lives in a file so
# neither ssh nor the shell gets a chance to mangle its quoting — the
# identifiers are double-quoted for Postgres, which is exactly what a nested
# ssh command string destroys.
cat > "$FPSQL" <<'SQL'
SELECT
  (SELECT count(*) FROM "Document")       AS documents,
  (SELECT count(*) FROM "SigningRequest") AS links,
  (SELECT count(*) FROM "Product")        AS products,
  (SELECT count(*) FROM "Option")         AS options,
  (SELECT count(*) FROM "User")           AS users,
  (SELECT count(*) FROM "Product" WHERE form = 'EASYLOADER') AS easyloader;
SQL

FP_HEADER="documents|links|products|options|users|easyloader"

echo "==> Local fingerprint"
LOCAL_FP="$(docker compose exec -T postgres psql -Atq -U pathquote -d pathquote < "$FPSQL")"
echo "    $FP_HEADER"
echo "    $LOCAL_FP"

# --- local: dump -----------------------------------------------------------
echo "==> Dumping local Postgres"
docker compose exec -T postgres pg_dump -U pathquote pathquote </dev/null | gzip > "$DUMP"
[ -s "$DUMP" ] || { echo "empty dump — is the local postgres container up?"; exit 1; }

echo "==> Packing local uploads ($LOCAL_UPLOADS)"
tar czf "$UPL" -C "$LOCAL_UPLOADS" .

echo "==> dump $(du -h "$DUMP" | cut -f1)   uploads $(du -h "$UPL" | cut -f1)"

# --- the remote half, as a file --------------------------------------------
cat > "$REMOTE" <<'REMOTE_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
VPS_DIR="$1"; DUMP="$2"; UPL="$3"; VOL="$4"; FPSQL="$5"; FPOUT="$6"
cd "$VPS_DIR"

# Every `docker compose exec -T` below gets its stdin from a file or
# /dev/null, never inherited. See the note at the top of the caller.

echo "==> Backing up what is about to be replaced"
if [ -x /usr/local/bin/pq-backup.sh ]; then
  /usr/local/bin/pq-backup.sh </dev/null
else
  mkdir -p /opt/backups
  docker compose exec -T postgres pg_dump -U pathquote pathquote </dev/null \
    | gzip > "/opt/backups/pq-prereplace-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
fi

echo "==> Stopping app (nothing may hold a connection)"
docker compose stop app </dev/null

echo "==> Recreating the database"
# WITH (FORCE) drops it out from under any session still attached; without it
# the DROP simply blocks forever.
docker compose exec -T postgres psql -U pathquote -d postgres </dev/null \
  -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE pathquote WITH (FORCE);" \
  -c "CREATE DATABASE pathquote OWNER pathquote;"

echo "==> Restoring dump"
# ON_ERROR_STOP is not optional. Without it psql runs a plain-format dump to
# the end and exits 0 even when half the statements failed, so `set -e` sees a
# clean run and the copy silently isn't one.
gunzip -c "$DUMP" | docker compose exec -T postgres \
  psql -q -v ON_ERROR_STOP=1 -U pathquote -d pathquote

echo "==> Replacing uploads volume $VOL (wipes every stored + signed PDF)"
docker volume inspect "$VOL" >/dev/null
docker run --rm -v "$VOL:/data" -v /tmp:/backup alpine \
  sh -c "rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/$(basename "$UPL") -C /data" </dev/null

echo "==> migrate deploy (expected: no pending migrations)"
docker compose run --rm tools npx prisma migrate deploy </dev/null

echo "==> Starting app"
docker compose up -d app </dev/null
sleep 5
curl -fsS http://127.0.0.1:3010/api/health && echo

echo "==> Production fingerprint"
docker compose exec -T postgres psql -Atq -U pathquote -d pathquote < "$FPSQL" > "$FPOUT"
cat "$FPOUT"

rm -f "$DUMP" "$UPL" "$FPSQL"
REMOTE_SCRIPT

echo "==> Copying to $VPS"
"${SCP[@]}" "$DUMP" "$UPL" "$FPSQL" "$REMOTE" "$VPS:/tmp/"

# --- remote: replace -------------------------------------------------------
# stdin closed, so nothing downstream can consume the run itself.
"${SSH[@]}" "$VPS" \
  "bash /tmp/$(basename "$REMOTE") '$VPS_DIR' '/tmp/$(basename "$DUMP")' '/tmp/$(basename "$UPL")' '$UPLOADS_VOLUME' '/tmp/$(basename "$FPSQL")' '/tmp/pq-fp-$STAMP.txt'" \
  </dev/null

# --- verify ----------------------------------------------------------------
echo "==> Verifying production matches this machine"
REMOTE_FP="$("${SSH[@]}" "$VPS" "cat '/tmp/pq-fp-$STAMP.txt'; rm -f '/tmp/pq-fp-$STAMP.txt' '/tmp/$(basename "$REMOTE")'" </dev/null)"
echo "    $FP_HEADER"
echo "    local  $LOCAL_FP"
echo "    prod   $REMOTE_FP"
if [ "$LOCAL_FP" != "$REMOTE_FP" ]; then
  echo
  echo "!! MISMATCH — production is NOT a copy of this machine."
  echo "!! The backup taken at the start is in /opt/backups on the VPS."
  exit 1
fi

echo
echo "==> Done. Sign in on production NOW with a LOCAL account and confirm it works."
echo "    The only credentials that exist there are the ones from this machine."
