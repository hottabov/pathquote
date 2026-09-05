import { describe, it, expect } from "vitest";
import catalogData from "../prisma/seed-data/catalog.json";
import {
  legacyOptionIdentity,
  legacyProductIdentity,
  legacyProductionForm,
  whereAnyCode,
} from "../src/lib/catalog-identity";
import { resolveForm } from "../src/lib/production-forms/resolve";
import { mSeriesSpec } from "../src/lib/production-forms/specs/m-series";
import { easyLoaderSpec } from "../src/lib/production-forms/specs/easyloader";
import type { ProductSpecs } from "../src/lib/validation/product-specs";
import { EL_MODULE_ROLE_LIST } from "../src/lib/production-forms/table-sections";

/**
 * The legacy code rules (src/lib/catalog-identity.ts) held to what the
 * readers they replaced used to answer. The readers themselves (machine-
 * specs, quotation-data, option-length, the production forms) now take
 * kind/specs/role/contentBlockKey/unitLengthM off the columns and no longer
 * export a code path to compare against, so each rule is checked against a
 * fixed table of the answers the old reader gave for the same codes.
 *
 * Deleted with the legacy rules in phase 4 of
 * docs/plans/2026-09-05-catalog-identity-and-cleanup.md.
 */

type Catalog = {
  series: { seriesCode: string; products: { code: string; isCredit?: boolean }[] }[];
  options: { code: string; name: string }[];
};
const catalog = catalogData as Catalog;

const products = catalog.series.flatMap((s) => s.products.map((p) => ({ ...p, seriesCode: s.seriesCode })));

/** What the per-form `matches(code)` regexes used to answer, per product. */
const LEGACY_FORM_BY_CODE: Record<string, "M_SERIES" | "EASYLOADER" | "FABRICPRO" | null> = {
  M3180: "M_SERIES",
  M5220: "M_SERIES",
  M7300: "M_SERIES",
  M10390: "M_SERIES",
  "EL-2020": "EASYLOADER",
  "EL-4030": "EASYLOADER",
  "FP-180": "FABRICPRO",
  "FP-300": "FABRICPRO",
  "FP-TROLLEY": null,
  "EF-2420": null,
  "X-10180": null,
  "PTW(I)": null,
  PDG: null,
  SERVICE: null,
};

describe("product identity parity", () => {
  it("form matches what the per-form code regexes answered", () => {
    for (const [code, form] of Object.entries(LEGACY_FORM_BY_CODE)) {
      expect(legacyProductionForm(code), code).toBe(form);
    }
  });

  it("every form the backfill can assign has a spec to print", () => {
    const forms = new Set(products.map((p) => legacyProductionForm(p.code)).filter((f) => f !== null));
    expect(forms).toEqual(new Set(["M_SERIES", "EASYLOADER", "FABRICPRO"]));
    for (const form of forms) expect(resolveForm(form)?.form, form).toBe(form);
  });

  it("reads the cutting specs out of the machine codes the way the old code parser did", () => {
    // What machine-specs.ts's `parseMachineSpecs` answered, plus the two
    // things the column knows that the regex never did: the real cut of a
    // 220-family machine (227 / 226, where the parser reported the family)
    // and the 300 width / L-320E variant (which the parser never matched).
    const SPECS_BY_CODE: Record<string, [series: string, specs: ProductSpecs]> = {
      M3390: ["M", { cutHeightCm: 3, cutWidthCm: 390, widthCode: 390, modelTier: "M3" }],
      M10180: ["M", { cutHeightCm: 10, cutWidthCm: 180, widthCode: 180, modelTier: "M10" }],
      M5220: ["M", { cutHeightCm: 5, cutWidthCm: 227, widthCode: 220, modelTier: "M5" }],
      M7300: ["M", { cutHeightCm: 7, cutWidthCm: 300, widthCode: 300, modelTier: "M7" }],
      "X-3180": ["X", { cutHeightCm: 3, cutWidthCm: 180, widthCode: 180, modelTier: "X3" }],
      "X-10390": ["X", { cutHeightCm: 10, cutWidthCm: 390, widthCode: 390, modelTier: "X10" }],
      "L-320": ["L", { cutWidthCm: 320, widthCode: 320, extended: false, belt: "urethane" }],
      "L-180F": ["L", { cutWidthCm: 180, widthCode: 180, extended: false, belt: "felt" }],
      "L-220": ["L", { cutWidthCm: 226, widthCode: 220, extended: false, belt: "urethane" }],
      "L-320E": ["L", { cutWidthCm: 320, widthCode: 320, extended: true, belt: "urethane" }],
      "L-320EF": ["L", { cutWidthCm: 320, widthCode: 320, extended: true, belt: "felt" }],
      M999: ["M", {}],
      "EL-2020": ["EL", { tableWidthMm: 2020 }],
      "EL-4030": ["EL", { tableWidthMm: 4030 }],
      "EL-202A": ["EL", {}],
      "EF-2420": ["EF", { tableWidthMm: 2420 }],
      "FP-180": ["FP", { cutWidthCm: 180, widthCode: 180 }],
      "FP-TROLLEY": ["FP", {}],
      "P-180": ["P", { paperWidthMm: 1880 }],
      "P-220": ["P", { paperWidthMm: 2280 }],
      "P-390": ["P", {}],
      "LNS-2020": ["LNS", {}],
      SERVICE: ["SVC", {}],
    };
    for (const [code, [series, specs]] of Object.entries(SPECS_BY_CODE)) {
      expect(legacyProductIdentity(series, code).specs, code).toEqual(specs);
    }
  });

  it("every cutter in the catalogue gets a width, and every table a table width", () => {
    for (const p of products.filter((p) => ["M", "X", "L"].includes(p.seriesCode))) {
      expect(legacyProductIdentity(p.seriesCode, p.code).specs.cutWidthCm, p.code).toBeGreaterThan(0);
    }
    for (const p of products.filter((p) => p.seriesCode === "EL" || p.seriesCode === "EF")) {
      expect(legacyProductIdentity(p.seriesCode, p.code).specs.tableWidthMm, p.code).toBeGreaterThan(0);
    }
  });

  it("assigns the content block quotation-data.ts's productBlockKey used to pick", () => {
    const BLOCK_BY_CODE: Record<string, [series: string, key: string | null]> = {
      M5180: ["M", "machine.m-series"],
      "X-450": ["X", "machine.m-series"],
      "EL-2020": ["EL", "equipment.easy-loader"],
      "FP-180": ["FP", "equipment.fabric-pro"],
      "FP-TROLLEY": ["FP", "equipment.fabric-pro"],
      "P-180": ["P", "equipment.punchline"],
      "PTW(S)": ["SW", "software.pathworks-s"],
      "PTW(I)": ["SW", "software.pathworks-i"],
      PTW: ["SW", null],
      PDG: ["SW", null],
      "EF-100": ["EF", null],
      "L-320": ["L", null],
      "LNS-2020": ["LNS", null],
      "HDRF-180": ["HDRF", null],
      SERVICE: ["SVC", null],
    };
    for (const [code, [series, key]] of Object.entries(BLOCK_BY_CODE)) {
      expect(legacyProductIdentity(series, code).contentBlockKey, code).toBe(key);
    }
  });

  it("classifies every product as something other than the default where it should", () => {
    const kinds = new Map(products.map((p) => [p.code, legacyProductIdentity(p.seriesCode, p.code, p.isCredit).kind]));
    expect(kinds.get("M3180")).toBe("MACHINE");
    expect(kinds.get("EL-2020")).toBe("TABLE");
    expect(kinds.get("EF-2020")).toBe("FEEDER");
    expect(kinds.get("FP-180")).toBe("SPREADER");
    expect(kinds.get("FP-TROLLEY")).toBe("ACCESSORY");
    expect(kinds.get("PTW(I)")).toBe("SOFTWARE");
    expect(kinds.get("LNS-2020")).toBe("SYSTEM");
    expect(kinds.get("HDRF-180")).toBe("ACCESSORY");
    expect(kinds.get("TRADE-IN")).toBe("CREDIT");
    expect(kinds.get("SERVICE")).toBe("SERVICE");
  });

  it("reads the software mode and PathWorks module out of software codes", () => {
    expect(legacyProductIdentity("SW", "PTW(I)").specs.softwareMode).toBe("integrated");
    expect(legacyProductIdentity("SW", "PTW(S)").specs.softwareMode).toBe("standalone");
    expect(legacyProductIdentity("SW", "ANT-V6").specs.pathworksModule).toBe("ANT_V6");
    expect(legacyProductIdentity("SW", "PDG").specs.pathworksModule).toBe("PDG");
    expect(legacyProductIdentity("SW", "PRA").specs).toEqual({});
  });
});

/** Which role each M-Series tick pattern stands for -- the phase-2 map. */
const M_SERIES_TICK_ROLES: Record<string, string> = {
  F42: "VRB",
  J42: "OFJ",
  O42: "HFV",
  F44: "PM",
  J44: "OFD",
  O44: "PRM",
  F46: "APM",
  J46: "OFP",
  O46: "DMT",
  F48: "DRG_3",
  J48: "MRK",
  O48: "CRATE",
  F50: "DRG_1",
  J50: "IJP",
  F52: "HDC",
  J52: "ABR",
  F55: "BCR",
  J55: "DR2",
  F57: "IKA",
  J57: "AFP",
  D72: "MTS",
};

/** The option-code suffixes the EasyLoader builder used to assemble. */
const LEGACY_EL_SUFFIX_BY_ROLE: Record<(typeof EL_MODULE_ROLE_LIST)[number], string> = {
  EL_DRIVE: "Drive Module (first 1.2M)",
  EL_CONVEYOR: "Additional 1.2M lengths",
  EL_STATIC: "Static table 1.2M lengths",
  EL_BUSBAR: "Electrical Busbar Per 1.2M Used for Fabric Pro automatic spreader.",
  EL_RAIL: "Travel Platform support rail. Per 1.2m",
};

describe("option identity parity", () => {
  it("the M-Series form ticks exactly the roles its option patterns stood for, cell by cell", () => {
    const coversByCell = Object.fromEntries(
      mSeriesSpec.ticks.filter((t) => t.covers !== undefined).map((t) => [t.cell, t.covers])
    );
    expect(coversByCell).toEqual(M_SERIES_TICK_ROLES);
  });

  it("every code an M-Series tick pattern matched carries that tick's role", () => {
    // The role is broader than the pattern only where the old form
    // deliberately had no box: /^Crate/ never matched "HDRF-180 Crate"
    // (those never print on the M-Series form), and /^DRG-3$/ is one of
    // three drag knives. Either way a code the pattern matched must carry
    // the role.
    const LEGACY_PATTERNS: Record<string, RegExp> = {
      VRB: /^VRB/, OFJ: /^OFJ$/, HFV: /^HFV/, PM: /^PM-/, OFD: /^OFD/, PRM: /^PRM/, APM: /^APM/,
      OFP: /^OFP/, DMT: /^DMT$/, DRG_3: /^DRG-3$/, MRK: /^MRK$/, CRATE: /^Crate/, DRG_1: /^DRG-1$/,
      IJP: /^IJP$/, HDC: /^HDC/, ABR: /^ABR/, BCR: /^BCR/, DR2: /^DR2$/, IKA: /^IKA$/, AFP: /^AFP$/, MTS: /^MTS$/,
    };
    expect(new Set(Object.keys(LEGACY_PATTERNS))).toEqual(new Set(Object.values(M_SERIES_TICK_ROLES)));
    for (const [role, pattern] of Object.entries(LEGACY_PATTERNS)) {
      for (const o of catalog.options) {
        if (pattern.test(o.code)) expect(legacyOptionIdentity(o.code).role, `${o.code} should carry ${role}`).toBe(role);
      }
    }
  });

  it("the EasyLoader's covered options are exactly the EL module roles", () => {
    expect(new Set(easyLoaderSpec.coversOptions)).toEqual(new Set(EL_MODULE_ROLE_LIST));
    for (const o of catalog.options) {
      const role = legacyOptionIdentity(o.code).role;
      const covered = easyLoaderSpec.coversOptions!.includes(role!);
      const legacyCovered = Object.values(LEGACY_EL_SUFFIX_BY_ROLE).some((suffix) => o.code.endsWith(suffix));
      expect(covered, o.code).toBe(legacyCovered);
    }
  });

  it("derives the role and parent EasyLoader for every module code the builder used to write", () => {
    for (const width of ["EL-2020", "EL-2420", "EL-3220", "EL-4030"]) {
      for (const [role, suffix] of Object.entries(LEGACY_EL_SUFFIX_BY_ROLE)) {
        const identity = legacyOptionIdentity(`${width} ${suffix}`);
        expect(identity.parentProductCode, `${width} ${role}`).toBe(width);
        expect(identity.role, `${width} ${role}`).toBe(role);
      }
    }
    expect(legacyOptionIdentity("Crate-EL").parentProductCode).toBeNull();
  });

  it("gives the options sold by the section the unit length option-length.ts used to read off their names", () => {
    // What `unitLengthMetres(name)` answered: a "1.2M" figure counted only
    // when the name also said "per" or "length(s)"...
    const UNIT_LENGTH_BY_CODE: Record<string, number | null> = {
      "EL-2020 Drive Module (first 1.2M)": 1.2,
      "EL-2020 Additional 1.2M lengths": 1.2,
      "EL-4030 Static table 1.2M lengths": 1.2,
      "EL-2020 Electrical Busbar Per 1.2M Used for Fabric Pro automatic spreader.": 1.2,
      "EL-2020 Travel Platform support rail. Per 1.2m": 1.2,
      "EL-2020 Single Roll feed attachment": null,
      "EL-2020 #ST620-2020 Roll Holder- x": null,
      MTS: null,
      AFP: null,
      "180-E": null,
      "Edge sealer Static- clip on blanking panel 800mm width": null,
    };
    for (const [code, metres] of Object.entries(UNIT_LENGTH_BY_CODE)) {
      expect(legacyOptionIdentity(code).unitLengthM, code).toBe(metres);
    }
    // ...and the one the name parser never caught, set because the role
    // says so.
    expect(legacyOptionIdentity("MTS- additional travel p/Metre").unitLengthM).toBe(1);
  });

  it("tries the content block keys quotation-data.ts's optionBlockKey used to try, in order", () => {
    // Exact code first, then the code with its trailing "-suffix" stripped
    // (only when there is a dash past position 0).
    const CANDIDATES_BY_CODE: Record<string, string[]> = {
      MTS: ["option.MTS"],
      "ABR-M": ["option.ABR-M", "option.ABR"],
      "ABR-FP": ["option.ABR-FP", "option.ABR"],
      "-M": ["option.-M"],
      FM180: ["option.FM180"],
      "FM-220": ["option.FM-220", "option.FM"],
      "EL-2020 Drive Module (first 1.2M)": ["option.EL-2020 Drive Module (first 1.2M)", "option.EL"],
    };
    for (const [code, candidates] of Object.entries(CANDIDATES_BY_CODE)) {
      expect(legacyOptionIdentity(code).contentBlockKeyCandidates, code).toEqual(candidates);
    }
  });

  it("gives the L-Series tools, the extended lengths and the services a role", () => {
    expect(legacyOptionIdentity("1.0mm dia punch").role).toBe("L_TOOL");
    expect(legacyOptionIdentity("Notch Tool- Quick Release (to suit carbide knife 1.0mm x 7mm)").role).toBe("L_TOOL");
    expect(legacyOptionIdentity("Driven- Electrically driven. Suit 28mm Carbide Octagonal blade.").role).toBe("L_TOOL");
    expect(legacyOptionIdentity("180-E").role).toBe("L_EXTENDED");
    expect(legacyOptionIdentity("JetPen").role).toBe("JTP");
    expect(legacyOptionIdentity("SVC-M-INSTALL-MTS").role).toBe("INSTALL");
    expect(legacyOptionIdentity("SVC-SW-TRAINING").role).toBe("TRAINING");
    expect(legacyOptionIdentity("PTW").role).toBe("SOFTWARE");
    expect(legacyOptionIdentity("PRA-L").role).toBe("SOFTWARE");
    expect(legacyOptionIdentity("MTS- additional travel p/Metre").role).toBe("MTS_TRAVEL");
    expect(legacyOptionIdentity("HDRF-180 Crate").role).toBe("CRATE");
    expect(legacyOptionIdentity("EL-2020 #ST620-2020 Roll Holder- x").role).toBe("EL_ROLL_HOLDER");
  });

  it("leaves nothing in the catalogue without a role except what genuinely has none", () => {
    const roleless = catalog.options.filter((o) => legacyOptionIdentity(o.code).role === null).map((o) => o.code);
    expect(roleless).toEqual([]);
  });
});

describe("whereAnyCode", () => {
  it("matches the current code or a retired one", () => {
    expect(whereAnyCode("M-3180")).toEqual({ OR: [{ code: "M-3180" }, { legacyCodes: { has: "M-3180" } }] });
  });
});
