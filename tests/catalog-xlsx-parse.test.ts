import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import {
  OPTION_ROLES,
  PRODUCT_KINDS,
  PRODUCTION_FORMS,
  PRODUCT_COLUMNS,
  OPTION_COLUMNS,
  PRICE_COLUMNS,
  RETIRED_COLUMNS,
  SHEET_NAMES,
} from "../src/lib/catalog-xlsx/columns";
import { buildCatalogWorkbook } from "../src/lib/catalog-xlsx/export";
import {
  isCatalogSheets,
  parseCatalogSheets,
  readCatalogWorkbook,
  workbookToSheets,
  type ImportError,
} from "../src/lib/catalog-xlsx/parse";
import { col, rowOf, setCell, sheetsOf, tinySnapshot } from "./helpers/catalog-xlsx";

const ROOT = path.resolve(__dirname, "..");

/** The values of `enum Name { ... }` in prisma/schema.prisma, comments stripped. */
function schemaEnum(name: string): string[] {
  const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
  const match = schema.match(new RegExp(`enum ${name} \\{([\\s\\S]*?)\\}`));
  if (!match) throw new Error(`enum ${name} not found`);
  return match[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0);
}

function messages(errors: ImportError[]): string[] {
  return errors.map((e) => `${e.sheet}!${e.row}:${e.column ?? "-"} ${e.message}`);
}

function expectError(errors: ImportError[], sheet: string, row: number, column: string | null, pattern: RegExp) {
  const hit = errors.find((e) => e.sheet === sheet && e.row === row && e.column === column && pattern.test(e.message));
  expect(hit, `expected ${sheet}!${row}:${column} ${pattern}\n got:\n${messages(errors).join("\n")}`).toBeDefined();
}

describe("catalog-xlsx columns — enum lists mirror prisma/schema.prisma", () => {
  it("ProductKind", () => expect([...PRODUCT_KINDS]).toEqual(schemaEnum("ProductKind")));
  it("ProductionForm", () => expect([...PRODUCTION_FORMS]).toEqual(schemaEnum("ProductionForm")));
  it("OptionRole", () => expect([...OPTION_ROLES]).toEqual(schemaEnum("OptionRole")));
});

describe("parseCatalogSheets — happy path", () => {
  it("parses an unedited export back into typed rows with no errors", () => {
    const snapshot = tinySnapshot();
    const { parsed, errors } = parseCatalogSheets(sheetsOf(snapshot), snapshot);
    expect(errors).toEqual([]);
    expect(parsed.products).toHaveLength(2);
    expect(parsed.options).toHaveLength(2);
    expect(parsed.prices).toHaveLength(4);

    const m = parsed.products.find((p) => p.code === "M-5180")!;
    expect(m.id).toBe("p1");
    expect(m.specs).toEqual({ cutHeightCm: 5, cutWidthCm: 180 });
    expect(m.kind).toBe("MACHINE");
    expect(m.form).toBe("M_SERIES");
    expect(m.active).toBe(true);
    expect(m.sortOrder).toBe(2);
    expect(m.description).toBeNull();

    const dm = parsed.options.find((o) => o.code === "EL-2020-DM12")!;
    expect(dm.parentProduct).toBe("EL-2020");
    expect(dm.unitLengthM).toBe(1.2);
    expect(dm.compatProducts).toEqual(["EL-2020"]);
    expect(dm.attributeSchema).toEqual([{ key: "metres", type: "number" }]);
    const abr = parsed.options.find((o) => o.code === "ABR-M")!;
    expect(abr.compatSeries).toEqual(["M", "X"]);
    expect(abr.role).toBe("ABR");

    const price = parsed.prices.find((p) => p.itemCode === "M-5180" && p.region === "AU")!;
    expect(price).toMatchObject({ itemType: "product", itemId: "p1", amount: 150000, needsReview: true });
  });

  it("reads the workbook the export builder writes (SheetJS in memory)", () => {
    const snapshot = tinySnapshot();
    const bytes = XLSX.write(buildCatalogWorkbook(snapshot), { type: "buffer", bookType: "xlsx" }) as Uint8Array;
    const read = readCatalogWorkbook(bytes);
    expect(read.errors).toEqual([]);
    expect(read.sheets).not.toBeNull();
    expect(read.sheets!.products[0]).toEqual([...PRODUCT_COLUMNS]);
    expect(read.sheets!.options[0]).toEqual([...OPTION_COLUMNS]);
    expect(read.sheets!.prices[0]).toEqual([...PRICE_COLUMNS]);
    expect(isCatalogSheets(read.sheets)).toBe(true);
    const { errors } = parseCatalogSheets(read.sheets!, snapshot);
    expect(errors).toEqual([]);
  });

  it("rejects bytes that are not a workbook", () => {
    // SheetJS reads plain text as a one-sheet CSV rather than throwing, so
    // the failure surfaces as the data sheets being missing; either way the
    // caller gets `sheets: null` and a sheet-level error.
    const read = readCatalogWorkbook(new TextEncoder().encode("not a workbook"));
    expect(read.sheets).toBeNull();
    expect(read.errors.length).toBeGreaterThan(0);
    expect(read.errors[0].row).toBe(0);
  });

  it("accepts a blank id as a new row, lenient booleans, numeric strings and lowercase enums", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    sheets.products.push([null, "M", "M-7180", "New machine", null, "machine", "m_series", null, "yes", 0, "FALSE", "3", null]);
    const { parsed, errors } = parseCatalogSheets(sheets, snapshot);
    expect(errors).toEqual([]);
    const created = parsed.products.find((p) => p.code === "M-7180")!;
    expect(created.id).toBeNull();
    expect(created.kind).toBe("MACHINE");
    expect(created.form).toBe("M_SERIES");
    expect(created.isCredit).toBe(true);
    expect(created.noCommission).toBe(false);
    expect(created.active).toBe(false);
    expect(created.sortOrder).toBe(3);
  });

  it("defaults blank kind to ACCESSORY, blank active to TRUE, blank sortOrder to 0", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    sheets.products.push([null, "M", "HDRF", "Roll feeder", null, null, null, null, null, null, null, null, null]);
    const { parsed, errors } = parseCatalogSheets(sheets, snapshot);
    expect(errors).toEqual([]);
    const created = parsed.products.find((p) => p.code === "HDRF")!;
    expect(created.kind).toBe("ACCESSORY");
    expect(created.active).toBe(true);
    expect(created.sortOrder).toBe(0);
  });

  it("ignores fully blank rows and accepts columns in any order", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    sheets.products.push([null, null, null, null, null, null, null, null, null, null, null, null, null]);
    sheets.products.push(["", "", "", "", "", "", "", "", "", "", "", "", ""]);
    // Reverse the Options columns wholesale.
    sheets.options = sheets.options.map((row) => [...row].reverse());
    const { parsed, errors } = parseCatalogSheets(sheets, snapshot);
    expect(errors).toEqual([]);
    expect(parsed.products).toHaveLength(2);
    expect(parsed.options.find((o) => o.code === "EL-2020-DM12")!.parentProduct).toBe("EL-2020");
  });

  it("identifies a price for a new item by code, and by itemId for an existing one even when its code is stale", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    sheets.products.push([null, "M", "M-7180", "New machine", null, "MACHINE", null, null, false, false, true, 0, null]);
    sheets.prices.push(["product", null, "M-7180", "AU", "AUD", 210000, false]);
    // Rename M-5180 in Products but leave the Prices sheet's code column as it was.
    setCell(sheets.products, "M-5180", "code", "M-5180-R");
    const { parsed, errors } = parseCatalogSheets(sheets, snapshot);
    expect(errors).toEqual([]);
    expect(parsed.prices.find((p) => p.itemCode === "M-7180")).toMatchObject({ itemId: null, amount: 210000 });
    const renamed = parsed.prices.filter((p) => p.itemId === "p1");
    expect(renamed).toHaveLength(2);
    expect(renamed.every((p) => p.itemCode === "M-5180-R")).toBe(true);
  });
});

describe("parseCatalogSheets — every error kind, as sheet/row/column", () => {
  it("missing sheet", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[...PRODUCT_COLUMNS]]), SHEET_NAMES.products);
    const { sheets, errors } = workbookToSheets(wb);
    expect(sheets).toBeNull();
    expect(messages(errors)).toEqual(['Options!0:- Sheet "Options" is missing', 'Prices!0:- Sheet "Prices" is missing']);
  });

  it("unknown, missing and duplicated headers", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    sheets.products[0][col(sheets.products, "imageUrl")] = "image";
    sheets.options[0][col(sheets.options, "name")] = "code";
    const { errors } = parseCatalogSheets(sheets, snapshot);
    expectError(errors, "Products", 1, "image", /Unknown column/);
    expectError(errors, "Products", 1, "imageUrl", /is missing/);
    expectError(errors, "Options", 1, "code", /appears twice/);
    expectError(errors, "Options", 1, "name", /is missing/);
    // A broken header stops that sheet's rows from being parsed; the Prices
    // rows that point at its items then read as pointing at deleted rows.
    expect(errors.filter((e) => e.sheet === "Prices").length).toBeGreaterThan(0);
  });

  it("still imports a workbook exported before contentBlockKey was dropped", () => {
    // The in-flight spreadsheet case: somebody exported the catalogue before
    // z37_drop_content_block, has been editing it since, and uploads it now.
    // Their file carries a column this contract no longer knows. Rejecting it
    // as an unknown header would cost them the whole file for a column whose
    // values nothing reads any more, so `RETIRED_COLUMNS` skips it by name.
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    for (const sheet of [sheets.products, sheets.options]) {
      sheet[0].push("contentBlockKey");
      for (const row of sheet.slice(1)) row.push("machine.m-series");
    }
    const { parsed, errors } = parseCatalogSheets(sheets, snapshot);
    expect(errors).toEqual([]);
    expect(parsed.products.map((p) => p.code).sort()).toEqual(["EL-2020", "M-5180"]);
    expect(parsed.options.map((o) => o.code).sort()).toEqual(["ABR-M", "EL-2020-DM12"]);
    // Nothing is read off it, and nothing is written back: the stale column
    // disappears from that copy the first time it is round-tripped.
    expect(Object.keys(parsed.products[0])).not.toContain("contentBlockKey");
    expect(RETIRED_COLUMNS).toContain("contentBlockKey");
    expect(PRODUCT_COLUMNS).not.toContain("contentBlockKey");
    expect(OPTION_COLUMNS).not.toContain("contentBlockKey");
  });

  it("unknown enum values (kind, form, role)", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    setCell(sheets.products, "M-5180", "kind", "CUTTER");
    setCell(sheets.products, "M-5180", "form", "M-SERIES");
    setCell(sheets.options, "ABR-M", "role", "ABRASIVE");
    const { errors } = parseCatalogSheets(sheets, snapshot);
    // Products are exported by series sortOrder: M-5180 (M, 1) is row 2,
    // EL-2020 (EL, 5) is row 3.
    expectError(errors, "Products", 2, "kind", /must be one of MACHINE/);
    expectError(errors, "Products", 2, "form", /must be one of M_SERIES/);
    expectError(errors, "Options", 2, "role", /must be one of ABR/);
  });

  it("bad JSON and specs that fail productSpecsSchema; bad attributeSchema shape", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    setCell(sheets.products, "M-5180", "specs", "{cutHeightCm: 5}");
    setCell(sheets.products, "EL-2020", "specs", '{"cutHeightCm":-1,"colour":"red"}');
    setCell(sheets.options, "ABR-M", "attributeSchema", "[1,");
    setCell(sheets.options, "EL-2020-DM12", "attributeSchema", '"just a string"');
    const { errors } = parseCatalogSheets(sheets, snapshot);
    expectError(errors, "Products", 2, "specs", /not valid JSON/);
    expectError(errors, "Products", 3, "specs", /specs: /);
    expectError(errors, "Options", 2, "attributeSchema", /not valid JSON/);
    expectError(errors, "Options", 3, "attributeSchema", /array or object/);
  });

  it("non-numeric and negative numbers (amount, sortOrder, unitLengthM)", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    setCell(sheets.products, "M-5180", "sortOrder", "two");
    setCell(sheets.products, "EL-2020", "sortOrder", 1.5);
    setCell(sheets.options, "EL-2020-DM12", "unitLengthM", "1.2m");
    const priceRow = sheets.prices[1];
    priceRow[col(sheets.prices, "amount")] = -5;
    sheets.prices[2][col(sheets.prices, "amount")] = "abc";
    sheets.prices[3][col(sheets.prices, "amount")] = null;
    const { errors } = parseCatalogSheets(sheets, snapshot);
    expectError(errors, "Products", 2, "sortOrder", /must be a number/);
    expectError(errors, "Products", 3, "sortOrder", /whole number/);
    expectError(errors, "Options", 3, "unitLengthM", /must be a number/);
    expectError(errors, "Prices", 2, "amount", /0 or greater/);
    expectError(errors, "Prices", 3, "amount", /must be a number/);
    expectError(errors, "Prices", 4, "amount", /required/);
  });

  it("booleans that are neither TRUE nor FALSE", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    setCell(sheets.products, "M-5180", "active", "maybe");
    const { errors } = parseCatalogSheets(sheets, snapshot);
    expectError(errors, "Products", 2, "active", /TRUE or FALSE/);
    expect(errors).toHaveLength(1);
  });

  it("unknown series and region codes", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    setCell(sheets.products, "M-5180", "series", "Q");
    setCell(sheets.options, "ABR-M", "compatSeries", "M; Q");
    sheets.prices[1][col(sheets.prices, "region")] = "NZ";
    const { errors } = parseCatalogSheets(sheets, snapshot);
    expectError(errors, "Products", 2, "series", /Unknown series "Q"/);
    expectError(errors, "Options", 2, "compatSeries", /unknown series "Q"/);
    expectError(errors, "Prices", 2, "region", /Unknown region "NZ"/);
  });

  it("parentProduct / compatProducts must exist in the file's own Products sheet", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    // Delete EL-2020 from the file while the module still names it.
    sheets.products = sheets.products.filter((r) => r[col(sheets.products, "code")] !== "EL-2020");
    setCell(sheets.options, "ABR-M", "compatProducts", "NOPE");
    const { errors } = parseCatalogSheets(sheets, snapshot);
    expectError(errors, "Options", 3, "parentProduct", /not in the Products sheet \(this import would delete it\)/);
    expectError(errors, "Options", 3, "compatProducts", /not in the Products sheet/);
    expectError(errors, "Options", 2, "compatProducts", /unknown product "NOPE"/);
  });

  it("a rename in Products is honoured by the references (old code becomes unknown)", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    setCell(sheets.products, "EL-2020", "code", "EL-2020-V2");
    const { errors } = parseCatalogSheets(sheets, snapshot);
    expectError(errors, "Options", 3, "parentProduct", /not in the Products sheet/);
    setCell(sheets.options, "EL-2020-DM12", "parentProduct", "EL-2020-V2");
    setCell(sheets.options, "EL-2020-DM12", "compatProducts", "EL-2020-V2");
    expect(parseCatalogSheets(sheets, snapshot).errors).toEqual([]);
  });

  it("duplicate codes and duplicate ids within a sheet", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    setCell(sheets.products, "M-5180", "code", "EL-2020");
    sheets.options.push([...rowOf(sheets.options, "ABR-M")]);
    sheets.options[sheets.options.length - 1][col(sheets.options, "code")] = "ABR-M-2";
    const { errors } = parseCatalogSheets(sheets, snapshot);
    expectError(errors, "Products", 3, "code", /Product code "EL-2020" is already used on row 2/);
    expectError(errors, "Options", 4, "id", /Option id "o2" is already used on row 2/);
  });

  it("a price row left behind for an item this file deletes is an error, not silently dropped", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    sheets.options = sheets.options.filter((r) => r[col(sheets.options, "code")] !== "ABR-M");
    const { errors } = parseCatalogSheets(sheets, snapshot);
    expect(errors).toHaveLength(1);
    expectError(errors, "Prices", 4, "itemId", /not in the Options sheet \(this import would delete it\)/);
  });

  it("duplicate price for the same item x region", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    sheets.prices.push([...sheets.prices[1]]);
    const { errors } = parseCatalogSheets(sheets, snapshot);
    expectError(errors, "Prices", sheets.prices.length, "region", /Duplicate price .* \(see row 2\)/);
  });

  it("unknown id, missing required cells, bad code and image URL", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    setCell(sheets.products, "M-5180", "id", "p999");
    setCell(sheets.products, "EL-2020", "name", null);
    setCell(sheets.products, "EL-2020", "imageUrl", "https://example.com/x.png");
    setCell(sheets.options, "ABR-M", "code", "tab\there");
    sheets.prices[1][col(sheets.prices, "itemType")] = "bundle";
    sheets.prices[2][col(sheets.prices, "itemId")] = "p888";
    sheets.prices[3][col(sheets.prices, "itemId")] = null;
    sheets.prices[3][col(sheets.prices, "code")] = null;
    const { errors } = parseCatalogSheets(sheets, snapshot);
    expectError(errors, "Products", 2, "id", /Unknown product id "p999"/);
    expectError(errors, "Products", 3, "name", /required/);
    expectError(errors, "Products", 3, "imageUrl", /uploaded image URL/);
    expectError(errors, "Options", 2, "code", /printable ASCII/);
    expectError(errors, "Prices", 2, "itemType", /product or option/);
    expectError(errors, "Prices", 3, "itemId", /No product with id "p888"/);
    expectError(errors, "Prices", 4, "itemId", /required/);
  });

  it("a row with an error is left out of the parsed rows; the rest survive", () => {
    const snapshot = tinySnapshot();
    const sheets = sheetsOf(snapshot);
    setCell(sheets.products, "M-5180", "kind", "???");
    const { parsed, errors } = parseCatalogSheets(sheets, snapshot);
    // One error, not three: the row's two prices are not reported as
    // orphans on top of the problem that already excludes their row.
    expect(errors).toHaveLength(1);
    expect(parsed.products.map((p) => p.code)).toEqual(["EL-2020"]);
    expect(parsed.prices.some((p) => p.itemId === "p1")).toBe(false);
  });

  it("isCatalogSheets refuses anything that is not cell grids", () => {
    expect(isCatalogSheets(null)).toBe(false);
    expect(isCatalogSheets({ products: [], options: [] })).toBe(false);
    expect(isCatalogSheets({ products: [[{ a: 1 }]], options: [], prices: [] })).toBe(false);
    expect(isCatalogSheets({ products: [["id", 1, true, null]], options: [], prices: [] })).toBe(true);
  });
});
