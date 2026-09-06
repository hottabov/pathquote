# Catalog import / export — implementation plan

Date: 2026-09-05. Backlog: John/Wayne #17, Ross/Martin #12 (both sized **M**).

Owner decisions taken 2026-09-05:

- **Rows missing from an uploaded file are deleted from the catalogue**, with confirmation.
  Finalized quotes are left untouched. Non-finalized quotes lose the line too. Admin-only,
  global action.
- **Three sheets**: `Products`, `Options`, `Prices` (a price row = item × region).
- **Price versioning is out of v1** — effective dates and history come later.

Status: `[ ]` not started · `[~]` in progress · `[x]` done.

> **Built 2026-09-06** as Settings -> Import / Export (`/settings/import-export`, ADMIN/DEVELOPER).
> Reference for the shipped shape: `docs/reference/catalog-import-export.md`. Where the build
> departs from the text below it is noted inline with a **Built:** marker.

---

## 0. What the codebase already gives us, verified

Both checks below were run against the tree, not assumed.

**`DocumentItem` snapshots everything a quote needs to render**: `code`, `name`,
`description`, `unitPrice`, `listPrice`, `imageUrl` (`prisma/schema.prisma:576-593`).
So a finalized quote survives its product being deleted — nothing it prints is read
live. This is what makes the owner's "don't touch finalized quotes" rule cheap to honour.

**`code` coupling is narrower than the catalogue-v2 audit estimated.** That doc says
"~60 sites of application logic branch on its literal value"; the actual count is
**13 literals across 9 files**, plus **six mechanisms**:

| # | Mechanism | Where |
|---|---|---|
| 1 | Machine specs parsed out of the code digits (`M3390` → 3cm × 390cm) | `lib/machine-specs.ts` |
| 2 | EasyLoader derived option codes **constructed** as `` `${itemCode} ${suffix}` `` | `lib/production-forms/table-sections.ts:55` |
| 3 | Which production form a product gets | `production-forms/resolve.ts` |
| 4 | EasyLoader printed-width box picked by a code-keyed map | `production-forms/specs/easyloader.ts:121` |
| 5 | Content-block key derived from code | `lib/quotation-data.ts:177` |
| 6 | Hardcoded `["EL-2020", "EL-2420"]` | `components/builder/production-spec-editor.tsx:557` |

Mechanism 1 is a **deliberate domain rule**, not accidental coupling — its own comment
says the digits in the code are the source of truth and a catalogue description can be
wrong. Mechanism 2 is the dangerous one: rename an EasyLoader product and every derived
option code changes with it, so existing layouts stop matching.

**Conclusion that shapes v1:** matching import rows by `id` makes the *import mechanism*
safe today. What is not safe is letting the file change `code`. Those are separable, so
v1 ships with `code` read-only and full editing of everything else.

> **Superseded 2026-09-06.** All six mechanisms were removed by
> `docs/plans/2026-09-05-catalog-identity-and-cleanup.md` (phases 2 and 4): behaviour
> now keys on `Product.kind/form/specs/contentBlockKey` and
> `Option.role/parentProductId/unitLengthM/contentBlockKey`, and `code` is a mutable
> label. An import may therefore let the file change `code`: renaming a code is simply an
> update of the label on the row the `id` names (no history of old codes is kept — owner
> decision 2026-09-06, migration `z32_drop_legacy_codes`) — revisit the "code read-only"
> scoping below before building v1.

---

## 1. The trap: deletion cannot be left to the schema

`DocumentItem.product` is declared **without `onDelete`** (`schema.prisma:578`), so
Prisma's default for an optional relation applies: `SetNull`. Deleting a product
therefore does **not** raise an error and does **not** remove anything — it nulls the
link and leaves the item in place.

For a finalized quote that is exactly right (see §0). For a draft it is the worst
outcome available: a **phantom line** with a price, still counted in the total, pointing
at a product that no longer exists. Nobody wrote that behaviour down; it is a Prisma
default nobody chose.

`DocumentLine.refId` is worse: a plain `String`, not a foreign key
(`schema.prisma:626`), so deleting an **option** leaves lines referencing nothing at all,
with no database-level signal.

**So the import must own deletion explicitly:**

1. FINAL documents — touch nothing. Snapshots already make them correct.
2. DRAFT documents — delete the affected items and lines, then **recalculate each
   affected document**. This is the expensive and destructive part, and it reaches into
   drafts belonging to other users.
3. Make the intent explicit in the schema rather than relying on a default: an explicit
   `onDelete: SetNull` with a comment saying *why* (finalized quotes must survive), so the
   next reader sees a decision instead of an accident.

- [x] **1.1** Migration: explicit `onDelete: SetNull` on `DocumentItem.product`, with the
  reasoning in a schema comment. No behaviour change — it writes down what already happens.
  **Built:** schema comment on `DocumentItem.product`; migration `z33_catalog_import` carries
  no statement for it (verified with `prisma migrate diff`: the explicit `SetNull` is what the
  default already generated) and says so in its header.

---

## 2. Export

- [x] **2.1** `GET /api/catalog/export` (ADMIN only) → `.xlsx`, three sheets.
  **Built:** `src/app/api/catalog/export/route.ts`, `Content-Disposition: attachment;
  filename="catalog-<date>.xlsx"`; same builder as `npm run catalog:export`.
- [x] **2.2** Column layout. Every sheet leads with `id` — that is the join key on import.
  It is deliberately not hidden: a hidden column that silently controls destructive
  behaviour is worse than a visible one nobody edits. Header row frozen and styled;
  read-only columns (`id`, `code`) visually marked and protected via sheet protection,
  which Excel honours as a warning rather than a lock — the import validates regardless.

  | Sheet | Columns |
  |---|---|
  | `Products` | `id`, `code` (ro), `series`, `name`, `description`, `partNumber`, `sortOrder`, `active`, `isCredit`, `noCommission` |
  | `Options` | `id`, `code` (ro), `name`, `description`, `partNumber`, `sortOrder`, `active`, `noCommission` |
  | `Prices` | `id` (price row), `itemId`, `itemType` (product\|option), `itemCode` (ro), `itemName` (ro), `regionCode`, `currency` (ro), `amount`, `needsReview` |

  **Built** with the column set the Phase-5 export already established (kept, not the table
  above): Products `id, series, code, name, description, kind, form, specs, contentBlockKey,
  isCredit, noCommission, active, sortOrder, imageUrl`; Options `id, code, name,
  shortDescription, role, parentProduct, unitLengthM, compatSeries, compatProducts,
  contentBlockKey, noCommission, active, sortOrder, imageUrl, attributeSchema`; Prices
  `itemType, itemId, code, region, currency, amount, needsReview` (no price-row id: a price is
  keyed by item x region). `code` is editable (see the Superseded note in §0), so no column is
  marked read-only; the README sheet states the rules. Contract in
  `src/lib/catalog-xlsx/columns.ts`, shared by export and import.

- [x] **2.3** Build on `xlsx` (already a devDependency) — but it must move to
  `dependencies`, since this now runs in the app rather than in a script. Note its two
  open advisories (prototype pollution, ReDoS): both are parser-side and this route
  **reads** untrusted files at import, so this is a real consideration and not a
  formality. Evaluate `exceljs` as an alternative before committing to it; decide on
  evidence and record the decision here.

  **Decision 2026-09-06: stay on `xlsx` 0.18.5, moved to `dependencies`; `exceljs` not
  adopted.** `exceljs` was not installed (no network guarantee for the build, and it would be
  a second spreadsheet stack next to the `fflate`-based production forms). The exposure is
  bounded instead: (a) the only caller of the parser is an ADMIN/DEVELOPER-gated server
  action, so the "untrusted" file is one an administrator chose to upload; (b) uploads are
  capped at 5 MB and must be `.xlsx` (`MAX_IMPORT_BYTES`, `checkFile`); (c) the parser runs
  with `cellFormula: false, cellHTML: false, dense: true` and never evaluates anything --
  cells are read as scalars and re-validated column by column (`parse.ts`); (d) the values
  from a parsed workbook are only ever spread into typed Prisma writes after that
  validation, so a prototype-pollution payload has no object graph to land in that reaches
  the database. Revisit if the import is ever opened beyond admins or if a patched SheetJS
  line becomes installable from npm.
- [x] **2.4** A round-trip test: export → parse → assert every catalogue row is present
  with the values the DB holds. **Built:** `tests/catalog-xlsx-apply-plan.test.ts` ("round
  trip"): builder → workbook bytes → `readCatalogWorkbook` → parse → diff = all unchanged,
  empty plan; plus `tests/catalog-export.test.ts`'s file round trip.

---

## 3. Import — preview first, write second

The backlog is explicit on both sides ("імпорт з попереднім переглядом змін",
"confirmation before write"), and the deletion rule makes it mandatory.

- [x] **3.1** Upload → parse → **diff against the live catalogue**, computed and returned
  without writing anything. Diff shape: `unchanged | updated (field-by-field before→after)
  | new | missing`. **Built:** `previewCatalogImport`; buckets are named
  `unchanged | updated | created | deleted` (`src/lib/catalog-xlsx/diff.ts`).
- [x] **3.2** Preview screen: counts per bucket, a table of every change, and — for the
  `missing` bucket — for each row **how many DRAFT documents will lose a line** and
  **how many FINAL quotes reference it** (the latter shown as reassurance that they are
  not being touched). This is the number that makes the confirmation meaningful.
  **Built:** `src/components/settings/catalog-import-panel.tsx`; the confirm dialog spells
  out "delete N products and M options ... remove their lines from K draft quotes".
- [x] **3.3** Validation, all reported as row/column errors rather than a single failure:
  unknown `id`, `code` edited (rejected in v1), negative price, unparseable number,
  unknown `regionCode`, duplicate row for the same item × region. **Built** (`parse.ts`),
  with `code` edits *allowed* per the Superseded note; also: missing/unknown sheet or
  header, unknown enum value, bad JSON, `specs` failing `productSpecsSchema`, unknown
  series / parentProduct / compatProducts (against the file's own Products sheet), duplicate
  code or id, a price left behind for a deleted item, a non-upload `imageUrl`.
- [x] **3.4** Apply, in **one transaction**: updates, inserts, then deletions with the
  draft cleanup from §1, then a recalc per affected draft. If the transaction is too large
  in practice, batch by document — but never leave a draft un-recalculated, since a stale
  total is money that is silently wrong. **Built:** `applyCatalogImport` — one interactive
  `db.$transaction` (120 s timeout) that re-parses and re-diffs the client's cells against
  the live catalogue and aborts if the counts moved since the preview; order is deletions
  first (detach DRAFT items/lines, delete options then products), then renamed codes are
  parked, then products, options, compat, prices; `recalcDocument` per affected draft. See
  `src/lib/catalog-xlsx/apply-plan.ts` for why deletes go first.
- [x] **3.5** Audit record: who, when, file name, counts per bucket, and the full diff.
  Without it a bad import cannot be reconstructed, and versioning (§6) will need this
  table anyway. **Built:** `CatalogImport` (migration `z33_catalog_import`): user, time,
  file name, counts, full diff, APPLIED/FAILED + error. The last ten are listed on the page.
- [x] **3.6** ADMIN only, on both the export and the import routes and in the UI.
  **Built:** `isAdminRole` on the route, `requireAdmin` in both actions, `notFound()` on
  the page, `adminOnly: true` in `SETTINGS_NAV_ITEMS`.

---

## 4. Testing

The action layer has no automated coverage by design (the suite is pure-function, zero
Prisma mocks). So the diff engine must be **pure**: `(parsedRows, catalogueSnapshot) → diff`,
with no database access, and it carries the test weight.

- [x] **4.1** Unit tests for the diff: every bucket, field-level updates, duplicate rows,
  unknown ids, a `code` edit, an empty file, a file with only headers.
  **Built:** `tests/catalog-xlsx-parse.test.ts` (every error kind; enum lists asserted
  against `prisma/schema.prisma`), `tests/catalog-xlsx-diff.test.ts`,
  `tests/catalog-xlsx-apply-plan.test.ts` (ordering).
- [x] **4.2** Round-trip test (§2.4).
- [~] **4.3** A test asserting a finalized quote's totals are **unchanged** after its
  product is deleted — the owner's rule, currently guaranteed only by snapshots that
  nobody has pinned down. **Built (structurally):** the apply plan's only document-touching
  op is `detachDraftReferences`, and its executor filters `document: { status: "DRAFT" }`
  on every read and delete; no op recalculates a FINAL document. A test that actually
  deletes a product under a FINAL quote and re-reads its totals needs a database, which the
  suite does not have (see §4) — left open for an integration run.

---

## 5. Out of v1, deliberately

- ~~**Editing `code`**~~ — was gated on the six mechanisms in §0 moving to `id`/attributes
  (`docs/plans/2026-09-05-catalog-identity-and-cleanup.md`, Phase 1); they did, so v1 as
  built allows it (see the Superseded note in §0).
- **Price versioning / effective dates** — owner's call; separate schema work.
- **Nightly Google Sheets / M365 sync** (Ross/Martin #12 item 3) — needs v1 stable first.
- **Creating new regions from the file** — the `Prices` sheet references regions, it does
  not define them.

---

## 6. Open question for the owner

Ross set a constraint at the meeting: *"people have to have certainty, it can't be
fluctuating all the time"* — prices change monthly, not daily. v1 as planned applies an
import the moment it is confirmed, with no scheduling. Worth confirming that immediate
application is what is wanted, or whether an import should be stageable against a date
from the start (which would pull §5's versioning into v1).
