/**
 * The column contract the catalogue workbook is written with and read back
 * by -- one place, so export (./export.ts) and import (./parse.ts) can never
 * disagree about a header. Everything here is plain data: no Prisma, no
 * SheetJS, no Next, so the whole catalog-xlsx directory stays importable from
 * a unit test.
 *
 * Every data sheet leads with the row's database `id`: that is the join key
 * the import matches on (a blank id means "create this row"), and it is
 * deliberately visible rather than hidden -- a hidden column that silently
 * controls destructive behaviour is worse than a visible one nobody edits.
 * The README sheet is written for the reader and ignored on import.
 */

export const SHEET_NAMES = {
  readme: "README",
  products: "Products",
  options: "Options",
  prices: "Prices",
} as const;

export const PRODUCT_COLUMNS = [
  "id",
  "series",
  "code",
  "name",
  "description",
  "kind",
  "form",
  "specs",
  "isCredit",
  "noCommission",
  "active",
  "sortOrder",
  "imageUrl",
] as const;

export const OPTION_COLUMNS = [
  "id",
  "code",
  "name",
  "shortDescription",
  "role",
  "parentProduct",
  "unitLengthM",
  "compatSeries",
  "compatProducts",
  "noCommission",
  "active",
  "sortOrder",
  "imageUrl",
  "attributeSchema",
] as const;

/**
 * A price row is one item x region. `itemId` is the product/option id; it is
 * blank when the item itself is new in this file, in which case `code`
 * identifies it (against the file's own Products/Options sheet). `currency`
 * is informational -- it is the region's currency and is not read back.
 */
export const PRICE_COLUMNS = [
  "itemType",
  "itemId",
  "code",
  "region",
  "currency",
  "amount",
  "needsReview",
] as const;

/**
 * Headers a workbook may still carry that the contract above no longer knows,
 * and that the import must ignore rather than reject.
 *
 * `readHeader` treats an unrecognised header as an error, on purpose -- it is
 * almost always a typo that would otherwise drop a whole column of edits on
 * the floor. But a column that used to be part of the contract is not a typo:
 * an export somebody took last week, and is halfway through editing on their
 * desktop right now, carries `contentBlockKey` on both data sheets because
 * this file listed it then. Failing their upload with `Unknown column
 * "contentBlockKey"` would cost them the whole file's worth of work for a
 * column whose values nothing reads any more.
 *
 * So these are matched BY NAME, silently skipped, and never written back --
 * re-exporting produces the current contract, and the stale column disappears
 * from that copy of the workbook the first time it is round-tripped.
 *
 * `contentBlockKey` (Product and Option): dropped with the ContentBlock table
 * itself in migration z37_drop_content_block. Category copy lives on the
 * category (`Series.quoteDescription`) and legal text in `QuoteDocument`, so
 * the column named a row in a table that no longer exists.
 *
 * Entries here are permanent-ish, not a migration step: keep one until it is
 * safe to assume nobody holds a workbook that old.
 */
export const RETIRED_COLUMNS = ["contentBlockKey"] as const;

export type ProductColumn = (typeof PRODUCT_COLUMNS)[number];
export type OptionColumn = (typeof OPTION_COLUMNS)[number];
export type PriceColumn = (typeof PRICE_COLUMNS)[number];

/** Separator for list cells (compatSeries, compatProducts). */
export const LIST_SEPARATOR = "; ";

/** A cell value. `null` is a blank cell (SheetJS skips nulls on write). */
export type Cell = string | number | boolean | null;

/**
 * Enum value lists, hardcoded rather than imported from `@prisma/client`:
 * the generated client's runtime enum objects pull the whole client (and its
 * engine) into a module that must stay pure. tests/catalog-xlsx-parse.test.ts
 * asserts each list equals the enum block in prisma/schema.prisma, so a new
 * value added there fails a test here instead of being silently rejected on
 * import.
 */
export const PRODUCT_KINDS = [
  "MACHINE",
  "TABLE",
  "FEEDER",
  "SPREADER",
  "SOFTWARE",
  "SYSTEM",
  "SERVICE",
  "CREDIT",
  "ACCESSORY",
] as const;

export const PRODUCTION_FORMS = ["M_SERIES", "EASYLOADER", "FABRICPRO"] as const;

export const OPTION_ROLES = [
  "ABR",
  "AFP",
  "APM",
  "BCR",
  "BED",
  "CRATE",
  "DMT",
  "DR2",
  "DRG_1",
  "DRG_2",
  "DRG_3",
  "EDS",
  "EXH",
  "HDC",
  "HFV",
  "IJP",
  "IKA",
  "IKP",
  "MRK",
  "MTS",
  "MTS_TRAVEL",
  "OFD",
  "OFJ",
  "OFP",
  "PM",
  "PRM",
  "TRANSFORMER",
  "VRB",
  "WASTE_BIN",
  "JTP",
  "L_EXTENDED",
  "L_TOOL",
  "EL_DRIVE",
  "EL_CONVEYOR",
  "EL_STATIC",
  "EL_BUSBAR",
  "EL_RAIL",
  "EL_ROLL_FEED",
  "EL_ROLL_HOLDER",
  "EL_SYNC",
  "TPL",
  "INSTALL",
  "TRAINING",
  "SOFTWARE",
  "CONSUMABLE",
] as const;

export type ProductKindValue = (typeof PRODUCT_KINDS)[number];
export type ProductionFormValue = (typeof PRODUCTION_FORMS)[number];
export type OptionRoleValue = (typeof OPTION_ROLES)[number];

export const ITEM_TYPES = ["product", "option"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** Upload limit for an import file. The real catalogue is a few hundred rows
 * (well under 1 MB); the cap bounds what the SheetJS parser is ever handed. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
