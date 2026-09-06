import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";
import {
  type CatalogExportSnapshot,
  type ExportOption,
  type ExportProduct,
  OPTION_COLUMNS,
  PRICE_COLUMNS,
  PRODUCT_COLUMNS,
  SHEET_NAMES,
  buildCatalogSheets,
  buildCatalogWorkbook,
  defaultExportPath,
  orderedProducts,
  priceRows,
  readmeLines,
} from "../src/lib/catalog-xlsx/export";

const ROOT = path.resolve(__dirname, "..");

/** Row shape written by scripts/dump-catalog.ts (predates the identity columns). */
type Dump = {
  dumpedAt: string;
  regions: { code: string; name: string }[];
  series: { id: string; code: string; name: string; sortOrder: number }[];
  products: {
    id: string;
    code: string;
    series: string;
    name: string;
    description: string | null;
    specs: unknown;
    active: boolean;
    isCredit: boolean;
    noCommission: boolean;
    imageUrl: string | null;
    prices: Record<string, { amount: string; needsReview: boolean }>;
  }[];
  options: {
    id: string;
    code: string;
    name: string;
    shortDescription: string | null;
    attributeSchema: unknown;
    active: boolean;
    noCommission: boolean;
    imageUrl: string | null;
    compatSeries: string[];
    compatProducts: string[];
    prices: Record<string, { amount: string; needsReview: boolean }>;
  }[];
};

const CURRENCY: Record<string, string> = { AU: "AUD", US: "USD", UK: "GBP" };

/** Map the pre-identity dump into the export snapshot, defaulting the columns it lacks. */
function snapshotFromDump(dump: Dump): CatalogExportSnapshot {
  return {
    generatedAt: dump.dumpedAt,
    regions: dump.regions.map((r) => ({ ...r, currency: CURRENCY[r.code] ?? r.code })),
    series: dump.series,
    products: dump.products.map((p, i) => ({
      ...p,
      kind: "ACCESSORY",
      form: null,
      contentBlockKey: null,
      sortOrder: i,
    })),
    options: dump.options.map((o, i) => ({
      ...o,
      role: null,
      parentProduct: null,
      unitLengthM: null,
      contentBlockKey: null,
      sortOrder: i,
    })),
  };
}

const dumpPath = existsSync(path.join(ROOT, "tests/fixtures/catalog-dump.json"))
  ? path.join(ROOT, "tests/fixtures/catalog-dump.json")
  : path.join(ROOT, "RAW/catalog-dump.json");
const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
const snapshot = snapshotFromDump(dump);

/** Small hand-built snapshot exercising every column shape. */
function tiny(): CatalogExportSnapshot {
  const product: ExportProduct = {
    id: "p1",
    code: "M-5180",
    series: "M",
    name: "M-Series 5cm x 180cm",
    description: null,
    kind: "MACHINE",
    form: "M_SERIES",
    specs: { cutHeightCm: 5, cutWidthCm: 180 },
    contentBlockKey: "machine.m-series",
    isCredit: false,
    noCommission: false,
    active: true,
    sortOrder: 2,
    imageUrl: null,
    prices: { US: { amount: "199000.00", needsReview: false }, AU: { amount: "150000", needsReview: true } },
  };
  const product2: ExportProduct = {
    ...product,
    id: "p2",
    code: "EL-2020",
    series: "EL",
    kind: "TABLE",
    form: "EASYLOADER",
    specs: null,
    contentBlockKey: null,
    sortOrder: 0,
    prices: {},
  };
  const option: ExportOption = {
    id: "o1",
    code: "EL-2020-DM12",
    name: "Drive module 1.2 m",
    shortDescription: "First module",
    role: "DM",
    parentProduct: "EL-2020",
    unitLengthM: "1.20",
    compatSeries: [],
    compatProducts: ["EL-2020"],
    contentBlockKey: null,
    noCommission: false,
    active: true,
    sortOrder: 1,
    imageUrl: "/images/dm.png",
    attributeSchema: [{ key: "metres", type: "number" }],
    prices: { AU: { amount: "4200", needsReview: false } },
  };
  const option2: ExportOption = {
    ...option,
    id: "o2",
    code: "ABR-M",
    role: "ABR",
    parentProduct: null,
    unitLengthM: null,
    compatSeries: ["M", "X"],
    compatProducts: [],
    imageUrl: null,
    attributeSchema: null,
    prices: { AU: { amount: 1950, needsReview: false } },
  };
  return {
    generatedAt: "2026-09-06T00:00:00.000Z",
    regions: [
      { code: "AU", name: "Australia", currency: "AUD" },
      { code: "US", name: "United States", currency: "USD" },
    ],
    series: [
      { id: "s-el", code: "EL", name: "EasyLoader", sortOrder: 5 },
      { id: "s-m", code: "M", name: "M-Series", sortOrder: 1 },
    ],
    products: [product2, product],
    options: [option, option2],
  };
}

describe("catalog export builder — rows", () => {
  it("emits the agreed column headers", () => {
    const sheets = buildCatalogSheets(tiny());
    expect(sheets.products[0]).toEqual([...PRODUCT_COLUMNS]);
    expect(sheets.options[0]).toEqual([...OPTION_COLUMNS]);
    expect(sheets.prices[0]).toEqual([...PRICE_COLUMNS]);
    expect(PRODUCT_COLUMNS[0]).toBe("id");
    expect(OPTION_COLUMNS[0]).toBe("id");
  });

  it("orders products by series sortOrder, then product sortOrder, then code", () => {
    const codes = orderedProducts(tiny()).map((p) => p.code);
    expect(codes).toEqual(["M-5180", "EL-2020"]);

    const ordered = orderedProducts(snapshot);
    const rank = new Map(snapshot.series.map((s) => [s.code, s.sortOrder]));
    for (let i = 1; i < ordered.length; i++) {
      expect(rank.get(ordered[i - 1].series)! <= rank.get(ordered[i].series)!).toBe(true);
    }
    expect(ordered).toHaveLength(snapshot.products.length);
  });

  it("writes typed cells: booleans, numbers, blanks, joined lists, compact JSON", () => {
    const sheets = buildCatalogSheets(tiny());
    const m = sheets.products[1];
    expect(m[PRODUCT_COLUMNS.indexOf("description")]).toBeNull();
    expect(m[PRODUCT_COLUMNS.indexOf("specs")]).toBe('{"cutHeightCm":5,"cutWidthCm":180}');
    expect(m[PRODUCT_COLUMNS.indexOf("active")]).toBe(true);
    expect(m[PRODUCT_COLUMNS.indexOf("sortOrder")]).toBe(2);

    const el = sheets.products[2];
    expect(el[PRODUCT_COLUMNS.indexOf("specs")]).toBeNull();

    const dm = sheets.options.find((r) => r[OPTION_COLUMNS.indexOf("code")] === "EL-2020-DM12")!;
    expect(dm[OPTION_COLUMNS.indexOf("parentProduct")]).toBe("EL-2020");
    expect(dm[OPTION_COLUMNS.indexOf("unitLengthM")]).toBe(1.2);
    expect(dm[OPTION_COLUMNS.indexOf("compatProducts")]).toBe("EL-2020");
    expect(dm[OPTION_COLUMNS.indexOf("compatSeries")]).toBeNull();
    expect(dm[OPTION_COLUMNS.indexOf("attributeSchema")]).toBe('[{"key":"metres","type":"number"}]');

    const abr = sheets.options.find((r) => r[OPTION_COLUMNS.indexOf("code")] === "ABR-M")!;
    expect(abr[OPTION_COLUMNS.indexOf("compatSeries")]).toBe("M; X");
    expect(abr[OPTION_COLUMNS.indexOf("unitLengthM")]).toBeNull();
    // options ordered by code
    expect(sheets.options.slice(1).map((r) => r[1])).toEqual(["ABR-M", "EL-2020-DM12"]);
  });

  it("emits one price row per item x region with currency, ordered product/option, code, region", () => {
    const rows = priceRows(tiny());
    expect(rows.map((r) => [r.itemType, r.code, r.region, r.currency, r.amount, r.needsReview])).toEqual([
      ["product", "M-5180", "AU", "AUD", 150000, true],
      ["product", "M-5180", "US", "USD", 199000, false],
      ["option", "ABR-M", "AU", "AUD", 1950, false],
      ["option", "EL-2020-DM12", "AU", "AUD", 4200, false],
    ]);
    expect(rows.every((r) => typeof r.amount === "number")).toBe(true);
  });

  it("covers every price in the dump", () => {
    const expected =
      snapshot.products.reduce((n, p) => n + Object.keys(p.prices).length, 0) +
      snapshot.options.reduce((n, o) => n + Object.keys(o.prices).length, 0);
    expect(priceRows(snapshot)).toHaveLength(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it("rejects a price in an unknown region", () => {
    const s = tiny();
    s.products[0].prices = { XX: { amount: "1", needsReview: false } };
    expect(() => priceRows(s)).toThrow(/unknown region "XX"/);
  });

  it("README states the editing rules and the timestamp in 6-10 lines", () => {
    const lines = readmeLines(tiny());
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(lines.length).toBeLessThanOrEqual(10);
    const all = lines.join("\n");
    expect(all).toContain("2026-09-06T00:00:00.000Z");
    expect(all).toMatch(/id column .*never be edited/);
    expect(all).toMatch(/code column may be edited/);
    expect(all).toMatch(/deleted from the catalogue on import/);
  });

  it("default path is RAW/catalog-export-<date>.xlsx", () => {
    expect(defaultExportPath(new Date(2026, 8, 6, 12))).toBe("RAW/catalog-export-2026-09-06.xlsx");
  });
});

describe("catalog export builder — workbook round-trip", () => {
  it("writes a workbook from RAW/catalog-dump.json that SheetJS reads back", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "catalog-export-"));
    try {
      const file = path.join(dir, "catalog.xlsx");
      XLSX.writeFile(buildCatalogWorkbook(snapshot), file);

      // cellStyles: true is what makes SheetJS read <cols> back into ws["!cols"].
      const wb = XLSX.readFile(file, { cellStyles: true });
      expect(wb.SheetNames).toEqual([SHEET_NAMES.readme, SHEET_NAMES.products, SHEET_NAMES.options, SHEET_NAMES.prices]);

      const products = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[SHEET_NAMES.products], { header: 1 });
      const options = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[SHEET_NAMES.options], { header: 1 });
      const prices = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[SHEET_NAMES.prices], { header: 1 });
      expect(products[0]).toEqual([...PRODUCT_COLUMNS]);
      expect(options[0]).toEqual([...OPTION_COLUMNS]);
      expect(prices[0]).toEqual([...PRICE_COLUMNS]);
      expect(products).toHaveLength(snapshot.products.length + 1);
      expect(options).toHaveLength(snapshot.options.length + 1);
      expect(prices).toHaveLength(priceRows(snapshot).length + 1);

      // A couple of cell values survive the trip with their types.
      const first = orderedProducts(snapshot)[0];
      expect(products[1][PRODUCT_COLUMNS.indexOf("id")]).toBe(first.id);
      expect(products[1][PRODUCT_COLUMNS.indexOf("code")]).toBe(first.code);
      expect(products[1][PRODUCT_COLUMNS.indexOf("series")]).toBe(first.series);
      expect(products[1][PRODUCT_COLUMNS.indexOf("active")]).toBe(first.active);
      expect(products[1][PRODUCT_COLUMNS.indexOf("sortOrder")]).toBe(first.sortOrder);

      const p0 = priceRows(snapshot)[0];
      expect(prices[1]).toEqual([p0.itemType, p0.itemId, p0.code, p0.region, p0.currency, p0.amount, p0.needsReview]);

      // Header formatting hooks: widths for readability, autofilter on the header row.
      for (const name of [SHEET_NAMES.products, SHEET_NAMES.options, SHEET_NAMES.prices]) {
        const ws = wb.Sheets[name];
        expect(ws["!autofilter"]?.ref.startsWith("A1:")).toBe(true);
        expect(ws["!cols"]?.length).toBeGreaterThan(0);
      }

      const readme = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[SHEET_NAMES.readme], { header: 1 });
      expect(readme[0][0]).toBe("PathQuote catalogue export");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
