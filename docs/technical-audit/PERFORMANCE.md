# Performance — method, baseline, targets, before/after

## Method

- Server-side: `docs/technical-audit/scripts/measure.sh` logs in as a test user
  (credentials provider), warms each path once, then runs N=10 GETs and reports
  p50/p95 of TTFB and total time (ms) plus HTML bytes, and for one extra warm
  request the number of SQL statements executed and their summed server-side
  duration (from Postgres `log_min_duration_statement=0`; `execute` lines only).
- Client-side: Chromium (Claude's built-in browser) against the same server;
  request count, waterfall, RSC payload sizes, server-action POSTs per user
  action. Recorded in this file by scenario.
- Conditions: Apple Silicon Mac, production build (`next build` 19.7 s;
  `next start -p 3200`), local Docker postgres:16-alpine, no other load except
  the owner's idle dev server on :3100. Tiny DB (2 documents, 1 company,
  59 products, 105 options) unless stated otherwise.
- Production numbers: NOT yet available (SSH blocked in this session). Local
  results show code-path cost only; data-volume and VPS-resource effects are
  measured separately with the PERF seed (see "Volume run") and, once access
  is granted, on the VPS.

## Baseline A — production build, tiny DB, ADMIN (2026-10-16)

| path | ttfb p50 | ttfb p95 | total p50 | total p95 | HTML bytes | SQL stmts | SQL ms |
|---|---|---|---|---|---|---|---|
| / (dashboard) | 31 | 42 | 39 | 55 | 64,155 | 8 | 0.1 |
| /quotes | 32 | 38 | 35 | 45 | 92,144 | 3 | 0.1 |
| /quotes/[draft] (builder) | 34 | 41 | 73 | 81 | 291,427 | 64 | 2.1 |
| /quotes/[final] (builder) | 36 | 55 | 67 | 90 | 231,901 | 64 | 2.2 |
| /quotes/[final]/quotation | 33 | 37 | 62 | 65 | 249,566 | 18 | 0.6 |
| /clients | 31 | 46 | 34 | 51 | 88,694 | 3 | 0.1 |
| /clients/[id] | 32 | 39 | 42 | 49 | 153,143 | 6 | 0.3 |
| /catalog | 25 | 32 | 27 | 36 | 83,848 | 3 | 0.2 |
| /catalog/options | 32 | 38 | 56 | 60 | 454,151 | 7 | 0.6 |
| /settings/users | 34 | 41 | 38 | 47 | 161,547 | 2 | 0.1 |

Raw: `scripts/baseline-prod-admin-tinydb.txt`. SQL dump of one builder request:
`scripts/builder-page-sql-dump.log` (192 log lines = 64 statements; parse/bind/execute).

Reading: with a tiny DB the server renders every page in 25–40 ms and spends
≤2.2 ms in Postgres. Slowness reported by users is therefore NOT a fixed
code-path cost on an idle server. Remaining candidates, in order of
likelihood: (1) data volume (lists are unpaginated; builder issues 64
statements and ships 230–290 KB of HTML for a 2-item quote), (2) client-side
waterfall / payload over a real WAN, (3) production host contention
(VPS CPU/RAM/IO, background jobs), (4) serialized server actions queuing behind
one slow action (external calls on the hot path).

## Baseline B — dev server (:3100, Turbopack), tiny DB, ADMIN, N=3

| path | ttfb p50 | total p50 | HTML bytes | SQL |
|---|---|---|---|---|
| /quotes | 110 | 110 | 113,870 | 3 |
| /quotes/[draft] | 134 | 300 | 349,616 | 64 |
| /clients | 111 | 115 | 111,274 | 3 |

Dev is ~3–4× slower than the production build on the same pages; used only
for diagnostics, never for conclusions.

## Client-side run (Chromium, :3200, tiny DB, builder page)

- Navigation: TTFB 14 ms, DOMContentLoaded 89 ms, load 136 ms; HTML 291 KB
  decoded / 45 KB transferred (gzip on); 36 resources; 18 JS chunks =
  1,230 KB decoded JS; 12 `/api/files` images (35 KB).
- Dashboard → builder: 14 RSC prefetch GETs (7 routes × 2) fired from the
  dashboard and aborted by the navigation.
- One discount autosave (type "6", wait): 1 server-action POST, 185 ms,
  response 132 KB decoded (32 KB wire) = the whole builder page re-rendered;
  84 SQL statements (20 for the action, 64 for the page re-render); plus 4
  `/quotes?_rsc` prefetch GETs re-fired by the nav link after revalidation.
  Raw: `scripts/autosave-sql.log` (to be copied).

## Targets (set before fixes, 2026-10-16)

Measured locally (production build, volume DB = 600 PERF documents / 400
companies, same machine). Production targets are set once VPS access exists.

| Scenario | Target | Why |
|---|---|---|
| Autosave of a simple field (discount, note, validity, price) | action response ≤ 100 ms p95 locally; ≤ 25 SQL statements; response payload < 5 KB; no page re-render inside the action response | a 2-column UPDATE must not cost a page render; this is what queues saves |
| Builder page `/quotes/[id]` | ≤ 40 SQL statements; TTFB ≤ 60 ms p95; HTML ≤ 200 KB decoded | remove the forms double-load and per-product fan-out |
| `/quotes` list, 600 documents | TTFB ≤ 80 ms p95; rows returned bounded (≤ 100 per page) | unpaginated list grows linearly with production data |
| `/clients` list, 400+ companies (prod ≈ 8,800) | TTFB ≤ 80 ms p95; sort served by an index (EXPLAIN shows Index Scan) | sort of the whole set by an unindexed column |
| Dashboard | ≤ 2 RSC prefetches on load, none aborted | prefetch storm competes with the user's navigation |
| Finalize | action returns without waiting for Gotenberg (PDF generated after the response) | PDF time (up to 30 s) must not block the click |
| Pool | a checkout that waits > 5 s fails loudly; statements > 30 s are cut | silent indefinite queueing is the "hang with all 200s" signature |

Targets are not lowered after the fact. A miss is documented as a miss.
