import { cache } from "react";
import { db } from "@/lib/db";
import { toPlainTextPreview } from "@/lib/rich-text";

const DEFAULT_REGION_CODE = "AU";

export type RegionSummary = {
  id: string;
  code: string;
  name: string;
  currency: string;
};

/** All active regions, ordered by code, for the per-region price editors. */
export const listActiveRegions = cache(async function listActiveRegions(): Promise<
  RegionSummary[]
> {
  const regions = await db.region.findMany({
    where: { active: true },
    orderBy: { code: "asc" },
  });
  return regions.map((r) => ({ id: r.id, code: r.code, name: r.name, currency: r.currency }));
});

/** A single region by id — used by the settings page to show the current
 * user's region name/currency alongside their role. `null` id (no region
 * assigned yet) short-circuits to `null` without hitting the database. */
export async function getRegionById(regionId: string | null): Promise<RegionSummary | null> {
  if (!regionId) return null;
  const region = await db.region.findUnique({ where: { id: regionId } });
  if (!region) return null;
  return { id: region.id, code: region.code, name: region.name, currency: region.currency };
}

export type SeriesWithCounts = {
  id: string;
  code: string;
  name: string;
  maxDiscountPct: string | null;
  sortOrder: number;
  productCount: number;
  /** Resolved display image for the /catalog series card: the series' own
   * override if set, else the first active product (ordered by sortOrder,
   * then code) that has an image, else `null`. */
  imageUrl: string | null;
};

/**
 * All series, ordered for display, with the number of products in each and
 * the image to show on its /catalog card. A single `findMany` -- the
 * fallback product image is pulled via a nested `products` relation
 * (`take: 1`, filtered/ordered so Prisma resolves it as part of the same
 * query) rather than a per-series follow-up query.
 */
export async function listSeriesWithCounts(): Promise<SeriesWithCounts[]> {
  const series = await db.series.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      _count: { select: { products: true } },
      products: {
        where: { active: true, imageUrl: { not: null } },
        orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
        take: 1,
        select: { imageUrl: true },
      },
    },
  });

  return series.map((s) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    maxDiscountPct: s.maxDiscountPct?.toString() ?? null,
    sortOrder: s.sortOrder,
    productCount: s._count.products,
    imageUrl: s.imageUrl ?? s.products[0]?.imageUrl ?? null,
  }));
}

/** How many global options exist, for the "Options" entry card on /catalog. */
export async function countOptions(): Promise<number> {
  return db.option.count();
}

export type CatalogPrice = {
  amount: string;
  needsReview: boolean;
  currency: string;
};

export type ProductListItem = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  price?: CatalogPrice;
  /** `Product.imageUrl` (raw, unresolved) — the list pages render it as a
   * thumbnail beside the name via `CatalogThumb`. `null` when the product
   * has no image; unlike `SeriesDetail.imageUrl` there is no fallback. */
  imageUrl: string | null;
  /** `Product.description`, reduced to a single-line plain-text preview via
   * `toPlainTextPreview` (src/lib/rich-text.ts) — the list rows show a
   * truncated one-line snippet, never the full rendered rich text a product
   * detail page does. `null` when the product has no description, or when
   * it's blank/whitespace-only. */
  description: string | null;
};

export type SeriesDetail = {
  id: string;
  code: string;
  name: string;
  maxDiscountPct: string | null;
  /** The series' own image override (raw, unresolved) -- `null` means "no
   * override, falls back to a product image" (see listSeriesWithCounts and
   * getSeriesFallbackImageUrl). Distinct from ProductDetail/OptionDetail's
   * imageUrl, which has no fallback of its own. */
  imageUrl: string | null;
};

type SeriesProductsResult = { series: SeriesDetail; products: ProductListItem[] };

async function seriesProductsResult(
  series: {
    id: string;
    code: string;
    name: string;
    maxDiscountPct: { toString(): string } | null;
    imageUrl: string | null;
  },
  regionCode: string
): Promise<SeriesProductsResult> {
  // `sortOrder` first (drag-to-reorder — see `reorderProducts` in
  // src/lib/actions/catalog.ts), `code` as the tiebreak. Every product
  // defaults to `sortOrder: 0`, so a series nobody has ever reordered ties
  // on every row and falls through entirely to `code` — i.e. reads
  // alphabetically, exactly the owner's stated default. Dragging touches
  // only that series' own rows (see `reorderProducts`), so an untouched
  // series elsewhere is unaffected either way.
  const products = await db.product.findMany({
    where: { seriesId: series.id },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    include: {
      prices: {
        where: { region: { code: regionCode } },
        include: { region: true },
      },
    },
  });

  return {
    series: {
      id: series.id,
      code: series.code,
      name: series.name,
      maxDiscountPct: series.maxDiscountPct?.toString() ?? null,
      imageUrl: series.imageUrl,
    },
    products: products.map((p) => {
      const price = p.prices[0];
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        active: p.active,
        imageUrl: p.imageUrl,
        description: toPlainTextPreview(p.description),
        price: price
          ? {
              amount: price.amount.toString(),
              needsReview: price.needsReview,
              currency: price.region.currency,
            }
          : undefined,
      };
    }),
  };
}

/**
 * A series (by id) plus its products ordered for display, each carrying its
 * price in the given region (default AU) if one exists. A product with no
 * Price row for the region, or whose Price row has needsReview=true, is
 * returned with `price` reflecting that (or omitted entirely when there's no
 * row at all) so the UI can render a "price required" badge.
 *
 * Routed by id rather than code for the same reason the option editor route
 * is (see the doc comment on `Params` in
 * `src/app/(app)/catalog/[seriesId]/page.tsx`): a series code is short-lived
 * free text today, but nothing stops an admin editing it, and an id never
 * changes. A code-keyed twin of this used to sit alongside it for the "Add
 * item" picker's sake, back when that picker was keyed by code; the picker
 * now reads its whole tree in one query of its own (see
 * `getItemPickerCatalog`, src/lib/queries/documents.ts) and identifies
 * series and products by id, leaving nothing that needs the lookup by
 * code.
 *
 * Request-memoized because `/catalog/[seriesId]` resolves the series in
 * `generateMetadata` and again in the page body.
 */
export const listProductsBySeriesById = cache(async function listProductsBySeriesById(
  seriesId: string,
  regionCode: string = DEFAULT_REGION_CODE
): Promise<SeriesProductsResult | null> {
  const series = await db.series.findUnique({ where: { id: seriesId } });
  if (!series) return null;
  return seriesProductsResult(series, regionCode);
});

/** The product photo a series falls back to on /catalog when it has no
 * explicit `Series.imageUrl` override -- the first active product (ordered
 * by sortOrder, then code) that has an image of its own, mirroring
 * listSeriesWithCounts' resolution. Used by the admin "Series image" panel
 * on the series products page to show what "Reset to product image" would
 * revert to. */
export async function getSeriesFallbackImageUrl(seriesId: string): Promise<string | null> {
  const product = await db.product.findFirst({
    where: { seriesId, active: true, imageUrl: { not: null } },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
    select: { imageUrl: true },
  });
  return product?.imageUrl ?? null;
}

export type OptionListItem = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  price?: CatalogPrice;
  compatSeriesCodes: string[];
  /** `Option.imageUrl` (raw, unresolved) — rendered as a thumbnail beside
   * the name by the options list, same as `ProductListItem.imageUrl`. */
  imageUrl: string | null;
  /** `Option.shortDescription`, reduced to a single-line plain-text preview
   * via `toPlainTextPreview` (src/lib/rich-text.ts) — same "truncated
   * one-line snippet, not the full text" rule as `ProductListItem.description`.
   * `shortDescription` is plain text already (no rich-text editor on the
   * option form — see `OptionForm`), but still routed through the same
   * helper so a multi-line textarea value collapses to one line the same
   * way. `null` when the option has no description, or it's blank. */
  description: string | null;
};

/**
 * Global options list, ordered by code, optionally filtered by a
 * case-insensitive name/code search and/or restricted to those compatible
 * with a given series (series-level compatibility only, per phase 3 scope).
 */
export async function listOptions(params: {
  search?: string;
  seriesCode?: string;
  regionCode?: string;
} = {}): Promise<OptionListItem[]> {
  const { search, seriesCode, regionCode = DEFAULT_REGION_CODE } = params;

  const where: NonNullable<Parameters<typeof db.option.findMany>[0]>["where"] = {};

  if (search && search.trim()) {
    const term = search.trim();
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { code: { contains: term, mode: "insensitive" } },
    ];
  }

  // `seriesCode` is the `?series=` query parameter on /catalog/options -- a
  // human-readable filter in a URL, so it stays a code on purpose: the
  // filter chips render from the live series list on the same request, and
  // a stale bookmarked code merely filters to nothing, which is the right
  // outcome for a filter (unlike an identifier a write depends on -- see
  // docs/plans/2026-09-05-catalog-identity-and-cleanup.md).
  if (seriesCode && seriesCode.trim()) {
    where.compat = { some: { series: { code: seriesCode.trim() } } };
  }

  const options = await db.option.findMany({
    where,
    orderBy: { code: "asc" },
    include: {
      prices: {
        where: { region: { code: regionCode } },
        include: { region: true },
      },
      compat: { include: { series: true } },
    },
  });

  return options.map((o) => {
    const price = o.prices[0];
    return {
      id: o.id,
      code: o.code,
      name: o.name,
      active: o.active,
      imageUrl: o.imageUrl,
      description: toPlainTextPreview(o.shortDescription),
      price: price
        ? {
            amount: price.amount.toString(),
            needsReview: price.needsReview,
            currency: price.region.currency,
          }
        : undefined,
      compatSeriesCodes: o.compat
        .map((c) => c.series?.code)
        .filter((code): code is string => Boolean(code))
        .sort(),
    };
  });
}

/** A single series by id — for the "new product" page header and to
 * validate a `[seriesId]` route param without pulling its product list.
 * Looked up by id rather than code for the same routing reason as
 * `listProductsBySeriesById`; its only caller (`/catalog/[seriesId]/new`)
 * has no other need for code lookup, so `getSeriesByCode` was replaced here
 * rather than kept alongside this, the same call `getOptionDetailById` made
 * for the option route. */
export async function getSeriesById(seriesId: string): Promise<SeriesDetail | null> {
  const series = await db.series.findUnique({ where: { id: seriesId } });
  if (!series) return null;
  return {
    id: series.id,
    code: series.code,
    name: series.name,
    maxDiscountPct: series.maxDiscountPct?.toString() ?? null,
    imageUrl: series.imageUrl,
  };
}

export type RegionPriceRow = {
  regionId: string;
  regionCode: string;
  regionName: string;
  currency: string;
  amount: string | null;
  needsReview: boolean;
};

/** The regions whose price rows a viewer should see: every active region
 * for an admin (`regionId` null — the price editor needs the full table),
 * or just their own. An unknown region id yields an empty list rather than
 * the full one, so a stale session cannot widen the view. */
function regionsForPriceRows(
  regions: RegionSummary[],
  regionId: string | null
): RegionSummary[] {
  if (regionId === null) return regions;
  return regions.filter((region) => region.id === regionId);
}

function toRegionPriceRows(
  regions: RegionSummary[],
  prices: { regionId: string; amount: { toString(): string }; needsReview: boolean }[]
): RegionPriceRow[] {
  const priceByRegionId = new Map(prices.map((p) => [p.regionId, p]));
  return regions.map((region) => {
    const price = priceByRegionId.get(region.id);
    return {
      regionId: region.id,
      regionCode: region.code,
      regionName: region.name,
      currency: region.currency,
      amount: price ? price.amount.toString() : null,
      // No price row at all is treated the same as needsReview for display
      // purposes — both mean "price required" in the editor.
      needsReview: price ? price.needsReview : true,
    };
  });
}

export type ProductDetail = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  noCommission: boolean;
  sortOrder: number;
  imageUrl: string | null;
  series: SeriesDetail;
  prices: RegionPriceRow[];
};

/**
 * A single product (by id) with everything the editor needs: a price row
 * (present or not) per region the viewer may see — every active region for
 * an admin, their own for anyone else, see `regionsForPriceRows` — for the
 * per-region price section.
 * Looked up by id rather than by series code + product code: the route it
 * backs (`/catalog/[seriesId]/[productId]`) needs a key that never changes,
 * since a code is free text an admin can edit and may contain characters
 * (like `/`) that don't survive as a URL path segment — same reasoning as
 * `getOptionDetailById`. `getProductDetail`-by-code has no other callers, so
 * it was replaced here rather than kept alongside this.
 *
 * Request-memoized: `/catalog/[seriesId]/[productId]` loads the product in
 * `generateMetadata` (to decide whether its name may appear in the tab
 * title) and again in the page body. `cache()` keys on *every* argument, so
 * both call sites must pass the same `regionId` or the single query becomes
 * two.
 */
export const getProductDetailById = cache(async function getProductDetailById(
  productId: string,
  regionId: string | null
): Promise<ProductDetail | null> {
  const [product, regions] = await Promise.all([
    db.product.findUnique({
      where: { id: productId },
      include: { series: true, prices: { include: { region: true } } },
    }),
    listActiveRegions(),
  ]);
  if (!product) return null;

  return {
    id: product.id,
    code: product.code,
    name: product.name,
    description: product.description,
    active: product.active,
    noCommission: product.noCommission,
    sortOrder: product.sortOrder,
    imageUrl: product.imageUrl,
    series: {
      id: product.series.id,
      code: product.series.code,
      name: product.series.name,
      maxDiscountPct: product.series.maxDiscountPct?.toString() ?? null,
      imageUrl: product.series.imageUrl,
    },
    prices: toRegionPriceRows(regionsForPriceRows(regions, regionId), product.prices),
  };
});

export type ConflictingOption = { id: string; code: string; name: string };

export type ConflictGroupSummary = { id: string; name: string };

export type OptionDetail = {
  id: string;
  code: string;
  name: string;
  shortDescription: string | null;
  attributeSchema: unknown;
  active: boolean;
  noCommission: boolean;
  sortOrder: number;
  imageUrl: string | null;
  prices: RegionPriceRow[];
  /** Ids of the series this option is compatible with at the series level
   * (phase-3 scope excludes product-level compatibility) -- what
   * `CompatEditor` selects by and `setOptionCompatibility` takes. */
  compatSeriesIds: string[];
  /** `OptionConflictGroup`(s) this option belongs to, sorted by name —
   * read-only here. Membership is managed from
   * `/settings/option-conflict-groups`, not from this page: a group needs a
   * name an admin will recognise, which has no natural home on a single
   * option's editor (see that settings section's own page for the write
   * side). Two options conflict when they share at least one group here —
   * see the `OptionConflictGroup` model comment in schema.prisma. */
  conflictGroups: ConflictGroupSummary[];
};

/** A single option (by id) with a price row per region the viewer may see
 * (every active region for an admin, their own for anyone else — see
 * `regionsForPriceRows`), its series-level compatibility, and its conflicts,
 * for the option editor.
 * Looked up by id rather than code: the route it backs
 * (`/catalog/options/[optionId]`) needs a key that never changes, since a
 * code is free text an admin can edit and may contain characters (like `/`)
 * that don't survive as a URL path segment. `getOptionDetail`-by-code has no
 * other callers, so it was replaced here rather than kept alongside this.
 * Request-memoized for the same reason `getProductDetailById` above is:
 * `/catalog/options/[optionId]` reads it in `generateMetadata` and again in
 * the page body — and, as there, both call sites must pass the same
 * `regionId`, since `cache()` keys on every argument. */
export const getOptionDetailById = cache(async function getOptionDetailById(
  optionId: string,
  regionId: string | null
): Promise<OptionDetail | null> {
  const [option, regions] = await Promise.all([
    db.option.findUnique({
      where: { id: optionId },
      include: {
        prices: { include: { region: true } },
        compat: { select: { seriesId: true, productId: true } },
        conflictGroupMemberships: { include: { group: { select: { id: true, name: true } } } },
      },
    }),
    listActiveRegions(),
  ]);
  if (!option) return null;

  const conflictGroups: ConflictGroupSummary[] = option.conflictGroupMemberships
    .map((m) => m.group)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    id: option.id,
    code: option.code,
    name: option.name,
    shortDescription: option.shortDescription,
    attributeSchema: option.attributeSchema,
    active: option.active,
    noCommission: option.noCommission,
    sortOrder: option.sortOrder,
    imageUrl: option.imageUrl,
    prices: toRegionPriceRows(regionsForPriceRows(regions, regionId), option.prices),
    compatSeriesIds: option.compat
      .filter((c) => c.productId === null)
      .map((c) => c.seriesId)
      .filter((id): id is string => id !== null),
    conflictGroups,
  };
});

/** Every option (id/code/name only), ordered by code, for the
 * `/settings/option-conflict-groups/[groupId]` member checkbox editor — the
 * analogue of `listSeriesWithCounts` feeding `CompatEditor`'s series
 * checkboxes, but for options instead of series. Unlike the old
 * `listOtherOptions` this replaces, nothing is excluded: a group's own
 * current members are among "every option", not carved out of it (that
 * editor edits membership directly, not one option's relationship to every
 * other option). */
export async function listOptionsForConflictGroups(): Promise<ConflictingOption[]> {
  const options = await db.option.findMany({
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });
  return options;
}
