/**
 * DEPRECATED (2026-09-05, catalogue v2). The spreadsheet this script reads is
 * superseded by docs/reference/catalog-v2-target.json, from which
 * scripts/build-seed-data-from-target.ts regenerates prisma/seed-data/
 * catalog.json and prices-us.json. Re-running this script would overwrite the
 * regenerated files with the pre-v2 codes (M3180, "PTW(S)", "EL-2020 Drive
 * Module (first 1.2M)"...) and rows v2 deleted. Do not re-run it; kept for
 * the record of how the original extraction was done.
 */
/**
 * Extracts the PathQuote product/option catalog from the raw Excel price
 * list into a committed JSON snapshot: prisma/seed-data/catalog.json.
 *
 * Source:  RAW/11 Price List Australia 2026-05-28.xlsx  (9 sheets total).
 * The "Order" sheet is a pure cross-sheet aggregation (SUM/lookup formulas
 * only, no priced items of its own) and is intentionally ignored.
 *
 * Run:     npm run extract:catalog
 *
 * Background reading: docs/reference/price-list-analysis.md. That report is
 * a useful map of the file but its counts are explicitly approximate ("~").
 * This script reads every relevant cell directly (including cached formula
 * results) and is the source of truth; every non-obvious decision below is
 * commented at the point it's made, and the run-time summary reports actual
 * counts so drift from the report is visible rather than silently swallowed.
 *
 * Classification rules (series / product vs. option), duplicate handling,
 * and known data gaps are all implemented per the Task 7 spec; see comments
 * inline for the reasoning behind each judgment call.
 */
import * as XLSX from "xlsx";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const SOURCE_XLSX = path.join(ROOT, "RAW", "11 Price List Australia 2026-05-28.xlsx");
const OUTPUT_JSON = path.join(ROOT, "prisma", "seed-data", "catalog.json");

type CatalogItem = {
  code: string;
  name: string;
  description: string;
  price: number | null;
  needsReview: boolean;
  /** Only set on options scoped to one or more specific products rather than
   *  a whole series (e.g. an EasyLoader accessory tied to one drive-module
   *  product, not the EL series generally). Carried through to GlobalOption
   *  by buildGlobalOptions; unset/undefined for series-scoped items and for
   *  every product (products don't have compatibility of their own). */
  compatibleProducts?: string[];
  /** `Product.isCredit` (see that column's doc comment in schema.prisma) --
   *  only meaningful on a product entry (an option has no such column).
   *  Unset/undefined for every entry except TRADE-IN (see MANUAL_PRODUCTS.SVC)
   *  -- prisma/seed-lib.ts's `mapProducts` defaults a missing value to
   *  `false`. */
  isCredit?: boolean;
};

type CatalogSeries = {
  seriesCode: string;
  seriesName: string;
  maxDiscountPct: number | null;
  products: CatalogItem[];
};

/** A global, deduplicated option -- 1:1 with the DB's Option model. Series
 *  affinity (formerly implicit in "which sheet's options[] it lived in") is
 *  now explicit via compatibleSeries, matching OptionCompatibility. */
type GlobalOption = {
  code: string;
  name: string;
  description: string;
  price: number | null;
  needsReview: boolean;
  compatibleSeries: string[];
  /** Present (non-empty) only for options scoped to specific products; in
   *  that case compatibleSeries is `[]` rather than the series the product
   *  happens to belong to -- see buildGlobalOptions. */
  compatibleProducts?: string[];
};

/** A per-sheet option before cross-sheet merging, tagged with the series it
 *  came from so the merge step can compare prices and build compatibleSeries. */
type SeriesOptions = { seriesCode: string; options: CatalogItem[] };

type LogEntry = { series: string; list: "product" | "option"; code: string; reason: string };
type DisambigEntry = { series: string; list: "product" | "option"; original: string; final: string };
type MergeEntry = { code: string; seriesCodes: string[]; price: number | null };
type SplitEntry = { code: string; variants: { seriesCode: string; finalCode: string; price: number | null }[] };

const dropped: LogEntry[] = [];
const disambiguated: DisambigEntry[] = [];
const merged: MergeEntry[] = [];
const split: SplitEntry[] = [];

// ---------------------------------------------------------------------------
// Generic cell helpers
// ---------------------------------------------------------------------------

/** Collapse internal whitespace runs to a single space and trim the ends. */
function normalize(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

/** Looks up a sheet by name and fails loudly (rather than deferencing
 *  `undefined` deep inside cellText/cellNumber) if the workbook doesn't have
 *  it -- e.g. the source file was resaved with a renamed/reordered tab. */
function getSheet(wb: XLSX.WorkBook, name: string): XLSX.WorkSheet {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error("sheet not found: " + name);
  return ws;
}

function cellText(ws: XLSX.WorkSheet, ref: string): string {
  const c = ws[ref] as XLSX.CellObject | undefined;
  if (!c || c.v === undefined || c.v === null) return "";
  return normalize(c.v);
}

/** Only returns a value for genuinely numeric cells (formula cells included,
 *  via their cached `.v` -- the xlsx package reads the cached result rather
 *  than recomputing). Returns null for blank/text cells, never `undefined`,
 *  so `price === null` is a reliable "missing" check even for price 0. */
function cellNumber(ws: XLSX.WorkSheet, ref: string): number | null {
  const c = ws[ref] as XLSX.CellObject | undefined;
  if (!c || typeof c.v !== "number") return null;
  return c.v;
}

/**
 * Internal engineering notes hand-verified as embedded in otherwise-real,
 * priced item descriptions. Per spec: "if a note is attached to a real
 * priced item, keep the item, drop the note from name." The item itself
 * (code + price) is untouched -- only these trailing note clauses are
 * stripped from the description/name text.
 */
const NOTE_STRIP_PATTERNS: RegExp[] = [
  // M-series C24 "Waste Bin-180": internal question about which widths to support.
  /\.?\s*Do we eliminate this or also include 220\/300\/390\?\s*$/i,
  // EasyLoader D13 "Syncronisation Feature": internal note to production/R&D.
  /\s*jph to discuss with production&RD if we standardize all with sync\?\?\?\s*$/i,
];

function stripNotes(text: string): string {
  let out = text;
  for (const re of NOTE_STRIP_PATTERNS) out = out.replace(re, "");
  return normalize(out);
}

/**
 * Adds an item to a series' product/option list, deduplicating by code
 * (schema requires unique codes; the source file has a few genuine repeats).
 *  - Free code            -> add as-is.
 *  - Collides, disambiguator given (and distinct from the code) -> retry as
 *    `${code} ${disambiguator}` (e.g. two "Drills included" rows disambiguated
 *    by their distinct part-number description).
 *  - Still collides (or no useful disambiguator) -> drop, keep the first
 *    occurrence, and log it (e.g. L-Series' two identical "3.0mm dia punch"
 *    rows -- a genuine duplicate in the source data).
 */
function register(
  list: CatalogItem[],
  seenCodes: Set<string>,
  item: CatalogItem,
  seriesCode: string,
  listType: "product" | "option",
  disambiguator?: string
): void {
  if (!seenCodes.has(item.code)) {
    seenCodes.add(item.code);
    list.push(item);
    return;
  }
  if (disambiguator) {
    const altCode = normalize(`${item.code} ${disambiguator}`);
    if (altCode !== item.code && !seenCodes.has(altCode)) {
      seenCodes.add(altCode);
      list.push({ ...item, code: altCode });
      disambiguated.push({ series: seriesCode, list: listType, original: item.code, final: altCode });
      return;
    }
  }
  dropped.push({ series: seriesCode, list: listType, code: item.code, reason: "duplicate code" });
}

// ---------------------------------------------------------------------------
// Per-sheet extraction
//
// Series/product-vs-option classification follows the Task 7 spec (as
// corrected by the later catalog-reclassification fix below): within
// M-series, L-Series and Punchline the sheet has a dedicated machine-code
// column (product) separate from an accessory column (option), so we use
// sheet position directly. FabricPro's FP-180/FP-220 match the spec's
// explicit "FM/FP models -> products" cue and are standalone machines in
// their own right, so they're classified as FabricPro products (TPL/Crate
// remain options); M-series' FM180 is left as an M-series option since it
// lives structurally in that sheet's accessory column, not its machine
// column. The Leather Nesting System's 3 LNS-* rows are "clearly standalone
// systems" and are products, with no options of their own.
//
// EasyLoader, EasyFeeder and Software were originally (incorrectly) treated
// as pure accessory sheets with no dedicated machine/product column, which
// left all three series with 0 products -- making their machines/modules
// impossible to add to a document. Re-verified against the source sheets:
//  - EasyLoader has two width sections, each headed by a priced
//    "Drive Module (first 1.2M)" row that IS the base machine for that
//    width; the remaining rows in each section are accessories scoped to
//    that specific drive-module product (not the EL series generally), so
//    they carry compatibleProducts instead of compatibleSeries.
//  - EasyFeeder's three rows (2020/2420/4030) are each a complete,
//    standalone unit with no separate accessory rows -- all products.
//  - Software's rows are all standalone, independently sellable modules
//    (including the SW-sheet "PRA" and the two-row "LS Convert" straddle)
//    with no accessory/option split on that sheet -- all products. The
//    L-Series sheet's own "PRA" row (a different price) remains an L-scoped
//    option, explicitly coded "PRA-L" so it can't collide with the SW
//    product code "PRA" now that there's no second "PRA" option to
//    auto-suffix it via the merge/split logic below.
// ---------------------------------------------------------------------------

function extractMSeries(wb: XLSX.WorkBook) {
  const ws = getSheet(wb, "M-series");
  const products: CatalogItem[] = [];
  const options: CatalogItem[] = [];
  const seenP = new Set<string>();
  const seenO = new Set<string>();

  // Base machines: rows 5-16, code column B, description column E, price column F.
  // Row 7 (M3390) has no price in the source file -- kept as a needsReview gap.
  for (let row = 5; row <= 16; row++) {
    const code = cellText(ws, `B${row}`);
    if (!code) continue;
    const desc = cellText(ws, `E${row}`);
    const price = cellNumber(ws, `F${row}`);
    register(products, seenP, { code, name: desc, description: desc, price, needsReview: price === null }, "M", "product");
  }

  // Options: rows 17-51, code column C, description column E, price column F.
  for (let row = 17; row <= 51; row++) {
    const code = cellText(ws, `C${row}`);
    if (!code) continue;
    // FM180 ("Fabric Master") is retired -- not sold anymore (owner
    // decision). Dropped at extraction rather than post-filtered so it never
    // reappears in catalog.json; prisma/seed.ts's RETIRED_OPTION_CODES
    // handles the corresponding existing-DB cleanup.
    if (code === "FM180") continue;
    const desc = stripNotes(cellText(ws, `E${row}`));
    const price = cellNumber(ws, `F${row}`);
    // "Drills included" (rows 50-51) share the same code; the description
    // column holds the distinguishing part number, used as a disambiguator.
    register(options, seenO, { code, name: desc, description: desc, price, needsReview: price === null }, "M", "option", desc);
  }

  return { products, options };
}

function extractLSeries(wb: XLSX.WorkBook) {
  const ws = getSheet(wb, "L-Series");
  const products: CatalogItem[] = [];
  const options: CatalogItem[] = [];
  const seenP = new Set<string>();
  const seenO = new Set<string>();

  // Base machines: rows 5-10, code column B, description column E, price column F.
  for (let row = 5; row <= 10; row++) {
    const code = cellText(ws, `B${row}`);
    if (!code) continue;
    const desc = cellText(ws, `E${row}`);
    const price = cellNumber(ws, `F${row}`);
    register(products, seenP, { code, name: desc, description: desc, price, needsReview: price === null }, "L", "product");
  }

  // Options: rows 11-42. Many tool/accessory rows (26-38, 40-42) have no
  // short code in column C -- only a description in column E. Row 39 is a
  // blank spacer row and row 44 is the sheet's "MAXIMUM DISCOUNT..." note,
  // both with neither a code nor a price and so skipped generically.
  for (let row = 11; row <= 42; row++) {
    const desc = cellText(ws, `E${row}`);
    let code = cellText(ws, `C${row}`);
    const hadExplicitCode = code.length > 0;
    const price = cellNumber(ws, `F${row}`);
    if (!desc && !code) continue; // blank spacer row
    if (price === null && !code) continue; // note row with no code and no price
    if (!code) code = desc; // fall back to the (normalized) description as the code
    // "PRA" here is a distinct, differently-priced option from the SW
    // sheet's own "PRA" -- which is now a SW product (see extractSoftware),
    // not an option, so it can no longer collide with this one and trigger
    // the auto-suffixing merge/split logic below. Hard-code the "-L" suffix
    // so this row keeps its long-standing "PRA-L" code regardless.
    if (code === "PRA") code = "PRA-L";
    // Only pass the description as a disambiguator when the code came from a
    // real, distinct code column -- when the code IS the description (the
    // fallback above), appending it to itself can't disambiguate anything;
    // a genuine collision there (e.g. the two identical "3.0mm dia punch"
    // rows) is a true duplicate and should be dropped, not renamed.
    register(
      options, seenO,
      { code, name: desc, description: desc, price, needsReview: price === null },
      "L", "option",
      hadExplicitCode ? desc : undefined
    );
  }

  return { products, options };
}

// Punchline (the "P" series -- P-180/P-220 perforator machines plus the
// Crate-P accessory, rows 6-8 of the AU sheet's "Punchline" tab) is retired --
// not sold anymore (owner decision, same "delete the product line entirely"
// treatment FM180 got below, not a deactivation). Dropped at extraction so it
// never reappears in catalog.json even after a `npm run extract:catalog`
// re-run against a source workbook that still has the sheet; an existing DB
// is cleaned up by a hand-written migration instead of prisma/seed.ts's
// RETIRED_OPTION_CODES loop, since a whole series (Series + Products +
// Options + their Price/OptionCompatibility rows) is a bigger blast radius
// than the single-Option retirements that loop handles -- see the migration
// referenced from the commit that removed this function for the exact
// DELETE statements and its DocumentItem guard.

function extractSoftware(wb: XLSX.WorkBook) {
  const ws = getSheet(wb, "Software");
  const products: CatalogItem[] = [];
  const seen = new Set<string>();

  // Rows 5-14: code column A, description column C, price column E. Every
  // row on this sheet (including "PRA", row 14) is a standalone, separately
  // sellable software module -- there's no accessory/option column here, so
  // (unlike M/L/Punchline) sheet position doesn't split product from option;
  // per spec, all of them are products.
  for (let row = 5; row <= 14; row++) {
    const code = cellText(ws, `A${row}`);
    if (!code) continue;
    const desc = cellText(ws, `C${row}`);
    const price = cellNumber(ws, `E${row}`);
    register(products, seen, { code, name: desc, description: desc, price, needsReview: price === null }, "SW", "product");
  }

  // LS Convert (row 17) is laid out differently: its own Total formulas
  // (G17/I17/K17) multiply against $F17 -- the same column every other row
  // in this sheet uses for its unit price -- but F17 is blank. A numeric
  // value (9018) does sit in E17, but given the row's own formula wiring
  // treats the price as unset, this is extracted as a missing price rather
  // than trusting the stray E17 value -- needsReview stays true so a human
  // confirms which figure (if either) is correct before it's trusted.
  // NOTE: this reads code from row 16 and description from row 17 -- a
  // deliberate two-row straddle specific to LS Convert's current layout in
  // this sheet. If the sheet is ever re-laid-out (rows inserted/removed
  // above/within this block), these two row numbers will need re-verifying
  // by hand; they are not derived from any structural marker.
  const lsCode = cellText(ws, "A16") || "LS Convert";
  const lsDesc = cellText(ws, "C17");
  register(products, seen, { code: lsCode, name: lsDesc, description: lsDesc, price: null, needsReview: true }, "SW", "product");

  return { products, options: [] as CatalogItem[] };
}

function extractLNS(wb: XLSX.WorkBook) {
  const ws = getSheet(wb, "Leather Nesting System");
  const products: CatalogItem[] = [];
  const seen = new Set<string>();

  // Rows 5, 9, 13: code column A, description column C, price column E.
  // LNS-2420 and LNS-3220 are formula-priced (=previous * 1.05); the file
  // carries cached results for both (38547.6 and 40474.98), which are used
  // directly -- no needsReview needed unless a cached value is ever absent.
  for (const row of [5, 9, 13]) {
    const code = cellText(ws, `A${row}`);
    const desc = cellText(ws, `C${row}`);
    const price = cellNumber(ws, `E${row}`);
    register(products, seen, { code, name: desc, description: desc, price, needsReview: price === null }, "LNS", "product");
  }

  return { products, options: [] as CatalogItem[] };
}

function extractEasyLoader(wb: XLSX.WorkBook) {
  const ws = getSheet(wb, "EasyLoader");
  const products: CatalogItem[] = [];
  const options: CatalogItem[] = [];
  const seenP = new Set<string>();
  const seenO = new Set<string>();

  // Two width sections, each headed by a "Drive Module (first 1.2M)" row
  // that IS the base machine for that width (product EL-2020 / EL-2420).
  // The remaining rows in each section are accessories for that specific
  // drive module -- not the EL series generally -- so they're extracted as
  // options scoped via compatibleProducts rather than compatibleSeries.
  // No short-code column on this sheet for the accessory rows -- component
  // descriptions (column D) repeat verbatim across the two width groups
  // (e.g. "Additional 1.2M lengths" appears in both), so each option code is
  // still prefixed with its group's width tag to keep codes unique.
  const groups: {
    tag: string;
    driveRow: number;
    accessoryRows: number[];
    productName: string;
    productDescription: string;
  }[] = [
    {
      tag: "2020",
      driveRow: 7, // "EasyLoader- 2020 width (to suit FM180/FabricPro-180)" (A7)
      accessoryRows: [8, 9, 10, 11, 12, 13, 14],
      productName: "EasyLoader 2020",
      productDescription: "2020mm width, to suit FM180/FabricPro-180. Base: drive module, first 1.2M.",
    },
    {
      tag: "2420",
      driveRow: 21, // "EasyLoader- 2420 width(to suit FM220/FabricPro220)" (A21)
      accessoryRows: [22, 23, 24, 25, 26, 27, 28],
      productName: "EasyLoader 2420",
      productDescription: "2420mm width, to suit FM220/FabricPro220. Base: drive module, first 1.2M.",
    },
  ];

  for (const group of groups) {
    const productCode = `EL-${group.tag}`;
    const price = cellNumber(ws, `F${group.driveRow}`);
    register(
      products,
      seenP,
      {
        code: productCode,
        name: group.productName,
        description: group.productDescription,
        price,
        needsReview: price === null,
      },
      "EL",
      "product"
    );

    for (const row of group.accessoryRows) {
      const rawDesc = cellText(ws, `D${row}`);
      if (!rawDesc) continue;
      const desc = stripNotes(rawDesc);
      const price = cellNumber(ws, `F${row}`);
      if (price === null) continue; // no priced item on this row
      const code = `EL-${group.tag} ${desc}`;
      register(
        options,
        seenO,
        { code, name: desc, description: desc, price, needsReview: false, compatibleProducts: [productCode] },
        "EL",
        "option"
      );
    }
  }

  return { products, options };
}

function extractEasyFeeder(wb: XLSX.WorkBook) {
  const ws = getSheet(wb, "EasyFeeder");
  const products: CatalogItem[] = [];
  const seen = new Set<string>();

  // Rows 8, 10, 12: code column A (e.g. "EasyFeeder- 2020"), description
  // column D, price column E. Each row is a complete, standalone unit with
  // no separate accessory rows on this sheet -- all three are products,
  // coded EF-<width> to match the EL-<width> convention.
  for (const row of [8, 10, 12]) {
    const rawCode = cellText(ws, `A${row}`);
    const width = rawCode.match(/\d+/)?.[0] ?? "";
    const code = `EF-${width}`;
    const name = `EasyFeeder ${width}`;
    const desc = cellText(ws, `D${row}`);
    const price = cellNumber(ws, `E${row}`);
    register(products, seen, { code, name, description: desc, price, needsReview: price === null }, "EF", "product");
  }

  return { products, options: [] as CatalogItem[] };
}

function extractFabricPro(wb: XLSX.WorkBook) {
  const ws = getSheet(wb, "FabricPro");
  const products: CatalogItem[] = [];
  const options: CatalogItem[] = [];
  const seenP = new Set<string>();
  const seenO = new Set<string>();

  // Rows 7-10: code column C, description column D, price column J.
  // FP-180 / FP-220 are the spreader machines (product); TPL (price 0,
  // included as standard equipment) and Crate are accessories (option).
  // TPL's price cell (J9) is a genuine 0 -- checked every other cell in the
  // row (D-K) and none carries a real number instead. A price of exactly 0
  // isn't a usable sale price even though it's not blank, so it's flagged
  // needsReview rather than trusted at face value (per Task spec point D).
  for (const row of [7, 8, 9, 10]) {
    const code = cellText(ws, `C${row}`);
    if (!code) continue;
    const desc = cellText(ws, `D${row}`);
    const price = cellNumber(ws, `J${row}`);
    const item: CatalogItem = { code, name: desc, description: desc, price, needsReview: price === null || price === 0 };
    if (/^FP-\d/.test(code)) register(products, seenP, item, "FP", "product");
    else register(options, seenO, item, "FP", "option");
  }

  return { products, options };
}

// ---------------------------------------------------------------------------
// Cross-sheet option merging
//
// Options are global (1:1 with the DB's Option model); series affinity is
// expressed via compatibleSeries (1:1 with OptionCompatibility) rather than
// which sheet's options[] an item lived in. 12 option codes are duplicated
// across sheets in the source file (same short code, different accessory
// per machine line). For each duplicated code:
//   - If every sheet prices it identically, it's genuinely one option sold
//     across multiple lines -> merge into a single option, union the
//     compatible series.
//   - If sheets disagree on price, it's NOT the same option -- keep them
//     separate, with the series code suffixed onto every variant's code
//     (e.g. "ABR-M", "ABR-L") so the base code is never ambiguously reused.
// Every option pulled from the M-series sheet is also compatible with
// X-Calibre (X clones M's machines and is expected to reuse M's options).
// The X-Calibre *series code* is "X" (not "XC" -- that was the old code,
// renamed per owner request since the catalog UI showed "XC" but should
// read "X"; X-Calibre's product-code prefix was already "X-####" before
// this rename and is unaffected).
// ---------------------------------------------------------------------------

function compatibleSeriesFor(seriesCode: string): string[] {
  return seriesCode === "M" ? ["M", "X"] : [seriesCode];
}

function buildGlobalOptions(seriesOptionsList: SeriesOptions[]): GlobalOption[] {
  const byCode = new Map<string, { seriesCode: string; item: CatalogItem }[]>();
  for (const { seriesCode, options } of seriesOptionsList) {
    for (const item of options) {
      const entries = byCode.get(item.code) ?? [];
      entries.push({ seriesCode, item });
      byCode.set(item.code, entries);
    }
  }

  const result: GlobalOption[] = [];
  for (const [code, entries] of byCode) {
    if (entries.length === 1) {
      const { seriesCode, item } = entries[0];
      const hasProductCompat = Boolean(item.compatibleProducts?.length);
      result.push({
        code: item.code,
        name: item.name,
        description: item.description,
        price: item.price,
        needsReview: item.needsReview,
        // Product-scoped options (e.g. EasyLoader accessories) carry an
        // empty compatibleSeries -- their compatibility is expressed via
        // compatibleProducts instead, not "the item's series generally".
        compatibleSeries: hasProductCompat ? [] : compatibleSeriesFor(seriesCode),
        ...(hasProductCompat ? { compatibleProducts: item.compatibleProducts } : {}),
      });
      continue;
    }

    const prices = entries.map((e) => e.item.price);
    const allSamePrice = prices.every((p) => p === prices[0]);

    if (allSamePrice) {
      const first = entries[0]; // insertion order == series extraction order (M, L, P, SW, LNS, EL, EF, FP)
      const compatibleSeries = Array.from(new Set(entries.flatMap((e) => compatibleSeriesFor(e.seriesCode))));
      result.push({
        code,
        name: first.item.name,
        description: first.item.description,
        price: first.item.price,
        needsReview: entries.some((e) => e.item.needsReview),
        compatibleSeries,
      });
      merged.push({ code, seriesCodes: entries.map((e) => e.seriesCode), price: first.item.price });
    } else {
      const variants: SplitEntry["variants"] = [];
      for (const { seriesCode, item } of entries) {
        const finalCode = `${code}-${seriesCode}`;
        result.push({
          code: finalCode,
          name: item.name,
          description: item.description,
          price: item.price,
          needsReview: item.needsReview,
          compatibleSeries: compatibleSeriesFor(seriesCode),
        });
        variants.push({ seriesCode, finalCode, price: item.price });
      }
      split.push({ code, variants });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Manual products
//
// Hand-authored products with no row in the source Excel at all -- not
// extracted from any sheet, so they can't be represented as an
// extract*() function. Appended into their series' products arrays in
// main(), after sheet extraction and before the JSON is written, so a
// re-run of `npm run extract:catalog` (which fully rebuilds catalog.json
// from the workbook) preserves them instead of silently dropping them.
// Both carry price: null / needsReview: true -- pricing isn't published
// for either yet, same convention as every other needsReview gap above.
// ---------------------------------------------------------------------------

const MANUAL_PRODUCTS: Record<string, CatalogItem[]> = {
  FP: [
    {
      code: "FP-TROLLEY",
      name: "Fabric Roll Trolley",
      description:
        "Ergonomic fabric roll trolley designed for seamless use with the FabricPro spreading system. Direct roll transfer from storage to FabricPro with no intermediate handling or bulky roll-lifting devices. Carries up to 2 fabric rolls; 2 lockable castor wheels; welded steel construction; compatible with EasyLoader tables (880-940mm height); compact flat-packed design.",
      price: null,
      needsReview: true,
    },
  ],
  // HDRF used to be a single width-less "HDRF" product. The NA price list
  // (scripts/extract-us-prices.ts) confirms three real, distinctly-priced
  // width variants (180/220/320cm) -- owner decision: split into three
  // separate products, one per width, same convention as EasyLoader/
  // EasyFeeder/FabricPro's own per-width products. US pricing is
  // 12500/13900/15290 respectively -- see extractHDRF in
  // scripts/extract-us-prices.ts, which writes all three into
  // prisma/seed-data/prices-us.json. prisma/seed.ts renames any pre-existing
  // "HDRF" product row to "HDRF-180" in place (preserving its id/refs/image)
  // before this product list is upserted.
  //
  // AU pricing: there is no AU-sheet row for HDRF at all (it never shipped
  // on RAW/11 Price List Australia ...xlsx), so unlike every other needsReview
  // gap in this file these three prices are NOT extracted from a spreadsheet
  // -- they're the owner's own AUD figures (USD x1.3961, the mid-market rate
  // at the time, rounded UP to the next whole 100 -- e.g. 12500 -> 17451 ->
  // 17500), given directly for the HDRF launch rather than sourced from a
  // price-list cell. needsReview: false because this is a real, deliberate
  // number, not a "TBD" placeholder -- same reasoning as TRADE-IN's price
  // in MANUAL_PRODUCTS.SVC below.
  //
  // Own series, not EF: HDRF used to live inside MANUAL_PRODUCTS.EF (it
  // rode along in the EasyFeeder series purely because it had no sheet of
  // its own on the AU side). The NA source workbook
  // (RAW/Price List North America (01-06-2026).xlsx) has a dedicated "HDRF"
  // sheet (see extractHDRF in scripts/extract-us-prices.ts) and its own
  // product photo (hdrf.png, see PRODUCT_IMAGES in scripts/import-images-lib.ts)
  // -- it's a different machine, not an EasyFeeder variant, so owner
  // decision: give it its own catalogue series ("HDRF" series entry below,
  // alongside `series` in main()) instead of nesting it under EF. No
  // Option in this catalog is compatibleSeries-scoped to "EF" (the EF sheet
  // itself contributes zero options -- see extractEasyFeeder, options: []
  // always), so this move carries nothing else along implicitly; the HDRF
  // crate options below (MANUAL_OPTIONS) were already product-scoped
  // (compatibleProducts: ["HDRF-180"] etc.), not series-scoped, so they are
  // unaffected by which series the products sit in.
  HDRF: [
    {
      code: "HDRF-180",
      name: "Heavy Duty Roll Feeder 180",
      description:
        "Heavy duty roll feeder for rolls up to 500kg, roll diameters up to 900mm and widths up to 1800mm. Adjustable core support 70-80mm (option up to 200mm), adjustable disk brake prevents roll run-away, heavy-duty lockable castors. Compatible with all Pathfinder automatic cutting machines.",
      price: 17500,
      needsReview: false,
    },
    {
      code: "HDRF-220",
      name: "Heavy Duty Roll Feeder 220",
      description:
        "Heavy duty roll feeder for rolls up to 500kg, roll diameters up to 900mm and widths up to 2200mm. Adjustable core support 70-80mm (option up to 200mm), adjustable disk brake prevents roll run-away, heavy-duty lockable castors. Compatible with all Pathfinder automatic cutting machines.",
      price: 19500,
      needsReview: false,
    },
    {
      code: "HDRF-320",
      name: "Heavy Duty Roll Feeder 320",
      description:
        "Heavy duty roll feeder for rolls up to 500kg, roll diameters up to 900mm and widths up to 3200mm. Adjustable core support 70-80mm (option up to 200mm), adjustable disk brake prevents roll run-away, heavy-duty lockable castors. Compatible with all Pathfinder automatic cutting machines.",
      price: 21400,
      needsReview: false,
    },
  ],
  // "Service" is a container product -- it exists so the service OPTIONS in
  // MANUAL_OPTIONS below (compatibleProducts: ["SERVICE"]) have something to
  // attach to in a document, the same way EasyLoader's accessory options
  // attach to a specific EL-#### drive-module product. Unlike every other
  // needsReview gap in this file, its own price is a real, deliberate 0 (not
  // a "TBD" placeholder) -- the product itself is never sold on its own, only
  // its options carry a price -- so needsReview is false here.
  SVC: [
    {
      code: "SERVICE",
      name: "Service",
      description: "Installation, training and support services.",
      price: 0,
      needsReview: false,
    },
    // A credit product, not a discount -- John (meeting transcript): "we
    // should create another product called trade-in, so that way the
    // terminology is correct for everybody in the world... It's a line
    // item. It's a product. You're selling a trade in. It's a negative
    // value." `isCredit: true` (see Product.isCredit in schema.prisma) is
    // what actually makes it subtract from a quote -- the salesperson still
    // types a positive amount. `price: 20000` is John's own stated default
    // ("I would put a value of $20,000 on it. Australian dollars, for
    // example, as a default, they can always change it up or down.") --
    // AU only, same as every other product here; no NA figure exists to
    // seed a US price from (see prisma/seed.ts step 7 vs. 7b).
    //
    // PROVISIONAL WORDING: `description` below is transcribed from that same
    // meeting and is NOT the agreed legal redaction -- it captures the three
    // terms John dictated (removal/disposal responsibility, no re-entering
    // the market as parts or as a machine, Pathfinder's chance to remove/
    // destroy components first) in the order he gave them, but has not been
    // reviewed by counsel. Whoever finalizes the real wording should replace
    // this string (and prisma/seed-data/catalog.json's matching TRADE-IN
    // entry, which duplicates it -- see prisma/seed.ts, product descriptions
    // aren't overwritten by a re-seed of an existing row) in one edit, not
    // patch around it.
    {
      code: "TRADE-IN",
      name: "Trade-in",
      description:
        "The customer is responsible for removing the traded-in machine and disposing of (trashing) it. The customer agrees that neither the machine nor its parts may be re-entered into the market, whether as parts or as a machine. Before the machine is trashed, Pathfinder's engineers have the opportunity to remove or destroy its components.",
      price: 20000,
      needsReview: false,
      isCredit: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// North America (NA) products
//
// Hand-authored products confirmed to exist by
// RAW/Price List North America (01-06-2026).xlsx (see scripts/extract-us-prices.ts)
// but with no row at all in the AU price list this catalog is otherwise
// extracted from -- so, like MANUAL_PRODUCTS above, they can't come from any
// extract*() function here. Kept as a separate, dedicated list (per spec)
// rather than folded into MANUAL_PRODUCTS, so its NA provenance stays
// traceable. Every entry here is price: null / needsReview: true for AU --
// exactly the MANUAL_PRODUCTS convention -- because the AU price genuinely
// doesn't exist yet; that is distinct from "no price at all". Each has a
// real US price captured separately, by scripts/extract-us-prices.ts, into
// prisma/seed-data/prices-us.json and applied only to the US region's Price
// rows by prisma/seed.ts -- never written into this file's AU price/
// needsReview fields.
//
// Evidence (sheet, and the NA row this was read from):
//  - M3300/M5300/M7300/M10300: M-series sheet rows 7/11/15/19 -- a "300cm
//    cutting width" tier that doesn't exist at all in the AU M-series sheet
//    (AU only has 180/220/390). Every one of the 3/5/7/10cm height variants
//    gets this new width, not just M3300 -- all four are genuinely new
//    machines, not a single isolated addition.
//  - L-320E: L-Series sheet row 7, an "Extended" 320cm-width variant with
//    its own row (and its own price) distinct from the existing L-320/
//    L-320F. (Note: its NA description literally says "Width 226cm" --
//    that's not a NA-specific typo; the AU sheet's own existing L-320 row
//    carries the exact same "226cm" text, so it's reproduced here verbatim
//    rather than silently corrected, per this script's usual policy of
//    trusting source text as-is.)
//  - PTW(I): Software sheet row 7, coded "PTW (I)" (normalized to "PTW(I)",
//    stripping the space before the parenthesis) -- a standalone SW-series
//    product distinct from the existing "PTW(S)" SW product and from the
//    unrelated cross-series "PTW" GlobalOption (M/X/L-compatible, sourced
//    from the AU M-series/L-Series sheets) -- per spec, this is added as a
//    new product, not merged into that option.
//  - EL-3220/EL-4030: EasyLoader sheet has FOUR width sections in the NA
//    file (2020/2420/3220/4030), not the two (2020/2420) in the AU sheet --
//    each headed by its own priced "Drive Module (first 1.2M)" row, exactly
//    like the two existing EL products. The 3220/4030 sections' accessory
//    rows (Additional lengths, Static table, Electrical Runner, Travel
//    platform, Crate, Installation) have no equivalent options in the
//    existing catalog and are NOT added as options here -- see
//    scripts/extract-us-prices.ts's unmatched[] output, they're reported,
//    not invented.
//  - EF-3220: EasyFeed sheet has FOUR width sections (2020/2420/3220/4030)
//    vs. the catalog's existing 3 EF products (2020/2420/4030) -- 3220 is
//    the missing one.
//  - FP-300: FabricPro sheet has a third FP-300 section (68000) beyond the
//    existing FP-180/FP-220.
//
// Not added despite a "300"-width pattern: X-Calibre. The X-series sheet
// only prices two machine codes at all (X10180, X10220 -- both already
// mapped to existing X-10180/X-10220), so there is no NA evidence for an
// X-3300-style product the way there is for M3300 et al. X's own products
// are cloned from M-Series' products earlier in this file (see "X-Calibre"
// below) -- that clone happens before this NA_PRODUCTS append, so it does
// NOT pick up M3300/M5300/M7300/M10300 either; X stays at its original 12
// products.
// ---------------------------------------------------------------------------

const NA_PRODUCTS: Record<string, CatalogItem[]> = {
  M: [
    {
      code: "M3300",
      name: "Computer controlled cutting machine - 3cm compressed lay height, 300cm cutting width",
      description: "Computer controlled cutting machine - 3cm compressed lay height, 300cm cutting width",
      price: null,
      needsReview: true,
    },
    {
      code: "M5300",
      name: "Computer controlled cutting machine - 5cm compressed lay height, 300cm cutting width",
      description: "Computer controlled cutting machine - 5cm compressed lay height, 300cm cutting width",
      price: null,
      needsReview: true,
    },
    {
      code: "M7300",
      name: "Computer controlled cutting machine - 7cm compressed lay height, 300cm cutting width",
      description: "Computer controlled cutting machine - 7cm compressed lay height, 300cm cutting width",
      price: null,
      needsReview: true,
    },
    {
      code: "M10300",
      name: "Computer controlled cutting machine - 10cm compressed lay height, 300cm cutting width",
      description: "Computer controlled cutting machine - 10cm compressed lay height, 300cm cutting width",
      price: null,
      needsReview: true,
    },
  ],
  L: [
    {
      code: "L-320E",
      name: "Coveyorised cnc cutting machine - Capacity single/low ply. Width 226cm. Cutting belt perforated flat. Standard with MRK (included). Facility for 3 Simultaneous tools. Quick release tools not included.",
      description: "Coveyorised cnc cutting machine - Capacity single/low ply. Width 226cm. Cutting belt perforated flat. Standard with MRK (included). Facility for 3 Simultaneous tools. Quick release tools not included.",
      price: null,
      needsReview: true,
    },
  ],
  SW: [
    {
      code: "PTW(I)",
      name: "PathWorks Integrated software module within PathCutTM . Pathworks features include, pattern creation tools, piece shredder, magnetic nesting, importing and exporting of standard DXF and G-code.",
      description: "PathWorks Integrated software module within PathCutTM . Pathworks features include, pattern creation tools, piece shredder, magnetic nesting, importing and exporting of standard DXF and G-code.",
      price: null,
      needsReview: true,
    },
  ],
  EL: [
    {
      code: "EL-3220",
      name: "EasyLoader 3220",
      description: "3220mm width, to suit Mx300, L320 & FabricPro300. Base: drive module, first 1.2M.",
      price: null,
      needsReview: true,
    },
    {
      code: "EL-4030",
      name: "EasyLoader 4030",
      description: "4030mm width, to suit Mx390 & FabricPro390. Base: drive module, first 1.2M.",
      price: null,
      needsReview: true,
    },
  ],
  EF: [
    {
      code: "EF-3220",
      name: "EasyFeeder 3220",
      description:
        "1200m length, functionality for synchronisation with the M and L series. Electronic Edge Control including Edge control sensors. Includes roll keeper and plastic roll holder.",
      price: null,
      needsReview: true,
    },
  ],
  FP: [
    {
      code: "FP-300",
      name: "FabricPro Automatic Spreading Machine (maximum fabric width=300 cm)",
      description: "FabricPro Automatic Spreading Machine (maximum fabric width=300 cm)",
      price: null,
      needsReview: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// Manual options
//
// Hand-authored GlobalOptions with no row in the AU price list at all --
// same rationale as MANUAL_PRODUCTS/NA_PRODUCTS above, just for the options
// list instead of a series' products. Merged into the cross-sheet-merged
// options array in main(), after buildGlobalOptions() runs, so a re-run of
// `npm run extract:catalog` always regenerates them rather than requiring a
// hand-edit of catalog.json. Every entry here has AU price: null /
// needsReview: true -- none of these are published in the AU price list
// (RAW/11 Price List Australia ...xlsx) at all -- EXCEPT the HDRF crates and
// SVC-HDRF-INSTALL, whose AU price is the owner's own manual USD->AUD
// conversion (see the comment on MANUAL_PRODUCTS.EF's HDRF entries above for
// the exact rule); those three carry a real price and needsReview: false.
//
//  - JTP ("JetPen"): owner-requested new option, L-Series only. Distinct
//    from the pre-existing "JetPen" option (coded from the L-Series sheet's
//    own "Jetpen Marking Tool..." row, priced 7500) -- that row is untouched;
//    this is a second, separate, as-yet-unpriced option per explicit
//    instruction. needsReview stays true for BOTH AU and US (unlike the
//    service options below, this one deliberately has no US price either --
//    see scripts/extract-us-prices.ts, which does not map "JTP" to anything).
//
//  - SVC-*: service options for the new "SERVICE" container product (see
//    MANUAL_PRODUCTS.SVC above), sourced from rows scripts/extract-us-prices.ts
//    reports in prisma/seed-data/prices-us.json's `unmatched[]` array (real
//    NA price-list rows with no AU equivalent and no catalog code to attach
//    to). Every one of these DOES get a real US price -- extract-us-prices.ts
//    now maps these exact rows onto these codes instead of leaving them
//    unmatched (see that script's SVC_UNMATCHED_TARGETS). Only rows with a
//    single, unambiguous price across every sheet/width they appear on are
//    included; width-dependent-priced service rows (e.g. EasyFeeder's
//    "Installation (3 hrs)" row, 360 for the 2020/2420 sections vs 720 for
//    3220/4030) are left as unmatched/unclaimed rather than guessing which
//    price (or how many split codes) is "correct" -- same policy this file
//    already applies to genuinely ambiguous data everywhere else. Same for
//    HDRF's own installation row (identical 180 across all three width
//    sections, hence one option, not three) -- SVC-HDRF-INSTALL itself is
//    the one exception with a real AU price too, per the note above.
//
//  - HDRF crates: unlike every other HDRF row, the NA sheet's per-width
//    crate rows (HDRF-180/220/320) are genuinely different prices, so
//    they're product-scoped options (compatibleProducts, not
//    compatibleSeries) -- the same "per-product option" shape EasyLoader's
//    EL-2020 accessories already use -- rather than one shared option like
//    SVC-HDRF-INSTALL. scripts/extract-us-prices.ts's extractHDRF used to
//    report these three rows into prices-us.json's `unmatched[]` (no catalog
//    code existed for them); it now maps them onto these three codes instead
//    -- see that function's own comment.
const MANUAL_OPTIONS: GlobalOption[] = [
  {
    code: "JTP",
    name: "JetPen",
    description: "Non-contact high speed ink marking.",
    price: null,
    needsReview: true,
    compatibleSeries: ["L"],
  },
  {
    code: "SVC-LNS-INSTALL",
    name: "Installation/Training — Leather Nesting System (with cutter)",
    description: "Installation/Training — Leather Nesting System (with cutter installation), 2 days.",
    price: null,
    needsReview: true,
    compatibleSeries: [],
    compatibleProducts: ["SERVICE"],
  },
  {
    code: "SVC-FP-INSTALL",
    name: "FabricPro Installation & Training (1 day)",
    description: "FabricPro Installation & Training, 1 day (with Cutter installation).",
    price: null,
    needsReview: true,
    compatibleSeries: [],
    compatibleProducts: ["SERVICE"],
  },
  {
    code: "SVC-HDRF-INSTALL",
    name: "HDRF Installation (2 hours)",
    description: "Heavy Duty Roll Feeder installation, 2 hours.",
    price: 300,
    needsReview: false,
    compatibleSeries: [],
    compatibleProducts: ["SERVICE"],
  },
  {
    code: "HDRF-180 Crate- Wooden Crate for transport",
    name: "Crate- Wooden Crate for transport",
    description: "Crate- Wooden Crate for transport",
    price: 1800,
    needsReview: false,
    compatibleSeries: [],
    compatibleProducts: ["HDRF-180"],
  },
  {
    code: "HDRF-220 Crate- Wooden Crate for transport",
    name: "Crate- Wooden Crate for transport",
    description: "Crate- Wooden Crate for transport",
    price: 2000,
    needsReview: false,
    compatibleSeries: [],
    compatibleProducts: ["HDRF-220"],
  },
  {
    code: "HDRF-320 Crate- Wooden Crate for transport",
    name: "Crate- Wooden Crate for transport",
    description: "Crate- Wooden Crate for transport",
    price: 2300,
    needsReview: false,
    compatibleSeries: [],
    compatibleProducts: ["HDRF-320"],
  },
  {
    code: "SVC-M-INSTALL",
    name: "M-Series Installation & Training (Static, no MTS)",
    description: "1 day installation, 3 days training (Static -- no MTS).",
    price: null,
    needsReview: true,
    compatibleSeries: [],
    compatibleProducts: ["SERVICE"],
  },
  {
    code: "SVC-M-INSTALL-MTS",
    name: "M-Series Installation & Training (with MTS, up to 6m travel)",
    description: "2 day installation, 3 days training, with MTS up to 6m travel.",
    price: null,
    needsReview: true,
    compatibleSeries: [],
    compatibleProducts: ["SERVICE"],
  },
  {
    code: "SVC-L-INSTALL",
    name: "L-Series Installation & Training (Static, no MTS)",
    description: "L-Series Install/Training (Static -- no MTS).",
    price: null,
    needsReview: true,
    compatibleSeries: [],
    compatibleProducts: ["SERVICE"],
  },
  {
    code: "SVC-L-INSTALL-MTS",
    name: "L-Series Installation & Training (with MTS)",
    description: "L-Series Install/Training, with MTS.",
    price: null,
    needsReview: true,
    compatibleSeries: [],
    compatibleProducts: ["SERVICE"],
  },
  {
    code: "SVC-EL-INSTALL",
    name: "EasyLoader Installation",
    description: "EasyLoader installation (Drive Module + Additional Modules) with Cutter installation.",
    price: null,
    needsReview: true,
    compatibleSeries: [],
    compatibleProducts: ["SERVICE"],
  },
  {
    code: "SVC-SW-TRAINING",
    name: "Software Remote Training Support",
    description: "Remote training support for PathWorks/PathCut software modules.",
    price: null,
    needsReview: true,
    compatibleSeries: [],
    compatibleProducts: ["SERVICE"],
  },
];

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function sortByCode<T extends { code: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.code.localeCompare(b.code, "en"));
}

function main(): void {
  if (!fs.existsSync(SOURCE_XLSX)) {
    console.error(`Source workbook not found: ${SOURCE_XLSX}`);
    process.exit(1);
  }

  const wb = XLSX.readFile(SOURCE_XLSX);

  const m = extractMSeries(wb);
  const l = extractLSeries(wb);
  const sw = extractSoftware(wb);
  const lns = extractLNS(wb);
  const el = extractEasyLoader(wb);
  const ef = extractEasyFeeder(wb);
  const fp = extractFabricPro(wb);

  const series: CatalogSeries[] = [
    { seriesCode: "M", seriesName: "M-Series", maxDiscountPct: null, products: sortByCode(m.products) },
    { seriesCode: "L", seriesName: "L-Series", maxDiscountPct: 10, products: sortByCode(l.products) },
    // Punchline ("P") retired -- see the comment above extractSoftware for
    // why this series is gone rather than extracted-and-filtered.
    { seriesCode: "SW", seriesName: "Software", maxDiscountPct: null, products: sortByCode(sw.products) },
    { seriesCode: "LNS", seriesName: "Leather Nesting System", maxDiscountPct: null, products: sortByCode(lns.products) },
    { seriesCode: "EL", seriesName: "EasyLoader", maxDiscountPct: null, products: sortByCode(el.products) },
    { seriesCode: "EF", seriesName: "EasyFeeder", maxDiscountPct: null, products: sortByCode(ef.products) },
    // "Heavy Duty Roll Feeder" -- a hand-authored series with no sheet of
    // its own on the AU side (see MANUAL_PRODUCTS.HDRF above for why it's
    // its own series rather than nested under EF). Starts empty here; the
    // MANUAL_PRODUCTS append loop further down fills in its three width
    // variants.
    { seriesCode: "HDRF", seriesName: "Heavy Duty Roll Feeder", maxDiscountPct: null, products: [] },
    { seriesCode: "FP", seriesName: "FabricPro", maxDiscountPct: null, products: sortByCode(fp.products) },
    // "Service" -- a hand-authored series with no sheet of its own at all
    // (see MANUAL_PRODUCTS.SVC and MANUAL_OPTIONS below). Starts empty here;
    // the MANUAL_PRODUCTS append loop further down fills in its one product.
    { seriesCode: "SVC", seriesName: "Service", maxDiscountPct: null, products: [] },
  ];

  // Cross-sheet option merge, in the same M/L/SW/LNS/EL/EF/FP order used
  // above (Punchline's "P" dropped along with its series, see above) -- see
  // buildGlobalOptions for the merge/split rule. MANUAL_OPTIONS (JTP, the
  // SVC-* service options, the HDRF crates) have no sheet row at all, so
  // they're appended after the merge rather than fed into it, then the
  // combined list is re-sorted so they take their alphabetical place.
  const options = sortByCode([
    ...buildGlobalOptions([
      { seriesCode: "M", options: m.options },
      { seriesCode: "L", options: l.options },
      { seriesCode: "SW", options: sw.options },
      { seriesCode: "LNS", options: lns.options },
      { seriesCode: "EL", options: el.options },
      { seriesCode: "EF", options: ef.options },
      { seriesCode: "FP", options: fp.options },
    ]),
    ...MANUAL_OPTIONS,
  ]);

  // X-Calibre: a distinct sellable line built on M-Series' machine specs.
  // Cloned from the already-extracted M products; codes drop the leading
  // "M" and gain an "X-" prefix (M3180 -> X-3180). Prices are copied
  // as-is but flagged needsReview because X-Calibre-specific pricing is not
  // yet published in the source file -- these are provisional placeholders.
  // The series code is "X" (see compatibleSeriesFor above -- renamed from
  // "XC" per owner request; the catalog UI showed "XC" but should read "X")
  // -- the product-code prefix was already "X-", analogous to M/L-Series
  // product codes not repeating their series code either.
  // X is expected to reuse M-Series' options via compatibleSeries (every
  // M-sheet option already lists "X"), not via a duplicated options list.
  const mSeries = series.find((s) => s.seriesCode === "M")!;
  const xcSeries: CatalogSeries = {
    seriesCode: "X",
    seriesName: "X-Calibre",
    maxDiscountPct: null,
    products: sortByCode(
      mSeries.products.map((prod) => ({
        ...prod,
        code: `X-${prod.code.replace(/^M/, "")}`,
        needsReview: true,
      }))
    ),
  };
  series.unshift(xcSeries); // "insert at position 1" => first entry in the array

  // Append hand-authored products (see MANUAL_PRODUCTS) into their series,
  // re-sorting so they take their alphabetical place alongside the
  // sheet-extracted products rather than always trailing at the end.
  for (const s of series) {
    const manual = MANUAL_PRODUCTS[s.seriesCode];
    if (manual) s.products = sortByCode([...s.products, ...manual]);
  }

  // Append NA-only products (see NA_PRODUCTS above) the same way -- after
  // the X clone, so they don't leak into X without NA evidence of their
  // own X-series equivalent.
  for (const s of series) {
    const na = NA_PRODUCTS[s.seriesCode];
    if (na) s.products = sortByCode([...s.products, ...na]);
  }

  const catalog = {
    extractedAt: new Date().toISOString(),
    series,
    options,
  };

  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(catalog, null, 2) + "\n");

  printSummary(series, options);
}

function printSummary(series: CatalogSeries[], options: GlobalOption[]): void {
  console.log("\nCatalog extraction summary");
  console.log("===========================");

  let totalProducts = 0;
  const rows: string[][] = [["Series", "Products"]];
  for (const s of series) {
    rows.push([`${s.seriesCode} (${s.seriesName})`, String(s.products.length)]);
    totalProducts += s.products.length;
  }
  rows.push(["TOTAL", String(totalProducts)]);
  const widths = [0, 1].map((i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i])).join("  |  "));
  console.log(`\nGlobal options: ${options.length}`);

  console.log("\nneedsReview items:");
  let anyReview = false;
  for (const s of series) {
    for (const item of s.products) {
      if (item.needsReview) {
        anyReview = true;
        console.log(`  [${s.seriesCode}/product] ${item.code}  price=${item.price ?? "null"}`);
      }
    }
  }
  for (const item of options) {
    if (item.needsReview) {
      anyReview = true;
      console.log(`  [option] ${item.code}  price=${item.price ?? "null"}`);
    }
  }
  if (!anyReview) console.log("  (none)");

  if (disambiguated.length) {
    console.log("\nDisambiguated (duplicate code, distinguished by description):");
    for (const d of disambiguated) console.log(`  [${d.series}/${d.list}] "${d.original}" -> "${d.final}"`);
  }

  if (dropped.length) {
    console.log("\nDropped (duplicate code, first occurrence kept):");
    for (const d of dropped) console.log(`  [${d.series}/${d.list}] ${d.code} -- ${d.reason}`);
  }

  if (merged.length) {
    console.log("\nMerged options (same price across sheets -> single global option):");
    for (const m of merged) console.log(`  ${m.code}  price=${m.price ?? "null"}  series=[${m.seriesCodes.join(", ")}]`);
  }

  if (split.length) {
    console.log("\nSplit options (differing price across sheets -> series-suffixed codes):");
    for (const s of split) {
      const parts = s.variants.map((v) => `${v.finalCode}=${v.price ?? "null"}`).join(", ");
      console.log(`  ${s.code} -> ${parts}`);
    }
  }

  console.log(`\nWrote ${path.relative(ROOT, OUTPUT_JSON)}`);
}

main();
