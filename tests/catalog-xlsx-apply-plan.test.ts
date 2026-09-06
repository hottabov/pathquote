import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { buildCatalogWorkbook } from "../src/lib/catalog-xlsx/export";
import { parseCatalogSheets, readCatalogWorkbook, type CatalogSheets } from "../src/lib/catalog-xlsx/parse";
import { diffCatalog, isNoOpDiff } from "../src/lib/catalog-xlsx/diff";
import { buildApplyPlan, type ApplyOp, type ApplyPlan } from "../src/lib/catalog-xlsx/apply-plan";
import type { CatalogSnapshot } from "../src/lib/catalog-xlsx/snapshot";
import { col, setCell, sheetsOf, tinySnapshot } from "./helpers/catalog-xlsx";

function planOf(sheets: CatalogSheets, snapshot: CatalogSnapshot): ApplyPlan {
  const { parsed, errors } = parseCatalogSheets(sheets, snapshot);
  expect(errors).toEqual([]);
  return buildApplyPlan(diffCatalog(parsed, snapshot), parsed);
}

const kinds = (plan: ApplyPlan) => plan.map((op) => op.op);

/** Index of the first op of each kind, for ordering assertions. */
function firstIndex(plan: ApplyPlan, op: ApplyOp["op"]): number {
  return plan.findIndex((o) => o.op === op);
}
function lastIndex(plan: ApplyPlan, op: ApplyOp["op"]): number {
  return plan.length - 1 - [...plan].reverse().findIndex((o) => o.op === op);
}

describe("buildApplyPlan", () => {
  it("an unchanged file yields an empty plan", () => {
    const snapshot = tinySnapshot();
    expect(planOf(sheetsOf(snapshot), snapshot)).toEqual([]);
  });

  it("orders: detach + delete (options before products), release codes, products, options, compat, prices", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    // Delete ABR-M (option) and EL-2020 (product) with its module; rename
    // M-5180; add a product and an option with prices; change a price.
    sheets.options = sheets.options.filter((r) => !["ABR-M", "EL-2020-DM12"].includes(String(r[col(sheets.options, "code")])));
    sheets.products = sheets.products.filter((r) => r[col(sheets.products, "code")] !== "EL-2020");
    sheets.prices = sheets.prices.filter((r) => r[col(sheets.prices, "itemType")] !== "option");
    setCell(sheets.products, "M-5180", "code", "M5-180");
    sheets.products.push([null, "M", "M-7180", "New machine", null, "MACHINE", "M_SERIES", null, null, false, false, true, 1, null]);
    sheets.options.push([null, "HFV", "High-flow vacuum", null, "HFV", null, null, "M", "M-7180", null, false, true, 0, null, null]);
    sheets.prices.push(["product", null, "M-7180", "AU", "AUD", 210000, false]);
    sheets.prices.push(["option", null, "HFV", "AU", "AUD", 900, false]);
    const amount = col(sheets.prices, "amount");
    sheets.prices[2][amount] = 1;
    const plan = planOf(sheets, snapshot);

    expect(kinds(plan)).toEqual([
      "detachDraftReferences", // ABR-M (o2)
      "detachDraftReferences", // EL-2020-DM12 (o1)
      "detachDraftReferences", // EL-2020 (p2)
      "deleteOption",
      "deleteOption",
      "deleteProduct",
      "releaseCode", // M-5180 -> M5-180
      "updateProduct", // M-5180 (renamed)
      "createProduct", // M-7180
      "createOption", // HFV
      "replaceOptionCompat", // HFV
      "upsertPrice", // M-7180 AU
      "upsertPrice", // HFV AU
      "upsertPrice", // M5-180 US (amount 1)
    ]);

    // The detach ops precede every delete, and deletes precede every write.
    expect(lastIndex(plan, "detachDraftReferences")).toBeLessThan(firstIndex(plan, "deleteOption"));
    expect(lastIndex(plan, "deleteOption")).toBeLessThan(firstIndex(plan, "deleteProduct"));
    expect(lastIndex(plan, "deleteProduct")).toBeLessThan(firstIndex(plan, "releaseCode"));
    expect(lastIndex(plan, "releaseCode")).toBeLessThan(firstIndex(plan, "updateProduct"));
    expect(lastIndex(plan, "createProduct")).toBeLessThan(firstIndex(plan, "createOption"));
    expect(lastIndex(plan, "createOption")).toBeLessThan(firstIndex(plan, "replaceOptionCompat"));
    expect(lastIndex(plan, "replaceOptionCompat")).toBeLessThan(firstIndex(plan, "upsertPrice"));

    const detach = plan.filter((o) => o.op === "detachDraftReferences");
    expect(detach.map((o) => o.op === "detachDraftReferences" && [o.itemType, o.code])).toEqual([
      ["option", "EL-2020-DM12"],
      ["option", "ABR-M"],
      ["product", "EL-2020"],
    ]);
    const release = plan.find((o) => o.op === "releaseCode");
    expect(release).toEqual({ op: "releaseCode", itemType: "product", id: "p1" });
    const update = plan.find((o) => o.op === "updateProduct");
    expect(update).toMatchObject({ op: "updateProduct", id: "p1", data: { code: "M5-180", series: "M", kind: "MACHINE" } });
    const created = plan.find((o) => o.op === "createOption");
    expect(created).toMatchObject({ op: "createOption", code: "HFV", data: { role: "HFV", parentProduct: null } });
    const compat = plan.find((o) => o.op === "replaceOptionCompat");
    expect(compat).toEqual({ op: "replaceOptionCompat", option: { newCode: "HFV" }, compatSeries: ["M"], compatProducts: ["M-7180"] });
    const prices = plan.filter((o) => o.op === "upsertPrice");
    expect(prices).toEqual([
      { op: "upsertPrice", itemType: "product", item: { newCode: "M-7180" }, region: "AU", amount: 210000, needsReview: false },
      { op: "upsertPrice", itemType: "option", item: { newCode: "HFV" }, region: "AU", amount: 900, needsReview: false },
      { op: "upsertPrice", itemType: "product", item: { id: "p1" }, region: "US", amount: 1, needsReview: false },
    ]);
  });

  it("only releases the code of rows whose code actually changes", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    setCell(sheets.products, "M-5180", "name", "renamed name only");
    setCell(sheets.options, "ABR-M", "code", "ABR-M2");
    const plan = planOf(sheets, snapshot);
    expect(kinds(plan)).toEqual(["releaseCode", "updateProduct", "updateOption"]);
    expect(plan[0]).toEqual({ op: "releaseCode", itemType: "option", id: "o2" });
  });

  it("replaces compat only for updated options whose compat lists changed", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    setCell(sheets.options, "ABR-M", "compatSeries", "M");
    setCell(sheets.options, "EL-2020-DM12", "sortOrder", 5);
    const plan = planOf(sheets, snapshot);
    expect(kinds(plan)).toEqual(["updateOption", "updateOption", "replaceOptionCompat"]);
    expect(plan[2]).toEqual({ op: "replaceOptionCompat", option: { id: "o2" }, compatSeries: ["M"], compatProducts: [] });
  });

  it("deletes a price by the surviving item's id, and never for a deleted item", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    const codeCol = col(sheets.prices, "code");
    const region = col(sheets.prices, "region");
    sheets.prices = sheets.prices.filter((r) => !(r[codeCol] === "M-5180" && r[region] === "US") && r[codeCol] !== "ABR-M");
    sheets.options = sheets.options.filter((r) => r[col(sheets.options, "code")] !== "ABR-M");
    const plan = planOf(sheets, snapshot);
    expect(kinds(plan)).toEqual(["detachDraftReferences", "deleteOption", "deletePrice"]);
    expect(plan[2]).toEqual({ op: "deletePrice", itemType: "product", item: { id: "p1" }, region: "US" });
  });

  it("a deleted product re-added without its id is delete-then-create, so the code is free again", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    setCell(sheets.products, "M-5180", "id", null);
    // Its price rows must follow: with the old id still on them the parser
    // refuses the file (see the "price left behind" rule in parse.ts).
    const itemId = col(sheets.prices, "itemId");
    for (const row of sheets.prices.slice(1)) if (row[itemId] === "p1") row[itemId] = null;
    const plan = planOf(sheets, snapshot);
    expect(kinds(plan)).toEqual(["detachDraftReferences", "deleteProduct", "createProduct", "upsertPrice", "upsertPrice"]);
    expect(plan[1]).toEqual({ op: "deleteProduct", id: "p1", code: "M-5180" });
    expect(plan[2]).toMatchObject({ op: "createProduct", code: "M-5180" });
    expect(plan[3]).toMatchObject({ op: "upsertPrice", item: { newCode: "M-5180" } });
  });
});

describe("round trip: export -> workbook -> parse -> diff", () => {
  it("an unedited export diffs to all-unchanged and an empty plan", () => {
    const snapshot = tinySnapshot();
    const bytes = XLSX.write(buildCatalogWorkbook(snapshot), { type: "buffer", bookType: "xlsx" }) as Uint8Array;
    const read = readCatalogWorkbook(bytes);
    expect(read.sheets).not.toBeNull();
    const { parsed, errors } = parseCatalogSheets(read.sheets!, snapshot);
    expect(errors).toEqual([]);
    const diff = diffCatalog(parsed, snapshot);
    expect(isNoOpDiff(diff)).toBe(true);
    expect(diff.counts.products.unchanged).toBe(snapshot.products.length);
    expect(diff.counts.options.unchanged).toBe(snapshot.options.length);
    expect(diff.counts.prices.unchanged).toBe(4);
    expect(buildApplyPlan(diff, parsed)).toEqual([]);
  });
});
