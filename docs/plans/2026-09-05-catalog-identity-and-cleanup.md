# Catalog identity & cleanup — implementation plan

Date: 2026-09-05. Owner decisions recorded in `docs/reference/catalog-v2-decisions.md`.
Target data in `docs/reference/catalog-v2-target.json` (generated from the live DB dump
`RAW/catalog-dump.json` + decisions; the data-migration script reads it).

> **Done — 2026-09-06.** All five phases complete. Migration applied to the local DB and
> seed verified (3.5); the old code contract is gone (4.x); the director's export exists
> (5.1). What remains is outside this plan: the director's code review via the export, and
> the import half in `docs/plans/2026-09-05-catalog-import-export.md`.
>
> **`legacyCodes` removed — 2026-09-06 (owner decision).** The `Product.legacyCodes` /
> `Option.legacyCodes` columns from 1.1 are dropped by migration `z32_drop_legacy_codes`:
> "no garbage accumulation, the legacy is never needed again". The live DB already carries
> the v2 codes, so does the seed data, and existing documents are demo data — nothing looks a
> row up by an old code any more. A code rename is a plain update of the label. Consequences:
> `src/lib/catalog-identity.ts` (`whereAnyCode`) is deleted; the seed upserts by `code`
> again; the planner matches by `id`, else exact current code (a rename is only detected
> through the id); the target file, `catalog.json`, the export workbook and the image import
> carry no old codes. Items 2.9, 3.1, 3.2 and 3.4 below describe the state *before* this
> change and are annotated.

Status: `[ ]` not started · `[~]` in progress · `[x]` done.

## Why

Product/Option `code` is `@unique` but ~60 sites of application logic branch on its
literal value (regexes, `${itemCode} ${suffix}` templates, lookup maps, seed literals).
A director renaming a code today breaks production forms, the EasyLoader builder,
quotation content blocks and machine-spec sentences. Full map: `docs/audit` v1 appendix A
(mirrored below in Phase 1 checklist).

Goal: `code` is a mutable label. Behaviour keys on `id` and explicit attributes.

## Phase 1 — Explicit attributes, no behaviour change ✅ (2026-09-05, branch `catalog-identity`)

- [x] **1.1** Schema: `enum ProductKind { MACHINE TABLE FEEDER SPREADER SOFTWARE SYSTEM SERVICE CREDIT ACCESSORY }`,
  `enum ProductionForm { M_SERIES EASYLOADER FABRICPRO }`, `Product.kind`, `Product.form?`,
  `Product.legacyCodes String[]`, `Option.role OptionRole?`, `Option.parentProductId?`,
  `Option.unitLengthM Decimal?`, `Option.legacyCodes String[]`. `DocumentItem.kind/form`
  and `DocumentLine.role` snapshots. Migration `z26_catalog_identity`. (Both `legacyCodes`
  columns dropped again by `z32_drop_legacy_codes` — see the note at the top.)
- [x] **1.2** Typed `Product.specs`: `{ cutHeightCm?, cutWidthCm?, tableWidthMm?, paperWidthMm?, modelTier?, extended?, belt? }` zod schema in `src/lib/validation/product-specs.ts`.
- [x] **1.3** Backfill script (deleted in Phase 4 along with its library and test): derived every
  new column from the then-current code regexes (form resolver, machine-specs parser, EasyLoader
  option-suffix map, m-series tick regexes). Idempotent. Asserted that the derived form matched
  the regex path for every product.
- [x] **1.4** Tests: for each product in `catalog.json`, backfilled `kind/form/specs` equalled
  what the regex path returned at the time (deleted in Phase 4 with the regexes).

## Phase 2 — Readers switch to attributes ✅ (2026-09-05)

Known deliberate differences vs. the code-parsing readers: the quotation spec sentence prints the real cut width from `specs` (227cm for the 220 family, 226cm for L-220) where the parser printed the family number; M*300 and L-320E now get a sentence at all; `addItem` refuses an inactive product; unknown-option errors list ids.

- [x] **2.1** `production-forms/resolve.ts`: `resolveForm(product: {form})` instead of `(code)`. Callers: route, actions/production, production-forms-section, items-list, production-spec-editor, context.
- [x] **2.2** `specs/m-series.ts`, `specs/easyloader.ts`, `specs/fabricpro.ts`: model/width ticks from `specs`; option ticks from `Option.role` (map `role → cell`); `covers` = set of roles.
- [x] **2.3** `table-sections.ts`: `elOptionCode` → `findElOption(parentProductId, role)`; `derivedEasyLoaderCodes` → derived by role. `setEasyLoaderLayout` (both copies) rewrites lines by role.
- [x] **2.4** `machine-specs.ts`: read `specs.cutHeightCm/cutWidthCm/tableWidthMm/paperWidthMm`; regex only as fallback for `specs == null` (removed in Phase 4).
- [x] **2.5** `quotation-data.ts`: content block by `Product.contentBlockKey` / `Option.contentBlockKey` (add columns + backfill from `option.<code>` keys); the machine-series code list → `kind === MACHINE`; software (S)/(I) by `specs.softwareMode` or role.
- [x] **2.6** `option-length.ts` → `Option.unitLengthM`.
- [x] **2.7** Wire format: `addItem(documentId, productId)`, `optionSelectionSchema.optionId`, catalog-visibility by ids, compat by seriesId. `DocumentLine.refId` already holds optionId.
- [x] **2.8** `production-forms-section.tsx` software-host warning by `kind/role`.
- [x] **2.9** Seed: `code` is the seed's natural key — products and options are upserted by
  `code` (a code renamed in `catalog.json` seeds a new row; rename in the catalogue UI, then
  in the file). The seed's own retire list and the XC→X / HDRF one-off rewrites are gone
  (2026-09-06): deletions come only from the target's `delete` rows. *(Until the
  `legacyCodes` removal the seed matched by `code` OR `legacyCodes has` via `whereAnyCode`,
  so a database seeded under an old code was renamed in place; that path is gone.)*
- [x] **2.10** All 1330 tests green; identity test (1.4) still green at the time.

## Phase 3 — Data: rename, dedupe, add, delete (per decisions file)

- [x] **3.1** `scripts/migrate-catalog-v2.ts` (IO shell) + `scripts/lib/catalog-v2-plan.ts`
  (pure planner, tested against `RAW/catalog-dump.json` in `tests/catalog-v2-plan.test.ts`):
  matches by `id`, else by exact current code (a rename is detected only through the id);
  sets code/name/description/prices/compat/role/kind/specs; deletes listed rows (options,
  then products); adds new rows; `--dry-run` prints the diff; idempotent (second plan is
  empty). *(Originally also matched by any old code and wrote the old code to
  `legacyCodes`; gone with the column.)*
- [x] **3.2** `scripts/build-seed-data-from-target.ts` regenerated `catalog.json` + `prices-us.json`
  (new codes, `kind/form/specs`, `role/parentProductCode/unitLengthM`, `contentBlockKey`);
  `prisma/seed.ts` upserts rows by code and retires the target's deletes. The spreadsheet
  extractors that used to write the two files are deleted (Phase 4). *(The files carried
  `legacyCodes` until the column was dropped.)*
- [x] **3.3** `content-blocks.json` keys unchanged (`option.MTS`, `machine.m-series`, …) — they are
  block ids, not catalogue codes; rows link to them through `contentBlockKey` (backfilled,
  carried through renames, linked by the seed for fresh rows). Nothing in `src/` derives a key from a code.
- [x] **3.4** Image maps (`import-images-lib.ts`) keyed by new codes; `import-product-images.ts`
  matches rows by current code (`findUnique({ where: { code } })`). *(Matched by any code via
  `whereAnyCode` until the `legacyCodes` removal.)*
- [x] **3.5** (owner, 2026-09-06) Migration applied to the local DB, `db:verify-seed` clean, manual
  smoke OK: M-3180 quote → M-Series form; EL-2020 builder → DM1/DM12/ST12/BB12/RL12 lines;
  L-320EF quote → correct US price.

## Phase 4 — Remove the old contract ✅ (2026-09-06)

- [x] **4.1** Deleted: the code regexes, the EasyLoader option-suffix map, the printed-width map,
  the machine-series code list, the seed's retire list, `(S)/(I)` parsing, the backfill script +
  library, the identity test from 1.4, and the two spreadsheet extractors (`extract-*.ts` and
  their `npm run extract:*` entries). `src/lib/catalog-identity.ts` kept only `whereAnyCode`
  (and was deleted with the `legacyCodes` columns). `prisma/seed-lib.ts` requires an explicit `kind` (products) and `role` key (options) and
  throws naming the code otherwise. The planner (`catalog-v2-plan.ts`) carries `contentBlockKey`
  like every other scalar.
- [x] **4.2** Tests rewritten as invariants (audit plan 8.4): `tests/catalog.test.ts` asserts
  structural rules over `catalog.json` (unique codes, character rule, explicit identity, one
  option per EL role per width, …); `tests/seed-mapping.test.ts` uses fixtures with explicit
  identity and asserts exact payloads plus the missing-`kind`/missing-`role` errors;
  `tests/catalog-v2-plan.test.ts` checks the planner carries `contentBlockKey` and stays idempotent.

## Phase 5 — Export for the director ✅ (2026-09-06)

- [x] **5.1** `scripts/export-catalog.ts` (`npm run catalog:export`) → xlsx with `Products`,
  `Options`, `Prices` sheets; builder in `src/lib/catalog-xlsx/export.ts` (moved from `scripts/lib/catalog-export.ts` when the in-app import/export landed), tested in
  `tests/catalog-export.test.ts`; usage in `docs/reference/catalog-import-export.md`. Director reviews
  codes; corrections come back as edits to `catalog-v2-target.json`, a re-run of 3.1 and of
  `npm run catalog:build-seed-data`.

## Ordering constraint (historical)

Phase 3 **must not** have run before Phase 2: `M3180 → M-3180` would have broken the
model regex in `specs/m-series.ts`; `EL-2020 Additional 1.2M lengths → EL-2020-DM12` would have
broken the EasyLoader option-suffix map. Both are gone now. Existing documents are demo data
(owner) — snapshots are not migrated.
