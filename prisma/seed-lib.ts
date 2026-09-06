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
import { legacyOptionIdentity, legacyProductIdentity } from "../src/lib/catalog-identity";

export interface CatalogItem {
  code: string;
  name: string;
  description: string;
  price: number | null;
  needsReview: boolean;
  /** Codes this row had before catalogue v2 renamed it (see Product/
   * Option.legacyCodes in schema.prisma). The seed matches an existing row
   * by its current code OR any of these, so a database seeded under the old
   * code is renamed in place rather than duplicated. Absent = none. */
  legacyCodes?: string[];
  /** `Product.noCommission` / `Option.noCommission`; absent = false. */
  noCommission?: boolean;
  /** `Product.isCredit` (see that column's doc comment in schema.prisma) —
   * only meaningful for a product entry (an `Option` has no such column);
   * absent/`undefined` on every entry except the TRADE-IN product means
   * `mapProducts` below defaults it to `false`, so nothing about any
   * existing catalog.json entry needs to change for this field to exist.
   * PROVISIONAL WORDING: the TRADE-IN entry's own `description` is
   * transcribed from a meeting, not the agreed legal redaction — see the
   * fuller note on it in scripts/extract-catalog.ts's `MANUAL_PRODUCTS.SVC`. */
  isCredit?: boolean;
  /** Product identity (Product.kind/form/specs). Written by
   * scripts/build-seed-data-from-target.ts from the target file. When an
   * entry has no `kind` the seed falls back to the legacy code rules
   * (src/lib/catalog-identity.ts) applied to `legacyCodes[0] ?? code`. */
  kind?: ProductKind;
  form?: ProductionForm | null;
  specs?: ProductSpecs | null;
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
  /** Option identity (Option.role/parentProductId/unitLengthM). Same
   * fallback rule as the product fields: an entry with no `role` key is
   * classified by the legacy code rules. */
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
  legacyCodes: string[];
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
}

/** The code the legacy rules understand: the one the row had before v2. */
function legacyCodeOf(item: { code: string; legacyCodes?: string[] }): string {
  return item.legacyCodes?.[0] ?? item.code;
}

/**
 * Product identity for a catalog entry: the entry's own `kind`/`form`/
 * `specs` when it carries a `kind`, otherwise what the legacy code rules
 * say about its pre-v2 code. Pure, so a fresh seed and the tests agree.
 */
export function resolveProductIdentity(
  p: CatalogItem,
  seriesCode: string
): { kind: ProductKind; form: ProductionForm | null; specs: ProductSpecs | null } {
  if (p.kind) {
    return { kind: p.kind, form: p.form ?? null, specs: p.specs && Object.keys(p.specs).length ? p.specs : null };
  }
  const legacy = legacyProductIdentity(seriesCode, legacyCodeOf(p), p.isCredit ?? false);
  return { kind: legacy.kind, form: legacy.form, specs: Object.keys(legacy.specs).length ? legacy.specs : null };
}

export function mapProducts(catalog: Catalog): ProductPayload[] {
  const out: ProductPayload[] = [];
  for (const series of catalog.series) {
    series.products.forEach((p, i) => {
      out.push({
        code: p.code,
        legacyCodes: p.legacyCodes ?? [],
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
  legacyCodes: string[];
  name: string;
  shortDescription: string | null;
  sortOrder: number;
  noCommission: boolean;
  role: OptionRole | null;
  /** Product code (current, as in catalog.json) -- resolved to an id by the seed. */
  parentProductCode: string | null;
  unitLengthM: number | null;
}

/** Same rule as resolveProductIdentity, keyed on the presence of `role`. */
export function resolveOptionIdentity(o: CatalogOption): {
  role: OptionRole | null;
  parentProductCode: string | null;
  unitLengthM: number | null;
} {
  if ("role" in o) {
    return { role: o.role ?? null, parentProductCode: o.parentProductCode ?? null, unitLengthM: o.unitLengthM ?? null };
  }
  const legacy = legacyOptionIdentity(legacyCodeOf(o));
  return { role: legacy.role, parentProductCode: legacy.parentProductCode, unitLengthM: legacy.unitLengthM };
}

export function mapOptions(catalog: Catalog): OptionPayload[] {
  return catalog.options.map((o, i) => ({
    code: o.code,
    legacyCodes: o.legacyCodes ?? [],
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
 *  scripts/extract-us-prices.ts. `unmatched` isn't consumed here -- it's
 *  purely informational (services, per-width crate rows, etc. with no
 *  catalog code to attach to) and stays in the JSON file for the report. */
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
   *  should be empty in practice (scripts/extract-us-prices.ts already
   *  validates every code it writes against the catalog it was run
   *  against), but the catalog and the price file can drift apart if one is
   *  regenerated without the other, so this is surfaced rather than
   *  silently dropped. */
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
 *  informational (mirrors scripts/extract-us-prices.ts's own "catalog codes
 *  with no US price" summary line), used by prisma/seed.ts to log a warning
 *  per missing code rather than leave the gap silent. */
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
 * Exact body of the "machine.m-series" content block as seeded before commit
 * 315e089 ("fix: quotation renders heading and all options for every item
 * section"), which removed a duplicate inline "## Pathfinder {{model}}
 * Cutting System" heading from the body — the quotation renderer already
 * prints its own heading from the block's `title`, so the old body produced
 * a duplicate heading on the rendered quotation. Captured verbatim via
 * `git show 8d4c4de:prisma/seed-data/content-blocks.json` (the commit
 * immediately before 315e089). prisma/seed.ts's normal content-block seeding
 * never overwrites an existing row (an admin's own edits always win), so any
 * DB seeded before 315e089 is stuck showing the duplicate heading forever
 * without this targeted migration.
 */
export const M_SERIES_OLD_BODY =
  "## Pathfinder {{model}} Cutting System\n\nModel {{model}} conveyorised computer controlled cutting system. Maximum compressed cutting height {{cutHeightCm}}cm. Maximum cutting width {{cutWidthCm}}cm.\n\n- Conveyorised precision cutting table\n- High efficiency vacuum generator\n- Vacuum VSD (Variable Speed Device) - computer controlled vacuum level for optimising cut quality and reducing power consumption.\n- VRB (Vacuum Recovery Blind) - computer controlled blind that reduces vacuum loss and power consumption.\n- Unloading conveyor\n- Roll holder (used for plastic overlay)\n- Operator console with utility drawer\n- Touch screen with wireless keyboard and mouse\n\n### Software\n\n- Windows 10™ operating system\n- PathCut™ cutting software V12.x (graphic user interface)\n\n### Accessories\n\n- Operator manual\n- Operator tool kit\n- 1 roll plastic overlay\n- 1 roll perforated paper\n- 10 knives\n- 1 diamond sharpening stone\n\n**Price: {{price}}**";

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
 */
export const BLOCK_BODY_MIGRATIONS: Record<string, { oldBody: string }> = {
  "machine.m-series": { oldBody: M_SERIES_OLD_BODY },
};

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
