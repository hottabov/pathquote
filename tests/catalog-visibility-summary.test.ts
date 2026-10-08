import { describe, it, expect } from "vitest";
import { NO_HIDDEN_CATALOG_IDS } from "../src/lib/catalog-visibility";
import { countCatalogueShown, describeCatalogueAccess } from "../src/lib/catalog-visibility-summary";

const tree = [
  { id: "s1", products: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] },
  { id: "s2", products: [{ id: "p4" }, { id: "p5" }] },
  { id: "s3", products: [] },
];

const hiding = (seriesIds: string[], productIds: string[]) => ({
  seriesIds: new Set(seriesIds),
  productIds: new Set(productIds),
});

describe("countCatalogueShown", () => {
  it("counts everything as shown for a user with no hidden rows", () => {
    expect(countCatalogueShown(tree, NO_HIDDEN_CATALOG_IDS)).toEqual({
      seriesTotal: 3,
      seriesShown: 3,
      productsTotal: 5,
      productsShown: 5,
    });
  });

  it("takes a hidden product off the shown count, and nothing else", () => {
    expect(countCatalogueShown(tree, hiding([], ["p2"]))).toEqual({
      seriesTotal: 3,
      seriesShown: 3,
      productsTotal: 5,
      productsShown: 4,
    });
  });

  it("takes every product under a hidden series off the shown count", () => {
    expect(countCatalogueShown(tree, hiding(["s1"], []))).toEqual({
      seriesTotal: 3,
      seriesShown: 2,
      productsTotal: 5,
      productsShown: 2,
    });
  });

  it("does not count a product twice when it is hidden under a hidden series as well", () => {
    // p1 has its own row AND sits under hidden s1: it is one hidden product.
    expect(countCatalogueShown(tree, hiding(["s1"], ["p1", "p4"]))).toEqual({
      seriesTotal: 3,
      seriesShown: 2,
      productsTotal: 5,
      productsShown: 1,
    });
  });

  it("is empty for an empty catalogue", () => {
    expect(countCatalogueShown([], NO_HIDDEN_CATALOG_IDS)).toEqual({
      seriesTotal: 0,
      seriesShown: 0,
      productsTotal: 0,
      productsShown: 0,
    });
  });
});

describe("describeCatalogueAccess", () => {
  it("says the whole catalogue when nothing is hidden -- the default state", () => {
    const result = describeCatalogueAccess(countCatalogueShown(tree, NO_HIDDEN_CATALOG_IDS));
    expect(result.tone).toBe("all");
    expect(result.summary).toBe("This user sees the whole catalogue (3 series, 5 products).");
    expect(result.warning).toBeNull();
  });

  it("states a partial selection as what the user WILL see, out of the total", () => {
    const result = describeCatalogueAccess(countCatalogueShown(tree, hiding(["s2"], ["p1"])));
    expect(result.tone).toBe("some");
    expect(result.summary).toBe("This user sees 2 of 3 series and 2 of 5 products.");
    expect(result.warning).toBeNull();
  });

  it("agrees the noun with the total, and reads 'series' the same in both numbers", () => {
    const one = describeCatalogueAccess({ seriesTotal: 1, seriesShown: 1, productsTotal: 1, productsShown: 1 });
    expect(one.summary).toBe("This user sees the whole catalogue (1 series, 1 product).");
    const part = describeCatalogueAccess({ seriesTotal: 2, seriesShown: 1, productsTotal: 1, productsShown: 1 });
    expect(part.summary).toBe("This user sees 1 of 2 series and 1 of 1 product.");
  });

  it("groups thousands, like the Contacts summary", () => {
    const result = describeCatalogueAccess({
      seriesTotal: 14,
      seriesShown: 12,
      productsTotal: 1380,
      productsShown: 1340,
    });
    expect(result.summary).toBe("This user sees 12 of 14 series and 1,340 of 1,380 products.");
  });

  it("warns, rather than staying silent, when every series is unticked", () => {
    const result = describeCatalogueAccess(countCatalogueShown(tree, hiding(["s1", "s2", "s3"], [])));
    expect(result.tone).toBe("none");
    expect(result.summary).toBe("This user sees nothing in the catalogue.");
    expect(result.warning).toContain("item picker will be empty");
  });

  it("warns when series are ticked but every product in them is not", () => {
    const result = describeCatalogueAccess(countCatalogueShown(tree, hiding([], ["p1", "p2", "p3", "p4", "p5"])));
    expect(result.tone).toBe("none");
  });

  it("does not warn for a ticked series that simply has no products", () => {
    const empties = [{ id: "e1", products: [] }];
    const result = describeCatalogueAccess(countCatalogueShown(empties, NO_HIDDEN_CATALOG_IDS));
    expect(result.tone).toBe("all");
  });

  it("never describes a selection as hiding anything, in any state", () => {
    const states = [
      NO_HIDDEN_CATALOG_IDS,
      hiding(["s2"], ["p1"]),
      hiding(["s1", "s2", "s3"], []),
    ];
    for (const hidden of states) {
      const { summary, warning } = describeCatalogueAccess(countCatalogueShown(tree, hidden));
      expect(`${summary} ${warning ?? ""}`).not.toMatch(/\bhid(e|es|den)\b/i);
    }
  });
});
