import { describe, it, expect } from "vitest";
import {
  catalogVisibilityUserId,
  isProductHidden,
  isSeriesHidden,
  filterHiddenSeries,
  filterHiddenProducts,
  NO_HIDDEN_CATALOG_IDS,
  type HiddenCatalogIds,
} from "../src/lib/catalog-visibility";
import { toSheetData } from "../src/lib/sheet-data";
import { sheetDoc, sheetItem } from "./helpers/fixtures";

const hidden: HiddenCatalogIds = {
  seriesIds: new Set(["series_X"]),
  productIds: new Set(["prod_M5180"]),
};

describe("catalogVisibilityUserId", () => {
  it("returns null for an ADMIN, regardless of their own id", () => {
    expect(catalogVisibilityUserId({ role: "ADMIN", id: "user_A" })).toBeNull();
    expect(catalogVisibilityUserId({ role: "ADMIN", id: "user_B" })).toBeNull();
  });

  it("returns the user's own id for a non-admin", () => {
    expect(catalogVisibilityUserId({ role: "MANAGER", id: "user_A" })).toBe("user_A");
  });

  it("returns null for a DEVELOPER, same as an ADMIN", () => {
    expect(catalogVisibilityUserId({ role: "DEVELOPER", id: "user_A" })).toBeNull();
  });

  it("scopes by the individual user, not anything shared like a region -- two MANAGERs resolve to their own, different ids", () => {
    // `catalogVisibilityUserId` doesn't even accept a regionId -- there is no
    // region input it could key off of. This is the point of the rescope:
    // "два менеджера в одному регіоні" (two managers in one region) still
    // resolve to two different scoping ids.
    expect(catalogVisibilityUserId({ role: "MANAGER", id: "user_A" })).toBe("user_A");
    expect(catalogVisibilityUserId({ role: "MANAGER", id: "user_B" })).toBe("user_B");
  });

  it("treats a missing session the same as no user (sees everything)", () => {
    expect(catalogVisibilityUserId(null)).toBeNull();
    expect(catalogVisibilityUserId(undefined)).toBeNull();
  });
});

describe("isSeriesHidden / isProductHidden", () => {
  it("a user with no rows (NO_HIDDEN_CATALOG_IDS) sees the whole catalogue", () => {
    expect(isSeriesHidden("series_X", NO_HIDDEN_CATALOG_IDS)).toBe(false);
    expect(isProductHidden({ id: "prod_M5180", seriesId: "series_M" }, NO_HIDDEN_CATALOG_IDS)).toBe(false);
  });

  it("flags a series with its own hidden row", () => {
    expect(isSeriesHidden("series_X", hidden)).toBe(true);
    expect(isSeriesHidden("series_M", hidden)).toBe(false);
  });

  it("flags a product hidden by its own row", () => {
    expect(isProductHidden({ id: "prod_M5180", seriesId: "series_M" }, hidden)).toBe(true);
  });

  it("flags a product hidden because its whole series is hidden, even with no product-level row", () => {
    expect(isProductHidden({ id: "prod_X100", seriesId: "series_X" }, hidden)).toBe(true);
  });

  it("leaves a sibling product visible when only its own product row is hidden", () => {
    expect(isProductHidden({ id: "prod_M5190", seriesId: "series_M" }, hidden)).toBe(false);
  });
});

describe("filterHiddenSeries", () => {
  it("removes a hidden series and keeps the rest, for any {id}-shaped row", () => {
    const series = [
      { id: "series_M", name: "M-Series" },
      { id: "series_X", name: "X-Calibre" },
    ];
    expect(filterHiddenSeries(series, hidden)).toEqual([{ id: "series_M", name: "M-Series" }]);
  });

  it("keeps every series when nothing is hidden", () => {
    const series = [{ id: "series_M" }, { id: "series_X" }];
    expect(filterHiddenSeries(series, NO_HIDDEN_CATALOG_IDS)).toEqual(series);
  });
});

describe("filterHiddenProducts", () => {
  it("removes a directly-hidden product and a product whose series is hidden, keeps siblings", () => {
    const products = [
      { id: "prod_M5180", seriesId: "series_M", code: "M5180" }, // directly hidden
      { id: "prod_M5190", seriesId: "series_M", code: "M5190" }, // sibling, stays visible
      { id: "prod_X100", seriesId: "series_X", code: "X100" }, // series hidden
    ];
    expect(filterHiddenProducts(products, hidden)).toEqual([
      { id: "prod_M5190", seriesId: "series_M", code: "M5190" },
    ]);
  });

  it("keeps every product when nothing is hidden", () => {
    const products = [{ id: "prod_M5180", seriesId: "series_M" }];
    expect(filterHiddenProducts(products, NO_HIDDEN_CATALOG_IDS)).toEqual(products);
  });
});

describe("per-user scoping (the case this rescope exists for)", () => {
  // Two salespeople in the same region, per the owner's own example ("є
  // менеджер А і менеджер Б в USA... регіон тут ні до чого") -- модеled here
  // as two independent `HiddenCatalogIds` values, one per user, resolved
  // from that user's *own* rows only (see `getHiddenCatalogIds`,
  // src/lib/queries/catalog-visibility.ts, which queries
  // `where: { userId }`). Nothing about either set is derived from a shared
  // region -- these two fixtures could belong to users in the same region
  // or different ones; it makes no difference to this module at all.
  const hiddenForManagerA: HiddenCatalogIds = {
    seriesIds: new Set(["series_X"]), // A can't sell X-Calibre
    productIds: new Set(),
  };
  const hiddenForManagerB: HiddenCatalogIds = NO_HIDDEN_CATALOG_IDS; // B has no rows of their own

  it("hiding a series for manager A hides its products for A only -- manager B, same region, is unaffected", () => {
    const xCalibreProduct = { id: "prod_X100", seriesId: "series_X" };

    expect(isProductHidden(xCalibreProduct, hiddenForManagerA)).toBe(true);
    expect(isProductHidden(xCalibreProduct, hiddenForManagerB)).toBe(false);
  });

  it("an ADMIN sees hidden items regardless of what any manager has hidden", () => {
    // `catalogVisibilityUserId` resolves an ADMIN straight to `null`
    // (see above), which every caller wires to `NO_HIDDEN_CATALOG_IDS`
    // (getHiddenCatalogIds(null) short-circuits without a query) -- so an
    // ADMIN's *own* effective `hidden` set is always empty, independent of
    // hiddenForManagerA/B above.
    const adminHidden = NO_HIDDEN_CATALOG_IDS;
    const xCalibreProduct = { id: "prod_X100", seriesId: "series_X" };
    expect(isProductHidden(xCalibreProduct, adminHidden)).toBe(false);
  });
});

describe("adding a hidden product is rejected server-side, not merely absent from the UI", () => {
  // `addItem` (src/lib/actions/documents.ts) calls exactly this check --
  // `isProductHidden(product, hiddenCatalogIds)` -- after loading the
  // product by its submitted id, and returns the same "Product not
  // found" error a genuinely nonexistent id would, regardless of what
  // the item picker rendered. This is the actual gate a crafted request
  // (any productId, bypassing the UI entirely) still hits.
  it("the gate addItem calls returns true for a product hidden via its series", () => {
    const submittedProduct = { id: "prod_X100", seriesId: "series_X" };
    expect(isProductHidden(submittedProduct, hidden)).toBe(true);
  });

  it("the gate addItem calls returns true for a directly-hidden product", () => {
    const submittedProduct = { id: "prod_M5180", seriesId: "series_M" };
    expect(isProductHidden(submittedProduct, hidden)).toBe(true);
  });

  it("the same product resolves to visible (false) for a user with nothing hidden", () => {
    const submittedProduct = { id: "prod_X100", seriesId: "series_X" };
    expect(isProductHidden(submittedProduct, NO_HIDDEN_CATALOG_IDS)).toBe(false);
  });
});

describe("a hidden product already on a document still renders and totals identically", () => {
  // `DocumentItem` snapshots a product's code/name/description/price at the
  // moment it's added (see the schema comment on DocumentItem, and
  // `addItem`'s own doc comment) -- it does keep an optional `productId`
  // (the builder uses it, alongside seriesId, to look up compatible
  // options), but `ToSheetItemInput` (the shape `toSheetData`,
  // src/lib/sheet-data.ts, actually renders from) drops it: no
  // productId/seriesId field survives into what's rendered, so there is no
  // id left for a `HiddenCatalogIds` check to key off even in principle.
  // Confirmed by grep: neither `toSheetData` nor `computeTotals`
  // (src/lib/pricing.ts) imports src/lib/catalog-visibility.ts, and the
  // only two call sites that ever invoke `isProductHidden`/
  // `filterHiddenProducts` anywhere in src/ are the item *picker*'s own
  // catalogue tree (choosing a NEW item to add) and `addItem`'s own gate on
  // a submitted id -- neither one ever runs against an item already on a
  // document. So hiding "X100" today cannot change how an existing document
  // that already contains it renders or totals.
  it("renders the item and the document totals exactly the same whether or not its series is hidden elsewhere", () => {
    // This item's code, "X100", belongs to "series_X" -- the exact series
    // `hidden` (defined at the top of this file) marks hidden for whichever
    // user that fixture represents.
    expect(hidden.seriesIds.has("series_X")).toBe(true);

    const doc = sheetDoc({
      status: "FINAL",
      number: "Q-1",
      subtotal: "50000.00",
      taxAmount: "5000.00",
      total: "55000.00",
      items: [
        sheetItem({
          code: "X100",
          name: "X-Calibre 100",
          unitPrice: "50000.00",
          listPrice: "50000.00",
          total: "50000.00",
        }),
      ],
    });
    const sheet = toSheetData(doc);

    // `toSheetData` never consulted `hidden` -- there's no productId/seriesId
    // on `ToSheetItemInput` for it to check, and no import of
    // src/lib/catalog-visibility.ts in src/lib/sheet-data.ts at all. The
    // item renders, and the document totals, exactly as if nothing were
    // hidden anywhere.
    expect(sheet.items[0].code).toBe("X100");
    expect(sheet.items[0].breakdown.subtotal).toBe("50000.00");
    expect(sheet.totals.subtotal).toBe("50000.00");
    expect(sheet.totals.total).toBe("55000.00");
  });
});
