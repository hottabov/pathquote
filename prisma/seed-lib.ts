/**
 * Pure mapping layer for the DB seed: catalog.json -> flat upsert payloads.
 *
 * No IO and no Prisma client here on purpose — everything in this file is a
 * plain function of its inputs, so it can be unit tested without a database
 * (see tests/seed-mapping.test.ts). prisma/seed.ts is the IO shell: it calls
 * these functions and turns the payloads into upserts.
 */

import type { OptionRole, ProductKind, ProductionForm } from "@prisma/client";
import type { ProductSpecs } from "../src/lib/validation/product-specs";

export interface CatalogItem {
  /** The seed's natural key: prisma/seed.ts upserts the row by it. In the
   * database a code is only a label (the row's identity is its id, see
   * Product.code in schema.prisma), but from outside the app it is the one
   * handle there is -- so renaming a code here and re-seeding creates a new
   * row rather than renaming the old one. */
  code: string;
  name: string;
  description: string;
  price: number | null;
  needsReview: boolean;
  /** `Product.noCommission` / `Option.noCommission`; absent = false. */
  noCommission?: boolean;
  /** `Product.isCredit` (see that column's doc comment in schema.prisma) —
   * only meaningful for a product entry (an `Option` has no such column);
   * absent/`undefined` on every entry except the TRADE-IN product means
   * `mapProducts` below defaults it to `false`, so nothing about any
   * existing catalog.json entry needs to change for this field to exist.
   * PROVISIONAL WORDING: the TRADE-IN entry's own `description` is
   * transcribed from a meeting, not the agreed legal redaction — the
   * director reviews it at export (docs/reference/catalog-import-export.md). */
  isCredit?: boolean;
  /** Product identity (Product.kind/form/specs). Written by
   * scripts/build-seed-data-from-target.ts from the target file. `kind` is
   * required on a product entry -- the seed refuses an entry without one
   * (see `resolveProductIdentity`); it is optional in the type only because
   * an option entry shares this shape. */
  kind?: ProductKind;
  form?: ProductionForm | null;
  specs?: ProductSpecs | null;
  /** `Product.contentBlockKey` / `Option.contentBlockKey`: the quotation
   * content block (prisma/seed-data/content-blocks.json key) that describes
   * this row, or null for none. Absent = null. */
  contentBlockKey?: string | null;
}

export interface CatalogSeries {
  seriesCode: string;
  seriesName: string;
  maxDiscountPct: number | null;
  products: CatalogItem[];
}

export interface CatalogOption extends CatalogItem {
  compatibleSeries: string[];
  /** Present (non-empty) only for options scoped to specific products
   *  (e.g. an EasyLoader accessory tied to one drive-module product) rather
   *  than a whole series -- in that case compatibleSeries is `[]`. */
  compatibleProducts?: string[];
  /** Option identity (Option.role/parentProductId/unitLengthM). The `role`
   * key must be present (null is a valid value: an option with no box on
   * any form) -- the seed refuses an entry without it (see
   * `resolveOptionIdentity`). */
  role?: OptionRole | null;
  /** Code of the product this option belongs to (EasyLoader modules). */
  parentProductCode?: string | null;
  unitLengthM?: number | null;
}

export interface Catalog {
  extractedAt: string;
  series: CatalogSeries[];
  options: CatalogOption[];
}

export interface RegionSeed {
  code: string;
  name: string;
  currency: string;
  taxName: string;
  taxRate: number;
  entityName: string;
  entityLegalId?: string;
  entityAddress?: string;
  bankDetails?: Record<string, string>;
  /** Region-level discount cap (owner: "USA 15%, Australia 10; don't
   * surface in the catalog") -- `null` means no cap. See
   * Region.maxDiscountPct in schema.prisma and its enforcement in
   * setItemDiscount/setDocumentDiscount (src/lib/actions/documents.ts). */
  maxDiscountPct: number | null;
}

/**
 * The three regions PathQuote operates in. AU carries the real Pathfinder
 * Australia entity + bank details; US and UK are placeholders until real
 * entity data for those regions is supplied.
 */
export const REGIONS: RegionSeed[] = [
  {
    code: "AU",
    name: "Australia",
    currency: "AUD",
    taxName: "GST",
    taxRate: 10.0,
    entityName: "Pathfinder Australia Pty Ltd",
    entityLegalId: "ABN 64 072 458 667",
    entityAddress:
      "12 Dib Court\nTullamarine, VIC 3043, Australia\nPh: +61 3 9338 3471\nEmail: sales@pathfindercut.com\nWeb: pathfindercut.com",
    bankDetails: {
      bank: "ANZ Westfield",
      accountName: "Pathfinder Australia Pty Ltd",
      swift: "ANZBAU3M",
      bsb: "013 442",
      accountNo: "4405 63886",
    },
    maxDiscountPct: 10,
  },
  {
    code: "US",
    name: "United States",
    currency: "USD",
    taxName: "Sales Tax",
    taxRate: 0,
    entityName: "Pathfinder Cutting Technology LLC",
    entityAddress:
      "5623–5625 W74th Street\nIndianapolis, IN, 46278, USA\nTel: +1 (317) 349 0002\nEmail: salesusa@pathfindercut.com\nWeb: pathfindercut.com",
    maxDiscountPct: 15,
  },
  {
    code: "UK",
    name: "United Kingdom",
    currency: "GBP",
    taxName: "VAT",
    taxRate: 20,
    entityName: "Pathfinder Cutting Technology UK LTD",
    entityAddress:
      "Unit 5 Maricott Court, Holywell Business Park,\nKineton Road Industrial Estate, Southam,\nWarwickshire, CV47 0FT, United Kingdom\nTel: +44 (0) 7572 949248\nEmail: salesuk@pathfindercut.com\nWeb: pathfindercut.com",
    maxDiscountPct: null,
  },
];

export interface SeriesPayload {
  code: string;
  name: string;
  maxDiscountPct: number | null;
  sortOrder: number;
}

export function mapSeries(catalog: Catalog): SeriesPayload[] {
  return catalog.series.map((s, i) => ({
    code: s.seriesCode,
    name: s.seriesName,
    maxDiscountPct: s.maxDiscountPct,
    sortOrder: i,
  }));
}

export interface ProductPayload {
  code: string;
  name: string;
  description: string | null;
  seriesCode: string;
  sortOrder: number;
  /** See `CatalogItem.isCredit`'s doc comment — defaults to `false` when the
   * catalog entry doesn't set it. */
  isCredit: boolean;
  noCommission: boolean;
  kind: ProductKind;
  form: ProductionForm | null;
  /** `null` = no specs (the column stays NULL). */
  specs: ProductSpecs | null;
  contentBlockKey: string | null;
}

/**
 * Product identity for a catalog entry: its explicit `kind`/`form`/`specs`/
 * `contentBlockKey`. The file is the only source -- an entry without a
 * `kind` is a broken file, not a row to guess at, so this throws naming the
 * code. Pure, so a fresh seed and the tests agree.
 */
export function resolveProductIdentity(
  p: CatalogItem,
  seriesCode: string
): { kind: ProductKind; form: ProductionForm | null; specs: ProductSpecs | null; contentBlockKey: string | null } {
  if (!p.kind) {
    throw new Error(`seed: product ${p.code} (series ${seriesCode}) has no kind in catalog.json`);
  }
  return {
    kind: p.kind,
    form: p.form ?? null,
    specs: p.specs && Object.keys(p.specs).length ? p.specs : null,
    contentBlockKey: p.contentBlockKey ?? null,
  };
}

export function mapProducts(catalog: Catalog): ProductPayload[] {
  const out: ProductPayload[] = [];
  for (const series of catalog.series) {
    series.products.forEach((p, i) => {
      out.push({
        code: p.code,
        name: p.name,
        description: p.description ?? null,
        seriesCode: series.seriesCode,
        sortOrder: i,
        isCredit: p.isCredit ?? false,
        noCommission: p.noCommission ?? false,
        ...resolveProductIdentity(p, series.seriesCode),
      });
    });
  }
  return out;
}

export interface OptionPayload {
  code: string;
  name: string;
  shortDescription: string | null;
  sortOrder: number;
  noCommission: boolean;
  role: OptionRole | null;
  /** Product code (current, as in catalog.json) -- resolved to an id by the seed. */
  parentProductCode: string | null;
  unitLengthM: number | null;
  contentBlockKey: string | null;
}

/**
 * Option identity for a catalog entry: its explicit `role`/
 * `parentProductCode`/`unitLengthM`/`contentBlockKey`. Same rule as
 * `resolveProductIdentity`, keyed on the presence of the `role` key (null
 * is a valid role; a missing key is a broken file and throws).
 */
export function resolveOptionIdentity(o: CatalogOption): {
  role: OptionRole | null;
  parentProductCode: string | null;
  unitLengthM: number | null;
  contentBlockKey: string | null;
} {
  if (!("role" in o)) throw new Error(`seed: option ${o.code} has no role key in catalog.json`);
  return {
    role: o.role ?? null,
    parentProductCode: o.parentProductCode ?? null,
    unitLengthM: o.unitLengthM ?? null,
    contentBlockKey: o.contentBlockKey ?? null,
  };
}

export function mapOptions(catalog: Catalog): OptionPayload[] {
  return catalog.options.map((o, i) => ({
    code: o.code,
    name: o.name,
    shortDescription: o.description ?? null,
    sortOrder: i,
    noCommission: o.noCommission ?? false,
    ...resolveOptionIdentity(o),
  }));
}

export type PriceTargetKind = "product" | "option";

export interface PricePayload {
  kind: PriceTargetKind;
  code: string;
  regionCode: string;
  amount: number;
  needsReview: boolean;
}

/**
 * One Price row per product and per option, all against `regionCode`
 * (AU-only for now — the other regions have no pricing data yet). Items
 * with a null price in the catalog get amount 0 with needsReview forced
 * true, so admins see them flagged as "price required" rather than a
 * silent $0. Items with a real price (including a genuine 0) keep the
 * catalog's own needsReview flag as-is.
 */
export function mapPrices(catalog: Catalog, regionCode = "AU"): PricePayload[] {
  const out: PricePayload[] = [];
  for (const series of catalog.series) {
    for (const p of series.products) {
      out.push({
        kind: "product",
        code: p.code,
        regionCode,
        amount: p.price ?? 0,
        needsReview: p.price === null ? true : p.needsReview,
      });
    }
  }
  for (const o of catalog.options) {
    out.push({
      kind: "option",
      code: o.code,
      regionCode,
      amount: o.price ?? 0,
      needsReview: o.price === null ? true : o.needsReview,
    });
  }
  return out;
}

/**
 * One row per (option, compatible series) OR (option, compatible product)
 * pair. Exactly one of `seriesCode` / `productCode` is set per entry — the
 * DB mirrors this with OptionCompatibility.seriesId/productId, one of which
 * is always null (see the two partial-unique indexes in schema.prisma).
 */
export type CompatPayload =
  | { optionCode: string; seriesCode: string; productCode?: undefined }
  | { optionCode: string; seriesCode?: undefined; productCode: string };

/** One row per (option, compatible series) pair and one row per (option,
 *  compatible product) pair. Most options are series-level (productCode
 *  entries stay empty for them); a few (e.g. EasyLoader accessories) are
 *  scoped to one or more specific products instead, via compatibleProducts. */
export function mapCompatibility(catalog: Catalog): CompatPayload[] {
  const out: CompatPayload[] = [];
  for (const o of catalog.options) {
    for (const seriesCode of o.compatibleSeries) {
      out.push({ optionCode: o.code, seriesCode });
    }
    for (const productCode of o.compatibleProducts ?? []) {
      out.push({ optionCode: o.code, productCode });
    }
  }
  return out;
}

// --- US region prices (prisma/seed-data/prices-us.json) -----------------

/** Shape of prisma/seed-data/prices-us.json, written by
 *  scripts/build-seed-data-from-target.ts from the US figures in
 *  docs/reference/catalog-v2-target.json. `unmatched` isn't consumed here
 *  -- it is a leftover of the spreadsheet extractor that used to write the
 *  file (rows with no catalog code to attach to) and is always `[]` now;
 *  kept so the file's shape is stable. */
export interface UsPricesJson {
  extractedAt: string;
  prices: { code: string; amountUsd: number }[];
  unmatched: { sheet: string; label: string; price: number }[];
}

export interface UsPricesMapping {
  /** One Price payload per prices-us.json entry whose code matched a real
   *  catalog product or option, always against region "US" with
   *  needsReview: false -- unlike AU's price:null convention, the US price
   *  list is a real, published, authoritative retail price for the codes it
   *  covers, so there's no "amount 0, flagged for review" case here. */
  payloads: PricePayload[];
  /** prices-us.json codes that don't exist in the given catalog at all --
   *  should be empty in practice (both files are written together from the
   *  same target by scripts/build-seed-data-from-target.ts), but the
   *  catalog and the price file can drift apart if one is edited without
   *  the other, so this is surfaced rather than silently dropped. */
  unknownCodes: string[];
}

/**
 * Resolves each prices-us.json entry's code against the catalog's products
 * and options (a code is exactly one or the other, never both -- product
 * and option codes are drawn from disjoint namespaces) to produce US Price
 * payloads. Pure function of its inputs, like every other mapper in this
 * file -- prisma/seed.ts is the only place that turns `payloads` into
 * upserts and reports `unknownCodes`.
 */
export function mapUsPrices(catalog: Catalog, usPrices: UsPricesJson): UsPricesMapping {
  const productCodes = new Set(catalog.series.flatMap((s) => s.products.map((p) => p.code)));
  const optionCodes = new Set(catalog.options.map((o) => o.code));

  const payloads: PricePayload[] = [];
  const unknownCodes: string[] = [];

  for (const { code, amountUsd } of usPrices.prices) {
    if (productCodes.has(code)) {
      payloads.push({ kind: "product", code, regionCode: "US", amount: amountUsd, needsReview: false });
    } else if (optionCodes.has(code)) {
      payloads.push({ kind: "option", code, regionCode: "US", amount: amountUsd, needsReview: false });
    } else {
      unknownCodes.push(code);
    }
  }

  return { payloads, unknownCodes };
}

/** Every product/option code in the catalog that prices-us.json's matched
 *  entries don't cover -- i.e. it simply has no US price yet. Purely
 *  informational, used by prisma/seed.ts to log a warning per missing code
 *  rather than leave the gap silent. */
export function missingUsPriceCodes(catalog: Catalog, usPrices: UsPricesJson): string[] {
  const pricedCodes = new Set(usPrices.prices.map((p) => p.code));
  const allCodes = [
    ...catalog.series.flatMap((s) => s.products.map((p) => p.code)),
    ...catalog.options.map((o) => o.code),
  ];
  return allCodes.filter((code) => !pricedCodes.has(code)).sort((a, b) => a.localeCompare(b, "en"));
}

// --- content blocks ------------------------------------------------------

/** One entry of prisma/seed-data/content-blocks.json's `blocks` array. */
export interface ContentBlockJsonItem {
  key: string;
  title: string;
  sortOrder: number;
  body: string;
}

/** Shape of prisma/seed-data/content-blocks.json. `placeholders` maps a
 * `{{token}}` name (as it appears in one or more block bodies) to a
 * human-readable description — consumed directly by the admin editor's
 * placeholder hint panel, not by this mapper. */
export interface ContentBlocksJson {
  blocks: ContentBlockJsonItem[];
  placeholders: Record<string, string>;
}

export interface ContentBlockPayload {
  key: string;
  title: string;
  body: string;
  sortOrder: number;
}

/**
 * Pure passthrough mapping from content-blocks.json's `blocks` array to the
 * flat payload prisma/seed.ts writes as each key's regionId:null default row.
 * No validation here (that's the admin editor's zod schema's job for
 * *edits*) — this just shapes the seed data 1:1, kept as its own function so
 * it's unit-testable and so the IO shell (prisma/seed.ts) never touches the
 * JSON's field names directly.
 */
export function mapContentBlocks(json: ContentBlocksJson): ContentBlockPayload[] {
  return json.blocks.map((b) => ({
    key: b.key,
    title: b.title,
    body: b.body,
    sortOrder: b.sortOrder,
  }));
}

// --- targeted content-block body migrations -------------------------------

/**
 * Content-block keys with a targeted, exact-match body migration for
 * existing DBs — distinct from the seed's normal "never touch an existing
 * row" rule for content blocks (see prisma/seed.ts's content-blocks step): a
 * key listed here gets its title+body force-updated by prisma/seed.ts's
 * migration step, but only when the existing row's body is byte-for-byte
 * `oldBody` (see `shouldMigrateBlock`) — i.e. still exactly what an older
 * version of the seed itself put there, never touched by an admin. Add a new
 * entry here (and nowhere else — prisma/seed.ts's migration loop iterates
 * this map generically) whenever a future seed-data body/title edit needs
 * the same safe, targeted forward-fix treatment.
 *
 * Empty today. Its one past entry, "machine.m-series" (with a hardcoded
 * `oldBody` capturing the pre-315e089 duplicate-heading body), was removed
 * by the category-quote-copy migration (docs/superpowers/plans/
 * 2026-09-07-category-quote-copy.md, Task 10): that key no longer exists in
 * content-blocks.json at all — scripts/migrate-content-blocks-to-series.ts
 * copies its live body onto Series.quoteDescription and deletes the
 * ContentBlock row outright, so there is no longer a row for this step to
 * force-update. Left in place, typed and exported, so the next targeted body
 * fix has somewhere to go without touching prisma/seed.ts's generic loop.
 */
export const BLOCK_BODY_MIGRATIONS: Record<string, { oldBody: string }> = {};

/**
 * True when `existingBody` (a `ContentBlock` row's current body, read from
 * the DB) is exactly `oldBody` (a migration's hardcoded pre-change string,
 * see `BLOCK_BODY_MIGRATIONS`) — i.e. safe to force-update to the new
 * seed-data title/body without clobbering an admin's own edit. Any
 * difference at all (an admin edit, or a row already migrated to the new
 * body) means this returns false and the row must be left alone.
 */
export function shouldMigrateBlock(existingBody: string, oldBody: string): boolean {
  return existingBody === oldBody;
}

// --- retired content-block keys (category-quote-copy migration) -----------

/**
 * Key prefixes `scripts/migrate-content-blocks-to-series.ts` (Task 10 of
 * docs/superpowers/plans/2026-09-07-category-quote-copy.md) deletes from
 * `ContentBlock` outright: the three it migrates onto `Series.quoteDescription`
 * (`machine.m-series`, `equipment.easy-loader`, `equipment.fabric-pro`) and
 * every orphan/option/software block that maps to nothing
 * (`equipment.fabric-master`, `equipment.spreading-table`, `option.*`,
 * `software.*`). `Product.contentBlockKey` / `Option.contentBlockKey`
 * (catalog.json) still name these keys — dropping those two columns is
 * Task 11, deliberately deferred until this migration has actually run
 * against a database — so every product/option row naming a retired key is
 * an *expected* dangling reference from here until Task 11 lands, not a typo
 * in catalog.json. See `isRetiredContentBlockKey`.
 */
export const RETIRED_CONTENT_BLOCK_KEY_PREFIXES = ["machine.", "equipment.", "software.", "option."] as const;

/** True when `key` falls under one of `RETIRED_CONTENT_BLOCK_KEY_PREFIXES` —
 * i.e. a `Product`/`Option.contentBlockKey` naming it is known, deliberate
 * fallout of the category-quote-copy migration rather than a mistake. Used by
 * prisma/seed.ts's dangling-content-block-key check to keep that warning
 * meaningful for an actual typo in catalog.json. */
export function isRetiredContentBlockKey(key: string): boolean {
  return RETIRED_CONTENT_BLOCK_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}
