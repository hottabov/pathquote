// Pure counting and wording for the live summary in the "Catalogue visibility"
// editor on a user's settings page
// (src/components/settings/catalog-visibility-editor.tsx). Lives in its own
// module, apart from src/lib/catalog-visibility.ts, so the enforcement half of
// the feature stays untouched by what is only a presentation concern. No
// `@/lib/db` or `next/*` imports, so it is unit-testable in the no-database
// suite.

import { isProductHidden, isSeriesHidden, type HiddenCatalogIds } from "./catalog-visibility";

/** The slice of `VisibilitySeriesRow` the counts need. */
export type CatalogueTree = readonly { id: string; products: readonly { id: string }[] }[];

export type CatalogueCounts = {
  seriesTotal: number;
  seriesShown: number;
  productsTotal: number;
  /** Products this user can actually reach: not hidden themselves AND not under
   *  a hidden series. */
  productsShown: number;
};

/**
 * How much of the catalogue a user sees under `hidden`, decided by the very
 * predicates every query and server-side recheck uses (`isSeriesHidden`,
 * `isProductHidden`) rather than by a second copy of the rule. A product ticked
 * under an unticked series is therefore not counted as shown -- which is the
 * one overlap in this model that an admin cannot see by looking at the boxes.
 */
export function countCatalogueShown(tree: CatalogueTree, hidden: HiddenCatalogIds): CatalogueCounts {
  let seriesShown = 0;
  let productsTotal = 0;
  let productsShown = 0;
  for (const s of tree) {
    if (!isSeriesHidden(s.id, hidden)) seriesShown += 1;
    for (const p of s.products) {
      productsTotal += 1;
      if (!isProductHidden({ id: p.id, seriesId: s.id }, hidden)) productsShown += 1;
    }
  }
  return { seriesTotal: tree.length, seriesShown, productsTotal, productsShown };
}

export type CatalogueAccessSummary = {
  /** `none` is the dangerous one: the user's catalogue and item picker are
   *  empty. The editor renders it as a warning, not as a neutral note. */
  tone: "all" | "some" | "none";
  /** What the current, possibly unsaved, selection means in plain words. */
  summary: string;
  /** Present only for `none`: why that is probably not what the admin meant. */
  warning: string | null;
};

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/**
 * Restates the working selection as its effect on what the user will see.
 *
 * Ticking SHOWS here, the same as in the Contacts visibility card below it, so
 * the summary speaks only of what the user sees and never of what is hidden. A
 * user with no `CatalogVisibility` rows is the "all" case: that is the default,
 * and it is what an empty deny-list means.
 */
export function describeCatalogueAccess(counts: CatalogueCounts): CatalogueAccessSummary {
  const { seriesTotal, seriesShown, productsTotal, productsShown } = counts;

  const nothingReachable = seriesShown === 0 || (productsTotal > 0 && productsShown === 0);
  if (nothingReachable) {
    return {
      tone: "none",
      summary: "This user sees nothing in the catalogue.",
      warning:
        "Their catalogue and item picker will be empty. Tick the series and products this user should see.",
    };
  }

  if (seriesShown === seriesTotal && productsShown === productsTotal) {
    return {
      tone: "all",
      summary: `This user sees the whole catalogue (${plural(seriesTotal, "series", "series")}, ${plural(productsTotal, "product", "products")}).`,
      warning: null,
    };
  }

  const n = (value: number) => value.toLocaleString("en-US");
  return {
    tone: "some",
    summary: `This user sees ${n(seriesShown)} of ${plural(seriesTotal, "series", "series")} and ${n(productsShown)} of ${plural(productsTotal, "product", "products")}.`,
    warning: null,
  };
}
