#!/usr/bin/env bash
# Measures server-side page timings (TTFB, total, size) over N runs per path,
# plus the SQL statement count (execute lines only; parse/bind lines are skipped) and summed SQL duration for ONE warm request per
# path, read from the local Postgres statement log (log_min_duration_statement=0).
#
# usage: BASE=http://localhost:3200 EMAIL=... PASSWORD=... N=10 \
#        docs/technical-audit/scripts/measure.sh /quotes /clients ...
set -euo pipefail
BASE=${BASE:-http://localhost:3200}
N=${N:-10}
PG=${PG:-pfinvoice-postgres-1}
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

# --- login (credentials provider) ---
CSRF=$(curl -s -c "$JAR" -b "$JAR" "$BASE/api/auth/csrf" | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')
curl -s -o /dev/null -c "$JAR" -b "$JAR" -X POST "$BASE/api/auth/callback/credentials" \
  --data-urlencode "csrfToken=$CSRF" --data-urlencode "email=$EMAIL" \
  --data-urlencode "password=$PASSWORD" --data-urlencode "callbackUrl=$BASE/" >/dev/null
if ! grep -q 'authjs.session-token' "$JAR"; then echo "login failed" >&2; exit 1; fi

pct() { # pct <p> values...   (values sorted ascending, ms)
  local p=$1; shift; local n=$#; local idx=$(( (p*n + 99) / 100 )); [ $idx -lt 1 ] && idx=1
  echo "$@" | tr ' ' '\n' | sed -n "${idx}p"
}

printf '%-40s %5s %8s %8s %8s %8s %9s %6s %9s\n' path status ttfb_p50 ttfb_p95 tot_p50 tot_p95 bytes sql sql_ms
for path in "$@"; do
  ttfbs=(); tots=(); status=0; bytes=0
  # warm-up
  curl -s -o /dev/null -b "$JAR" "$BASE$path"
  for i in $(seq 1 "$N"); do
    out=$(curl -s -o /dev/null -b "$JAR" -w '%{http_code} %{time_starttransfer} %{time_total} %{size_download}' "$BASE$path")
    set -- $out; status=$1; ttfbs+=( $(awk -v v=$2 'BEGIN{printf "%d", v*1000}') ); tots+=( $(awk -v v=$3 'BEGIN{printf "%d", v*1000}') ); bytes=$4
  done
  # one more request, bracketed by a line-count of the pg log, for SQL count/duration
  before=$(docker logs "$PG" 2>&1 | grep -c 'duration:' || true)
  curl -s -o /dev/null -b "$JAR" "$BASE$path"
  sleep 0.6
  sqlstats=$(docker logs "$PG" 2>&1 | grep 'duration:' | tail -n +$((before+1)) | grep -E 'execute|statement:' | awk '{for(i=1;i<=NF;i++) if($i=="duration:"){n++; s+=$(i+1)}} END{printf "%d %.1f", n, s}')
  st=$(printf '%s\n' "${ttfbs[@]}" | sort -n | tr '\n' ' '); tt=$(printf '%s\n' "${tots[@]}" | sort -n | tr '\n' ' ')
  printf '%-40s %5s %8s %8s %8s %8s %9s %6s %9s\n' "$path" "$status" "$(pct 50 $st)" "$(pct 95 $st)" "$(pct 50 $tt)" "$(pct 95 $tt)" "$bytes" ${sqlstats}
done
