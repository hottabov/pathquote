#!/usr/bin/env bash
#
# Copy catalogue images from this machine to production. Nothing else.
#
# Production is live (since 2026-09-28): its database holds real quotes,
# users and clients, and it is never replaced from a development machine
# again. Catalogue data reaches production through migrations; this script
# only brings across the image FILES those rows point at.
#
# What it does, and deliberately does not do:
#   - copies image files (png, jpg, jpeg, webp, svg) from data/uploads that
#     production does not have yet;
#   - never touches the database;
#   - never deletes a file on production and never overwrites one: upload
#     names are random UUIDs, so a name that already exists there is the same
#     file (or production's own, which wins);
#   - never copies PDFs (the archived signed quotes live in the same volume)
#     or the derived/ thumbnail cache (production builds its own).
#
# A copied file is only shown once a production row points at it -- a
# product image uploaded in the local admin sets `imageUrl` in the LOCAL
# database only. Ship that change as a migration (or set it in the
# production admin) as well.
#
# Usage (dry run -- lists what would be copied):
#   VPS=root@74.208.106.34 SSH_PORT=3498 SSH_KEY=~/.ssh/pathfinder-key ./scripts/push-images-to-prod.sh
# Copy:
#   ... ./scripts/push-images-to-prod.sh --yes
#
# Optional:
#   UPLOADS_VOLUME=pathquote_uploads
#   LOCAL_UPLOADS=data/uploads
#
set -euo pipefail

VPS="${VPS:?set VPS=user@host}"
SSH_PORT="${SSH_PORT:-22}"
UPLOADS_VOLUME="${UPLOADS_VOLUME:-pathquote_uploads}"
LOCAL_UPLOADS="${LOCAL_UPLOADS:-data/uploads}"
APPLY=0
[ "${1:-}" = "--yes" ] && APPLY=1

SSH=(ssh -p "$SSH_PORT")
if [ -n "${SSH_KEY:-}" ]; then
  # IdentitiesOnly stops the agent from offering other keys first and
  # tripping the server's MaxAuthTries before this one is ever tried.
  SSH+=(-i "$SSH_KEY" -o IdentitiesOnly=yes)
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/$LOCAL_UPLOADS"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Top-level image files only: derived/ is a cache, PDFs are signed quotes.
# Plain `find | sort` -- this runs on macOS's bash 3.2 and BSD userland.
find . -maxdepth 1 -type f \
  \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' -o -iname '*.svg' \) \
  ! -name '.*' | sed 's|^\./||' | LC_ALL=C sort > "$WORK/local.txt"

echo "==> Reading what production already has ($VPS, volume $UPLOADS_VOLUME)"
# Read-only mount: listing cannot change anything.
"${SSH[@]}" "$VPS" \
  "docker run --rm -v $UPLOADS_VOLUME:/data:ro alpine sh -c 'cd /data && ls -1A'" </dev/null \
  | LC_ALL=C sort > "$WORK/remote.txt"

LC_ALL=C comm -23 "$WORK/local.txt" "$WORK/remote.txt" > "$WORK/new.txt"
NEW_COUNT="$(wc -l < "$WORK/new.txt" | tr -d ' ')"

echo "    local images:      $(wc -l < "$WORK/local.txt" | tr -d ' ')"
echo "    already on prod:   $(LC_ALL=C comm -12 "$WORK/local.txt" "$WORK/remote.txt" | wc -l | tr -d ' ')"
echo "    new, to copy:      $NEW_COUNT"

if [ "$NEW_COUNT" = "0" ]; then
  echo "Nothing to copy."
  exit 0
fi
sed 's/^/      + /' "$WORK/new.txt"

if [ "$APPLY" != "1" ]; then
  echo
  echo "Dry run. Re-run with --yes to copy these files. The database is never touched."
  exit 0
fi

echo "==> Copying $NEW_COUNT files"
# COPYFILE_DISABLE stops macOS tar adding ._AppleDouble files. On the far
# side, `-o` drops the Mac's uid, the files are handed to whoever owns the
# volume (the app's user), and `tar -x` without an existing-file guard is
# safe only because every name in the list was absent a moment ago -- so
# anything that appeared since is skipped explicitly rather than overwritten.
COPYFILE_DISABLE=1 tar czf - -T "$WORK/new.txt" \
  | "${SSH[@]}" "$VPS" "docker run --rm -i -v $UPLOADS_VOLUME:/data alpine sh -c '
      set -e
      mkdir -p /tmp/in && tar xzof - -C /tmp/in
      owner=\$(stat -c %u:%g /data)
      copied=0; skipped=0
      for f in /tmp/in/*; do
        name=\$(basename \"\$f\")
        if [ -e \"/data/\$name\" ]; then skipped=\$((skipped+1)); continue; fi
        cp \"\$f\" \"/data/\$name\" && chown \"\$owner\" \"/data/\$name\" && chmod 644 \"/data/\$name\"
        copied=\$((copied+1))
      done
      echo \"    copied \$copied, skipped \$skipped (already there)\"
    '"

echo "Done. No database rows were changed."
