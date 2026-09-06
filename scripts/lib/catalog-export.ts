/**
 * Pure builder for the director's catalogue workbook (Phase 5 of
 * docs/plans/2026-09-05-catalog-identity-and-cleanup.md; the export half of
 * docs/plans/2026-09-05-catalog-import-export.md).
 *
 * Snapshot in, SheetJS workbook out -- no database, no filesystem, so it can
 * be unit-tested against a JSON dump. scripts/export-catalog.ts is the IO
 * shell that reads the DB into `CatalogExportSnapshot` and writes the file.
 *
 * Four sheets: README (first), Products, Options, Prices. Every data row
 * leads with the row's database `id`: that is the join key the import reads
 * back, and it is deliberately visible rather than hidden.
 */
import * as XLSX from "xlsx";

// ---------------------------------------------------------------------------
// Snapshot shape (what the IO shell reads out of Prisma)
// ---------------------------------------------------------------------------

export type ExportPrice = {
  /** Decimal as string ("1950.00") or number; converted to a number cell. */
  amount: string | number;
  needsReview: boolean;
};

export type ExportRegion = { code: string; name: string; currency: string };

export type ExportSeries = { id: string; code: string; name: string; sortOrder: number };

export type ExportProduct = {
  id: string;
  code: string;
  legacyCodes: string[];
  /** Series.code */
  series: string;
  name: string;
  description: string | null;
  kind: string;
  form: string | null;
  specs: unknown;
  contentBlockKey: string | null;
  isCredit: boolean;
  noCommission: boolean;
  active: boolean;
  sortOrder: number;
  imageUrl: string | null;
  /** keyed by Region.code */
  prices: Record<string, ExportPrice>;
};

export type ExportOption = {
  id: string;
  code: string;
  legacyCodes: string[];
  name: string;
  shortDescription: string | null;
  role: string | null;
  /** Product.code of the owning product, or null */
  parentProduct: string | null;
  unitLengthM: string | number | null;
  compatSeries: string[];
  compatProducts: string[];
  contentBlockKey: string | null;
  noCommission: boolean;
  active: boolean;
  sortOrder: number;
  imageUrl: string | null;
  attributeSchema: unknown;
  prices: Record<string, ExportPrice>;
};

export type CatalogExportSnapshot = {
  /** ISO timestamp; printed in the README sheet. */
  generatedAt: string;
  regions: ExportRegion[];
  series: ExportSeries[];
  products: ExportProduct[];
  options: ExportOption[];
};

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** A cell value. `null` is written as a blank cell (SheetJS skips nulls). */
export type Cell = string | number | boolean | null;

export const PRODUCT_COLUMNS = [
  "id",
  "series",
  "code",
  "legacyCodes",
  "name",
  "description",
  "kind",
  "form",
  "specs",
  "contentBlockKey",
  "isCredit",
  "noCommission",
  "active",
  "sortOrder",
  "imageUrl",
] as const;

export const OPTION_COLUMNS = [
  "id",
  "code",
  "legacyCodes",
  "name",
  "shortDescription",
  "role",
  "parentProduct",
  "unitLengthM",
  "compatSeries",
  "compatProducts",
  "contentBlockKey",
  "noCommission",
  "active",
  "sortOrder",
  "imageUrl",
  "attributeSchema",
] as const;

export const PRICE_COLUMNS = [
  "itemType",
  "itemId",
  "code",
  "region",
  "currency",
  "amount",
  "needsReview",
] as const;

export const SHEET_NAMES = {
  readme: "README",
  products: "Products",
  options: "Options",
  prices: "Prices",
} as const;

export const LIST_SEPARATOR = "; ";

function text(v: string | null | undefined): Cell {
  return v == null || v === "" ? null : v;
}

function list(v: readonly string[]): Cell {
  return v.length ? v.join(LIST_SEPARATOR) : null;
}

function json(v: unknown): Cell {
  return v == null ? null : JSON.stringify(v);
}

function num(v: string | number | null | undefined): Cell {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`catalog-export: not a number: ${JSON.stringify(v)}`);
  return n;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const byCode = (a: { code: string }, b: { code: string }) => collator.compare(a.code, b.code);

/** Products ordered by series sortOrder, then product sortOrder, then code. */
export function orderedProducts(snapshot: CatalogExportSnapshot): ExportProduct[] {
  const seriesOrder = new Map(snapshot.series.map((s) => [s.code, s.sortOrder]));
  const seriesRank = (code: string) => seriesOrder.get(code) ?? Number.MAX_SAFE_INTEGER;
  return [...snapshot.products].sort(
    (a, b) =>
      seriesRank(a.series) - seriesRank(b.series) ||
      collator.compare(a.series, b.series) ||
      a.sortOrder - b.sortOrder ||
      byCode(a, b)
  );
}

/** Options ordered by code. */
export function orderedOptions(snapshot: CatalogExportSnapshot): ExportOption[] {
  return [...snapshot.options].sort(byCode);
}

export function productRow(p: ExportProduct): Cell[] {
  return [
    p.id,
    p.series,
    p.code,
    list(p.legacyCodes),
    p.name,
    text(p.description),
    p.kind,
    text(p.form),
    json(p.specs),
    text(p.contentBlockKey),
    p.isCredit,
    p.noCommission,
    p.active,
    p.sortOrder,
    text(p.imageUrl),
  ];
}

export function optionRow(o: ExportOption): Cell[] {
  return [
    o.id,
    o.code,
    list(o.legacyCodes),
    o.name,
    text(o.shortDescription),
    text(o.role),
    text(o.parentProduct),
    num(o.unitLengthM),
    list(o.compatSeries),
    list(o.compatProducts),
    text(o.contentBlockKey),
    o.noCommission,
    o.active,
    o.sortOrder,
    text(o.imageUrl),
    json(o.attributeSchema),
  ];
}

export type PriceRow = {
  itemType: "product" | "option";
  itemId: string;
  code: string;
  region: string;
  currency: string;
  amount: number;
  needsReview: boolean;
};

/** One row per Price, ordered by itemType (product before option), code, region. */
export function priceRows(snapshot: CatalogExportSnapshot): PriceRow[] {
  const currency = new Map(snapshot.regions.map((r) => [r.code, r.currency]));
  const rows: PriceRow[] = [];
  const push = (itemType: PriceRow["itemType"], item: { id: string; code: string; prices: Record<string, ExportPrice> }) => {
    for (const [region, price] of Object.entries(item.prices)) {
      const cur = currency.get(region);
      if (cur === undefined) throw new Error(`catalog-export: unknown region "${region}" on ${itemType} ${item.code}`);
      rows.push({
        itemType,
        itemId: item.id,
        code: item.code,
        region,
        currency: cur,
        amount: num(price.amount) as number,
        needsReview: price.needsReview,
      });
    }
  };
  for (const p of snapshot.products) push("product", p);
  for (const o of snapshot.options) push("option", o);
  const typeRank = { product: 0, option: 1 } as const;
  return rows.sort(
    (a, b) =>
      typeRank[a.itemType] - typeRank[b.itemType] ||
      collator.compare(a.code, b.code) ||
      collator.compare(a.region, b.region)
  );
}

export function readmeLines(snapshot: CatalogExportSnapshot): string[] {
  return [
    "PathQuote catalogue export",
    `Generated ${snapshot.generatedAt} -- ${snapshot.products.length} products, ${snapshot.options.length} options, regions: ${snapshot.regions.map((r) => r.code).join(", ")}.`,
    "Products: one row per catalogue product. Options: one row per option (compatSeries / compatProducts / parentProduct say what it fits). Prices: one row per item x region.",
    "The id column is the database key and must never be edited -- the import matches rows by id.",
    "The code column may be edited freely; the old code is kept in legacyCodes automatically.",
    "Lists (legacyCodes, compatSeries, compatProducts) are separated by '; '. specs and attributeSchema are JSON.",
    "A row deleted from this file is deleted from the catalogue on import (with confirmation). Finalized quotes are not affected.",
    "Booleans are TRUE / FALSE. Leave a cell blank to clear the value.",
  ];
}

/** Everything the workbook contains, as plain arrays -- handy for tests. */
export function buildCatalogSheets(snapshot: CatalogExportSnapshot): {
  readme: string[];
  products: Cell[][];
  options: Cell[][];
  prices: Cell[][];
} {
  return {
    readme: readmeLines(snapshot),
    products: [[...PRODUCT_COLUMNS], ...orderedProducts(snapshot).map(productRow)],
    options: [[...OPTION_COLUMNS], ...orderedOptions(snapshot).map(optionRow)],
    prices: [
      [...PRICE_COLUMNS],
      ...priceRows(snapshot).map((r) => [r.itemType, r.itemId, r.code, r.region, r.currency, r.amount, r.needsReview]),
    ],
  };
}

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

const PRODUCT_WIDTHS: Record<(typeof PRODUCT_COLUMNS)[number], number> = {
  id: 28,
  series: 8,
  code: 16,
  legacyCodes: 18,
  name: 44,
  description: 70,
  kind: 11,
  form: 12,
  specs: 40,
  contentBlockKey: 22,
  isCredit: 9,
  noCommission: 13,
  active: 8,
  sortOrder: 10,
  imageUrl: 36,
};

const OPTION_WIDTHS: Record<(typeof OPTION_COLUMNS)[number], number> = {
  id: 28,
  code: 18,
  legacyCodes: 18,
  name: 44,
  shortDescription: 70,
  role: 8,
  parentProduct: 14,
  unitLengthM: 12,
  compatSeries: 14,
  compatProducts: 24,
  contentBlockKey: 22,
  noCommission: 13,
  active: 8,
  sortOrder: 10,
  imageUrl: 36,
  attributeSchema: 40,
};

const PRICE_WIDTHS: Record<(typeof PRICE_COLUMNS)[number], number> = {
  itemType: 10,
  itemId: 28,
  code: 18,
  region: 8,
  currency: 9,
  amount: 12,
  needsReview: 12,
};

function dataSheet(rows: Cell[][], widths: Record<string, number>): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const header = rows[0];
  ws["!cols"] = header.map((h) => ({ wch: widths[String(h)] ?? 14 }));
  // Bold header. The community build of SheetJS (0.18.x) ignores cell styles
  // and `!freeze` when writing, so this is a no-op there (verified: neither
  // reaches the sheet XML); harmless, and honoured by the Pro build should it
  // ever be swapped in. Column widths and the autofilter below ARE written.
  for (let c = 0; c < header.length; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
    if (cell) cell.s = { font: { bold: true } };
  }
  const last = XLSX.utils.encode_cell({ r: Math.max(rows.length - 1, 0), c: header.length - 1 });
  ws["!autofilter"] = { ref: `A1:${last}` };
  return ws;
}

export function buildCatalogWorkbook(snapshot: CatalogExportSnapshot): XLSX.WorkBook {
  const sheets = buildCatalogSheets(snapshot);
  const wb = XLSX.utils.book_new();

  const readme = XLSX.utils.aoa_to_sheet(sheets.readme.map((line) => [line]));
  readme["!cols"] = [{ wch: 120 }];
  XLSX.utils.book_append_sheet(wb, readme, SHEET_NAMES.readme);
  XLSX.utils.book_append_sheet(wb, dataSheet(sheets.products, PRODUCT_WIDTHS), SHEET_NAMES.products);
  XLSX.utils.book_append_sheet(wb, dataSheet(sheets.options, OPTION_WIDTHS), SHEET_NAMES.options);
  XLSX.utils.book_append_sheet(wb, dataSheet(sheets.prices, PRICE_WIDTHS), SHEET_NAMES.prices);
  return wb;
}

/** Default output path: RAW/catalog-export-<YYYY-MM-DD>.xlsx (local date). */
export function defaultExportPath(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `RAW/catalog-export-${y}-${m}-${d}.xlsx`;
}
