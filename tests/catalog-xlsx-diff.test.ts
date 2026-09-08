import { describe, it, expect } from "vitest";
import { OPTION_COLUMNS, PRICE_COLUMNS, PRODUCT_COLUMNS } from "../src/lib/catalog-xlsx/columns";
import { parseCatalogSheets, type CatalogSheets, type ParsedCatalog } from "../src/lib/catalog-xlsx/parse";
import { diffCatalog, isNoOpDiff, sameCounts, stableJson, type CatalogDiff } from "../src/lib/catalog-xlsx/diff";
import type { CatalogSnapshot } from "../src/lib/catalog-xlsx/snapshot";
import { col, setCell, sheetsOf, tinySnapshot } from "./helpers/catalog-xlsx";

/** Parse (asserting no errors) and diff in one go. */
function diffOf(sheets: CatalogSheets, snapshot: CatalogSnapshot): CatalogDiff {
  const { parsed, errors } = parseCatalogSheets(sheets, snapshot);
  expect(errors).toEqual([]);
  return diffCatalog(parsed, snapshot);
}

function change(diff: CatalogDiff, sheet: "products" | "options", code: string, field: string) {
  const row = diff[sheet].updated.find((u) => u.code === code);
  expect(row, `no updated ${sheet} row with code ${code}`).toBeDefined();
  return row!.changes.find((c) => c.field === field);
}

describe("diffCatalog — buckets", () => {
  it("an unedited export is all unchanged, and a no-op", () => {
    const snapshot = tinySnapshot();
    const diff = diffOf(sheetsOf(snapshot), snapshot);
    expect(diff.counts).toEqual({
      products: { unchanged: 2, updated: 0, created: 0, deleted: 0 },
      options: { unchanged: 2, updated: 0, created: 0, deleted: 0 },
      prices: { unchanged: 4, updated: 0, created: 0, deleted: 0 },
      affectedDraftDocuments: 0,
    });
    expect(diff.products.unchanged.map((r) => r.code).sort()).toEqual(["EL-2020", "M-5180"]);
    expect(isNoOpDiff(diff)).toBe(true);
  });

  it("reports field-level before -> after for an updated row", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    setCell(sheets.products, "M-5180", "name", "M-Series 5 x 180");
    setCell(sheets.products, "M-5180", "active", false);
    setCell(sheets.products, "M-5180", "sortOrder", 9);
    setCell(sheets.products, "M-5180", "specs", '{"cutWidthCm":180,"cutHeightCm":5,"modelTier":"M5"}');
    setCell(sheets.products, "M-5180", "description", "<p>Now described</p>");
    const diff = diffOf(sheets, snapshot);
    expect(diff.counts.products).toEqual({ unchanged: 1, updated: 1, created: 0, deleted: 0 });
    const u = diff.products.updated[0];
    expect(u).toMatchObject({ id: "p1", code: "M-5180", row: 2 });
    expect(u.changes).toEqual([
      { field: "name", before: "M-Series 5cm x 180cm", after: "M-Series 5 x 180" },
      { field: "description", before: null, after: "<p>Now described</p>" },
      { field: "specs", before: '{"cutHeightCm":5,"cutWidthCm":180}', after: '{"cutHeightCm":5,"cutWidthCm":180,"modelTier":"M5"}' },
      { field: "active", before: true, after: false },
      { field: "sortOrder", before: 2, after: 9 },
    ]);
    expect(isNoOpDiff(diff)).toBe(false);
  });

  it("JSON key order and list order do not count as changes", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    setCell(sheets.products, "M-5180", "specs", '{"cutWidthCm":180,"cutHeightCm":5}');
    setCell(sheets.options, "ABR-M", "compatSeries", "X; M");
    const diff = diffOf(sheets, snapshot);
    expect(diff.counts.products.updated).toBe(0);
    expect(diff.counts.options.updated).toBe(0);
    expect(stableJson({ b: [{ z: 1, a: 2 }], a: null })).toBe('{"a":null,"b":[{"a":2,"z":1}]}');
    expect(stableJson(null)).toBeNull();
  });

  it("a code edit is an update of the row the id names, not a delete + create", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    setCell(sheets.products, "M-5180", "code", "M5-180");
    const diff = diffOf(sheets, snapshot);
    expect(diff.counts.products).toEqual({ unchanged: 1, updated: 1, created: 0, deleted: 0 });
    expect(diff.products.updated[0].code).toBe("M5-180");
    expect(change(diff, "products", "M5-180", "code")).toEqual({ field: "code", before: "M-5180", after: "M5-180" });
    // Its prices follow the id, so they are unchanged too.
    expect(diff.counts.prices).toEqual({ unchanged: 4, updated: 0, created: 0, deleted: 0 });
  });

  it("option updates cover parentProduct, compat lists, role, unitLengthM and attributeSchema", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    setCell(sheets.options, "EL-2020-DM12", "parentProduct", null);
    setCell(sheets.options, "EL-2020-DM12", "compatProducts", null);
    setCell(sheets.options, "EL-2020-DM12", "compatSeries", "EL");
    setCell(sheets.options, "EL-2020-DM12", "role", "EL_CONVEYOR");
    setCell(sheets.options, "EL-2020-DM12", "unitLengthM", 2.4);
    setCell(sheets.options, "EL-2020-DM12", "attributeSchema", null);
    const diff = diffOf(sheets, snapshot);
    expect(diff.options.updated[0].changes).toEqual([
      { field: "role", before: "EL_DRIVE", after: "EL_CONVEYOR" },
      { field: "parentProduct", before: "EL-2020", after: null },
      { field: "unitLengthM", before: 1.2, after: 2.4 },
      { field: "compatSeries", before: null, after: "EL" },
      { field: "compatProducts", before: "EL-2020", after: null },
      { field: "attributeSchema", before: '[{"key":"metres","type":"number"}]', after: null },
    ]);
  });

  it("a blank id is a created row (product, option), with its prices created by code", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    sheets.products.push([null, "X", "X-10390", "X-Calibre 10 x 390", null, "MACHINE", "M_SERIES", null, false, false, true, 0, null]);
    sheets.options.push([null, "ABR-X", "Abrasive kit X", null, "ABR", null, null, "X", null, false, true, 0, null, null]);
    sheets.prices.push(["product", null, "X-10390", "AU", "AUD", 250000, false]);
    sheets.prices.push(["option", "", "ABR-X", "US", "USD", 1500, true]);
    const diff = diffOf(sheets, snapshot);
    expect(diff.products.created).toEqual([{ row: 4, code: "X-10390", name: "X-Calibre 10 x 390" }]);
    expect(diff.options.created).toEqual([{ row: 4, code: "ABR-X", name: "Abrasive kit X" }]);
    expect(diff.prices.created).toEqual([
      { itemType: "product", itemCode: "X-10390", region: "AU", row: 6, amount: 250000, needsReview: false },
      { itemType: "option", itemCode: "ABR-X", region: "US", row: 7, amount: 1500, needsReview: true },
    ]);
    expect(diff.counts.products.created).toBe(1);
    expect(diff.counts.prices.created).toBe(2);
  });

  it("a row missing from the file is deleted, with its draft and final document counts", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    sheets.products = sheets.products.filter((r) => r[col(sheets.products, "code")] !== "EL-2020");
    // The module that belongs to EL-2020 has to go too, or the file is
    // invalid -- and so must its price row (a price left behind for a
    // deleted item is a validation error, not silently dropped).
    sheets.options = sheets.options.filter((r) => r[col(sheets.options, "code")] !== "EL-2020-DM12");
    sheets.prices = sheets.prices.filter((r) => r[col(sheets.prices, "code")] !== "EL-2020-DM12");
    const diff = diffOf(sheets, snapshot);
    expect(diff.products.deleted).toEqual([{ id: "p2", code: "EL-2020", name: "EasyLoader 2020", draftDocuments: 2, finalDocuments: 3 }]);
    expect(diff.options.deleted).toEqual([
      { id: "o1", code: "EL-2020-DM12", name: "Drive module 1.2 m", draftDocuments: 0, finalDocuments: 0 },
    ]);
    expect(diff.counts.affectedDraftDocuments).toBe(2);
    // The deleted option's AU price is not listed as a deleted price: it goes with the row.
    expect(diff.prices.deleted).toEqual([]);
    expect(diff.counts.prices).toEqual({ unchanged: 3, updated: 0, created: 0, deleted: 0 });
  });

  it("counts distinct affected drafts across several deletions", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    sheets.products = sheets.products.filter((r) => r[col(sheets.products, "code")] !== "EL-2020");
    sheets.options = [sheets.options[0]]; // header only: every option goes
    sheets.prices = sheets.prices.filter((r) => r[col(sheets.prices, "itemType")] !== "option");
    const diff = diffOf(sheets, snapshot);
    expect(diff.products.deleted.map((d) => d.draftDocuments)).toEqual([2]);
    expect(diff.options.deleted.map((d) => [d.code, d.draftDocuments, d.finalDocuments])).toEqual([
      ["EL-2020-DM12", 0, 0],
      ["ABR-M", 1, 1],
    ]);
    // d2 is shared between EL-2020 and ABR-M: 2 + 1 references, 2 documents.
    expect(diff.counts.affectedDraftDocuments).toBe(2);
  });

  it("prices: updated (amount or needsReview), deleted (row removed), created (new region)", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    const amount = col(sheets.prices, "amount");
    const review = col(sheets.prices, "needsReview");
    const region = col(sheets.prices, "region");
    const codeCol = col(sheets.prices, "code");
    const rows = sheets.prices.slice(1);
    const mAu = rows.find((r) => r[codeCol] === "M-5180" && r[region] === "AU")!;
    mAu[amount] = 155000;
    mAu[review] = false;
    const abr = rows.find((r) => r[codeCol] === "ABR-M")!;
    abr[review] = true;
    // Removing the US row shifts every later row up by one (ABR-M AU: 4 -> 3).
    sheets.prices = sheets.prices.filter((r) => !(r[codeCol] === "M-5180" && r[region] === "US"));
    sheets.prices.push(["option", "o2", "ABR-M", "US", "USD", 1300, false]);
    const diff = diffOf(sheets, snapshot);
    expect(diff.prices.updated).toEqual([
      {
        itemType: "product",
        itemCode: "M-5180",
        region: "AU",
        row: 2,
        before: { amount: 150000, needsReview: true },
        after: { amount: 155000, needsReview: false },
      },
      {
        itemType: "option",
        itemCode: "ABR-M",
        region: "AU",
        row: 3,
        before: { amount: 1950, needsReview: false },
        after: { amount: 1950, needsReview: true },
      },
    ]);
    expect(diff.prices.deleted).toEqual([{ itemType: "product", itemCode: "M-5180", region: "US", amount: 199000, needsReview: false }]);
    expect(diff.prices.created).toEqual([{ itemType: "option", itemCode: "ABR-M", region: "US", row: 5, amount: 1300, needsReview: false }]);
    expect(diff.counts.prices).toEqual({ unchanged: 1, updated: 2, created: 1, deleted: 1 });
  });

  it("headers only (every sheet empty) = delete everything, still a well-formed diff", () => {
    const snapshot = tinySnapshot();
    const sheets: CatalogSheets = { products: [[...PRODUCT_COLUMNS]], options: [[...OPTION_COLUMNS]], prices: [[...PRICE_COLUMNS]] };
    const diff = diffOf(sheets, snapshot);
    expect(diff.counts).toEqual({
      products: { unchanged: 0, updated: 0, created: 0, deleted: 2 },
      options: { unchanged: 0, updated: 0, created: 0, deleted: 2 },
      prices: { unchanged: 0, updated: 0, created: 0, deleted: 0 },
      affectedDraftDocuments: 2,
    });
    expect(diff.products.deleted.map((d) => d.code).sort()).toEqual(["EL-2020", "M-5180"]);
    expect(isNoOpDiff(diff)).toBe(false);
  });

  it("an empty catalogue with a file of new rows creates everything", () => {
    const snapshot = tinySnapshot();
    snapshot.products = [];
    snapshot.options = [];
    const parsed: ParsedCatalog = {
      products: [
        {
          row: 2,
          id: null,
          code: "N-1",
          series: "M",
          name: "New",
          description: null,
          kind: "ACCESSORY",
          form: null,
          specs: null,
          isCredit: false,
          noCommission: false,
          active: true,
          sortOrder: 0,
          imageUrl: null,
        },
      ],
      options: [],
      prices: [{ row: 2, itemType: "product", itemId: null, itemCode: "N-1", region: "AU", amount: 10, needsReview: false }],
    };
    const diff = diffCatalog(parsed, snapshot);
    expect(diff.counts.products).toEqual({ unchanged: 0, updated: 0, created: 1, deleted: 0 });
    expect(diff.counts.prices).toEqual({ unchanged: 0, updated: 0, created: 1, deleted: 0 });
  });

  it("sameCounts compares the whole counts object", () => {
    const snapshot = tinySnapshot();
    const a = diffOf(sheetsOf(snapshot), snapshot);
    const sheets = sheetsOf(snapshot);
    setCell(sheets.products, "M-5180", "name", "x");
    const b = diffOf(sheets, snapshot);
    expect(sameCounts(a.counts, a.counts)).toBe(true);
    expect(sameCounts(a.counts, b.counts)).toBe(false);
  });
});
