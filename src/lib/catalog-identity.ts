import type { OptionRole, ProductKind, ProductionForm } from "@prisma/client";
import type { ProductSpecs } from "@/lib/validation/product-specs";

/**
 * The one place that still knows what the *legacy* catalogue codes meant.
 *
 * Before migration z31_catalog_identity the app answered "is this a
 * machine?", "which order form?", "how wide?", "which box does this option
 * tick?" by pattern-matching Product.code / Option.code -- some sixty
 * sites, each with its own regex (map: docs/audit/2026-09-05-catalog-
 * proposal-v1.md, appendix A). Those answers now live in columns
 * (Product.kind/form/specs, Option.role/parentProductId/unitLengthM,
 * *.contentBlockKey), and every reader in src/ takes them from there.
 *
 * This module exists for the two places that still start from a code:
 *
 *  1. scripts/backfill-catalog-identity.ts, which fills the new columns for
 *     rows that pre-date them -- by running exactly the rules the readers
 *     used to run, so nothing changes behaviour on the day the columns
 *     arrive. tests/catalog-identity.test.ts holds each rule to the reader
 *     it replaced.
 *  2. prisma/seed.ts, which builds rows from prisma/seed-data/catalog.json
 *     -- a file that (until catalogue v2 regenerates it) carries the legacy
 *     codes and nothing else.
 *
 * Nothing under src/ other than the seed path may import the `legacy*`
 * functions. When the catalogue-v2 data lands (docs/plans/2026-09-05-
 * catalog-identity-and-cleanup.md, phase 3) the seed reads kind/role from
 * the target file instead and this file shrinks to `findByAnyCode`.
 */

export type ProductIdentity = {
  kind: ProductKind;
  form: ProductionForm | null;
  specs: ProductSpecs;
  contentBlockKey: string | null;
};

export type OptionIdentity = {
  role: OptionRole | null;
  /** Legacy product code this option belongs to (EasyLoader modules). */
  parentProductCode: string | null;
  unitLengthM: number | null;
  /**
   * Candidate ContentBlock keys, most specific first -- the backfill keeps
   * the first one that exists. Mirrors the old `optionBlockKey`.
   */
  contentBlockKeyCandidates: string[];
};

// --- Products ------------------------------------------------------------

/** What src/lib/production-forms/specs/m-series.ts matched on. */
const M_SERIES_CODE = /^M(3|5|7|10)(180|220|300|390)$/;
/** What src/lib/machine-specs.ts parsed for M and X. */
const M_X_SPECS = /^[MX]-?(\d{1,2})(180|220|300|390)$/;
/** L-Series: width, optional E (extended), optional F (felt). */
const L_CODE = /^L-(\d{2,3})(E?)(F?)$/;
const EL_CODE = /^EL-(\d{4})$/;
const EF_CODE = /^EF-(\d{4})$/;
const FP_FORM_CODE = /^FP-(180|220|300)$/;

/** Cutting widths per width family, as the price list describes them. */
const CUT_WIDTH_CM: Record<number, number> = { 180: 180, 220: 227, 300: 300, 390: 390 };
const L_CUT_WIDTH_CM: Record<number, number> = { 180: 180, 220: 226, 320: 320 };

const PATHWORKS_MODULES: Record<string, ProductSpecs["pathworksModule"]> = {
  PDG: "PDG",
  WPN: "WPN",
  WPL: "WPL",
  "ANT-V5": "ANT_V5",
  "ANT-V6": "ANT_V6",
};

export function legacyProductKind(seriesCode: string, code: string, isCredit: boolean): ProductKind {
  if (isCredit) return "CREDIT";
  switch (seriesCode) {
    case "M":
    case "X":
    case "L":
      return "MACHINE";
    case "EL":
      return "TABLE";
    case "EF":
      return "FEEDER";
    case "FP":
      return code === "FP-TROLLEY" ? "ACCESSORY" : "SPREADER";
    case "SW":
      return "SOFTWARE";
    case "LNS":
      return "SYSTEM";
    case "SVC":
      return "SERVICE";
    default:
      return "ACCESSORY";
  }
}

/**
 * Which form the legacy `resolveForm(code)` picked. X-Calibre deliberately
 * resolves to none: the M-Series form's model row prints M3/M5/M7/M10 boxes
 * only, and the old regex never matched an X code.
 */
export function legacyProductionForm(code: string): ProductionForm | null {
  if (M_SERIES_CODE.test(code)) return "M_SERIES";
  if (EL_CODE.test(code)) return "EASYLOADER";
  if (FP_FORM_CODE.test(code)) return "FABRICPRO";
  return null;
}

export function legacyProductSpecs(seriesCode: string, code: string): ProductSpecs {
  if (seriesCode === "M" || seriesCode === "X") {
    const match = M_X_SPECS.exec(code);
    if (!match) return {};
    const height = Number(match[1]);
    const widthCode = Number(match[2]);
    return {
      cutHeightCm: height,
      cutWidthCm: CUT_WIDTH_CM[widthCode] ?? widthCode,
      widthCode,
      modelTier: `${seriesCode}${height}`,
    };
  }

  if (seriesCode === "L") {
    const match = L_CODE.exec(code);
    if (!match) return {};
    const widthCode = Number(match[1]);
    return {
      cutWidthCm: L_CUT_WIDTH_CM[widthCode] ?? widthCode,
      widthCode,
      extended: match[2] === "E",
      belt: match[3] === "F" ? "felt" : "urethane",
    };
  }

  if (seriesCode === "EL" || seriesCode === "EF") {
    const match = (seriesCode === "EL" ? EL_CODE : EF_CODE).exec(code);
    return match ? { tableWidthMm: Number(match[1]) } : {};
  }

  if (seriesCode === "FP") {
    const match = FP_FORM_CODE.exec(code);
    return match ? { cutWidthCm: Number(match[1]), widthCode: Number(match[1]) } : {};
  }

  if (seriesCode === "P") {
    if (code === "P-180") return { paperWidthMm: 1880 };
    if (code === "P-220") return { paperWidthMm: 2280 };
    return {};
  }

  if (seriesCode === "SW") {
    const upper = code.toUpperCase();
    if (upper.includes("(S)")) return { softwareMode: "standalone" };
    if (upper.includes("(I)")) return { softwareMode: "integrated" };
    const pathworksModule = PATHWORKS_MODULES[code];
    return pathworksModule ? { pathworksModule } : {};
  }

  return {};
}

/** What src/lib/quotation-data.ts's `productBlockKey` returned. */
export function legacyProductContentBlockKey(seriesCode: string, code: string): string | null {
  switch (seriesCode) {
    case "M":
    case "X":
      return "machine.m-series";
    case "EL":
      return "equipment.easy-loader";
    case "FP":
      return "equipment.fabric-pro";
    case "P":
      return "equipment.punchline";
    case "SW": {
      const upper = code.toUpperCase();
      if (upper.includes("(S)")) return "software.pathworks-s";
      if (upper.includes("(I)")) return "software.pathworks-i";
      return null;
    }
    default:
      return null;
  }
}

export function legacyProductIdentity(seriesCode: string, code: string, isCredit = false): ProductIdentity {
  return {
    kind: legacyProductKind(seriesCode, code, isCredit),
    form: legacyProductionForm(code),
    specs: legacyProductSpecs(seriesCode, code),
    contentBlockKey: legacyProductContentBlockKey(seriesCode, code),
  };
}

// --- Options -------------------------------------------------------------

/**
 * Role by legacy code, in the order the M-Series form's `optionTick`
 * patterns and the EasyLoader spec's `coversOptions` matched. First match
 * wins, so the EasyLoader prefix rules come before the generic ones ("EL-2020
 * #ST620-2020 Roll Holder..." must not fall through to CRATE or anything
 * else).
 */
const OPTION_ROLE_RULES: Array<[RegExp, OptionRole]> = [
  // EasyLoader modules and fittings (src/lib/production-forms/table-sections.ts,
  // specs/easyloader.ts)
  [/Drive Module \(first 1\.2M\)$/i, "EL_DRIVE"],
  [/Additional 1\.2M lengths$/i, "EL_CONVEYOR"],
  [/Static table 1\.2M lengths$/i, "EL_STATIC"],
  [/Electrical Busbar Per 1\.2M/i, "EL_BUSBAR"],
  [/Travel Platform support rail\. Per 1\.2m$/i, "EL_RAIL"],
  [/Single Roll feed attachment/i, "EL_ROLL_FEED"],
  [/Roll Holder/i, "EL_ROLL_HOLDER"],
  [/Syncronisation/i, "EL_SYNC"],
  // M-Series form ticks (specs/m-series.ts), plus the AU-only options that
  // had no box
  [/^VRB/, "VRB"],
  [/^OFJ$/, "OFJ"],
  [/^HFV/, "HFV"],
  [/^PM-/, "PM"],
  [/^OFD/, "OFD"],
  [/^PRM/, "PRM"],
  [/^APM/, "APM"],
  [/^OFP/, "OFP"],
  [/^DMT$/, "DMT"],
  [/^DRG-1$/, "DRG_1"],
  [/^DRG-2$/, "DRG_2"],
  [/^DRG-3$/, "DRG_3"],
  [/^MRK$/, "MRK"],
  [/(^|\s)Crate/, "CRATE"],
  [/^IJP$/, "IJP"],
  [/^HDC/, "HDC"],
  [/^ABR/, "ABR"],
  [/^BCR/, "BCR"],
  [/^DR2$/, "DR2"],
  [/^IKA$/, "IKA"],
  [/^IKP$/, "IKP"],
  [/^AFP$/, "AFP"],
  [/^MTS-/, "MTS_TRAVEL"],
  [/^MTS$/, "MTS"],
  [/^BED$/, "BED"],
  [/^EDS-/, "EDS"],
  [/^EXH$/, "EXH"],
  [/^TR\d{3}$/, "TRANSFORMER"],
  [/^Waste Bin/, "WASTE_BIN"],
  [/^Drills included/, "CONSUMABLE"],
  // L-Series
  [/^(JTP|JetPen)$/, "JTP"],
  [/^\d{3}-E$/, "L_EXTENDED"],
  [/punch|Knife Tool|Notch Tool|^Driven-/i, "L_TOOL"],
  // FabricPro
  [/^TPL$/, "TPL"],
  // Services and software sold as option lines
  [/^SVC-.*-INSTALL/, "INSTALL"],
  [/^SVC-.*-TRAINING$/, "TRAINING"],
  [/^(PTW|PRA-[A-Z]+)$/, "SOFTWARE"],
];

const EL_PARENT = /^(EL-\d{4}) /;

export function legacyOptionRole(code: string): OptionRole | null {
  for (const [pattern, role] of OPTION_ROLE_RULES) if (pattern.test(code)) return role;
  return null;
}

export function legacyOptionParentProductCode(code: string): string | null {
  return EL_PARENT.exec(code)?.[1] ?? null;
}

/**
 * What src/lib/option-length.ts read out of the name: a "1.2M" figure only
 * counts when the name also says "per" or "length(s)". MTS travel is per
 * metre by its description ("Additional travel p/metre"), which that parser
 * never caught -- it is set here because the role says so.
 */
export function legacyOptionUnitLengthM(role: OptionRole | null): number | null {
  switch (role) {
    case "EL_DRIVE":
    case "EL_CONVEYOR":
    case "EL_STATIC":
    case "EL_BUSBAR":
    case "EL_RAIL":
      return 1.2;
    case "MTS_TRAVEL":
      return 1;
    default:
      return null;
  }
}

/** What src/lib/quotation-data.ts's `optionBlockKey` tried, in order. */
export function legacyOptionContentBlockKeyCandidates(code: string): string[] {
  const candidates = [`option.${code}`];
  const lastDash = code.lastIndexOf("-");
  if (lastDash > 0) {
    const stripped = `option.${code.slice(0, lastDash)}`;
    if (!candidates.includes(stripped)) candidates.push(stripped);
  }
  return candidates;
}

export function legacyOptionIdentity(code: string): OptionIdentity {
  const role = legacyOptionRole(code);
  return {
    role,
    parentProductCode: legacyOptionParentProductCode(code),
    unitLengthM: legacyOptionUnitLengthM(role),
    contentBlockKeyCandidates: legacyOptionContentBlockKeyCandidates(code),
  };
}

// --- Lookup by any code --------------------------------------------------

/**
 * A Prisma `where` that finds a product/option by its current code *or* a
 * code it used to have. For importers keyed on codes from outside the app
 * (price sheets, image maps, the seed) -- the app itself never looks rows up
 * by code.
 */
export function whereAnyCode(code: string): { OR: [{ code: string }, { legacyCodes: { has: string } }] } {
  return { OR: [{ code }, { legacyCodes: { has: code } }] };
}
