# Architecture — as found on `main` @ af1d83f

## Layers

- `src/proxy.ts` — Next 16 proxy; imports the full NextAuth config from
  `src/auth.ts` (JWT strategy, Prisma adapter, nodemailer, argon2) and redirects
  every non-public path to `/login`. JWT only: 0 DB reads per request outside
  a 5-minute revalidation tick.
- `src/app/(app)/*` — authenticated server components. `(app)/layout.tsx` →
  `requireSession` → `AppShell` + Confirm/Toast/Tooltip providers. 21
  `loading.tsx` skeletons; 7 settings layouts that only `await requireAdminPage()`.
- `src/app/(sign)/sign/[token]` — public client-signing entrance (token is the
  credential). `src/app/api/*` — PDFs, uploads, authenticated image serving
  (`/api/files/[name]`, sharp derivatives), catalog export, client-timing
  beacon, health.
- `src/lib/authz.ts` (requireSession/Admin/Region, `cache()`d), `roles.ts`
  (the only place role strings live), `scope.ts` (Prisma `where` per role for
  Company/Document/Price), `signing/state.ts` (all lifecycle verdicts).
- `src/lib/queries/*` — reads. `documents.ts` is a barrel over
  `documents-list/-builder/-forms/-pickers`; `getDocumentForBuilder` is
  `cache()`d per (user, id).
- `src/lib/actions/*` — server actions (writes). `actions/documents/*` = 31
  draft mutations sharing one frame: `requireSession` → scoped `findFirst` →
  `$transaction(assertStillDraft, write, recalcAndEnforce)` → revalidate →
  `mapDraftWriteError`. Plus `finalize.ts`, `signing.ts` (author side),
  `signing-client.ts` (token side), `catalog-import.ts`, `act-outbox.ts`,
  `act-sync.ts`.
- Domain: `pricing.ts` (1,191 lines), `documents/recalc.ts`,
  `quotation-data.ts` (1,370), `sheet-data.ts`, `production-forms/*`,
  `catalog-xlsx/*`, `signing/*`, `email/*`, `act/*` (41 files, ~13k lines
  with comments), `validation/*` (zod).
- `src/components` — 155 files, 100 of them `"use client"`; `builder/*` ≈ 40
  client components with autosave fields; `sheet/*` renders the quotation for
  screen and for Gotenberg.
- `prisma/` — 37 models, migrations z01…z70. `scripts/` — ~40 tsx operator
  and one-off scripts; `scripts/ops/*` — systemd timers (ACT! sync nightly,
  ACT! drain every 15 min, weekly report, backups).

Import direction is clean: app → components/lib; client components reach
`lib/actions` and pure `lib/*`; every client → `lib/queries` / `@prisma/client`
import is `import type`. One deliberate lib → components edge (`lib/pdf.ts`
renders `QuotationSheet` for Gotenberg). No `server-only` markers anywhere.

## Data flows that matter for speed

1. **Open builder** — `requireRegion` → `getDocumentForBuilder` →
   `Promise.all[picker catalog, 2 settings, forms document, spec images, quote
   documents, compatible options × distinct products]` → industries → history
   + ACT! state → ~25 client components get props. Measured 64 SQL statements,
   230–290 KB HTML.
2. **Autosave a field** — `useAutosave` (800 ms) → one of 31 actions →
   `$transaction(assertStillDraft, update, recalcAndEnforce)` (recalc reloads
   the whole document graph) → `revalidatePath('/quotes/[id]')` → **the POST
   response re-renders flow 1**. Measured 84 statements / 132 KB per save.
3. **Finalize** — one transaction (recalc, number, snapshot, revision, ACT!
   outbox row) → PDF through Gotenberg (was awaited; now `after()`) →
   revalidate list + document.
4. **Send to client** — claim transaction (token, SigningRequest) → SMTP
   outside the transaction → compensating transaction on failure → revalidate.
5. **Client signs** — `/sign/[token]` renders the sheet through the PDF
   pipeline's HTML renderer (images inlined as data URIs) on every view →
   `completeSigning` renders the PDF via Gotenberg, writes it, SIGNED, outbox
   row, two emails.
6. **ACT!** — inbound nightly sync under a pg advisory lock on its own
   connection; outbound outbox drained every 15 min by a fresh `tools`
   container, plus an in-request `after()` drain per finalize/sign/accept.

## Couplings that cost time per request (evidence in FINDINGS.md)

1. Builder loads the document graph twice per render (`getDocumentForBuilder`
   + `getDocumentForForms`, near-identical include) — PERF-03.
2. Autosave re-renders the page: 26 `revalidateDocument` sites in
   `actions/documents/*`; `recalcAndEnforce` reloads the graph — PERF-01/12.
3. Per-request fan-out: compatible options once per product; settings as
   three single-row `findUnique`s — PERF-10 (+ settings collapsed to one query).
4. Images are authenticated Node routes: `auth()` + `stat` per thumbnail,
   12–30 per builder page — PERF-18.
5. Tab state lives in the URL and is read on the server — PERF-04.
6. Client bundle carries the ACT! HTTP client (`act-sync-panel.tsx` →
   `sync-view.ts` → `run-record.ts` → `drain-rules.ts` → `act/client.ts`
   1,476 lines) — admin page only; noted, not fixed.
7. `proxy.ts` imports the whole NextAuth config — loaded once per process;
   not a per-request cost.
8. Two Gotenberg clients (`pdf.ts` with a 2-slot semaphore,
   `production-forms/render.ts` without); production-forms route does N
   conversions then a merge.
9. Signing page builds HTML through the PDF pipeline on every view.

## Duplicated sources of truth (correctness risk, not speed)

- Two "what matches a client search" definitions (`client-list.ts` vs
  `client-search.ts`): list page and combobox disagree.
- Hand-written mirrors of Prisma enums (`SigningStatus`, `ROLE_VALUES`) kept
  honest by two parity tests.
- Two production-form registries (`production-forms/specs/index.ts` and
  `components/forms/registry.tsx`) reconciled by `isRenderable`;
  `renderer: "html"` is the only variant.
- Seed catalogue target applied by two implementations (`seed.ts` and
  `scripts/migrate-catalog-v2.ts` + `scripts/lib/catalog-v2-plan.ts`).

## ACT! is a feature, not a dependency — how that is enforced

The owner's rule (2026-10-16): PathQuote must keep working when ACT! is
down, slow or unreachable; data moves between the two in the background and
accumulates in a queue while ACT! is away.

- **Writes are a queue.** Finalize, the client's signature and Accept write an
  `ActOutbox` row inside the same transaction as the document change
  (`enqueueActWrite*`, `src/lib/act/outbox.ts`). Nothing waits for ACT!. The
  drain (`scripts/act-drain.ts`, `pq-act-drain.timer`, every five minutes)
  sends due rows; a failure sets `attempts`, `lastError` and `nextAttemptAt`
  by an exponential backoff capped at six hours (`src/lib/act/drain-rules.ts`),
  a row ACT! refuses for a reason a person must settle is `blockedReason`,
  and a row is never dropped or expired. Rows wait, in order, for as long as
  ACT! is away. After a finalize the same drain also runs once in `after()`
  (post-response, 20 s budget) so the ordinary case reaches ACT! in seconds.
- **Reads are snapshots.** Contacts and companies come in through the nightly
  sync (and a requested one), with a cursor so an interrupted run resumes.
  The user page's ACT! user/Rep lists come from `Setting act.linkLists`,
  refreshed by the drain when older than an hour. "Sync now" records
  `Setting act.sync.requested`; the next tick runs it.
- **The guard is a test.** `tests/act-isolation.test.ts` walks the imports of
  every page, layout, route handler and server action and fails if one
  reaches a module that constructs an ACT! client, except the two that do so
  on purpose: `drain-after.ts` (post-response) and `outbox-admin-store.ts`
  (the administrator's explicit "ACT! has this person" check, 40 s ceiling).
- **Failure modes on the request path**: a missing `ACT_*` variable or an
  ACT! outage is logged by the drain and shown on the Settings → ACT! page
  from the run record; no page or action throws because of it.

## Documentation structure (2026-10-17)

`docs/README.md` is the index. Operational: `runbook.md`,
`act-integration-reference.md`. Decisions behind live behaviour: `design/`
(dated; code comments cite them). Rules and how-tos: `reference/`. Work not
done, with reasoning: `backlog/`. This audit: `technical-audit/`. Completed
implementation plans, pre-build analyses, mock-ups and draft copy were
deleted (git history keeps them).

## Changes made by this audit and why (see FIX_PLAN.md for contracts)

- Autosave no longer revalidates; the client refreshes once per burst (keeps
  one source of truth — the server render — but off the critical path).
- Builder page: one document load, one compatible-options query, two waves,
  tabs client-side, industries on demand.
- Lists: bounded rows, one DOM per row, one link per row.
- DB client: explicit pool limits and timeouts; PDF/ACT! work after the
  response; composite indexes for the two scoped list reads.
- Observability: `dbMs` + pool counters in `/api/health`, event-loop/pool
  smoke alarm, slow-query log, nginx timing log (runbook §3b), Postgres
  statement stats (compose).

## ponytail-audit (repo-wide, ranked biggest cut first)

Scope: over-engineering only. Verified against current `main`; dynamic imports,
package.json scripts, Next conventions and tests checked before calling
anything dead. Applied in this audit: the two marked **(done)**. Everything
else is listed for the owner; none of it is a speed fix.

- `delete:` one-off migration/repair scripts whose migrations shipped: `scripts/migrate-catalog-v2.ts` (286), `scripts/lib/catalog-v2-plan.ts` (575; seed needs only `type CatalogTarget`), `scripts/build-seed-data-from-target.ts`, `scripts/verify-quote-document-migration.ts` (198), `scripts/repair-z35-signing-request-drift.sql`, `scripts/sql/tax-migration-preview.sql`, `scripts/add-dmt-option.ts`, `scripts/check-production-form-enum.ts`, `scripts/act-fix-country-spellings.py` (338), `scripts/act-fix-country-usa.py` (198), `scripts/act-diagnose.py` (322) + `tests/catalog-v2-plan.test.ts`, `tests/catalog-v2-target.test.ts` + 4 package.json scripts. Nothing. [scripts/, package.json] — **partly done 2026-10-17**: the eight with no code dependency are gone (repair SQLs, the three Python fixers, `verify-quote-document-migration`, `add-dmt-option`, `check-production-form-enum`); the catalog-v2 chain stays because `prisma/seed.ts` and the CI seed verification build on it — retiring it means re-basing the seed on `catalog.json` alone, a separate change.
- `delete:` `sendQuoteToClient` + `SendQuoteInput` + `cleanEmails`/`EMAIL_RE` (≈300 lines; no caller), `src/lib/email/quote-send.ts` (280), its test, `EmailHistorySection` + the `emails` select in `getQuoteHistory` (reads a table nothing writes, on every builder render). **(done 2026-10-17; the `QuoteEmail` table stays until a verified-empty drop)**
- `stdlib:` six hand-rolled argv parsers (`act/cli-args.ts` 182, `drain-args.ts` 148, `preflight-args.ts` 73, `user-map-args.ts` 100, `weekly-report-args.ts` 93, `write-preflight-args.ts` 55) + `npm-swallowed-flags.ts` (82) + 7 tests. `node:util` `parseArgs({ options, strict: true })`. [src/lib/act/*-args.ts]
- `native:` `src/lib/phone-regions.ts` `DIAL_CODES`/`MAIN_REGION_BY_DIAL` (493 lines of typed data). `PhoneNumberUtil.getCountryCodeForRegion` / `getRegionCodeForCountryCode` / `getSupportedRegions` from `google-libphonenumber`, already a dependency. [src/lib/phone-regions.ts]
- `shrink:` 31 document actions repeat requireSession → scoped findFirst → `$transaction(assertStillDraft, …, recalcAndEnforce)` → revalidate → `mapDraftWriteError`. One `draftWrite(documentId, user, (tx, doc) => …)` helper in `_internal.ts`. [src/lib/actions/documents/*.ts]
- `delete:` 15 "meta tests" that regex-grep source text and pin match counts (`session-plumbing.test.ts` expects exactly 2 `token.regionId =` writes; `signing-exposure`, `signature-freeze`, `client-delete-affordance`, `form-sheet-css`, `act-outbox-sql`, `build-image-imports`, …). Nothing for the count-pinning ones; `scope-coverage.test.ts` → an ESLint `no-restricted-imports` rule. [tests/*.test.ts]
- `native:` `src/lib/country-names.ts` (274 lines, hand-typed ISO names). `new Intl.DisplayNames(["en"], { type: "region" }).of(code)`. [src/lib/country-names.ts] (~80%: a few names differ, XK absent from Intl)
- `yagni:` `src/lib/revalidate.ts` — 28 one-line wrappers that only delegate to `revalidatePath`. Call `revalidatePath` at the call sites. [src/lib/revalidate.ts]
- `shrink:` `SigningStatus` union (`signing/state.ts:17`) and `ROLE_VALUES` (`roles.ts:1`) mirror Prisma enums and need two parity tests (129 lines). `import { Role, SigningStatus } from "@prisma/client"`; delete both tests. [src/lib/signing/state.ts, src/lib/roles.ts]
- `delete:` 43 never-referenced exports: `LinesField` (forms/primitives.tsx), `NO_REFERENCES` (catalog-xlsx/snapshot.ts:92), `isMarkingTool` (production-forms/marking-tools.ts), `listUsersWithHiddenCounts` (queries/catalog-visibility-admin.ts:37) and 39 `export type …Input = z.infer<…>` aliases in `src/lib/validation/*.ts`. Nothing. Plus ~260 exports used only inside their own file: drop the `export` keyword.
- `yagni:` `renderer: "html"` discriminator + `type FormSpec = HtmlFormSpec` (one variant, `production-forms/types.ts:111-138`) and the parallel `COMPONENTS` map in `components/forms/registry.tsx`. Put `component` on each spec; `isRenderable` disappears.
- `shrink:` two Gotenberg POST clients (`pdf.ts` with semaphore; `production-forms/render.ts` without). One `postToGotenberg(route, form)` under the semaphore. **(done 2026-10-17)**
- `shrink:` duplicated client-search term/word/where builders (`client-list.ts:90-93,404-520` vs `client-search.ts:45-150`). One `companyWordClause(word, fields)`.
- `shrink:` three `Setting` getters each a `findUnique` (`settings.ts`) → one `cache()`d loader with `findMany({ where: { key: { in } } })`. **(done — two fewer queries per builder render)**
- `native:` `class-variance-authority` — one `cva()` call in the codebase. Two lookup objects + `cn()`. [src/components/ui/button.tsx]
- `delete:` `fflate` — 0 imports in src/scripts/prisma/tests. Nothing. [package.json] **(done)**
- `native:` `format.ts relativeTime` and three time-zone formatters (`format.ts`, `act/sync-view.ts:164-200`, `act/weekly-report.ts:49-90`). `Intl.RelativeTimeFormat` + one `formatInZone(date, zone, opts)`.
- `yagni:` `src/lib/app-version.ts` (12 lines, one `process.env` read). Inline it.
- `shrink:` comments are 27,166 of 83,425 src lines (32.6%); `act/outbox-plan.ts` 873/1025, `act/write-payloads.ts` 785/1215, `quotation-data.ts` 806/1370, `act/client.ts` 734/1476, `pricing.ts` 729/1191 are design essays. Keep the decision and the bug it prevents; drop the narrative.

`net: -5,400 lines (code+tests; excludes the optional ~-10,000 comment trim), -2 deps possible.`

Confidence notes: `backfill-quote-revisions.ts` is NOT listed (touched 2026-10-16, cited by `act/*`). `clsx` might also go if no `cn()` call uses object syntax (unverified → -3 deps). Prisma `Account`/`Session` models are unused at runtime (JWT) but dropping them is a migration on auth tables — flagged, not counted.
