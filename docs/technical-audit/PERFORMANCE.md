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

## After — production build of `audit/performance-2026-10` @ a37e7c7, same machine, volume DB (2026-10-16)

Two runs of N=10 (`scripts/after-prod-admin-volume.txt`, `-run2.txt`); the
better of the two p50s is NOT taken — both are shown where they differ.
"Before" for list pages is Baseline B-volume (`scripts/baseline-prod-admin-volume.txt`);
for the two template quotes it is Baseline A (tiny DB — those pages do not
depend on the number of other quotes).

| path (ADMIN) | ttfb p50 before → after | total p95 before → after | HTML bytes before → after | SQL before → after |
|---|---|---|---|---|
| / (dashboard) | 34 → 36–47 | 56 → 76–91 | 72,173 → 72,214 | 8 → 9 (count query added) |
| /quotes (602 quotes) | 31 → 38–50 | 207 → 105–183 | **4,548,265 → 1,019,274** (200 rows; wire 36 KB gzip) | 3 → 4 (+count) |
| /clients | 32 → 39–51 | 46 → 57–78 | 257,390 → 257,390 | 3 → 3 |
| /clients/[PERF company] | 30 → 39–49 | 45 → 64–159 | 125,510 → 125,106 | 6 → 6 |
| /quotes/[PERF final] (builder) | 33 → 37–46 | 74 → 115–118 | 229,690 → 199,518 | **64 → 52** |
| /quotes/[draft] (builder) | 34 → 37–40 | 81 → 102–117 | 291,427 → 255,546 | **64 → 38** |
| /quotes/[final] (builder) | 36 → 39 | 90 → 79–94 | 231,901 → 200,441 | **64 → 52** |
| /quotes/[final]/quotation | 33 → 40–46 | 65 → 83–248 | 249,566 → 249,566 | 18 → 18 |
| /catalog | 25 → 31–35 | 36 → 46–69 | 83,848 → 83,848 | 3 → 3 |
| /catalog/options | 32 → 35–39 | 60 → 74–89 | 454,151 → 454,151 | 7 → 7 |
| /settings/users | 34 → 36–39 | 47 → 57–72 | 161,547 → 161,547 | 2 → 2 |

MANAGER (150 quotes in scope): /quotes 871,153 → 607,084 bytes (all 150 rows
still fit under the 200 cap; the saving is the per-row cost), SQL 4 → 5.

TTFB is 5–15 ms higher across the board in the after-runs, including on pages
whose code did not change (catalog, settings, quotation). The two after-runs
were taken minutes after a `next build` and alongside a browser session on
the same machine; the before-runs on an idle machine. The numbers that
changed by design (SQL count, bytes, requests) are the comparison; a
same-conditions TTFB re-run is listed under "Still to do".

### Browser scenarios (Chromium, same server)

| Scenario | Before | After |
|---|---|---|
| Dashboard load: RSC prefetches | 14 (7 routes × 2), all aborted | **0** |
| Builder (draft) load | TTFB 14 ms, load 136 ms, 18 chunks, **1,230 KB** decoded JS, tiptap chunk (393 KB) downloaded, 12 images | TTFB 49 ms, load 183 ms, 19 chunks, **956 KB** decoded JS, tiptap NOT downloaded, 12 images, 0 RSC |
| One discount autosave | 1 POST **132,031 B** decoded (whole page re-rendered inside the action), 185 ms; **84 SQL** on the critical path | 1 POST **71 B**, 4 samples 193 / 117 / 53 / 43 ms (first after a 30 s idle = pool reconnect); **20 SQL** on the critical path; then ONE refresh GET (119 KB decoded / 29 KB wire, 91 ms, 38 SQL) off the critical path; totals and readiness update |
| Switch to Quote setup | full navigation: builder page re-rendered (64 SQL, 200+ KB) | **0 server requests**; URL → `?tab=settings`; the editor chunk (393 KB) loads now, once |
| Switch to History | full navigation | **0 server requests**; URL → `?tab=history` |
| /quotes (602 quotes) | 602 rows × 2 trees, ~7 Links per row, 4.5 MB | 200 rows, 1 tree, **200 Links**, 6,845 DOM nodes, 36 KB wire; "Show all 602" = 1 POST, 146 KB decoded / 13.6 KB wire, 96 ms → 602 rows |
| Built chunks containing zod | 1 chunk, 379,785 B, in the builder / clients routes | **none** (`scripts/client-zod-trace.mjs`: no "use client" module reaches zod) |

#### Final run after the review fixes (@ 7964898, quieter machine, N=10)

| path (ADMIN, volume DB) | ttfb p50 / p95 | total p50 / p95 | HTML bytes | SQL |
|---|---|---|---|---|
| / (dashboard) | 34 / 55 | 42 / 88 | 72,214 | 8 (count dropped again) |
| /quotes (602 quotes, 200 shown) | **28 / 32** (before 31 / 41) | 68 / 76 (before 179 / 207) | 1,030,117 | 4 |
| /quotes/[PERF final] | **31 / 34** (before 33 / 36) | 58 / 76 (before 64 / 74) | 200,446 | 52 |
| /quotes/[draft] | **34 / 38** (before 34 / 50) | 58 / 78 (before 81 / 98) | 256,349 | 38 |

Raw: `scripts/after-prod-admin-volume-final.txt`. The earlier after-runs'
higher TTFBs were machine load, as suspected: on a quiet machine every page
is at or below its baseline.

## Targets — met / missed

| Target | Result |
|---|---|
| Autosave: ≤ 100 ms p95 local, ≤ 25 SQL, < 5 KB, no page render in the response | **met** on SQL (20), payload (71 B) and design; latency 43–53 ms warm, 117–193 ms on the first save after the pool idled — p95 over 4 samples is a miss on the letter; the cold sample is the 30 s idle reconnect, not the action |
| Builder ≤ 40 SQL, TTFB ≤ 60 ms p95, HTML ≤ 200 KB | draft **38 SQL met**, FINAL 52 (forms document still loaded for FINAL — by design); TTFB p95 45–51 **met**; HTML 255 KB draft / 200 KB final — **missed** on the draft (catalog + compatible options payload remain; see Still to do) |
| /quotes 600 quotes: ≤ 400 KB HTML, TTFB ≤ 80 ms p95 | raw HTML 1,019 KB for the 200-row page — **missed on raw bytes** (36 KB on the wire; ~4.3 KB/row of mostly repeated Tailwind classes and an inline SVG per row); TTFB p95 68–81 **borderline** |
| /clients: index-served sort, TTFB ≤ 80 ms p95 | index added (z70); p95 43–64 **met**; EXPLAIN check on 8.8k rows needs production (local has 401) |
| Dashboard ≤ 2 prefetches | **0 — met** |
| Finalize returns before Gotenberg | **met by construction** (`after()`); not exercised in the browser (local Gotenberg present but no finalize run in this session) |
| Pool: checkout > 5 s fails loudly; statements > 30 s cut | **met by configuration**; not load-tested |

## Production-driven fixes (12a146a)

| Scenario | Before | After | Where measured |
|---|---|---|---|
| /settings/users/[id] open and save (PERF-19) | prod: GET 6–10 s, POST 6–11 s (two sequential ACT! reads of 1–2 s each per render, three per save) | ACT! lists cached 10 min per process; a save makes no ACT! call | code + unit tests; **to verify on the VPS after deploy** (commands in VERIFICATION.md) |
| /clients?pageSize=all (PERF-20) | prod: 8,845 rows, 5,848,032 B RSC, 2.87 s; local old code 401 rows: HTML 2,508,031 B, RSC 1,397,079 B | local new code 401 rows: HTML 2,350,222 B, RSC 1,194,600 B (**−14 %**), 76 KB on the wire, 105–121 ms | local; the row is now one tree, but the payload is dominated by per-cell class strings, so "all" at 8,845 rows stays a multi-MB page — the cap is the owner's decision |

The clients result is a miss against the intent: one tree per row saved
14 %, not half. At 2.7 KB per `<tr>` the cost is Tailwind class strings
repeated in every cell, which gzip hides on the wire (76 KB) but React still
serialises and the browser still parses.

## Production after the deploys (nginx `rt=`, 2026-10-16 11:00 → 2026-10-17 05:00 UTC, real use)

| Set | before (11–16 Oct) | after |
|---|---|---|
| everything | p50 0.019 / p95 0.117 / max 18.67 s | n=1,920: p50 0.023 / p95 0.107 / max 3.56 s |
| `/settings/users/<id>` (open + save) | p50 0.016 / p99 6.16 / max 11.36 s | n=22: **p50 0.036 / p95 0.041 / max 0.042 s** |
| `POST /quotes/<id>` (autosaves, item edits) | p50 0.123 / p95 0.243 / max 2.72 s | n=130: **p50 0.094 / p95 0.185 / max 0.233 s** |
| requests > 3 s | 23 in one day | 2: one `GET /` at 3.56 s (single sample, cause unknown), one `GET /clients?pageSize=all` RSC navigation |

`/clients?pageSize=all` as an RSC navigation: **5,848,032 → 7,120,796 bytes**
for 8,845 rows — the one-tree row made the payload LARGER on this page. The
list is a server component, so every cell's class string is serialised into
the navigation payload, and the responsive row carries longer class strings
than the old table cell did. Fixed (next deploy): the row/cell styles are CSS
component classes (`.list-row`, `.list-cell`, …) so each cell carries one
short name, and the per-row decorative icon is a CSS mask instead of an
inline SVG. Local, 401 companies: `/clients?pageSize=all` HTML 2,350,222 →
1,679,020 B (−29 %); `/quotes` 200 rows 1,030,117 → 809,096 B (−21 %). The
cap on "all" remains the owner's decision.
