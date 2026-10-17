# Audit worklog

## Checkpoint (update after every significant step)

- Date: 2026-10-16
- Branch: `main` @ af1d83f, clean at start. Audit work is committed in small
  packages on `main` (owner runs solo; no other pending changes found).
- Phase: 1 — environment check, docs skeleton, baseline.
- Dev server owned by the user running on :3100 (pid 48397, 4h) — not touched.
- Production SSH: blocked by the session's permission classifier. Key +
  command for the owner are in the final report.

## Decisions

- Measure production build (`next start` on :3200) against the local DB; dev
  mode only for diagnostics.
- Statement logging on local Postgres for SQL counts per request.

## Active agents

(none yet)

## Next step

Baseline measurements, then launch read-only diagnosis agents.

## 2026-10-16 — Phase 1 results (local, production build, tiny DB)

- Baseline A recorded (PERFORMANCE.md). Server renders every page in 25–40 ms;
  builder = 64 SQL statements / 2 ms DB; HTML 230–290 KB (45 KB gzipped).
- One discount autosave = 1 server-action POST = 84 SQL statements (20 for the
  action + 64 to re-render the whole builder page in the POST response,
  132 KB RSC payload decoded), ~185 ms locally, plus 4 `/quotes?_rsc`
  prefetch GETs re-fired by the nav link after revalidation.
- Dashboard fires 14 RSC prefetches (7 routes × 2) that get aborted on
  the first navigation.
- Each builder page load requests ~12–15 `/api/files/*.png?w=64|128` images.
- Agents running: BE/DB diagnosis, FE diagnosis, ARCH+ponytail, INFRA, and a
  seeder agent (docs/technical-audit/scripts/seed-volume.ts, 600 docs / 400
  companies) for the volume run.
- Blocker: production SSH denied by the permission classifier. Key generated at
  ~/.ssh/pathquote_audit_ed25519 (public half goes in the final report).

## 2026-10-16 — Phase 2: fixes in flight (branch `audit/performance-2026-10`)

- Lead package done locally: `src/lib/db.ts` (own pg Pool: connectionTimeout 5 s,
  idle 30 s, statement_timeout 30 s, idle_in_tx 60 s, slow-query log over
  `PRISMA_SLOW_MS`, `dbPoolStats`), `pg` added as a direct dependency,
  `finalize.ts` + `signing.ts` PDF work moved into `after()`, in-request ACT!
  drain budget capped at 20 s, `/api/health` reports `dbMs` + pool counters,
  `src/instrumentation.ts` logs event-loop p99 / pool waiting once a minute
  when over threshold, migration `z70_perf_indexes` (applied locally,
  `migrate diff` clean).
- Agents W1 (autosave/revalidate), W2 (builder page + tabs), W3 (lists +
  prefetch), W4 (bundles) running on disjoint file sets; ARCH/ponytail agent
  still running.
- Owner's untracked file `docs/superpowers/plans/2026-10-16-act-write-back-companies.md`
  is theirs — never staged.
- Next: fix the seeder's one type error, commit the lead package, integrate
  agent commits, rebuild, re-measure (tiny + volume), browser verification,
  independent review.
- W1 landed (5845b79, 2f286d8): `setItemDiscount`, `setDocumentDiscount`,
  `setDocumentNotes`, `setValidityDays`, `setIncoterm`, `setDocumentTax`,
  `setQuoteTerms`, `setItemOptions` no longer revalidate; `useAutosave`
  schedules one coalesced `router.refresh()` (150 ms) after a burst;
  `writeItemOptions` keeps revalidating for the two click callers; seven
  lifecycle buttons lost their duplicate `router.refresh()`; PERF-17 (double
  save on derived option lines) confirmed and fixed with a locked-role-free
  autosave key + test.
- Lead ops package landed (a86f66b): compose log rotation / app healthcheck /
  Postgres statement stats, runbook §3b, settings in one query, fflate gone.

## 2026-10-16 (evening) — agents W2/W3/W4 died on a rate limit; finished by the lead

- All three had committed nothing; their working-tree edits were reviewed and
  completed by hand: W2 needed one lint fix (ref-during-render → derived
  state); W3 needed the quotes page, dashboard and quotes-list wiring; W4
  needed every component import switched, the form specs split from their zod
  schemas (spec-schemas.ts), phone-field focus loading, the files route, and
  the four equivalence tests. Commits 2480a9c (builder), 2dba935 (lists),
  a37e7c7 (bundle).
- Checks: typecheck, lint, 3,890 tests green; production build ok; browser
  scenarios and two timing runs recorded in PERFORMANCE.md.
- Independent review of `main...HEAD` running (fresh agent).
- Pending: nowrap fix in the quotes table + `turbopackIgnore` comment
  (uncommitted, needs a rebuild), review findings, final report, SSH request.

## 2026-10-16 (late) — review applied, final state

- Independent review: 0 blockers; 3 should-fix + 4 nits applied (see
  VERIFICATION.md), 1 nit left as is. typecheck/lint clean, 3,890 tests pass.
- Branch `audit/performance-2026-10` is ready to merge. Deployment and rollback
  in FIX_PLAN.md. Still open: production evidence (SSH), PERF-12 second pass,
  PERF-13/14 (ops, need VPS numbers), owner decisions in FINDINGS (PERF-11,
  dead send-dialog code, one-off scripts).
- Local Postgres still has `log_min_duration_statement=0` from this audit
  (ALTER SYSTEM); reset once measurements are no longer needed.

## 2026-10-16 (night) — production evidence collected, two more fixes

- SSH access granted (dedicated key). Evidence in PRODUCTION.md and
  scripts/prod-evidence-2026-10-16.txt (redacted). Server p50 19 ms / p95
  117 ms; every request > 3 s this week = the user page's ACT! section or
  Sync now; ACT! costs the VPS 1–2 s per request; users are far from the VPS
  (Cloudflare in front). PERF-13/14 rejected as causes. Prod holds 13 quotes
  and 8,845 companies.
- PERF-19 (ACT! lists cached) and PERF-20 (clients one-tree rows, −14 %)
  committed (12a146a). Branch: 14 commits, typecheck/lint/3,890 tests green,
  build warning-free.
- Next: owner merges + deploys (FIX_PLAN.md); after deploy run the
  VERIFICATION.md post-deploy commands; decide the pageSize=all cap and
  "Sync now" (PERF-11). Local Postgres statement logging still on.

## 2026-10-16 11:00–11:15 UTC — deployed to production

- `main` fast-forwarded to the audit branch; two deploys (c5f0b6a: everything
  + ACT! in the background; 7faef33: background read uses normal limits).
- By hand on the VPS: nginx upstream keep-alive + immutable static,
  `PRISMA_SLOW_MS`, `pg_stat_statements`, drain timer every 5 min, service
  unit renamed. All verified (VERIFICATION.md).
- Open: read the nginx log after a day of use; owner decisions (pageSize=all
  cap, dead send-dialog code, one-off scripts); PERF-12 second pass.

## 2026-10-17 — cleanup pass (owner: clean architecture, ACT! as a feature)

- Docs restructured: `docs/README.md` index; `design/`, `reference/`,
  `backlog/`; 20 stale files deleted (plans, analyses, mock-ups, draft copy,
  `.obsidian`); code comments repointed.
- Dead code gone: `sendQuoteToClient` + `quote-send.ts` + email history
  section/read; eight one-off scripts and two npm entries.
- ACT! fully off the request path: lists snapshot reader split from the
  refresh (`user-link-refresh.ts`, drain-only); `tests/act-isolation.test.ts`
  guards it (105 entries). Gotenberg merge now goes through pdf.ts's single
  gated call.
- Deployed 182a642 (cleanup) — CI green. 156 test files / 3,981 tests.
- Open for the owner: `pageSize=all` cap on /clients; retiring the catalog-v2
  seed chain (re-base the seed on `catalog.json`); dropping the empty
  `QuoteEmail` table; the `draftWrite` helper for the 31 document actions
  (ponytail `shrink`, a refactor of money-bearing code best done with its own
  review); the unported findings in docs/backlog/audit-port-triage-2026-10-15.md.
- Deployed 62496e5: list component classes + CSS icons (local −21 % / −29 %
  on the two lists). Production real-use numbers after the deploys are in
  PERFORMANCE.md ("Production after the deploys").
- Decided NOT to hand-refactor the 16 draft-action frames in this session:
  money-bearing code, no DB-level tests, 16 varied sites. Recipe in
  FIX_PLAN.md Wave 4.
