# Fix plan

Order by user impact × frequency × evidence. Each package: what changes,
expected effect, contracts kept, verification, rollback. Work happens on branch
`audit/performance-2026-10` in small commits; `main` stays deployable.

Shared-file ownership (one owner each): `prisma/schema.prisma` + migrations,
`package.json`/lockfile, `docker-compose.yml`, `src/lib/db.ts`,
`src/lib/revalidate.ts`, `next.config.ts` → the lead (me). Agents edit only
the files listed in their package.

## Wave 1 (parallel, disjoint files)

### W1 — autosave without a page render (PERF-01, PERF-07 buttons, PERF-17)
- Files: `src/lib/use-autosave.ts`, `src/lib/actions/documents/{pricing,presentation,terms,options}.ts`, `src/components/builder/{item-options-editor,finalize-button,sign-button,send-to-client-button,accept-button,unfinalize-button,void-signature-button,revoke-signing-link-button}.tsx`, tests under `tests/` for those actions.
- Change: autosave-only actions stop calling `revalidateDocument`; `useAutosave` calls one coalesced `router.refresh()` inside `startTransition` after a save lands and no newer save is pending (module-level 150 ms coalescer so seven fields on one page produce one refresh). Buttons drop `router.refresh()` after actions that revalidate. Option editor key excludes server-derived lines.
- Keep: business rules, cap warnings, readiness rows, concession toast (all still arrive with the refresh); structural actions (add/remove/duplicate/reorder item, set client, document choices, finalize…) keep `revalidatePath`.
- Verify: browser — type a discount: 1 POST < 5 KB, then 1 GET refresh; totals update; SQL per POST ≤ 25. Vitest for actions still green.
- Rollback: revert the commit (no schema).

### W2 — builder page cost (PERF-04, PERF-10, PERF-16, tiptap half of PERF-08)
- Files: `src/app/(app)/quotes/[documentId]/page.tsx` (coordinate: the lead already changed the forms read), `src/components/builder/builder-tabs.tsx`, a new `src/components/builder/builder-panels.tsx`, `src/components/builder/client-section.tsx`, `src/components/builder/notes-section.tsx`, `src/lib/queries/documents-pickers.ts`, `src/lib/actions/clients.ts` (inline create), `src/lib/actions/industries.ts` or a new read action for industries.
- Change: tabs client-side with `history.replaceState`; only the active panel mounted; compat options in one query; wave 3 merged into wave 2; industries fetched when "+ New company" opens; inline create sets the client in the same transaction.
- Verify: tab switch = 0 requests; builder ≤ 40 SQL, HTML ≤ 200 KB; tiptap chunk not requested until Quote setup opens on a draft.

### W3 — lists and prefetch (PERF-05, PERF-06 code half, PERF-09)
- Files: `src/lib/queries/documents-list.ts`, `src/app/(app)/quotes/page.tsx`, `src/app/(app)/page.tsx` (dashboard), `src/components/documents/quotes-list.tsx`, `src/components/ui-kit/data-table.tsx`, `src/components/ui-kit/list-table.tsx`, `src/components/hover-prefetch-link.tsx`, `src/components/app-shell*.tsx`, clients list components under `src/components/clients/` (not the queries' `orderBy`, which the index package covers).
- Change: one DOM per row (CSS switches layout, not duplicated trees), one link per row with `prefetch={false}`; `/quotes` returns the most recent 200 rows + a "Show all N" affordance that loads the rest via a server action; dashboard links don't prefetch; nav links prefetch on hover only.
- Verify: volume DB admin `/quotes` ≤ 400 KB, TTFB ≤ 80 ms p95; dashboard ≤ 2 prefetches.

### W4 — client bundles (PERF-08 zod + phone, PERF-18)
- Files: `src/lib/validation/*` (add zod-free sibling helpers, do not change schemas), `src/components/builder/items-list.tsx`, `src/components/builder/production-spec-editor.tsx`, `src/components/builder/terms-documents-panel.tsx` (only the import of `quoteTermsSchema.shape`), `src/components/clients/industry-picker.tsx`, `src/components/ui-kit/phone-field.tsx`, `src/app/api/files/[name]/route.ts`, `src/lib/image-derivatives.ts`.
- Verify: `next build` → no zod in any `(app)` client chunk; builder route JS ≤ 450 KB; phone chunk requested only on focus.

### Lead — pool, PDF after(), schema indexes, observability (PERF-02, PERF-03, PERF-07 actions, PERF-06 schema, PERF-11 budget, PERF-15 code)
- `src/lib/db.ts`, `src/lib/actions/finalize.ts`, `src/lib/actions/signing.ts`, `prisma/schema.prisma` + `prisma/migrations/z70_perf_indexes`, `src/instrumentation.ts`, `src/lib/act/drain-after.ts`.

## Wave 2
- Independent review of every W1–W4 diff (fresh agent, not anchored on this plan).
- Integration: rebuild, re-run `measure.sh` (tiny + volume DB), browser scenarios, `npm run typecheck`, `npm run lint`, `npm test`.
- PERF-12 second pass if autosave still > 15 stmts.

## Wave 3 (needs the owner / VPS)
- Evidence script on the VPS; then compose limits + log rotation + pg config, nginx log_format/keepalive/static caching, drain cadence (PERF-13/14/15).
- Deploy: ordinary push to `main` after merge; migration z70 is additive (indexes only, `CREATE INDEX` — not `CONCURRENTLY`, Prisma runs it in a transaction; tables are small enough that the lock is sub-second at 8.8k rows); rollback = `TAG=<prev>` and leave the indexes.

## Deployment of `audit/performance-2026-10` (prepared 2026-10-16, not executed)

What ships: 9 commits on top of `main` @ af1d83f. No data migration; one
additive index migration (`z70_perf_indexes`: three `CREATE INDEX`, run by
`prisma migrate deploy` inside a transaction before the new app starts —
sub-second at production's row counts). No `Document` rows are touched.

1. Merge the branch into `main` (fast-forward) and push. CI runs lint,
   typecheck, 3,890 tests, `migrate diff`, the seed twice.
2. The deploy job: `docker compose pull`, `up -d postgres` — **this recreates
   the Postgres container** because `docker-compose.yml` changed its
   `command` (pg_stat_statements, slow-statement log) and `logging`. Expect
   a few seconds without the database, inside the window that already
   restarts the app. Then `migrate deploy`, `up -d app gotenberg`, health.
3. After the first healthy check, once, on the VPS:
   ```bash
   cd /opt/pathquote && docker compose exec -T postgres psql -U pathquote -d pathquote -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'
   ```
4. Add `PRISMA_SLOW_MS=500` to `/opt/pathquote/.env` and `docker compose up -d app`
   (one more restart) — optional, but it is what makes a slow query visible.
5. nginx by hand (runbook §3b): timing log format, keep-alive upstream,
   immutable `/_next/static/`. `nginx -t && systemctl reload nginx`.
6. Watch for a day: `docker compose logs app --since 24h | grep -E '\[runtime\]|slow-query|slow-save'`
   and `/api/health` → `dbMs`, `pool.waiting`.

Rollback: `TAG=af1d83f docker compose up -d app` (the previous image keeps
working against the z70 indexes — they are additive). Revert
`docker-compose.yml` in the checkout only if the Postgres flags cause
trouble (`git checkout af1d83f -- docker-compose.yml && docker compose up -d postgres`).
The nginx steps are independent and reversible one by one.

What a user should notice: saving a field in a quote no longer waits on a
page render; switching builder tabs is instant; the quotes list opens with
the latest 200 and offers "Show all"; the first open of a draft downloads
~270 KB less JavaScript and no editor until Quote setup is opened; the
dashboard no longer fires background requests on load.
