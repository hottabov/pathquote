/**
 * Pure mapping: catalog-v2-target.json -> the two seed-data files
 * (prisma/seed-data/catalog.json, prisma/seed-data/prices-us.json). The
 * shapes are the ones prisma/seed-lib.ts reads (`Catalog`, `UsPricesJson`);
 * scripts/build-seed-data-from-target.ts is the IO shell.
 */

import type { Catalog, CatalogItem, CatalogOption, CatalogSeries, UsPricesJson } from "../../prisma/seed-lib";
import type { CatalogTarget, TargetOption, TargetProduct } from "./catalog-v2-plan";

/** The series list is not in the target file; it comes from the catalog.json in place. */
export type SeriesHeader = Pick<CatalogSeries, "seriesCode" | "seriesName" | "maxDiscountPct">;

/**
 * AU price for a seed entry: the amount, or null when the target says 0 or
 * has no AU figure -- the seed turns null into amount 0 + needsReview true,
 * the same row scripts/migrate-catalog-v2.ts writes for a 0. A row may
 * carry `needsReviewAU: false` to keep a genuine 0 unflagged.
 */
function auPrice(row: TargetProduct | TargetOption): Pick<CatalogItem, "price" | "needsReview"> {
  const amount = row.prices.AU;
  if (amount === undefined || amount === 0) {
    const genuineZero = amount === 0 && "needsReviewAU" in row && row.needsReviewAU === false;
    return genuineZero ? { price: 0, needsReview: false } : { price: null, needsReview: true };
  }
  return { price: amount, needsReview: false };
}

function withOptional<T extends object>(entry: T, extras: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
  for (const [k, v] of Object.entries(extras)) if (v !== undefined) out[k] = v;
  return out as T;
}

export function buildSeedDataFromTarget(
  target: CatalogTarget,
  seriesHeaders: SeriesHeader[],
  extractedAt: string
): { catalog: Catalog; usPrices: UsPricesJson } {
  const products = target.products.filter((p) => p.action !== "delete");
  const options = target.options.filter((o) => o.action !== "delete");

  const knownSeries = new Set(seriesHeaders.map((s) => s.seriesCode));
  for (const p of products) {
    if (!knownSeries.has(p.series)) throw new Error(`product ${p.code}: series ${p.series} is not in catalog.json`);
  }

  const series: CatalogSeries[] = seriesHeaders.map((h) => ({
    seriesCode: h.seriesCode,
    seriesName: h.seriesName,
    maxDiscountPct: h.maxDiscountPct,
    products: products
      .filter((p) => p.series === h.seriesCode)
      .map((p) =>
        withOptional<CatalogItem>(
          {
            code: p.code,
            name: p.name,
            description: p.description,
            ...auPrice(p),
            kind: p.kind ?? "ACCESSORY",
            form: p.form ?? null,
            specs: p.specs && Object.keys(p.specs).length ? (p.specs as CatalogItem["specs"]) : null,
            contentBlockKey: p.contentBlockKey ?? null,
          },
          {
            legacyCodes: p.legacyCodes.length ? p.legacyCodes : undefined,
            isCredit: p.isCredit || undefined,
            noCommission: p.noCommission || undefined,
          }
        )
      ),
  }));

  const catalogOptions: CatalogOption[] = options.map((o) =>
    withOptional<CatalogOption>(
      {
        code: o.code,
        name: o.name,
        description: o.description,
        ...auPrice(o),
        compatibleSeries: [...o.compatSeries],
        role: o.role ?? null,
        parentProductCode: o.parentProductCode ?? null,
        unitLengthM: o.unitLengthM ?? null,
        contentBlockKey: o.contentBlockKey ?? null,
      },
      {
        compatibleProducts: o.compatProducts.length ? [...o.compatProducts] : undefined,
        legacyCodes: o.legacyCodes.length ? o.legacyCodes : undefined,
        noCommission: o.noCommission || undefined,
      }
    )
  );

  const usPrices: UsPricesJson = {
    extractedAt,
    prices: [...products, ...options]
      .filter((row) => row.prices.US !== undefined && row.prices.US !== 0)
      .map((row) => ({ code: row.code, amountUsd: row.prices.US as number }))
      .sort((a, b) => a.code.localeCompare(b.code, "en")),
    unmatched: [],
  };

  return { catalog: { extractedAt, series, options: catalogOptions }, usPrices };
}
