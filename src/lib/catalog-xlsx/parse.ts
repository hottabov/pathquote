/**
 * Workbook -> typed rows, with every problem reported as a row/column error
 * rather than a single failure (plan §3.3). Pure: SheetJS for the sheet
 * reading only, zod for the specs shape, nothing else -- no Prisma, no Next.
 *
 * Two stages, so the confirm step can re-run validation on what the client
 * hands back (see applyCatalogImport in src/lib/actions/catalog-import.ts):
 *
 *   readCatalogWorkbook(bytes)  -> CatalogSheets   (raw cells per sheet)
 *   parseCatalogSheets(sheets, snapshot) -> { parsed, errors }
 *
 * `CatalogSheets` is plain JSON (arrays of cells), which is what the preview
 * returns to the browser and the browser sends back on confirm; the server
 * never trusts a parsed row it did not produce itself in the same call.
 */
import * as XLSX from "xlsx";
import { productSpecsSchema } from "../validation/product-specs";
import { IMAGE_URL_PATTERN } from "../uploads";
import {
  ITEM_TYPES,
  LIST_SEPARATOR,
  OPTION_COLUMNS,
  OPTION_ROLES,
  PRICE_COLUMNS,
  PRODUCT_COLUMNS,
  PRODUCT_KINDS,
  PRODUCTION_FORMS,
  SHEET_NAMES,
  type Cell,
  type ItemType,
  type OptionColumn,
  type OptionRoleValue,
  type PriceColumn,
  type ProductColumn,
  type ProductKindValue,
  type ProductionFormValue,
} from "./columns";
import type { CatalogExportSnapshot } from "./snapshot";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three data sheets as cell grids, header row included. */
export type CatalogSheets = {
  products: Cell[][];
  options: Cell[][];
  prices: Cell[][];
};

export type ImportError = {
  sheet: string;
  /** 1-based Excel row number (the header is row 1); 0 for a sheet-level error. */
  row: number;
  column: string | null;
  message: string;
};

export type ParsedProduct = {
  /** Excel row number, for error messages and the preview. */
  row: number;
  /** null = new row (blank id cell). */
  id: string | null;
  code: string;
  series: string;
  name: string;
  description: string | null;
  kind: ProductKindValue;
  form: ProductionFormValue | null;
  specs: Record<string, unknown> | null;
  contentBlockKey: string | null;
  isCredit: boolean;
  noCommission: boolean;
  active: boolean;
  sortOrder: number;
  imageUrl: string | null;
};

export type ParsedOption = {
  row: number;
  id: string | null;
  code: string;
  name: string;
  shortDescription: string | null;
  role: OptionRoleValue | null;
  parentProduct: string | null;
  unitLengthM: number | null;
  compatSeries: string[];
  compatProducts: string[];
  contentBlockKey: string | null;
  noCommission: boolean;
  active: boolean;
  sortOrder: number;
  imageUrl: string | null;
  attributeSchema: unknown;
};

export type ParsedPrice = {
  row: number;
  itemType: ItemType;
  /** The resolved product/option id; null when the item is new in this file. */
  itemId: string | null;
  /** The item's code as it stands in the file's Products/Options sheet. */
  itemCode: string;
  region: string;
  amount: number;
  needsReview: boolean;
};

export type ParsedCatalog = {
  products: ParsedProduct[];
  options: ParsedOption[];
  prices: ParsedPrice[];
};

export type ParseResult = { parsed: ParsedCatalog; errors: ImportError[] };

// ---------------------------------------------------------------------------
// Stage 1: workbook -> cell grids
// ---------------------------------------------------------------------------

/**
 * Reads an uploaded .xlsx into cell grids. Parser options are the defensive
 * set: no formula text, no HTML, dense sheets (plan §2.3 -- the SheetJS
 * advisories are parser-side, so the parser is handed as little as possible
 * and, upstream of this, only an admin's file under MAX_IMPORT_BYTES).
 */
export function readCatalogWorkbook(bytes: Uint8Array): { sheets: CatalogSheets | null; errors: ImportError[] } {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(bytes, { type: "buffer", cellFormula: false, cellHTML: false, dense: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreadable file";
    return { sheets: null, errors: [{ sheet: "", row: 0, column: null, message: `Could not read the workbook: ${message}` }] };
  }
  return workbookToSheets(wb);
}

export function workbookToSheets(wb: XLSX.WorkBook): { sheets: CatalogSheets | null; errors: ImportError[] } {
  const errors: ImportError[] = [];
  const grid = (name: string): Cell[][] => {
    const ws = wb.Sheets[name];
    if (!ws) {
      errors.push({ sheet: name, row: 0, column: null, message: `Sheet "${name}" is missing` });
      return [];
    }
    return XLSX.utils.sheet_to_json<Cell[]>(ws, { header: 1, raw: true, defval: null, blankrows: false });
  };
  const sheets: CatalogSheets = {
    products: grid(SHEET_NAMES.products),
    options: grid(SHEET_NAMES.options),
    prices: grid(SHEET_NAMES.prices),
  };
  return { sheets: errors.length ? null : sheets, errors };
}

// ---------------------------------------------------------------------------
// Stage 2: cell grids -> typed rows
// ---------------------------------------------------------------------------

/** Validated shape of `CatalogSheets` coming back from the client on confirm. */
export function isCatalogSheets(value: unknown): value is CatalogSheets {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (["products", "options", "prices"] as const).every(
    (key) =>
      Array.isArray(v[key]) &&
      (v[key] as unknown[]).every(
        (row) =>
          Array.isArray(row) &&
          row.every((cell) => cell === null || ["string", "number", "boolean"].includes(typeof cell))
      )
  );
}

/** A cell as text: numbers/booleans are rendered, blanks are null. */
function cellText(cell: Cell | undefined): string | null {
  if (cell == null) return null;
  const s = typeof cell === "string" ? cell : typeof cell === "boolean" ? (cell ? "TRUE" : "FALSE") : String(cell);
  const trimmed = s.trim();
  return trimmed === "" ? null : trimmed;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "x"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0"]);

type RowReader<C extends string> = {
  sheet: string;
  row: number;
  errors: ImportError[];
  cell: (column: C) => Cell | undefined;
};

function makeReader<C extends string>(
  sheet: string,
  row: number,
  cells: Cell[],
  index: Map<C, number>,
  errors: ImportError[]
): RowReader<C> {
  return {
    sheet,
    row,
    errors,
    cell: (column) => {
      const i = index.get(column);
      return i === undefined ? undefined : cells[i];
    },
  };
}

function fail<C extends string>(r: RowReader<C>, column: C | null, message: string): void {
  r.errors.push({ sheet: r.sheet, row: r.row, column, message });
}

function readText<C extends string>(r: RowReader<C>, column: C, max = 2000): string | null {
  const v = cellText(r.cell(column));
  if (v !== null && v.length > max) {
    fail(r, column, `${column} is longer than ${max} characters`);
    return null;
  }
  return v;
}

/** Same rule as codeSchema in src/lib/validation/catalog.ts: 1-120 printable ASCII. */
const CODE_REGEX = /^[\x20-\x7E]{1,120}$/;

function readCode<C extends string>(r: RowReader<C>, column: C): string | null {
  const v = cellText(r.cell(column));
  if (v === null) {
    fail(r, column, `${column} is required`);
    return null;
  }
  if (!CODE_REGEX.test(v)) {
    fail(r, column, `${column} must be 1-120 printable ASCII characters`);
    return null;
  }
  return v;
}

/** Same rule as parseImageUrl in src/lib/actions/_shared.ts: blank, or exactly
 * the `/api/files/<uuid>.<ext>` shape an upload produces -- never an outside
 * host that would then be rendered and printed as if it were ours. */
function readImageUrl<C extends string>(r: RowReader<C>, column: C): string | null {
  const v = cellText(r.cell(column));
  if (v === null) return null;
  if (!IMAGE_URL_PATTERN.test(v)) {
    fail(r, column, `${column} must be an uploaded image URL (/api/files/<id>.<ext>) or blank`);
    return null;
  }
  return v;
}

function readRequiredText<C extends string>(r: RowReader<C>, column: C, max = 200): string | null {
  const v = readText(r, column, max);
  if (v === null) fail(r, column, `${column} is required`);
  return v;
}

function readBool<C extends string>(r: RowReader<C>, column: C, fallback: boolean): boolean {
  const raw = r.cell(column);
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") {
    if (raw === 1) return true;
    if (raw === 0) return false;
  } else {
    const word = raw.trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
  }
  fail(r, column, `${column} must be TRUE or FALSE`);
  return fallback;
}

function readNumber<C extends string>(
  r: RowReader<C>,
  column: C,
  opts: { required: boolean; integer?: boolean; min?: number }
): number | null {
  const raw = r.cell(column);
  if (raw == null || (typeof raw === "string" && raw.trim() === "")) {
    if (opts.required) fail(r, column, `${column} is required`);
    return null;
  }
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n)) {
    fail(r, column, `${column} must be a number`);
    return null;
  }
  if (opts.integer && !Number.isInteger(n)) {
    fail(r, column, `${column} must be a whole number`);
    return null;
  }
  if (opts.min !== undefined && n < opts.min) {
    fail(r, column, `${column} must be ${opts.min} or greater`);
    return null;
  }
  return n;
}

function readEnum<C extends string, V extends string>(
  r: RowReader<C>,
  column: C,
  values: readonly V[],
  fallback: V | null
): V | null {
  const v = cellText(r.cell(column));
  if (v === null) return fallback;
  const upper = v.toUpperCase();
  if ((values as readonly string[]).includes(upper)) return upper as V;
  fail(r, column, `${column} must be one of ${values.join(", ")}`);
  return fallback;
}

function readJson<C extends string>(r: RowReader<C>, column: C): { ok: boolean; value: unknown } {
  const raw = r.cell(column);
  const v = typeof raw === "string" ? raw.trim() : raw;
  if (v == null || v === "") return { ok: true, value: null };
  if (typeof v !== "string") {
    fail(r, column, `${column} must be JSON`);
    return { ok: false, value: null };
  }
  try {
    return { ok: true, value: JSON.parse(v) };
  } catch {
    fail(r, column, `${column} is not valid JSON`);
    return { ok: false, value: null };
  }
}

function readList<C extends string>(r: RowReader<C>, column: C): string[] {
  const v = cellText(r.cell(column));
  if (v === null) return [];
  const items = v
    .split(LIST_SEPARATOR.trim())
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const item of items) {
    if (seen.has(item)) {
      fail(r, column, `${column} lists "${item}" twice`);
      continue;
    }
    seen.add(item);
    unique.push(item);
  }
  return unique;
}

/**
 * Checks the header row and returns a column -> cell index map. Column order
 * is free (Excel users move columns); a header the contract does not know is
 * an error rather than silently ignored, since it is almost always a typo
 * that would otherwise drop a whole column of edits on the floor.
 */
function readHeader(
  sheet: string,
  grid: Cell[][],
  columns: readonly string[],
  errors: ImportError[]
): Map<string, number> | null {
  const header = grid[0] ?? [];
  const index = new Map<string, number>();
  header.forEach((cell, i) => {
    const name = cellText(cell);
    if (name === null) return;
    if (!columns.includes(name)) {
      errors.push({ sheet, row: 1, column: name, message: `Unknown column "${name}"` });
      return;
    }
    if (index.has(name)) {
      errors.push({ sheet, row: 1, column: name, message: `Column "${name}" appears twice` });
      return;
    }
    index.set(name, i);
  });
  for (const column of columns) {
    if (!index.has(column)) {
      errors.push({ sheet, row: 1, column, message: `Column "${column}" is missing` });
    }
  }
  return errors.some((e) => e.sheet === sheet && e.row === 1) ? null : index;
}

function isBlankRow(cells: Cell[]): boolean {
  return cells.every((c) => c == null || (typeof c === "string" && c.trim() === ""));
}

function checkUnique(
  sheet: string,
  column: string,
  rows: { row: number; value: string | null }[],
  label: string,
  errors: ImportError[]
): void {
  const seen = new Map<string, number>();
  for (const { row, value } of rows) {
    if (value === null) continue;
    const first = seen.get(value);
    if (first !== undefined) {
      errors.push({ sheet, row, column, message: `${label} "${value}" is already used on row ${first}` });
    } else {
      seen.set(value, row);
    }
  }
}

/**
 * The full pipeline on cell grids: header check, cell typing, reference
 * resolution (series and regions against the database snapshot; parent and
 * compatible products against the file's own Products sheet, which is the
 * catalogue *after* this import -- a product only in the database is being
 * deleted by the very file that would reference it), uniqueness of codes and
 * of item x region, and unknown ids.
 */
export function parseCatalogSheets(sheets: CatalogSheets, snapshot: CatalogExportSnapshot): ParseResult {
  const errors: ImportError[] = [];
  const seriesCodes = new Set(snapshot.series.map((s) => s.code));
  const regionCodes = new Set(snapshot.regions.map((r) => r.code));
  const productIds = new Set(snapshot.products.map((p) => p.id));
  const optionIds = new Set(snapshot.options.map((o) => o.id));

  // Rows that failed validation are left out of `parsed`, but their code and
  // id are still remembered so a reference to them from another sheet is not
  // reported as a second, misleading error on top of the first.
  const failedProductIds = new Set<string>();
  const failedOptionIds = new Set<string>();
  const allProductCodes = new Set<string>();

  // --- Products -----------------------------------------------------------
  const products: ParsedProduct[] = [];
  const productIndex = readHeader(SHEET_NAMES.products, sheets.products, PRODUCT_COLUMNS, errors) as Map<
    ProductColumn,
    number
  > | null;
  if (productIndex) {
    sheets.products.slice(1).forEach((cells, i) => {
      if (isBlankRow(cells)) return;
      const r = makeReader<ProductColumn>(SHEET_NAMES.products, i + 2, cells, productIndex, errors);
      const before = errors.length;

      const id = cellText(r.cell("id"));
      if (id !== null && !productIds.has(id)) fail(r, "id", `Unknown product id "${id}" -- leave id blank for a new row`);
      const code = readCode(r, "code");
      const series = cellText(r.cell("series"));
      if (series === null) fail(r, "series", "series is required");
      else if (!seriesCodes.has(series)) fail(r, "series", `Unknown series "${series}"`);
      const name = readRequiredText(r, "name");
      const description = readText(r, "description", 10000);
      const kind = readEnum(r, "kind", PRODUCT_KINDS, "ACCESSORY");
      const form = readEnum(r, "form", PRODUCTION_FORMS, null);
      const specsJson = readJson(r, "specs");
      let specs: Record<string, unknown> | null = null;
      if (specsJson.ok && specsJson.value !== null) {
        const checked = productSpecsSchema.safeParse(specsJson.value);
        if (!checked.success) {
          fail(r, "specs", `specs: ${checked.error.issues.map((iss) => `${iss.path.join(".") || "value"} ${iss.message}`).join("; ")}`);
        } else {
          specs = checked.data as Record<string, unknown>;
        }
      }
      const contentBlockKey = readText(r, "contentBlockKey", 200);
      const isCredit = readBool(r, "isCredit", false);
      const noCommission = readBool(r, "noCommission", false);
      const active = readBool(r, "active", true);
      const sortOrder = readNumber(r, "sortOrder", { required: false, integer: true, min: 0 }) ?? 0;
      const imageUrl = readImageUrl(r, "imageUrl");

      if (code !== null) allProductCodes.add(code);
      if (errors.length !== before || code === null || series === null || name === null || kind === null) {
        if (id !== null) failedProductIds.add(id);
        return;
      }
      products.push({
        row: r.row,
        id,
        code,
        series,
        name,
        description,
        kind,
        form,
        specs,
        contentBlockKey,
        isCredit,
        noCommission,
        active,
        sortOrder,
        imageUrl,
      });
    });
    checkUnique(SHEET_NAMES.products, "code", products.map((p) => ({ row: p.row, value: p.code })), "Product code", errors);
    checkUnique(SHEET_NAMES.products, "id", products.map((p) => ({ row: p.row, value: p.id })), "Product id", errors);
  }
  const fileProductCodes = allProductCodes;
  const dbProductCodes = new Set(snapshot.products.map((p) => p.code));

  const productRefMessage = (column: string, code: string): string =>
    dbProductCodes.has(code) && !fileProductCodes.has(code)
      ? `${column}: product "${code}" is not in the Products sheet (this import would delete it)`
      : `${column}: unknown product "${code}"`;

  // --- Options ------------------------------------------------------------
  const options: ParsedOption[] = [];
  const optionIndex = readHeader(SHEET_NAMES.options, sheets.options, OPTION_COLUMNS, errors) as Map<
    OptionColumn,
    number
  > | null;
  if (optionIndex) {
    sheets.options.slice(1).forEach((cells, i) => {
      if (isBlankRow(cells)) return;
      const r = makeReader<OptionColumn>(SHEET_NAMES.options, i + 2, cells, optionIndex, errors);
      const before = errors.length;

      const id = cellText(r.cell("id"));
      if (id !== null && !optionIds.has(id)) fail(r, "id", `Unknown option id "${id}" -- leave id blank for a new row`);
      const code = readCode(r, "code");
      const name = readRequiredText(r, "name");
      const shortDescription = readText(r, "shortDescription", 500);
      const role = readEnum(r, "role", OPTION_ROLES, null);
      const parentProduct = readText(r, "parentProduct", 120);
      if (parentProduct !== null && productIndex && !fileProductCodes.has(parentProduct)) {
        fail(r, "parentProduct", productRefMessage("parentProduct", parentProduct));
      }
      const unitLengthM = readNumber(r, "unitLengthM", { required: false, min: 0 });
      const compatSeries = readList(r, "compatSeries");
      for (const s of compatSeries) if (!seriesCodes.has(s)) fail(r, "compatSeries", `compatSeries: unknown series "${s}"`);
      const compatProducts = readList(r, "compatProducts");
      if (productIndex) {
        for (const p of compatProducts) {
          if (!fileProductCodes.has(p)) fail(r, "compatProducts", productRefMessage("compatProducts", p));
        }
      }
      const contentBlockKey = readText(r, "contentBlockKey", 200);
      const noCommission = readBool(r, "noCommission", false);
      const active = readBool(r, "active", true);
      const sortOrder = readNumber(r, "sortOrder", { required: false, integer: true, min: 0 }) ?? 0;
      const imageUrl = readImageUrl(r, "imageUrl");
      const attributeJson = readJson(r, "attributeSchema");
      if (
        attributeJson.ok &&
        attributeJson.value !== null &&
        !(Array.isArray(attributeJson.value) || typeof attributeJson.value === "object")
      ) {
        fail(r, "attributeSchema", "attributeSchema must be a JSON array or object");
      }

      if (errors.length !== before || code === null || name === null) {
        if (id !== null) failedOptionIds.add(id);
        return;
      }
      options.push({
        row: r.row,
        id,
        code,
        name,
        shortDescription,
        role,
        parentProduct,
        unitLengthM,
        compatSeries,
        compatProducts,
        contentBlockKey,
        noCommission,
        active,
        sortOrder,
        imageUrl,
        attributeSchema: attributeJson.value,
      });
    });
    checkUnique(SHEET_NAMES.options, "code", options.map((o) => ({ row: o.row, value: o.code })), "Option code", errors);
    checkUnique(SHEET_NAMES.options, "id", options.map((o) => ({ row: o.row, value: o.id })), "Option id", errors);
  }

  // --- Prices -------------------------------------------------------------
  const prices: ParsedPrice[] = [];
  const priceIndex = readHeader(SHEET_NAMES.prices, sheets.prices, PRICE_COLUMNS, errors) as Map<
    PriceColumn,
    number
  > | null;
  if (priceIndex) {
    const productById = new Map(products.map((p) => [p.id, p]));
    const productByCode = new Map(products.map((p) => [p.code, p]));
    const optionById = new Map(options.map((o) => [o.id, o]));
    const optionByCode = new Map(options.map((o) => [o.code, o]));
    const seenKeys = new Map<string, number>();

    sheets.prices.slice(1).forEach((cells, i) => {
      if (isBlankRow(cells)) return;
      const r = makeReader<PriceColumn>(SHEET_NAMES.prices, i + 2, cells, priceIndex, errors);
      const before = errors.length;

      const itemTypeRaw = cellText(r.cell("itemType"))?.toLowerCase() ?? null;
      const itemType = (ITEM_TYPES as readonly string[]).includes(itemTypeRaw ?? "") ? (itemTypeRaw as ItemType) : null;
      if (itemType === null) fail(r, "itemType", "itemType must be product or option");
      const itemId = cellText(r.cell("itemId"));
      const code = cellText(r.cell("code"));
      const region = cellText(r.cell("region"))?.toUpperCase() ?? null;
      if (region === null) fail(r, "region", "region is required");
      else if (!regionCodes.has(region)) fail(r, "region", `Unknown region "${region}"`);
      const amount = readNumber(r, "amount", { required: true, min: 0 });
      const needsReview = readBool(r, "needsReview", false);

      // Which row of the file this price belongs to. itemId wins when present
      // (the code column may have been left stale after a rename); code is the
      // fallback for an item that is new in this same file.
      let item: { id: string | null; code: string } | null = null;
      if (itemType !== null) {
        const sheetName = itemType === "product" ? SHEET_NAMES.products : SHEET_NAMES.options;
        const byId = itemType === "product" ? productById : optionById;
        const byCode = itemType === "product" ? productByCode : optionByCode;
        const failed = itemType === "product" ? failedProductIds : failedOptionIds;
        const known = itemType === "product" ? productIds : optionIds;
        if (itemId !== null) {
          const hit = byId.get(itemId);
          if (hit) item = hit;
          // Its row already carries the error -- not worth a second message.
          else if (failed.has(itemId)) return;
          // A price left behind for a row this file deletes is reported, not
          // dropped: silently losing it would hide the one case where the
          // director blanked an id meaning "re-create this row" and forgot
          // the price rows still name the old one.
          else if (known.has(itemId))
            fail(r, "itemId", `This ${itemType} is not in the ${sheetName} sheet (this import would delete it) -- remove this price row too, or restore the ${itemType}`);
          else fail(r, "itemId", `No ${itemType} with id "${itemId}" in the ${sheetName} sheet`);
        } else if (code !== null) {
          const hit = byCode.get(code);
          if (!hit) fail(r, "code", `No ${itemType} with code "${code}" in the ${sheetName} sheet`);
          else item = hit;
        } else {
          fail(r, "itemId", "itemId (or code, for a new item) is required");
        }
      }

      if (item !== null && region !== null) {
        const key = `${itemType}:${item.id ?? `new:${item.code}`}:${region}`;
        const first = seenKeys.get(key);
        if (first !== undefined) fail(r, "region", `Duplicate price for this item in region ${region} (see row ${first})`);
        else seenKeys.set(key, r.row);
      }

      if (errors.length !== before || itemType === null || region === null || amount === null || item === null) return;
      prices.push({ row: r.row, itemType, itemId: item.id, itemCode: item.code, region, amount, needsReview });
    });
  }

  return { parsed: { products, options, prices }, errors };
}
