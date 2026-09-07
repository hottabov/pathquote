// Pure — no DB, no next/*. `buildQuoteDocumentList` is the whole of what
// `listQuoteDocuments` does once its two `findMany`s have returned, split out
// precisely so the rule that matters (which keys appear in the admin list)
// can be pinned without a database.
import { describe, it, expect } from "vitest";
import {
  buildQuoteDocumentList,
  type QuoteDocumentDefaultRow,
  type QuoteDocumentRegionRow,
} from "../src/lib/quote-document-list";
import { isQuoteDocumentKeyPermutation } from "../src/lib/validation/quote-documents";

const terms: QuoteDocumentDefaultRow = {
  key: "terms",
  title: "Terms",
  sortOrder: 10,
  includedByDefault: true,
};
const conditions: QuoteDocumentDefaultRow = {
  key: "conditions",
  title: "General Conditions of Sale",
  sortOrder: 20,
  includedByDefault: true,
};

/** The EU-only Data Processing Agreement the spec names as the reason a row
 * may exist for a region with no global default (D2). */
const dpaEu: QuoteDocumentRegionRow = {
  key: "dpa",
  regionCode: "EU",
  title: "Data Processing Agreement",
  sortOrder: 30,
  includedByDefault: true,
};

describe("buildQuoteDocumentList", () => {
  it("lists every default, in print order", () => {
    const list = buildQuoteDocumentList([conditions, terms], []);
    expect(list.map((d) => d.key)).toEqual(["terms", "conditions"]);
  });

  it("names the regions that keep their own version of a default", () => {
    const list = buildQuoteDocumentList(
      [terms],
      [
        { ...terms, regionCode: "US" },
        { ...terms, regionCode: "AU" },
      ]
    );
    // Sorted, so the badge reads the same way on every load rather than in
    // whatever order the rows came back.
    expect(list[0].regionCodes).toEqual(["AU", "US"]);
    expect(list[0].regionOnly).toBe(false);
  });

  // The defect this function exists to fix: a document that exists only for
  // one region was invisible in the admin list, so the one screen that could
  // edit or delete it could not be reached at all.
  it("surfaces a key that exists only as a region version", () => {
    const list = buildQuoteDocumentList([terms], [dpaEu]);
    expect(list.map((d) => d.key)).toEqual(["terms", "dpa"]);
  });

  it("marks a region-only key as such, and names its regions", () => {
    const [, dpa] = buildQuoteDocumentList([terms], [dpaEu]);
    expect(dpa.regionOnly).toBe(true);
    expect(dpa.regionCodes).toEqual(["EU"]);
    expect(dpa.title).toBe("Data Processing Agreement");
  });

  it("takes a region-only row's print position from the row itself", () => {
    const list = buildQuoteDocumentList([conditions], [{ ...dpaEu, sortOrder: 5 }]);
    expect(list.map((d) => d.key)).toEqual(["dpa", "conditions"]);
  });

  // Two regions can hold the same region-only key with rows that disagree —
  // nothing constrains their titles or sort orders to match. The list shows
  // one row per key, so it has to pick deterministically rather than
  // whichever `findMany` happened to return first.
  it("picks a region-only row deterministically when regions disagree", () => {
    const rows = [
      { ...dpaEu, regionCode: "US", title: "US agreement", sortOrder: 40 },
      { ...dpaEu, regionCode: "EU", title: "EU agreement", sortOrder: 30 },
    ];
    const [dpa] = buildQuoteDocumentList([], rows);
    expect(dpa.title).toBe("EU agreement");
    expect(dpa.sortOrder).toBe(30);
    expect(dpa.regionCodes).toEqual(["EU", "US"]);
    // Same answer whichever order the rows arrive in.
    expect(buildQuoteDocumentList([], rows.slice().reverse())[0].title).toBe("EU agreement");
  });

  it("breaks a sortOrder tie by key, so the order never flickers", () => {
    const list = buildQuoteDocumentList(
      [
        { ...conditions, sortOrder: 10 },
        { ...terms, sortOrder: 10 },
      ],
      []
    );
    expect(list.map((d) => d.key)).toEqual(["conditions", "terms"]);
  });

  it("returns nothing for an empty table", () => {
    expect(buildQuoteDocumentList([], [])).toEqual([]);
  });
});

// The latent-fatal half of this pair. `reorderQuoteDocuments` compares the
// submitted order against every DISTINCT key in the table; the drag list is
// built from this function. While the list held defaults only, the first
// region-only document made the submitted list a strict subset, and
// reordering failed permanently with "Document list doesn't match — refresh
// and try again" — advice that could not work, because a refresh rebuilds the
// same short list.
describe("reordering a table that holds a region-only key", () => {
  it("submits a permutation of every distinct key in the table", () => {
    const list = buildQuoteDocumentList([terms, conditions], [dpaEu, { ...terms, regionCode: "US" }]);
    // What `reorderQuoteDocuments` reads back: findMany(distinct: ["key"]).
    const distinctKeysInTable = ["terms", "conditions", "dpa"];
    expect(isQuoteDocumentKeyPermutation(list.map((d) => d.key), distinctKeysInTable)).toBe(true);
  });

  it("still matches when the admin has dragged the rows around", () => {
    const list = buildQuoteDocumentList([terms, conditions], [dpaEu]);
    const dragged = list.map((d) => d.key).reverse();
    expect(isQuoteDocumentKeyPermutation(dragged, ["terms", "conditions", "dpa"])).toBe(true);
  });
});
