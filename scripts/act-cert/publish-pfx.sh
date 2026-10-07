#!/bin/bash
#
# Certbot deploy hook: rebuild the PFX the Act! server collects.
#
# Runs on the VPS after every successful renewal of
# actapi.pathfindercut.com. Writes a password-protected PFX into the
# directory nginx serves to one IP, so the Windows server can fetch it.
#
# Install:
#   sudo install -m 755 publish-pfx.sh \
#     /etc/letsencrypt/renewal-hooks/deploy/actapi-pfx.sh
#
# Secrets, both chmod 600, root-owned:
#   /root/.secrets/pfxpass   the PFX export password
#
# Test without waiting 60 days:
#   sudo /etc/letsencrypt/renewal-hooks/deploy/actapi-pfx.sh
#
set -euo pipefail

DOMAIN=actapi.pathfindercut.com
LIVE=/etc/letsencrypt/live/$DOMAIN
OUTDIR=/var/www/actapi-cert
PASSFILE=/root/.secrets/pfxpass

# Certbot runs deploy hooks for every renewed certificate, so ignore the
# ones that are not ours.
if [ -n "${RENEWED_LINEAGE:-}" ] && [ "$RENEWED_LINEAGE" != "$LIVE" ]; then
  exit 0
fi

[ -f "$LIVE/fullchain.pem" ] || { echo "no certificate at $LIVE"; exit 1; }
[ -f "$PASSFILE" ] || { echo "missing $PASSFILE"; exit 1; }

mkdir -p "$OUTDIR"
chmod 750 "$OUTDIR"

TMP=$(mktemp "$OUTDIR/.actapi.XXXXXX.pfx")
trap 'rm -f "$TMP"' EXIT

openssl pkcs12 -export \
  -out "$TMP" \
  -inkey "$LIVE/privkey.pem" \
  -in "$LIVE/fullchain.pem" \
  -name "$DOMAIN" \
  -passout "pass:$(cat "$PASSFILE")"

# Move into place in one step so a fetch can never see a half-written file.
chmod 640 "$TMP"
mv -f "$TMP" "$OUTDIR/actapi.pfx"
trap - EXIT

# The expiry date travels beside the file so the Windows side can log what
# it is about to install without parsing the PFX first.
openssl x509 -in "$LIVE/cert.pem" -noout -enddate | cut -d= -f2 > "$OUTDIR/expires.txt"
chmod 644 "$OUTDIR/expires.txt"

echo "published $OUTDIR/actapi.pfx (expires $(cat "$OUTDIR/expires.txt"))"
