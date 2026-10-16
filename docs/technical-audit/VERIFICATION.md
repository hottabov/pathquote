# Verification

## Checks run (local, 2026-10-16)

| Check | Scope | Result |
|---|---|---|
| `npm run typecheck` | whole tree after the lead package | pass |
| `npx vitest run` | all 149 files | 3778 passed |
| `npx prisma migrate deploy` + `migrate diff --exit-code` | z70 on the local DB | applied; "No difference detected" |
| `docker compose config` | compose edits | valid |
| Browser (Chromium) | login, dashboard, builder, one discount autosave | recorded in PERFORMANCE.md (before) |

| `npm run typecheck`, `npm run lint`, `npx vitest run` | integrated tree @ a37e7c7 | typecheck clean, lint clean, 155 files / 3,890 tests passed |
| `next build` | @ a37e7c7 | ok, 26.8 s; one Turbopack warning about `node:perf_hooks` in the edge evaluation of instrumentation.ts (guarded; silenced with `turbopackIgnore` in the follow-up commit) |
| `docs/technical-audit/scripts/client-zod-trace.mjs` | import graph from every "use client" module | no module reaches zod; only the deliberate lazy `import("google-libphonenumber")` is reported |
| Built chunk scan | `.next/static/chunks` | no chunk with zod markers; tiptap (393 KB) and phone (579 KB) remain as lazy chunks |
| Browser: dashboard, builder load, 4 autosaves, tab switches, /quotes + Show all | :3200, volume DB | recorded in PERFORMANCE.md "After" |
| `measure.sh` ×2 | 11 paths, ADMIN + MANAGER | `scripts/after-prod-admin-volume*.txt`, `after-prod-manager-volume.txt` |
| Independent review of `main...HEAD` | fresh agent, read-only, not given the plan | 0 blockers, 3 should-fix, 5 nits — all but one applied (below) |

### Independent review — findings and what was done

| # | Severity | Finding | Action |
|---|---|---|---|
| 1 | should-fix | `generateRevisionPdf` renders from the live document; in `after()` an unfinalize + edit could be filed as the frozen revision's PDF | guard added: render only while the document is still FINAL and the revision is still its newest; countersign re-archive re-checks SIGNED |
| 2 | should-fix | page revalidated before the PDF exists; History link only appears on the next navigation | `PdfPendingRefresh` polls 3/6/9/12 s while the newest revision has no `pdfPath` |
| 3 | should-fix | db.ts comment wrong; catalog import runs a 120 s web transaction under the new 30 s / 60 s session bounds | `SET LOCAL` lifts both inside that transaction; comment corrected |
| 4 | nit | dashboard paid an unused scoped `count(*)` | count is opt-in (`withTotal`); dashboard skips it |
| 5 | nit | "Show all" offset can drift under concurrent edits | an empty answer hides the control; dedupe by id already covered duplicates |
| 6 | nit | `aria-controls` pointed at unmounted panel ids | unvisited panels render as empty hidden elements |
| 7 | nit | pool built at boot via instrumentation; a box without DATABASE_URL dies in `register` | import wrapped; lag logging continues without pool stats |
| 8 | nit | coalesced refresh is page-agnostic (a save flushed within 150 ms of navigating refreshes the next page) | left as is: one extra render, no leak |

Verified sound by the reviewer: every autosaved action has only its hook as caller; the seven buttons' actions all revalidate; `pg` `options` applies (`statement_timeout=30s` observed); `after()` usage per Next 16 docs; z70 names and `migrate diff` clean; tab deep links and hydration; `listCompatibleOptionsForProducts` equals the per-product query; `createCompanyInline` skips nothing `setDocumentClient` did; `listRemainingQuotes` scope; validators equivalent on the untested edge cases too; every upload filename is a fresh uuid.

### Not verified (honest gaps)
- Finalize / sign / send in the browser after the `after()` change (no SMTP locally; Gotenberg is up but no finalize was run). Covered by typecheck + the existing action tests only.
- Concurrency: no multi-user load run. The pool bounds are configuration, not a measurement.
- Production: nothing. Every number above is local.

## Evidence still needed from production (owner runs this; read-only)

Nothing below changes anything. Paste the whole output back into the chat or
into this file under "Production evidence".

```bash
set +e; cd /opt/pathquote || exit 1
APP=$(docker compose ps -q app); PG=$(docker compose ps -q postgres); GB=$(docker compose ps -q gotenberg)
echo "### host"; nproc; free -m; swapon --show; uptime; df -h / /var/lib/docker; cat /proc/pressure/{cpu,memory,io} 2>/dev/null
echo "### vmstat (5 s)"; vmstat 1 5
echo "### containers"; docker stats --no-stream
for c in $APP $PG $GB; do docker inspect "$c" --format '{{.Name}} oom={{.State.OOMKilled}} restarts={{.RestartCount}} started={{.State.StartedAt}} mem={{.HostConfig.Memory}} log={{json .HostConfig.LogConfig.Config}}'; done
du -sh /var/lib/docker/containers/*/*-json.log 2>/dev/null | sort -h | tail -5
echo "### app log: slow saves & errors (72h)"
docker compose logs app --since 72h 2>&1 | grep -c 'slow-save'
docker compose logs app --since 72h 2>&1 | grep 'slow-save' | tail -30
docker compose logs app --since 72h 2>&1 | grep -iE 'prisma|P1[0-9]{3}|P2[0-9]{3}|timeout|ECONNRESET|heap|\[act\]|\[runtime\]|slow-query' | tail -30
docker compose logs postgres --since 72h 2>&1 | grep -iE 'checkpoint|lock|FATAL|too many|terminat|duration' | tail -20
echo "### nginx (live template)"
nginx -T 2>/dev/null | grep -nE 'proxy_(read|connect|send)_timeout|proxy_http_version|keepalive|gzip (on|off)|http2|log_format|proxy_buffering|client_max_body_size|access_log' | head -40
LOG=$(ls /var/log/nginx/*pathfindercut*access*.log 2>/dev/null | head -1); echo "access log: $LOG"
[ -n "$LOG" ] && awk '{print $9}' "$LOG" | sort | uniq -c | sort -rn | head
echo "### postgres"
cat /var/lib/docker/volumes/pathquote_pgdata/_data/postgresql.auto.conf 2>/dev/null
docker compose exec -T postgres psql -U pathquote -d pathquote -Atc "
SELECT name||'='||setting||coalesce(unit,'') FROM pg_settings WHERE name IN ('shared_buffers','work_mem','effective_cache_size','max_connections','shared_preload_libraries','log_min_duration_statement','autovacuum','track_io_timing');
SELECT 'db_size='||pg_size_pretty(pg_database_size('pathquote'));
SELECT 'rows: '||relname||'='||n_live_tup FROM pg_stat_user_tables WHERE relname IN ('Document','DocumentItem','DocumentLine','Company','Contact','User','Product','Option','QuoteRevision','ActOutbox') ORDER BY relname;
SELECT 'conns: '||state||' wait='||coalesce(wait_event_type,'-')||' n='||count(*) FROM pg_stat_activity WHERE datname='pathquote' GROUP BY 1,2 ORDER BY count(*) DESC;
SELECT 'longest: '||coalesce(now()-xact_start,'0')||' '||state||' '||left(query,120) FROM pg_stat_activity WHERE datname='pathquote' AND state<>'idle' ORDER BY xact_start LIMIT 5;
SELECT relname||' live='||n_live_tup||' dead='||n_dead_tup||' seq='||seq_scan||' idx='||coalesce(idx_scan,0)||' autovac='||coalesce(last_autovacuum::text,'never')||' analyze='||coalesce(coalesce(last_autoanalyze,last_analyze)::text,'never') FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 12;
SELECT 'db: hit_ratio='||round(100.0*blks_hit/nullif(blks_hit+blks_read,0),2)||' temp_files='||temp_files||' deadlocks='||deadlocks FROM pg_stat_database WHERE datname='pathquote';
SELECT 'waiting locks='||count(*) FROM pg_locks WHERE NOT granted;"
echo "### timers & background jobs"
systemctl list-timers --all | grep -E 'pq-|logrotate'
grep -c 'act:drain start' /var/log/pq-act-drain.log 2>/dev/null; tail -6 /var/log/pq-act-drain.log 2>/dev/null
tail -3 /var/log/pq-backup.log 2>/dev/null
echo "### one drain tick's fixed cost (starts a tools container that only prints the node version)"
TAG=$(git rev-parse HEAD) bash -c 'time docker compose run --rm -T tools node -e "console.log(process.version)"'
```

The audit also needs one timed request set from the VPS itself (the app
measured from localhost, no WAN): sign in once in a browser, copy the
`authjs.session-token` cookie value into `TOKEN`, then

```bash
for p in /quotes /clients /; do for i in 1 2 3 4 5; do curl -s -o /dev/null -w "$p %{http_code} ttfb=%{time_starttransfer} total=%{time_total} bytes=%{size_download}\n" -H "Cookie: authjs.session-token=$TOKEN" http://127.0.0.1:3010$p; done; done
```

## Production (read-only, 2026-10-16) — what was verified there

See PRODUCTION.md for the numbers. Verified on the VPS: host idle, no memory
or I/O pressure, Postgres healthy (hit ratio 100 %, no lock waits), nginx adds
no time (`rt` ≈ `urt`), the `pq_timing` access log is live, one drain tick
costs 1.35 s wall / 0.17 s CPU, ACT! costs the VPS 1–2 s per request.

## To verify after the deploy (commands, read-only)

```bash
# ACT! user page no longer takes seconds (PERF-19): p95/p99 of the page since the deploy
L=/var/log/nginx/q.pathfindercut.com.access.log
grep -E "/settings/users/[a-z0-9]+" $L | grep "$(date -u +%d/%b/%Y)" | grep -oE "rt=[0-9.]+" | cut -d= -f2 | sort -n | awk '{a[NR]=$1} END{print "n="NR, "p50="a[int(NR*.5)+1], "p95="a[int(NR*.95)], "max="a[NR]}'
# autosaves (PERF-01): POST /quotes/<id> since the deploy
grep -E "\"POST /quotes/[a-z0-9]+ " $L | grep "$(date -u +%d/%b/%Y)" | grep -oE "rt=[0-9.]+" | cut -d= -f2 | sort -n | awk '{a[NR]=$1} END{print "n="NR, "p50="a[int(NR*.5)+1], "p95="a[int(NR*.95)], "max="a[NR]}'
# pool / event loop never complained
docker compose logs app --since 24h 2>&1 | grep -cE "\[runtime\]|slow-query"
curl -s http://127.0.0.1:3010/api/health
```
