# Catalogue import / export (xlsx)

The catalogue as a workbook: download it, edit it in Excel, upload it back. Every change is
previewed and nothing is written until an admin confirms. Plan and owner decisions:
`docs/plans/2026-09-05-catalog-import-export.md`; export originally Phase 5 of
`docs/plans/2026-09-05-catalog-identity-and-cleanup.md`.

## Where

- **In the app**: Settings -> Import / Export (`/settings/import-export`), ADMIN/DEVELOPER only.
  "Download catalogue (.xlsx)" hits `GET /api/catalog/export`; the Import card uploads a file,
  shows the preview, and applies it on confirm.
- **CLI export** (same workbook, written to disk): `npm run catalog:export`
  (`-> RAW/catalog-export-<YYYY-MM-DD>.xlsx`, or `-- --out RAW/review.xlsx`). Needs `DATABASE_URL`
  via `.env`; writes nothing to the database.

## Code map

| Piece | Where |
|---|---|
| Column contract, enum lists, size limit | `src/lib/catalog-xlsx/columns.ts` |
| Snapshot types (what the DB is read into) | `src/lib/catalog-xlsx/snapshot.ts` |
| Export builder (snapshot -> workbook) | `src/lib/catalog-xlsx/export.ts` |
| Parser (workbook -> typed rows + errors) | `src/lib/catalog-xlsx/parse.ts` |
| Diff engine (rows + snapshot -> buckets) | `src/lib/catalog-xlsx/diff.ts` |
| Apply plan (diff -> ordered writes) | `src/lib/catalog-xlsx/apply-plan.ts` |
| Snapshot reader, import history | `src/lib/queries/catalog-xlsx.ts` |
| Server actions (preview, apply) | `src/lib/actions/catalog-import.ts` |
| Export route | `src/app/api/catalog/export/route.ts` |
| Page and preview UI | `src/app/(app)/settings/import-export/page.tsx`, `src/components/settings/catalog-import-panel.tsx` |
| Audit table | `CatalogImport` (migration `z33_catalog_import`) |
| Tests (pure, no DB) | `tests/catalog-export.test.ts`, `tests/catalog-xlsx-{parse,diff,apply-plan}.test.ts` |

Everything under `src/lib/catalog-xlsx/` is pure -- no Prisma, no Next -- and carries the
tests; the actions are a thin shell around it.

## Sheets

| Sheet | One row per | Columns |
|---|---|---|
| `README` | -- | The rules below plus the generation timestamp. Ignored on import. |
| `Products` | product | `id`, `series`, `code`, `name`, `description`, `kind`, `form`, `specs`, `contentBlockKey`, `isCredit`, `noCommission`, `active`, `sortOrder`, `imageUrl` |
| `Options` | option | `id`, `code`, `name`, `shortDescription`, `role`, `parentProduct`, `unitLengthM`, `compatSeries`, `compatProducts`, `contentBlockKey`, `noCommission`, `active`, `sortOrder`, `imageUrl`, `attributeSchema` |
| `Prices` | item x region | `itemType` (product\|option), `itemId`, `code`, `region`, `currency`, `amount`, `needsReview` |

Products are ordered by series `sortOrder`, then product `sortOrder`, then code; options by
code; prices by item type, code, region. `series`, `parentProduct`, `compatSeries`,
`compatProducts` and `region` are codes, not ids. Lists are `; `-separated; `specs` and
`attributeSchema` are compact JSON. Booleans are TRUE/FALSE, amounts are numbers, a missing
value is a blank cell. The header row has column widths and an autofilter; freeze panes and
bold are not written by the community SheetJS build.

## Editing rules (owner decisions, 2026-09-05 / 2026-09-06)

- `id` is the database key and must never be edited -- the import matches rows by it.
  **Leave `id` blank to create a new row.**
- `code` may be edited freely; it is a label, and renaming it is simply an update of the row
  (no history of old codes is kept -- migration `z32_drop_legacy_codes`). References in other
  cells (`parentProduct`, `compatProducts`) must use the code as it stands in the file.
- **A row deleted from the file is deleted from the catalogue on import, after confirmation.**
  Finalized quotes keep their snapshots and are not touched; draft quotes lose the line and are
  recalculated. The preview shows, per deleted row, how many drafts lose a line and how many
  finalized quotes reference it.
- Regions and series are referenced, not defined: a `Prices` row must use an existing region
  code, a product an existing series code.
- Columns may be reordered; an unknown or missing header is an error. Blank rows are ignored.
- On the `Prices` sheet, `itemId` identifies the item; for an item that is new in the same
  file leave `itemId` blank and put its code in `code`. `currency` is informational.
- Blank cells: `kind` -> ACCESSORY, `active` -> TRUE, other booleans -> FALSE, `sortOrder` -> 0,
  everything else -> cleared (null).
- `imageUrl` must be an uploaded image URL (`/api/files/<id>.<ext>`) or blank.

## Import flow

1. **Preview** (`previewCatalogImport`): the file (<= 5 MB, `.xlsx`) is parsed with the
   defensive SheetJS options, validated against the live catalogue, and diffed. Every problem is
   a `{ sheet, row, column, message }` entry; with any problem there is no Apply button. The
   preview lists per sheet the `unchanged / updated / created / deleted` counts, every field-level
   change (`code` + field: before -> after), every new row, and every deleted row with its
   draft / finalized quote counts. Nothing is written or recorded.
2. **Confirm**: the browser sends the raw sheet cells back with the previewed counts. Inside one
   interactive transaction the server re-reads the catalogue, re-parses, re-diffs and compares
   counts -- a catalogue edited in between aborts the import ("upload again"). Then the apply
   plan runs: detach DRAFT references + delete (options, then products) -> release renamed codes
   -> products create/update -> options create/update -> compat replace -> prices; every draft
   that lost a line is recalculated (`recalcDocument`); an APPLIED `CatalogImport` row with the
   full diff is written in the same transaction. Any failure rolls everything back and writes a
   FAILED row with the error.
3. The catalogue pages, the affected documents and the settings page are revalidated; the page
   shows a result banner and the last ten imports.

Deletes run first (rather than last) so a row deleted and re-added without its id does not
collide on the unique `code`; renamed codes are parked on a temporary value first so chains and
swaps of codes cannot collide either.
