/**
 * Pure builder for the catalogue workbook (Phase 5 of
 * docs/plans/2026-09-05-catalog-identity-and-cleanup.md; the export half of
 * docs/plans/2026-09-05-catalog-import-export.md).
 *
 * Snapshot in, SheetJS workbook out -- no database, no filesystem, so it can
 * be unit-tested against a JSON dump. Two IO shells share it:
 * scripts/export-catalog.ts (writes a file for `npm run catalog:export`) and
 * src/app/api/catalog/export/route.ts (streams it to an admin's browser from
 * Settings -> Import / Export).
 *
 * Four sheets: README (first), Products, Options, Prices. The column contract
 * lives in ./columns.ts, shared with the import parser, and the row types in
 * ./snapshot.ts.
 */
import * as XLSX from "xlsx";
import {
  LIST_SEPARATOR,
  OPTION_COLUMNS,
  PRICE_COLUMNS,
  PRODUCT_COLUMNS,
  SHEET_NAMES,
  type Cell,
  type ItemType,
  type OptionColumn,
  type PriceColumn,
  type ProductColumn,
} from "./columns";
import type { CatalogExportSnapshot, ExportOption, ExportPrice, ExportProduct } from "./snapshot";

export { LIST_SEPARATOR, OPTION_COLUMNS, PRICE_COLUMNS, PRODUCT_COLUMNS, SHEET_NAMES, type Cell } from "./columns";
export type {
  CatalogExportSnapshot,
  ExportOption,
  ExportPrice,
  ExportProduct,
  ExportRegion,
  ExportSeries,
} from "./snapshot";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

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
export function orderedProducts<P extends ExportProduct>(snapshot: { series: { code: string; sortOrder: number }[]; products: P[] }): P[] {
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
export function orderedOptions<O extends ExportOption>(snapshot: { options: O[] }): O[] {
  return [...snapshot.options].sort(byCode);
}

export function productRow(p: ExportProduct): Cell[] {
  return [
    p.id,
    p.series,
    p.code,
    p.name,
    text(p.description),
    p.kind,
    text(p.form),
    json(p.specs),
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
    o.name,
    text(o.shortDescription),
    text(o.role),
    text(o.parentProduct),
    num(o.unitLengthM),
    list(o.compatSeries),
    list(o.compatProducts),
    o.noCommission,
    o.active,
    o.sortOrder,
    text(o.imageUrl),
    json(o.attributeSchema),
  ];
}

export type PriceRow = {
  itemType: ItemType;
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
  const push = (itemType: ItemType, item: { id: string; code: string; prices: Record<string, ExportPrice> }) => {
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
    "The id column is the database key and must never be edited -- the import matches rows by id. Leave id blank on a new row.",
    "The code column may be edited freely; it is a label, and renaming it simply updates the row.",
    "Lists (compatSeries, compatProducts) are separated by '; '. specs and attributeSchema are JSON.",
    "A row deleted from this file is deleted from the catalogue on import (with confirmation). Finalized quotes are not affected.",
    "Booleans are TRUE / FALSE. Leave a cell blank to clear the value. This README sheet is ignored on import.",
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

const PRODUCT_WIDTHS: Record<ProductColumn, number> = {
  id: 28,
  series: 8,
  code: 16,
  name: 44,
  description: 70,
  kind: 11,
  form: 12,
  specs: 40,
  isCredit: 9,
  noCommission: 13,
  active: 8,
  sortOrder: 10,
  imageUrl: 36,
};

const OPTION_WIDTHS: Record<OptionColumn, number> = {
  id: 28,
  code: 18,
  name: 44,
  shortDescription: 70,
  role: 8,
  parentProduct: 14,
  unitLengthM: 12,
  compatSeries: 14,
  compatProducts: 24,
  noCommission: 13,
  active: 8,
  sortOrder: 10,
  imageUrl: 36,
  attributeSchema: 40,
};

const PRICE_WIDTHS: Record<PriceColumn, number> = {
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

/** The workbook as xlsx bytes -- what the export route sends. */
export function writeCatalogWorkbook(snapshot: CatalogExportSnapshot): Uint8Array {
  return XLSX.write(buildCatalogWorkbook(snapshot), { type: "buffer", bookType: "xlsx" }) as Uint8Array;
}

/** `catalog-<YYYY-MM-DD>.xlsx` (local date) -- the download's file name. */
export function exportFileName(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `catalog-${y}-${m}-${d}.xlsx`;
}

/** Default output path of the CLI script: RAW/catalog-export-<YYYY-MM-DD>.xlsx (local date). */
export function defaultExportPath(now: Date = new Date()): string {
  return `RAW/catalog-export-${exportFileName(now).slice("catalog-".length)}`;
}
