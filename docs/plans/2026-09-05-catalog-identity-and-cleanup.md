# Catalog identity & cleanup — implementation plan

Date: 2026-09-05. Owner decisions recorded in `docs/reference/catalog-v2-decisions.md`.
Target data in `docs/reference/catalog-v2-target.json` (generated from the live DB dump
`RAW/catalog-dump.json` + decisions; the data-migration script reads it).

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
  and `DocumentLine.role` snapshots. Migration `z26_catalog_identity`.
- [x] **1.2** Typed `Product.specs`: `{ cutHeightCm?, cutWidthCm?, tableWidthMm?, paperWidthMm?, modelTier?, extended?, belt? }` zod schema in `src/lib/validation/product-specs.ts`.
- [x] **1.3** Backfill script `scripts/backfill-catalog-identity.ts`: derives every new column
  from the *current* regexes (`resolveForm`, `machine-specs`, `EL_OPTION_SUFFIX`, m-series
  tick regexes). Idempotent. Asserts `resolveForm(code)?.id === form` for every product.
- [x] **1.4** Tests: for each product in `catalog.json`, backfilled `kind/form/specs` equals
  what the regex path returns today (parity test — deleted in Phase 4).

## Phase 2 — Readers switch to attributes ✅ (2026-09-05)

Known deliberate differences vs. the code-parsing readers: the quotation spec sentence prints the real cut width from `specs` (227cm for the 220 family, 226cm for L-220) where the parser printed the family number; M*300 and L-320E now get a sentence at all; `addItem` refuses an inactive product; unknown-option errors list ids.

- [x] **2.1** `production-forms/resolve.ts`: `resolveForm(product: {form})` instead of `(code)`. Callers: route, actions/production, production-forms-section, items-list, production-spec-editor, context.
- [x] **2.2** `specs/m-series.ts`, `specs/easyloader.ts`, `specs/fabricpro.ts`: model/width ticks from `specs`; option ticks from `Option.role` (map `role → cell`); `covers` = set of roles.
- [x] **2.3** `table-sections.ts`: `elOptionCode` → `findElOption(parentProductId, role)`; `derivedEasyLoaderCodes` → derived by role. `setEasyLoaderLayout` (both copies) rewrites lines by role.
- [x] **2.4** `machine-specs.ts`: read `specs.cutHeightCm/cutWidthCm/tableWidthMm/paperWidthMm`; regex only as fallback for `specs == null` (removed in Phase 4).
- [x] **2.5** `quotation-data.ts`: content block by `Product.contentBlockId` / `Option.contentBlockId` (add columns + backfill from `option.<code>` keys); `MACHINE_SERIES_CODES` → `kind === MACHINE`; software (S)/(I) by `specs.softwareMode` or role.
- [x] **2.6** `option-length.ts` → `Option.unitLengthM`.
- [x] **2.7** Wire format: `addItem(documentId, productId)`, `optionSelectionSchema.optionId`, catalog-visibility by ids, compat by seriesId. `DocumentLine.refId` already holds optionId.
- [x] **2.8** `production-forms-section.tsx` software-host warning by `kind/role`.
- [~] **2.9** (RETIRED entry for EL drive modules removed; seed still upserts by legacy code — regenerated catalog.json in phase 3 makes it whole) Seed: upsert by `code` stays (seed's natural key) but `RETIRED_OPTION_CODES` and
  the XC→X / HDRF rewrites move into `legacyCodes`-aware lookup: find by `code` OR `legacyCodes has`.
- [x] **2.10** All 1330 tests green; parity test still green.

## Phase 3 — Data: rename, dedupe, add, delete (per decisions file)

- [ ] **3.1** `scripts/migrate-catalog-v2.ts`: reads `catalog-v2-target.json`; for each row
  matches DB by `id` (from dump) → sets code/name/description/prices/compat/role/kind/specs;
  old code → `legacyCodes`. Deletes listed rows. Adds new rows. Dry-run flag prints diff.
- [ ] **3.2** Regenerate `prisma/seed-data/catalog.json` + `prices-us.json` from the same
  target so a fresh seed reproduces the cleaned catalogue. `extract-*.ts` scripts get a
  deprecation note (source spreadsheets are superseded by the target file).
- [ ] **3.3** `content-blocks.json` keys re-pointed via `contentBlockId` (no code keys).
- [ ] **3.4** Image maps (`import-images-lib.ts`) keyed by new codes + legacy fallback.
- [ ] **3.5** Run on local DB, `db:verify-seed`, manual smoke: M-3180 quote → M-Series form;
  EL-2020 builder → DM1/DM12/ST12/BB12/RL12 lines; L-320EF quote → correct US price.

## Phase 4 — Remove the old contract

- [ ] **4.1** Delete regexes, `EL_OPTION_SUFFIX`, `PRINTED_WIDTHS`, `MACHINE_SERIES_CODES`,
  `RETIRED_OPTION_CODES`, `(S)/(I)` parsing, parity tests.
- [ ] **4.2** Tests rewritten as invariants (audit plan 8.4).

## Phase 5 — Export for the director

- [ ] **5.1** `scripts/export-catalog.ts` → xlsx: one row per product/option, code / name /
  description / AU / US / compat / role. Director reviews codes; corrections come back as
  edits to `catalog-v2-target.json` and a re-run of 3.1.

## Ordering constraint

Phase 3 **must not** run before Phase 2: `M3180 → M-3180` breaks `/^M(3|5|7|10)…$/` in
`specs/m-series.ts:4`; `EL-2020 Additional 1.2M lengths → EL-2020-DM12` breaks
`EL_OPTION_SUFFIX`. Existing documents are demo data (owner) — snapshots are not migrated.
