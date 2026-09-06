# Catalogue export (xlsx)

Read-only dump of the live catalogue into a workbook the director can review in Excel.
Phase 5 of `docs/plans/2026-09-05-catalog-identity-and-cleanup.md`; it is also the export
half of `docs/plans/2026-09-05-catalog-import-export.md`, where the import half is tracked.

## Run

```
npm run catalog:export                          # -> RAW/catalog-export-<YYYY-MM-DD>.xlsx
npm run catalog:export -- --out RAW/review.xlsx # explicit path
```

Needs `DATABASE_URL` (via `.env`). Writes nothing to the database.
Code: `scripts/export-catalog.ts` (DB -> snapshot -> file) and `scripts/lib/catalog-export.ts`
(pure snapshot -> workbook builder, tested in `tests/catalog-export.test.ts` without a DB).

## Sheets

| Sheet | One row per | Columns |
|---|---|---|
| `README` | -- | The rules below plus the generation timestamp. |
| `Products` | product | `id`, `series`, `code`, `legacyCodes`, `name`, `description`, `kind`, `form`, `specs`, `contentBlockKey`, `isCredit`, `noCommission`, `active`, `sortOrder`, `imageUrl` |
| `Options` | option | `id`, `code`, `legacyCodes`, `name`, `shortDescription`, `role`, `parentProduct`, `unitLengthM`, `compatSeries`, `compatProducts`, `contentBlockKey`, `noCommission`, `active`, `sortOrder`, `imageUrl`, `attributeSchema` |
| `Prices` | item x region | `itemType` (product\|option), `itemId`, `code`, `region`, `currency`, `amount`, `needsReview` |

Products are ordered by series `sortOrder`, then product `sortOrder`, then code; options by
code; prices by item type, code, region. `series`, `parentProduct`, `compatSeries`,
`compatProducts` and `region` are codes, not ids. Lists are `; `-separated; `specs` and
`attributeSchema` are compact JSON. Booleans are TRUE/FALSE, amounts are numbers, a missing
value is a blank cell. The header row has column widths and an autofilter; freeze panes and
bold are not written by the community SheetJS build.

## Editing rules (owner decisions, 2026-09-05)

- `id` is the database key and must never be edited -- the import matches rows by it.
- `code` may be edited freely; the previous value is kept in `legacyCodes` automatically.
- A row deleted from the file is deleted from the catalogue on import, after confirmation.
  Finalized quotes keep their snapshots; draft quotes lose the line.
- Regions are referenced, not defined: a `Prices` row must use an existing region code.
