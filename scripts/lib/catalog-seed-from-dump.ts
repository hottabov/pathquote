/**
 * Pure mapping: `RAW/catalog-dump.json` (a read-only snapshot of the live
 * catalogue, written by scripts/dump-catalog.ts) -> the two seed-data files
 * prisma/seed.ts reads. scripts/build-seed-data-from-dump.ts is the IO shell.
 *
 * This replaces the target-file route
 * (scripts/build-seed-data-from-target.ts, from
 * prisma/seed-data/catalog-v2-target.json) as the way the seed is refreshed.
 * That file was the plan for a one-off cleanup and stopped being the truth
 * the moment the cleanup landed and people carried on editing the catalogue
 * in the app: by 2026-09-11 it still listed twelve X-Calibre products and a
 * Punchline that had been deleted, and knew nothing of the Fabric Pro
 * Trolley series or `L-320EF`. The live database is the catalogue. The seed
 * should be a photograph of it, not of an old intention.
 *
 * What the dump cannot supply is carried over from the catalog.json already
 * in place: `maxDiscountPct`, which is a series column the dump does not
 * export.
 */

import type {
  Catalog,
  CatalogItem,
  CatalogOption,
  CatalogSeries,
  UsPricesJson,
} from "../../prisma/seed-lib";
import type { ProductKind, ProductionForm, OptionRole } from "@prisma/client";
import type { ProductSpecs } from "../../src/lib/validation/product-specs";

/** One region's price as the dump writes it -- the amount is a decimal string. */
type DumpPrice = { amount: string; needsReview: boolean };

export type DumpSeries = { code: string; name: string; sortOrder: number };

export type DumpProduct = {
  code: string;
  series: string;
  name: string;
  description: string | null;
  kind: ProductKind;
  form: ProductionForm | null;
  specs: ProductSpecs | null;
  active: boolean;
  isCredit: boolean;
  noCommission: boolean;
  prices: Record<string, DumpPrice>;
};

export type DumpOption = {
  code: string;
  name: string;
  shortDescription: string | null;
  role: OptionRole | null;
  parentProductCode: string | null;
  unitLengthM: number | null;
  active: boolean;
  noCommission: boolean;
  compatSeries: string[];
  compatProducts: string[];
  prices: Record<string, DumpPrice>;
};

export type CatalogDump = {
  dumpedAt: string;
  regions: { code: string; name: string }[];
  series: DumpSeries[];
  products: DumpProduct[];
  options: DumpOption[];
};

/** The one series field the dump does not carry. */
export type SeriesHeader = Pick<CatalogSeries, "seriesCode" | "seriesName" | "maxDiscountPct">;

/** The base region: `CatalogItem.price` is an AU amount by convention. */
const BASE_REGION = "AU";
const US_REGION = "US";

/**
 * A seed entry's base price. A row with no AU price at all becomes
 * `price: null`, which `mapPrices` seeds as amount 0 + `needsReview: true`
 * -- the same "nobody has priced this yet" state the catalogue is in. A row
 * that does have one is copied across exactly, flag included, so a
 * deliberate unflagged zero survives the round trip.
 */
function basePrice(prices: Record<string, DumpPrice>): Pick<CatalogItem, "price" | "needsReview"> {
  const price = prices[BASE_REGION];
  if (!price) return { price: null, needsReview: true };
  const amount = Number(price.amount);
  if (!Number.isFinite(amount)) return { price: null, needsReview: true };
  return { price: amount, needsReview: price.needsReview };
}

/** Drops keys whose value is `undefined`, keeping the JSON free of noise. */
function withOptional<T extends object>(entry: T, extras: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
  for (const [key, value] of Object.entries(extras)) if (value !== undefined) out[key] = value;
  return out as T;
}

export type SeedFromDump = {
  catalog: Catalog;
  usPrices: UsPricesJson;
  /** Rows left out because they are deactivated in the live catalogue. */
  skippedInactive: string[];
  /** Series in the dump that the catalog.json in place had no cap for. */
  seriesWithoutDiscountCap: string[];
};

export function buildSeedDataFromDump(dump: CatalogDump, seriesHeaders: SeriesHeader[]): SeedFromDump {
  const capByCode = new Map(seriesHeaders.map((header) => [header.seriesCode, header.maxDiscountPct]));
  const skippedInactive: string[] = [];
  const seriesWithoutDiscountCap: string[] = [];

  // An inactive row is one somebody turned off in the app. Seeding it would
  // turn it back on -- `mapProducts` has no `active` to carry -- so it is
  // left out and named, rather than quietly resurrected on the next seed.
  const activeProducts = dump.products.filter((product) => {
    if (product.active) return true;
    skippedInactive.push(product.code);
    return false;
  });
  const activeOptions = dump.options.filter((option) => {
    if (option.active) return true;
    skippedInactive.push(option.code);
    return false;
  });

  const productsBySeries = new Map<string, CatalogItem[]>();
  for (const product of activeProducts) {
    const entry = withOptional<CatalogItem>(
      {
        code: product.code,
        name: product.name,
        description: product.description ?? "",
        ...basePrice(product.prices),
        kind: product.kind,
        form: product.form,
        specs: product.specs,
      },
      {
        noCommission: product.noCommission ? true : undefined,
        isCredit: product.isCredit ? true : undefined,
      }
    );
    const list = productsBySeries.get(product.series);
    if (list) list.push(entry);
    else productsBySeries.set(product.series, [entry]);
  }

  // Series order is the dump's own `sortOrder`, which is the order the
  // catalogue screen shows and the quote prints.
  const series: CatalogSeries[] = [...dump.series]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((row) => {
      if (!capByCode.has(row.code)) seriesWithoutDiscountCap.push(row.code);
      return {
        seriesCode: row.code,
        seriesName: row.name,
        maxDiscountPct: capByCode.get(row.code) ?? null,
        products: productsBySeries.get(row.code) ?? [],
      };
    });

  const options: CatalogOption[] = activeOptions.map((option) =>
    withOptional<CatalogOption>(
      {
        code: option.code,
        name: option.name,
        description: option.shortDescription ?? "",
        ...basePrice(option.prices),
        compatibleSeries: option.compatSeries,
        // `role` is written even when null: the seed refuses an option
        // entry with no `role` key at all, and null is a real answer --
        // an option no form has a box for.
        role: option.role,
        parentProductCode: option.parentProductCode,
        unitLengthM: option.unitLengthM,
      },
      {
        compatibleProducts: option.compatProducts.length > 0 ? option.compatProducts : undefined,
        noCommission: option.noCommission ? true : undefined,
      }
    )
  );

  const usPrices: UsPricesJson = {
    extractedAt: dump.dumpedAt,
    // Only settled US prices. A US row flagged `needsReview` is a placeholder
    // -- `L-320F` carries amount 0 with the flag set, meaning "nobody has
    // priced this for the US yet" -- and `mapUsPrices` seeds every entry in
    // this file as authoritative with `needsReview: false`. Carrying the
    // placeholder across would publish a machine at $0. A genuine zero that
    // nobody flagged (the EasyLoader, which costs nothing because every part
    // of it is an option) is kept, because that one is an answer.
    // Each entry names its table: software is sold under the same code as a
    // product and as a machine option, so a code alone is ambiguous.
    prices: [
      ...activeProducts.map((row) => ({ row, kind: "product" as const })),
      ...activeOptions.map((row) => ({ row, kind: "option" as const })),
    ]
      .flatMap(({ row, kind }) => {
        const price = row.prices[US_REGION];
        if (!price || price.needsReview) return [];
        const amountUsd = Number(price.amount);
        return Number.isFinite(amountUsd) ? [{ code: row.code, kind, amountUsd }] : [];
      })
      .sort((a, b) => a.code.localeCompare(b.code, "en") || a.kind.localeCompare(b.kind, "en")),
    // The dump is the catalogue, so every US price in it belongs to a row
    // that is also in it. The field exists for the spreadsheet extractor
    // this replaced, which could not say the same.
    unmatched: [],
  };

  return { catalog: { extractedAt: dump.dumpedAt, series, options }, usPrices, skippedInactive, seriesWithoutDiscountCap };
}
