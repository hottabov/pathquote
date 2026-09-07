// Fixtures for the catalogue workbook engine (src/lib/catalog-xlsx/*),
// shared by the parse, diff, apply-plan and round-trip test files. Same
// rules as ./fixtures.ts: builders return fresh values, and nothing here
// touches `@/lib/db` or `next/*`.
import type { CatalogSnapshot, SnapshotOption, SnapshotProduct } from "../../src/lib/catalog-xlsx/snapshot";
import type { Cell } from "../../src/lib/catalog-xlsx/columns";
import { buildCatalogSheets } from "../../src/lib/catalog-xlsx/export";
import type { CatalogSheets } from "../../src/lib/catalog-xlsx/parse";

export function product(overrides: Partial<SnapshotProduct> = {}): SnapshotProduct {
  return {
    id: "p1",
    code: "M-5180",
    series: "M",
    name: "M-Series 5cm x 180cm",
    description: null,
    kind: "MACHINE",
    form: "M_SERIES",
    specs: { cutHeightCm: 5, cutWidthCm: 180 },
    isCredit: false,
    noCommission: false,
    active: true,
    sortOrder: 2,
    imageUrl: null,
    prices: { US: { amount: "199000.00", needsReview: false }, AU: { amount: "150000", needsReview: true } },
    refs: { draftDocumentIds: [], finalDocuments: 0 },
    ...overrides,
  };
}

export function option(overrides: Partial<SnapshotOption> = {}): SnapshotOption {
  return {
    id: "o1",
    code: "EL-2020-DM12",
    name: "Drive module 1.2 m",
    shortDescription: "First module",
    role: "EL_DRIVE",
    parentProduct: "EL-2020",
    unitLengthM: "1.20",
    compatSeries: [],
    compatProducts: ["EL-2020"],
    noCommission: false,
    active: true,
    sortOrder: 1,
    imageUrl: "/api/files/0f0e1d2c-3b4a-4596-8778-99aabbccddee.png",
    attributeSchema: [{ key: "metres", type: "number" }],
    prices: { AU: { amount: "4200", needsReview: false } },
    refs: { draftDocumentIds: [], finalDocuments: 0 },
    ...overrides,
  };
}

/** Two products (one machine, one EasyLoader table), two options (a module
 * owned by the table, a series-compatible accessory), two regions. */
export function tinySnapshot(): CatalogSnapshot {
  return {
    generatedAt: "2026-09-06T00:00:00.000Z",
    regions: [
      { code: "AU", name: "Australia", currency: "AUD" },
      { code: "US", name: "United States", currency: "USD" },
    ],
    series: [
      { id: "s-el", code: "EL", name: "EasyLoader", sortOrder: 5 },
      { id: "s-m", code: "M", name: "M-Series", sortOrder: 1 },
      { id: "s-x", code: "X", name: "X-Calibre", sortOrder: 2 },
    ],
    products: [
      product({
        id: "p2",
        code: "EL-2020",
        series: "EL",
        name: "EasyLoader 2020",
        kind: "TABLE",
        form: "EASYLOADER",
        specs: null,
        sortOrder: 0,
        prices: {},
        refs: { draftDocumentIds: ["d1", "d2"], finalDocuments: 3 },
      }),
      product(),
    ],
    options: [
      option(),
      option({
        id: "o2",
        code: "ABR-M",
        name: "Abrasive kit",
        role: "ABR",
        parentProduct: null,
        unitLengthM: null,
        compatSeries: ["M", "X"],
        compatProducts: [],
        imageUrl: null,
        attributeSchema: null,
        prices: { AU: { amount: 1950, needsReview: false } },
        refs: { draftDocumentIds: ["d2"], finalDocuments: 1 },
      }),
    ],
  };
}

/** The three data sheets exactly as the export would write them. */
export function sheetsOf(snapshot: CatalogSnapshot): CatalogSheets {
  const s = buildCatalogSheets(snapshot);
  return { products: s.products, options: s.options, prices: s.prices };
}

/** Column index by header name, for editing a cell in a fixture sheet. */
export function col(sheet: Cell[][], name: string): number {
  const i = sheet[0].indexOf(name);
  if (i < 0) throw new Error(`no column ${name}`);
  return i;
}

/** The data row (1-based, excluding the header) whose `code` column is `code`. */
export function rowOf(sheet: Cell[][], code: string, column = "code"): Cell[] {
  const c = col(sheet, column);
  const row = sheet.slice(1).find((r) => r[c] === code);
  if (!row) throw new Error(`no row with ${column}=${code}`);
  return row;
}

export function setCell(sheet: Cell[][], code: string, column: string, value: Cell, keyColumn = "code"): void {
  rowOf(sheet, code, keyColumn)[col(sheet, column)] = value;
}
