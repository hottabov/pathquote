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
 * Extracts USD (North America) retail prices from the raw NA price list into
 * a committed JSON snapshot: prisma/seed-data/prices-us.json.
 *
 * Source:  RAW/Price List North America (01-06-2026).xlsx  (10 sheets: Order,
 * X-series, M-series, L-Series, Software, Leather Nesting System,
 * EasyLoader, EasyFeed, FabricPro, HDRF). "Order" is a pure cross-sheet
 * aggregation, same as the AU workbook's own "Order" sheet, and is ignored.
 *
 * Run:     npm run extract:us-prices
 *
 * Every row's "Listed Maximum Allowed End User Price" column is the USD
 * retail price used here -- "Dealer Price" and "Minimum/Maximum Allowed End
 * User Price" columns exist on every sheet but are deliberately never read;
 * their presence is noted here and in the run's printed report only.
 *
 * This script depends on prisma/seed-data/catalog.json already containing
 * every code it maps to -- run `npm run extract:catalog` first if
 * scripts/extract-catalog.ts's NA_PRODUCTS list has changed. Every mapped
 * target code is checked against the catalog at the end of this file's run;
 * an unrecognised target code is a bug in this script's normalization map,
 * not a data issue, and throws rather than silently writing a dangling
 * price.
 *
 * Design notes (see also inline comments at each call site):
 *
 *  - Rows without an explicit short code (column C blank) use their
 *    description text as the code, exactly like scripts/extract-catalog.ts's
 *    AU extraction of the same rows (e.g. L-Series' punch/tool rows) -- the
 *    catalog code IS that description string.
 *
 *  - X-Calibre reuses M-Series' options (compatibleSeries ["M","XC"]), so an
 *    "-M"-suffixed split option code (e.g. "OFD-M") is the correct target
 *    for both the M-series sheet's and the X-series sheet's rows of the same
 *    short code -- there's no separate "-XC" option code in the catalog.
 *
 *  - The X-series sheet's option rows (MTS, PRM, OFD, OFP, OFJ, HDC, BCR) are
 *    a near-duplicate of the M-series sheet's own rows -- same codes, same
 *    descriptions, same (or fractionally-rounded) prices; a handful of X's
 *    rows (IKA, HFV, AFP) are plain text ("Included as standard") with no
 *    price at all. Both sheets are still extracted (per spec: "Round
 *    fractional prices (e.g. MTS 10446.4285... to 2dp)" -- that exact value
 *    lives on the X-series sheet), but rather than silently letting
 *    whichever sheet is processed last win, this script applies a single
 *    explicit rule everywhere a code is produced more than once:
 *    FIRST OCCURRENCE WINS (sheets are processed in the order listed above,
 *    which is also the workbook's own tab order), and every later duplicate
 *    is logged to the console as a reconciliation note rather than silently
 *    overwriting or silently being dropped. Nothing in the spot-check tests
 *    depends on which side of a reconciled duplicate wins; this rule just
 *    needs to be deterministic and visible, and it is.
 *
 *  - A handful of NA rows describe the same accessory as an existing catalog
 *    option with slightly different wording (e.g. L-Series' "40 Dia. Round
 *    Knife Tool- Quick release (Not used on Felt bed)" vs. the catalog's
 *    "...(Not available yet)", or EasyLoader's "Electrical Runner Per 1.2M"
 *    vs. the catalog's "...Electrical Busbar Per 1.2M"). Rather than fuzzy-
 *    matching text, every such row is mapped to its target catalog code by
 *    explicit, hardcoded position (same convention scripts/extract-catalog.ts
 *    already uses for this workbook family) -- see EL_SECTIONS and the
 *    inline L-Series option list below.
 */
import * as XLSX from "xlsx";
import * as fs from "node:fs";
import * as path from "node:path";
import catalogData from "../prisma/seed-data/catalog.json";

const ROOT = path.resolve(__dirname, "..");
const SOURCE_XLSX = path.join(ROOT, "RAW", "Price List North America (01-06-2026).xlsx");
const OUTPUT_JSON = path.join(ROOT, "prisma", "seed-data", "prices-us.json");

interface CatalogItem {
  code: string;
}
interface CatalogSeries {
  seriesCode: string;
  products: CatalogItem[];
}
interface Catalog {
  series: CatalogSeries[];
  options: CatalogItem[];
}

const catalog = catalogData as Catalog;
const catalogCodes = new Set<string>([
  ...catalog.series.flatMap((s) => s.products.map((p) => p.code)),
  ...catalog.options.map((o) => o.code),
]);

// ---------------------------------------------------------------------------
// Generic cell + accumulator helpers (mirrors scripts/extract-catalog.ts)
// ---------------------------------------------------------------------------

function normalize(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

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

/** Only returns a value for genuinely numeric cells -- text cells like
 *  "Included as standard" (X-series' IKA/HFV/AFP rows) return null, same as
 *  a blank cell, so callers can skip them uniformly. */
function cellNumber(ws: XLSX.WorkSheet, ref: string): number | null {
  const c = ws[ref] as XLSX.CellObject | undefined;
  if (!c || typeof c.v !== "number") return null;
  return c.v;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type PriceEntry = { code: string; amountUsd: number };
type UnmatchedEntry = { sheet: string; label: string; price: number };

const priceByCode = new Map<string, { amountUsd: number; source: string }>();
const unmatched: UnmatchedEntry[] = [];
const reconciliations: string[] = [];

/** Records a matched (code, price) pair. First occurrence for a given code
 *  wins (see header comment); every later duplicate is logged, not applied,
 *  so the final prices-us.json is a deterministic function of sheet order. */
function setPrice(code: string, rawAmount: number, source: string): void {
  const amountUsd = round2(rawAmount);
  const existing = priceByCode.get(code);
  if (existing) {
    if (existing.amountUsd !== amountUsd) {
      reconciliations.push(
        `"${code}" already set to ${existing.amountUsd} (from ${existing.source}) -- ignoring ${amountUsd} from ${source}`
      );
    }
    return;
  }
  priceByCode.set(code, { amountUsd, source });
}

function addUnmatched(sheet: string, label: string, rawAmount: number): void {
  unmatched.push({ sheet, label, price: round2(rawAmount) });
}

// ---------------------------------------------------------------------------
// X-series -- 2 machine codes (X10180, X10220; NA has no other X codes at
// all, so no evidence of any further X-Calibre width for this file to add).
// Its options section (MTS, PRM, OFD, OFP, OFJ, HDC, BCR, plus text-only
// IKA/HFV/AFP and the never-catalogued TR220/Crate M180/M220/Install rows)
// duplicates the M-series sheet -- see extractMSeriesOptions below, which
// covers the same codes with the same target mapping.
// ---------------------------------------------------------------------------

function extractXSeries(wb: XLSX.WorkBook): void {
  const ws = getSheet(wb, "X-series");
  const sheet = "X-series";

  // Machines: rows 5-6, code col B, price col F. "X10180" -> "X-10180"
  // (insert the dash the catalog's XC codes use; XC's own codes are cloned
  // from M-Series' M#### codes with a "M"->"X-" swap, see extract-catalog.ts).
  for (const row of [5, 6]) {
    const raw = cellText(ws, `B${row}`);
    if (!raw) continue;
    const code = raw.replace(/^X(?!-)/, "X-");
    const price = cellNumber(ws, `F${row}`);
    if (price === null) continue;
    setPrice(code, price, `${sheet} B${row}`);
  }

  // Options: rows 7-22. Numeric rows map onto the same M/XC-shared option
  // codes the M-series sheet produces (see extractMSeriesOptions); this
  // sheet is processed first (workbook tab order), so its rounded/fractional
  // values are the ones actually recorded when a code repeats -- the
  // M-series sheet's cleaner, pre-rounded duplicates are logged as
  // reconciliation notes instead of silently overwriting them.
  const optionMap: Record<string, string> = {
    MTS: "MTS",
    "MTS- additional travel p/Metre": "MTS- additional travel p/Metre",
    PRM: "PRM-M",
    OFD: "OFD-M",
    OFP: "OFP-M",
    OFJ: "OFJ",
    HDC: "HDC-M",
    BCR: "BCR-M",
  };
  // IKA (row10), HFV (row16), AFP (row17) are 'Included as standard' text on
  // this sheet (no price) -- cellNumber returns null for them and the loop
  // below skips silently, same as any other non-numeric row.
  for (let row = 7; row <= 20; row++) {
    const rawCode = cellText(ws, `C${row}`);
    if (!rawCode) continue;
    const price = cellNumber(ws, `F${row}`);
    const label = cellText(ws, `E${row}`) || rawCode;
    if (price === null) continue;
    const target = optionMap[rawCode];
    if (target) {
      setPrice(target, price, `${sheet} C${row}`);
    } else {
      // TR220, Crate M180, Crate M220 -- no catalog code exists for these
      // (TR220/TR480 transformers and per-width crate variants aren't in
      // the catalog at all; see M-series/FabricPro/HDRF crate handling
      // below for the general "per-width crate" pattern).
      addUnmatched(sheet, `${rawCode} -- ${label}`, price);
    }
  }
  // Rows 21-22 (Install/Training, Install/Training+MTS) are services --
  // never added to the catalog per spec; reported here too since they carry
  // a price and a distinct code.
  for (const row of [21, 22]) {
    const rawCode = cellText(ws, `C${row}`);
    const price = cellNumber(ws, `F${row}`);
    if (!rawCode || price === null) continue;
    addUnmatched(sheet, `${rawCode} (service)`, price);
  }
}

// ---------------------------------------------------------------------------
// M-series -- 16 machine codes (12 existing + the new 300cm-width tier:
// M3300/M5300/M7300/M10300, see NA_PRODUCTS in extract-catalog.ts) and its
// options section, which is the primary/authoritative source for every
// M/XC-shared split option code.
// ---------------------------------------------------------------------------

function extractMSeries(wb: XLSX.WorkBook): void {
  const ws = getSheet(wb, "M-series");
  const sheet = "M-series";

  for (let row = 5; row <= 20; row++) {
    const code = cellText(ws, `B${row}`);
    if (!code) continue;
    const price = cellNumber(ws, `F${row}`);
    if (price === null) continue;
    setPrice(code, price, `${sheet} B${row}`);
  }

  const optionMap: Record<string, string> = {
    MTS: "MTS",
    "MTS- additional travel p/Metre": "MTS- additional travel p/Metre",
    PM: "PM-M",
    PRM: "PRM-M",
    APM: "APM-M",
    IKA: "IKA",
    OFD: "OFD-M",
    OFP: "OFP-M",
    OFJ: "OFJ",
    HDC: "HDC-M",
    DR2: "DR2",
    BCR: "BCR-M",
    "DRG-1": "DRG-1",
    "DRG-2": "DRG-2",
    "DRG-3": "DRG-3",
    ABR: "ABR-M",
    MRK: "MRK",
    IJP: "IJP",
    HFV: "HFV-M",
    AFP: "AFP",
  };
  for (let row = 21; row <= 42; row++) {
    const rawCode = cellText(ws, `C${row}`);
    if (!rawCode) continue;
    const price = cellNumber(ws, `F${row}`);
    const label = cellText(ws, `E${row}`) || rawCode;
    if (price === null) continue;
    const target = optionMap[rawCode];
    if (target) {
      setPrice(target, price, `${sheet} C${row}`);
    } else {
      // TR480, TR220 -- transformers, no catalog code.
      addUnmatched(sheet, `${rawCode} -- ${label}`, price);
    }
  }
  // Rows 43-46: Crate M180 / Crate M220 (per-width crate, no single
  // catalog "Crate-M180"/"Crate-M220" code -- the catalog's one "Crate-M" is
  // not width-specific -- stay unmatched) and Install/Training x2, which now
  // map onto the SVC-M-INSTALL / SVC-M-INSTALL-MTS service options (see
  // MANUAL_OPTIONS in scripts/extract-catalog.ts) instead of staying
  // unmatched.
  const installTargets: Record<string, string> = {
    "Install/Training": "SVC-M-INSTALL",
    "Install/Training+MTS": "SVC-M-INSTALL-MTS",
  };
  for (let row = 43; row <= 46; row++) {
    const rawCode = cellText(ws, `C${row}`);
    const price = cellNumber(ws, `F${row}`);
    if (!rawCode || price === null) continue;
    const label = cellText(ws, `E${row}`) || rawCode;
    const target = installTargets[rawCode];
    if (target) {
      setPrice(target, price, `${sheet} C${row}`);
    } else {
      addUnmatched(sheet, `${rawCode} -- ${label}`, price);
    }
  }
}

// ---------------------------------------------------------------------------
// L-Series -- 7 machine codes (6 existing + new L-320E) plus its options,
// several of which have no short code (column C) and use their description
// (column E) as the catalog code, same convention as AU's L-Series options.
// ---------------------------------------------------------------------------

function extractLSeries(wb: XLSX.WorkBook): void {
  const ws = getSheet(wb, "L-Series");
  const sheet = "L-Series";

  for (let row = 5; row <= 10; row++) {
    const rawCode = cellText(ws, `B${row}`);
    if (!rawCode) continue;
    const price = cellNumber(ws, `F${row}`);
    if (price === null) continue;
    // "L-320EF" is this file's code for the existing L-320F product -- its
    // description is byte-identical to the catalog's L-320F row (both read
    // "...Width 320cm. Cutting belt Porous felt flat...") whereas the new
    // L-320E (row 7 above) is a genuinely different, higher-priced product.
    const code = rawCode === "L-320EF" ? "L-320F" : rawCode;
    setPrice(code, price, `${sheet} B${row}`);
  }

  // Options: rows 11-39, mostly without a short code column. Each entry
  // below is keyed by the row's own description text (normalized) and maps
  // to the exact catalog option code -- identical text where the two
  // matched already, explicit remapping where NA's wording drifted from the
  // catalog's (see header comment).
  const byDescription: Record<string, string> = {
    "Pattern Match - spot light pattern match software": "PM-L",
    "Production Manager software": "PRM-L",
    "Adaptive Pattern Matching (Bow & Skew- HDC option required)": "APM-L",
    "Offload Display": "OFD-L",
    "Offload Projector (Mx180 & Mx220 only)": "OFJ",
    "HeadCam:Camera in cutting head- Dynamic interaction with PathCut": "HDC-L",
    "Offload Printer- synchronised with PathCut & OFD": "OFP-L",
    "Barcode Scanner- input of marker name via barcode": "BCR-L",
    "Air Brush- air brush including ink/paint reservoir.": "ABR-L",
    "High Flow Vacuum system- THIS REQUIRES 380v/415 3PHASE POWER)": "HFV-L",
    "Jetpen Marking Tool (this replaces the standard marking tool)": "JetPen",
    "28 Dia. Round Knife Tool- Patented Quick release mechanism (Not used on Felt bed) 2x10 sided blades included std":
      "28 Dia. Round Knife Tool- Patented Quick release mechanism (Not used on Felt bed) 2x10 sided blades included std",
    "40 Dia. Round Knife Tool- Quick release (Not used on Felt bed)":
      "40 Dia. Round Knife Tool- Quick release (Not available yet)",
    "Drag Knife Tool- Quick Release (to suit carbide knife 1.0mm x 7mm purchased seperately) 45 deg?":
      "Drag Knife Tool- Quick Release (to suit carbide knife 1.0mm x 7mm purchased seperately) 45 deg?",
    "Drag Knife Tool- Quick Release (to suit carbide knife 1.0mm x 7mm purchased seperately) 30 deg":
      "Drag Knife Tool- Quick Release (to suit carbide knife 1.0mm x 7mm purchased seperately) 30 deg",
    "Punch Tool- Quick Release (to suit Hollow dia 1mm/2mm/3mm/4mm/5mm purchased seperately)":
      "Punch Tool- Quick Release (to suit Hollow dia 1mm/2mm/3mm/4mm/5mm purchased seperately)",
    "Notch Tool- Quick Release (to suit carbide knife 1.0mm x 7mm)":
      "Notch Tool- Quick Release (to suit carbide knife 1.0mm x 7mm)",
    "Driven- Electrically driven. Suit 28mm Carbide Octagonal blade. Only used with machine optioned with Felt cutting surface.":
      "Driven- Electrically driven. Suit 28mm Carbide Octagonal blade.",
    "1.0mm dia punch": "1.0mm dia punch",
    "2.0mm dia punch": "2.0mm dia punch",
    "3.0mm dia punch": "3.0mm dia punch",
    "4.0mm dia punch": "4.0mm dia punch",
    "5.0mm dia punch": "5.0mm dia punch",
    "Crate-180": "Crate-180",
    "Crate-220": "Crate-220",
    "Crate-320": "Crate-320",
  };

  for (let row = 11; row <= 39; row++) {
    const explicitCode = cellText(ws, `C${row}`);
    const desc = cellText(ws, `E${row}`);
    const price = cellNumber(ws, `F${row}`);
    if (price === null) continue;
    // "180-E" / "220-E" have their own short code (column C); everything
    // else on this sheet keys off the description.
    if (explicitCode === "180-E" || explicitCode === "220-E") {
      setPrice(explicitCode, price, `${sheet} C${row}`);
      continue;
    }
    const target = byDescription[desc];
    if (target) {
      setPrice(target, price, `${sheet} row ${row}`);
    } else {
      addUnmatched(sheet, desc || `(row ${row})`, price);
    }
  }

  // Rows 40-41: Install/Training rows -- row 40 (L180/L180E/L220, Static/no
  // MTS, 6900) maps to SVC-L-INSTALL; row 41 (L220E/L320E, with MTS, 8820)
  // maps to SVC-L-INSTALL-MTS (see MANUAL_OPTIONS in
  // scripts/extract-catalog.ts). Mapped by row index rather than by parsing
  // the descriptive column-C text (which lists machine widths, not a code).
  const installTargetsByRow: Record<number, string> = { 40: "SVC-L-INSTALL", 41: "SVC-L-INSTALL-MTS" };
  for (const row of [40, 41]) {
    const rawCode = cellText(ws, `C${row}`);
    const price = cellNumber(ws, `F${row}`);
    if (!rawCode || price === null) continue;
    setPrice(installTargetsByRow[row], price, `${sheet} C${row}`);
  }
}

// ---------------------------------------------------------------------------
// Software -- PTW(S)/PDG/WPL/ANT-V5/ANT-V6/WPN/LS Convert/PRA match by code;
// "PTW (I)" normalizes to "PTW(I)" (a new SW product, see NA_PRODUCTS);
// "Training" (remote support) is a service, reported not catalogued. EDG and
// PTN (both catalog SW products) simply have no row in this sheet at all --
// they surface as "catalog codes with no US price" in the summary, not here.
// ---------------------------------------------------------------------------

function extractSoftware(wb: XLSX.WorkBook): void {
  const ws = getSheet(wb, "Software");
  const sheet = "Software";

  const directCodes = ["PTW(S)", "PDG", "WPL", "ANT-V5", "ANT-V6", "WPN"];
  for (let row = 6; row <= 12; row++) {
    const rawCode = cellText(ws, `C${row}`);
    if (!rawCode) continue;
    const price = cellNumber(ws, `F${row}`);
    if (price === null) continue;
    if (rawCode === "PTW (I)") {
      setPrice("PTW(I)", price, `${sheet} C${row}`);
    } else if (directCodes.includes(rawCode)) {
      setPrice(rawCode, price, `${sheet} C${row}`);
    } else {
      addUnmatched(sheet, rawCode, price);
    }
  }

  // Row 13: "Training" (remote support, service) -- maps to SVC-SW-TRAINING
  // (see MANUAL_OPTIONS in scripts/extract-catalog.ts).
  {
    const rawCode = cellText(ws, "C13");
    const price = cellNumber(ws, "F13");
    if (rawCode && price !== null) setPrice("SVC-SW-TRAINING", price, `${sheet} C13`);
  }

  // Row 17: "LS Convert software module (dongle protected)" -- the sheet's
  // own code cell (C16, "LS Convert ?  PLA convert?") is a working note, not
  // a real code; the catalog's own code for this product is the fixed
  // literal "LS Convert" (see extract-catalog.ts's extractSoftware).
  {
    const price = cellNumber(ws, "F17");
    if (price !== null) setPrice("LS Convert", price, `${sheet} F17`);
  }

  // Row 20: PRA.
  {
    const rawCode = cellText(ws, "C20");
    const price = cellNumber(ws, "F20");
    if (rawCode === "PRA" && price !== null) setPrice("PRA", price, `${sheet} C20`);
  }
}

// ---------------------------------------------------------------------------
// Leather Nesting System -- LNS-2020/2420/3220 match by code; each width's
// "Installation/Training (With cutter installation) 2 days." row is a
// service, priced identically (2600) across all three widths -- maps to the
// SVC-LNS-INSTALL service option (see MANUAL_OPTIONS in
// scripts/extract-catalog.ts) instead of staying unmatched.
// ---------------------------------------------------------------------------

function extractLNS(wb: XLSX.WorkBook): void {
  const ws = getSheet(wb, "Leather Nesting System");
  const sheet = "Leather Nesting System";

  for (const { codeRow, serviceRow } of [
    { codeRow: 7, serviceRow: 8 },
    { codeRow: 12, serviceRow: 13 },
    { codeRow: 17, serviceRow: 18 },
  ]) {
    const code = cellText(ws, `C${codeRow}`);
    const price = cellNumber(ws, `F${codeRow}`);
    if (code && price !== null) setPrice(code, price, `${sheet} C${codeRow}`);

    const serviceLabel = cellText(ws, `E${serviceRow}`);
    const servicePrice = cellNumber(ws, `F${serviceRow}`);
    if (serviceLabel && servicePrice !== null) {
      setPrice("SVC-LNS-INSTALL", servicePrice, `${sheet} F${serviceRow}`);
    }
  }
}

// ---------------------------------------------------------------------------
// EasyLoader -- 4 width sections in this file (2020/2420/3220/4030) vs. the
// catalog's 2 existing EL products. Each section's Drive Module row is that
// width's product price. The 2020/2420 sections' accessory rows map onto
// the existing "EL-2020 <name>" / "EL-2420 <name>" catalog option codes
// (explicit per-row target, since several rows' wording drifted slightly
// from the catalog's, e.g. "Electrical Runner" vs. the catalog's "Electrical
// Busbar"); the new 3220/4030 sections' accessory rows have no catalog
// option equivalent at all and are reported as unmatched, not invented.
// ---------------------------------------------------------------------------

// Every section's own "Installation (Drive Module@... + Additional
// Modules@...) with Cutter installation" row is priced identically (180)
// regardless of width -- these map to the SVC-EL-INSTALL service option
// (see MANUAL_OPTIONS in scripts/extract-catalog.ts) via the `service: true`
// flag below, instead of staying unmatched like the (still-uncatalogued)
// per-width Crate rows next to them.
const EL_SECTIONS: {
  width: string;
  driveRow: number;
  accessories: { row: number; target?: string; service?: true }[];
}[] = [
  {
    width: "2020",
    driveRow: 6,
    accessories: [
      { row: 7, target: "EL-2020 Additional 1.2M lengths" },
      { row: 8, target: "EL-2020 Static table 1.2M lengths" },
      { row: 9, target: "EL-2020 Electrical Busbar Per 1.2M Used for Fabric Pro automatic spreader." },
      { row: 10, target: "EL-2020 Travel Platform support rail. Per 1.2m" },
      {
        row: 11,
        target: "EL-2020 Single Roll feed attachment (L & R clip attachment with cross bar & pair of keeper)",
      },
      {
        row: 12,
        target:
          "EL-2020 #ST620-2020 Roll Holder- Used to dispense perforated underlay paper. Mounted rear of EasyLoader on lower leg.",
      },
      { row: 13 }, // Crate -- no catalog code
      { row: 14, service: true }, // Installation -- service
    ],
  },
  {
    width: "2420",
    driveRow: 21,
    accessories: [
      { row: 22, target: "EL-2420 Additional 1.2M lengths" },
      { row: 23, target: "EL-2420 Static table 1.2M lengths" },
      { row: 24, target: "EL-2420 Electrical Busbar Per 1.2M Used for Fabric Pro automatic spreader." },
      { row: 25, target: "EL-2420 Travel Platform support rail. Per 1.2m" },
      {
        row: 26,
        target: "EL-2420 Single Roll feed attachment (L & R clip attachment with cross bar & pair of keeper)",
      },
      {
        row: 27,
        target:
          "EL-2420 ST620-2420 Roll Holder- Used to dispense perforated underlay paper. Mounted rear of EasyLoader on lower leg.",
      },
      { row: 28 }, // Crate -- no catalog code
      { row: 29, service: true }, // Installation -- service
    ],
  },
  {
    // NEW product (EL-3220, see NA_PRODUCTS) -- accessories have no catalog
    // option equivalent yet.
    width: "3220",
    driveRow: 36,
    accessories: [
      { row: 37 },
      { row: 38 },
      { row: 39 },
      { row: 40 },
      { row: 41 }, // Crate -- no catalog code
      { row: 42, service: true }, // Installation -- service
    ],
  },
  {
    // NEW product (EL-4030, see NA_PRODUCTS) -- same as 3220.
    width: "4030",
    driveRow: 49,
    accessories: [
      { row: 50 },
      { row: 51 },
      { row: 52 },
      { row: 53 },
      { row: 54 }, // Crate -- no catalog code
      { row: 55, service: true }, // Installation -- service
    ],
  },
];

function extractEasyLoader(wb: XLSX.WorkBook): void {
  const ws = getSheet(wb, "EasyLoader");
  const sheet = "EasyLoader";

  for (const section of EL_SECTIONS) {
    const productCode = `EL-${section.width}`;
    const drivePrice = cellNumber(ws, `F${section.driveRow}`);
    if (drivePrice !== null) setPrice(productCode, drivePrice, `${sheet} F${section.driveRow}`);

    for (const acc of section.accessories) {
      const price = cellNumber(ws, `F${acc.row}`);
      if (price === null) continue;
      const label = cellText(ws, `E${acc.row}`) || `(row ${acc.row})`;
      if (acc.target) {
        setPrice(acc.target, price, `${sheet} F${acc.row}`);
      } else if (acc.service) {
        setPrice("SVC-EL-INSTALL", price, `${sheet} F${acc.row}`);
      } else {
        addUnmatched(sheet, `EL-${section.width} ${label}`, price);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// EasyFeed -- 4 width sections (2020/2420/3220/4030) vs. the catalog's 3
// existing EF products (2020/2420/4030); 3220 is the missing one, added via
// NA_PRODUCTS. Each section's own "EasyFeed- <width>" row is the product
// price; each section's "Installation (... hrs) with Cutter installation"
// row is a service, reported not catalogued.
// ---------------------------------------------------------------------------

function extractEasyFeed(wb: XLSX.WorkBook): void {
  const ws = getSheet(wb, "EasyFeed");
  const sheet = "EasyFeed";

  for (const { width, priceRow, installRow } of [
    { width: "2020", priceRow: 7, installRow: 16 },
    { width: "2420", priceRow: 21, installRow: 30 },
    { width: "3220", priceRow: 35, installRow: 44 },
    { width: "4030", priceRow: 50, installRow: 59 },
  ]) {
    const price = cellNumber(ws, `F${priceRow}`);
    if (price !== null) setPrice(`EF-${width}`, price, `${sheet} F${priceRow}`);

    const installLabel = cellText(ws, `E${installRow}`);
    const installPrice = cellNumber(ws, `F${installRow}`);
    if (installLabel && installPrice !== null) {
      addUnmatched(sheet, `EF-${width} ${installLabel} (service)`, installPrice);
    }
  }
}

// ---------------------------------------------------------------------------
// FabricPro -- FP-180/FP-220 match existing products; FP-300 is new (see
// NA_PRODUCTS). Each section's "Crate- Wooden Crate for transport" row maps
// to the single catalog "Crate-FP" option (per spec) -- but the three
// sections actually carry three DIFFERENT crate prices (1254/1400/1600,
// one per machine width), so only the first (FP-180's) is applied to
// "Crate-FP"; the other two are logged as reconciliation notes via the
// normal setPrice() dedup path, same as any other repeated code. Each
// section's "Installation & Training" row is a service, priced identically
// (960) across all three widths -- maps to the SVC-FP-INSTALL service option
// (see MANUAL_OPTIONS in scripts/extract-catalog.ts) instead of staying
// unmatched. Note: this sheet's price column is G, not F (unlike every
// other sheet in this workbook).
// ---------------------------------------------------------------------------

function extractFabricPro(wb: XLSX.WorkBook): void {
  const ws = getSheet(wb, "FabricPro");
  const sheet = "FabricPro";

  for (const { code, machineRow, crateRow, installRow } of [
    { code: "FP-180", machineRow: 6, crateRow: 7, installRow: 8 },
    { code: "FP-220", machineRow: 13, crateRow: 14, installRow: 15 },
    { code: "FP-300", machineRow: 23, crateRow: 24, installRow: 25 },
  ]) {
    const machinePrice = cellNumber(ws, `G${machineRow}`);
    if (machinePrice !== null) setPrice(code, machinePrice, `${sheet} G${machineRow}`);

    const crateLabel = cellText(ws, `C${crateRow}`);
    const cratePrice = cellNumber(ws, `G${crateRow}`);
    if (cratePrice !== null) setPrice("Crate-FP", cratePrice, `${sheet} ${code} ${crateLabel}`);

    const installLabel = cellText(ws, `C${installRow}`);
    const installPrice = cellNumber(ws, `G${installRow}`);
    if (installLabel && installPrice !== null) {
      setPrice("SVC-FP-INSTALL", installPrice, `${sheet} G${installRow}`);
    }
  }
}

// ---------------------------------------------------------------------------
// HDRF -- the catalog now has three width-specific products, HDRF-180/220/320,
// in their own "HDRF" series (see MANUAL_PRODUCTS.HDRF in
// scripts/extract-catalog.ts; owner decision to split the old single
// width-less "HDRF" product, same as this sheet's own three real,
// distinctly-priced width variants, and to give it its own series rather
// than nest it under EasyFeeder). Each section's machine row
// maps directly onto its matching catalog product code. Each section's
// "2 hours installation" row is priced identically (180) across all three
// widths and maps to the SVC-HDRF-INSTALL service option (see
// MANUAL_OPTIONS in scripts/extract-catalog.ts). Crate rows ARE genuinely
// different per width (1254/1400/1600) -- unlike installation, they map onto
// three separate product-scoped catalog options (one per width, see the same
// MANUAL_OPTIONS section) rather than a single shared one; catalogCratecode
// carries the exact code MANUAL_OPTIONS uses for each ("<width> Crate- Wooden
// Crate for transport"), sourced from this sheet's own label text (note the
// third section's label starts "HDRF320", no hyphen -- a typo in the source
// workbook, normalized to "HDRF-320 ..." here to match the catalog code).
// ---------------------------------------------------------------------------

function extractHDRF(wb: XLSX.WorkBook): void {
  const ws = getSheet(wb, "HDRF");
  const sheet = "HDRF";

  const sections = [
    {
      catalogCode: "HDRF-180",
      catalogCrateCode: "HDRF-180 Crate- Wooden Crate for transport",
      machineRow: 6,
      crateRow: 7,
      installRow: 8,
    },
    {
      catalogCode: "HDRF-220",
      catalogCrateCode: "HDRF-220 Crate- Wooden Crate for transport",
      machineRow: 13,
      crateRow: 14,
      installRow: 15,
    },
    {
      catalogCode: "HDRF-320",
      catalogCrateCode: "HDRF-320 Crate- Wooden Crate for transport",
      machineRow: 23,
      crateRow: 24,
      installRow: 25,
    },
  ];

  for (const section of sections) {
    const machinePrice = cellNumber(ws, `G${section.machineRow}`);
    if (machinePrice !== null) {
      setPrice(section.catalogCode, machinePrice, `${sheet} G${section.machineRow}`);
    }

    const cratePrice = cellNumber(ws, `G${section.crateRow}`);
    if (cratePrice !== null) {
      setPrice(section.catalogCrateCode, cratePrice, `${sheet} G${section.crateRow}`);
    }

    const installLabel = cellText(ws, `C${section.installRow}`);
    const installPrice = cellNumber(ws, `G${section.installRow}`);
    if (installLabel && installPrice !== null) {
      setPrice("SVC-HDRF-INSTALL", installPrice, `${sheet} G${section.installRow}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function main(): void {
  if (!fs.existsSync(SOURCE_XLSX)) {
    console.error(`Source workbook not found: ${SOURCE_XLSX}`);
    process.exit(1);
  }

  const wb = XLSX.readFile(SOURCE_XLSX);

  // Sheet processing order matches the workbook's own tab order (and the
  // "first occurrence wins" rule documented above depends on this order
  // being stable across runs).
  extractXSeries(wb);
  extractMSeries(wb);
  extractLSeries(wb);
  extractSoftware(wb);
  extractLNS(wb);
  extractEasyLoader(wb);
  extractEasyFeed(wb);
  extractFabricPro(wb);
  extractHDRF(wb);

  // Validate every matched target code against the catalog -- an
  // unrecognised code here means a typo in this script's normalization map,
  // not a real data issue, and should fail loudly rather than write a
  // dangling price no product/option will ever pick up.
  const badCodes = [...priceByCode.keys()].filter((c) => !catalogCodes.has(c));
  if (badCodes.length) {
    throw new Error(
      `extract-us-prices: ${badCodes.length} matched code(s) don't exist in catalog.json -- ` +
        `fix the normalization map or re-run 'npm run extract:catalog' first: ${badCodes.join(", ")}`
    );
  }

  const prices: PriceEntry[] = [...priceByCode.entries()]
    .map(([code, { amountUsd }]) => ({ code, amountUsd }))
    .sort((a, b) => a.code.localeCompare(b.code, "en"));

  const output = {
    extractedAt: new Date().toISOString(),
    prices,
    unmatched: [...unmatched].sort((a, b) => a.sheet.localeCompare(b.sheet, "en") || a.label.localeCompare(b.label, "en")),
  };

  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2) + "\n");

  printSummary(prices, output.unmatched);
}

function printSummary(prices: PriceEntry[], unmatchedRows: UnmatchedEntry[]): void {
  console.log("\nUS price extraction summary");
  console.log("============================");
  console.log(`Matched prices:   ${prices.length}`);
  console.log(`Unmatched rows:   ${unmatchedRows.length}`);

  const matchedCodes = new Set(prices.map((p) => p.code));
  const missing = [...catalogCodes].filter((c) => !matchedCodes.has(c)).sort((a, b) => a.localeCompare(b, "en"));
  console.log(`\nCatalog codes with NO US price (${missing.length}) -- these simply lack a US price, not an error:`);
  for (const code of missing) console.log(`  ${code}`);

  if (reconciliations.length) {
    console.log(`\nReconciliation notes (${reconciliations.length}) -- a code appeared more than once; first occurrence kept:`);
    for (const note of reconciliations) console.log(`  ${note}`);
  }

  if (unmatchedRows.length) {
    console.log(`\nUnmatched rows (${unmatchedRows.length}) -- services, per-width crate/variant rows, etc:`);
    for (const u of unmatchedRows) console.log(`  [${u.sheet}] ${u.label} = ${u.price}`);
  }

  console.log(
    "\nNote: every sheet also carries 'Dealer Price' and 'Minimum/Maximum Allowed End User Price' columns -- " +
      "intentionally never read by this script; only 'Listed Maximum Allowed End User Price' is the USD retail price."
  );

  console.log(`\nWrote ${path.relative(ROOT, OUTPUT_JSON)}`);
}

main();
