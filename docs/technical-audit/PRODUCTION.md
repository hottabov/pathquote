# Production evidence (VPS, read-only, 2026-10-16 10:27–10:40 UTC)

Collected over SSH with the dedicated audit key, with the script in
VERIFICATION.md plus a few follow-up read-only commands. Raw (redacted):
`scripts/prod-evidence-2026-10-16.txt`. No production state was changed.

## Host and containers

| | Value |
|---|---|
| CPU / RAM | 4 vCPU, 7.9 GB; load 0.04–0.07; PSI cpu/mem/io `some avg60` ≈ 0 |
| Swap | 668 MB used of 2 GB, but 4.3 GB available and no pressure (uptime 514 days — stale pages) |
| Disk | 233 GB, 29 % used |
| Containers | app 156 MB RSS, postgres 116 MB, gotenberg 339 MB; no limits, 0 restarts, 0 OOM; json-file logs 4 KB / 216 KB / 40 KB (`logging` not yet capped, nothing to cap yet) |
| App | started 04:08 UTC today (a deploy); `docker compose logs` therefore holds only 6 h — the 2026-10-01 incident's `[slow-save]` lines are gone |
| Edge | Cloudflare proxies `q.pathfindercut.com` (DNS → 104.21.65.126 / 172.67.145.107; `server: cloudflare`), HTTP/2 + HTTP/3, gzip on |
| nginx | the `q.` site logs with `pq_timing` (`rt=`/`urt=`) since 11 Oct — 12,205 requests; no keep-alive upstream; `proxy_read_timeout` default 60 s |
| Postgres | stock: shared_buffers 160 MB, effective_cache_size 5 GB, no pg_stat_statements, no slow log; hit ratio 100 %, 0 deadlocks, 0 waiting locks, 2 connections open; autovacuum running |

**Data volume** (why local volume tests were the wrong worry): Document 13,
DocumentItem 21, DocumentLine 113, QuoteRevision 13, User 10 — but Company
8,845, Contact 10,519, ActSnapshot 19,358.

**Drain tick** (`docker compose run --rm tools node -e …`): 1.35 s wall, 0.17 s
CPU — negligible, 96×/day. PERF-13 is not a cause.

## What the nginx timing log says (11–16 Oct, 12,205 requests)

| Set | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| every request (`rt`) | 12,205 | 0.019 s | 0.117 | 0.255 | 18.67 |
| upstream time (`urt`) | 12,205 | 0.019 | 0.117 | 0.248 | 18.67 — nginx itself adds nothing |
| GET pages (no static/files) | 11,024 | 0.018 | 0.071 | 0.193 | 10.10 |
| GET `?_rsc=` (client navigations) | 10,543 | 0.018 | 0.067 | 0.151 | 10.10 |
| `POST /quotes/<id>` (server actions: autosaves, items, finalize) | 954 | **0.123** | **0.243** | 0.982 | 2.72 |
| `GET /quotes/<id>` page + RSC | 1,220 | 0.059 | 0.149 | 0.270 | 0.51 |
| `/api/files` | 528 | 0.033 | 0.135 | 0.140 | 0.15 |
| `/settings/users/<id>` GET+POST | 2,016 | 0.016 | 0.098 | **6.16** | **11.36** |

Per day p95: 0.040 (11 Oct) → 0.080 → 0.132 → 0.103 → 0.129 → 0.161 (16 Oct).

Requests over 3 s: 1 on 12 Oct, **23 on 16 Oct** (00:07–02:57 UTC) — every
one of them `/settings/users/<id>` (GET 6–10 s, POST 6–11 s) or
`POST /settings/act-sync` (17–19 s). The only other outlier:
`GET /clients?pageSize=all` = 5,848,032 bytes in 2.87 s (used 210 times this week).

## Network between the parts

| Path | Measured |
|---|---|
| Node direct on the VPS, `/login` | 9–16 ms |
| nginx + TLS on the VPS (Cloudflare bypassed) | 19–24 ms |
| This machine → origin direct (TCP 320 ms RTT) | TTFB 0.87–1.18 s |
| This machine → Cloudflare → origin | TTFB 0.13–0.23 s, full 15 KB page 0.39–0.76 s |
| VPS → ACT! API host (`actapi.pathfindercut.com`, no credentials sent) | TCP 0.24–0.27 s, TLS 0.73–0.84 s, **first byte 1.06–1.96 s per request** |

## Reading

1. **The server is not slow for ordinary pages.** p50 19 ms, p95 117 ms for
   everything; a quote page renders in 59 ms. The pool, the host and Postgres
   show no contention. PERF-13 (drain cost) and PERF-14 (memory) are not causes.
2. **Autosaves were the slowest ordinary thing on the server**: `POST /quotes/<id>`
   p50 123 ms / p95 243 ms / max 2.7 s — the whole-page re-render inside the
   action (PERF-01) measured in production. After the fix the action is ~20
   statements and tens of milliseconds; the refresh moves off the critical path.
3. **Every ACT!-backed page is slow by construction**: one ACT! request costs
   the VPS 1–2 s (TLS to a distant host every time), and the user page reads
   two in sequence on every render and again on every save (PERF-19, new, P1).
   "Sync now" runs 17–19 s inside the web process (PERF-11, now observed).
4. **The distance is the rest.** Users are far from the VPS (AU/US ↔ US VPS
   via Cloudflare); from here a 15 KB page takes 0.4–0.8 s end to end though
   the server spent 12 ms on it. Each navigation and each server action pays
   that round trip, which is why the number of requests and the payload per
   action (PERF-01, PERF-04, PERF-09, PERF-08) matter more than the server's
   milliseconds.
5. The quotes-list bound (PERF-05) is correct engineering but not a production
   cause today (13 quotes). The clients list at `pageSize=all` is (PERF-20, new).
