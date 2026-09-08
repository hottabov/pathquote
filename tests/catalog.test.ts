import { describe, it, expect } from "vitest";
import catalogData from "../prisma/seed-data/catalog.json";
import usPricesData from "../prisma/seed-data/prices-us.json";
import type { Catalog, CatalogItem, CatalogOption, UsPricesJson } from "../prisma/seed-lib";
import { resolveOptionIdentity, resolveProductIdentity } from "../prisma/seed-lib";
import { deriveEasyLoaderOptions, EL_MODULE_ROLE_LIST } from "../src/lib/production-forms/table-sections";
import { readProductSpecs } from "../src/lib/validation/product-specs";

/**
 * Invariants over prisma/seed-data/catalog.json -- the file
 * scripts/build-seed-data-from-target.ts regenerates from
 * docs/reference/catalog-v2-target.json. These hold whatever the director
 * renames next; the counts and code literals the pre-v2 version of this
 * file asserted are gone with the spreadsheets that produced them.
 */

const catalog = catalogData as Catalog;
const usPrices = usPricesData as UsPricesJson;

const products: (CatalogItem & { seriesCode: string })[] = catalog.series.flatMap((s) =>
  s.products.map((p) => ({ ...p, seriesCode: s.seriesCode }))
);
const options: CatalogOption[] = catalog.options;
const allItems: CatalogItem[] = [...products, ...options];
const productCodes = new Set(products.map((p) => p.code));
const seriesCodes = new Set(catalog.series.map((s) => s.seriesCode));
const usByCode = new Map(usPrices.prices.map((p) => [p.code, p.amountUsd]));
const EL_WIDTHS = ["EL-2020", "EL-2420", "EL-3220", "EL-4030"];

/** The character rule from docs/reference/catalog-v2-decisions.md. The
 *  16-char cap is not enforced here: "SVC-M-INSTALL-MTS" (17) was kept as
 *  entered by the owner; "Crate-*" is provisional mixed case and "RSP+"
 *  pre-dates the rule -- the director reviews all of them at export. */
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-.+]*$/;

describe("catalog.json: codes", () => {
  it("every product and option code is unique across the whole catalogue", () => {
    const codes = allItems.map((i) => i.code);
    expect(codes.filter((c, i) => codes.indexOf(c) !== i)).toEqual([]);
  });

  it("every code follows the v2 character rule: no spaces, parentheses or #", () => {
    for (const item of allItems) expect(item.code, item.code).toMatch(CODE_PATTERN);
  });

  it("every entry has the required fields", () => {
    for (const item of allItems) {
      expect(item.name.length, item.code).toBeGreaterThan(0);
      expect(typeof item.description, item.code).toBe("string");
      expect(item.price === null || typeof item.price === "number", item.code).toBe(true);
      expect(typeof item.needsReview, item.code).toBe("boolean");
    }
  });
});

describe("catalog.json: products", () => {
  it("every product carries an explicit kind, form and specs (the seed never falls back to the code rules)", () => {
    for (const p of products) {
      expect(p.kind, p.code).toBeDefined();
      expect("form" in p, p.code).toBe(true);
      expect("specs" in p, p.code).toBe(true);
      expect(resolveProductIdentity(p, p.seriesCode).kind).toBe(p.kind);
    }
  });

  it("every product's specs validate against productSpecsSchema", () => {
    for (const p of products) {
      if (p.specs) expect(readProductSpecs(p.specs), p.code).toEqual(p.specs);
    }
  });

  it("no MACHINE lacks a cutting width", () => {
    for (const p of products.filter((p) => p.kind === "MACHINE")) {
      expect(readProductSpecs(p.specs).cutWidthCm, p.code).toBeGreaterThan(0);
    }
  });

  it("every product with a production form is a kind that prints on one", () => {
    const formByKind: Record<string, string> = { MACHINE: "M_SERIES", TABLE: "EASYLOADER", SPREADER: "FABRICPRO" };
    for (const p of products) {
      if (p.form) expect(formByKind[p.kind ?? ""], p.code).toBe(p.form);
    }
  });

  it("exactly two X-Calibre products remain, both 10cm machines with a US price and no AU price", () => {
    const x = products.filter((p) => p.seriesCode === "X");
    expect(x.map((p) => p.code).sort()).toEqual(["X-10180", "X-10220"]);
    for (const p of x) {
      expect(p.kind).toBe("MACHINE");
      expect(readProductSpecs(p.specs).cutHeightCm).toBe(10);
      expect(p.price).toBeNull();
      expect(p.needsReview).toBe(true);
      expect(usByCode.get(p.code)).toBeGreaterThan(0);
    }
  });

  it("M-Series has 16 hyphenated machines, one per (height, width)", () => {
    const m = products.filter((p) => p.seriesCode === "M");
    expect(m).toHaveLength(16);
    const pairs = new Set<string>();
    for (const p of m) {
      expect(p.code).toMatch(/^M-(3|5|7|10)(180|220|300|390)$/);
      const specs = readProductSpecs(p.specs);
      pairs.add(`${specs.cutHeightCm}x${specs.widthCode}`);
      expect(specs.modelTier).toBe(`M${specs.cutHeightCm}`);
    }
    expect(pairs.size).toBe(16);
  });

  it("software lives in the SW series as products: PTW-I, PTW-S and LSC exist, PTN and EDG do not", () => {
    const sw = catalog.series.find((s) => s.seriesCode === "SW")!;
    const codes = sw.products.map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(["PTW-I", "PTW-S", "LSC", "PRA"]));
    expect(codes).not.toContain("PTN");
    expect(codes).not.toContain("EDG");
    for (const p of sw.products) expect(p.kind, p.code).toBe("SOFTWARE");
    expect(readProductSpecs(sw.products.find((p) => p.code === "PTW-I")?.specs).softwareMode).toBe("integrated");
    expect(readProductSpecs(sw.products.find((p) => p.code === "PTW-S")?.specs).softwareMode).toBe("standalone");
  });

  it("L-320EF is the extended felt machine with US price 154864; L-320F has no US price", () => {
    const l320ef = products.find((p) => p.code === "L-320EF");
    expect(l320ef).toBeDefined();
    expect(l320ef?.seriesCode).toBe("L");
    expect(readProductSpecs(l320ef?.specs)).toMatchObject({ cutWidthCm: 320, extended: true, belt: "felt" });
    expect(usByCode.get("L-320EF")).toBe(154864);
    expect(products.find((p) => p.code === "L-320F")).toBeDefined();
    expect(usByCode.has("L-320F")).toBe(false);
  });

  it("the EasyLoader itself is free (assembled from its modules) and every width has a drive module", () => {
    for (const code of EL_WIDTHS) {
      const el = products.find((p) => p.code === code);
      expect(el, code).toBeDefined();
      expect(el?.kind).toBe("TABLE");
      expect(el?.form).toBe("EASYLOADER");
      // 0, not null: a genuine price, not a gap -- the target marks it
      // `needsReviewAU: false` so no one is asked to "fill it in".
      expect(el?.price, code).toBe(0);
      expect(el?.needsReview, code).toBe(false);
      const drive = options.find((o) => o.role === "EL_DRIVE" && o.parentProductCode === code);
      expect(drive, code).toBeDefined();
      expect(drive?.compatibleProducts).toEqual([code]);
    }
  });

  it("TRADE-IN is the only credit product, SERVICE the container for the service options", () => {
    const credits = products.filter((p) => p.isCredit);
    expect(credits.map((p) => p.code)).toEqual(["TRADE-IN"]);
    expect(credits[0].kind).toBe("CREDIT");
    expect(products.find((p) => p.code === "SERVICE")?.kind).toBe("SERVICE");
  });
});

describe("catalog.json: options", () => {
  it("every option carries an explicit role key (the seed never falls back to the code rules)", () => {
    for (const o of options) {
      expect("role" in o, o.code).toBe(true);
      expect(resolveOptionIdentity(o).role).toBe(o.role ?? null);
    }
  });

  it("no option has the SOFTWARE role -- software is never a machine option", () => {
    expect(options.filter((o) => o.role === "SOFTWARE").map((o) => o.code)).toEqual([]);
  });

  it("every option is compatible with something, and every compat refers to an existing series or product", () => {
    for (const o of options) {
      const series = o.compatibleSeries;
      const prods = o.compatibleProducts ?? [];
      expect(series.length + prods.length, o.code).toBeGreaterThan(0);
      for (const s of series) expect(seriesCodes.has(s), `${o.code} -> series ${s}`).toBe(true);
      for (const p of prods) expect(productCodes.has(p), `${o.code} -> product ${p}`).toBe(true);
    }
  });

  it("every parentProductCode is an existing product, and the option is scoped to it", () => {
    for (const o of options) {
      if (!o.parentProductCode) continue;
      expect(productCodes.has(o.parentProductCode), o.code).toBe(true);
      expect(o.compatibleSeries, o.code).toEqual([]);
      expect(o.compatibleProducts, o.code).toContain(o.parentProductCode);
    }
  });

  // The load-bearing one. The EasyLoader builder writes one option per
  // module role, looked up as "this width's option with this role"
  // (`setEasyLeaderLayout`), and refuses the layout when a role has no row.
  it("every EasyLoader width has exactly one option per EL module role, parented to that width", () => {
    const layout = [
      { lengthM: 3.6, surface: "conveyor" as const },
      { lengthM: 1.2, surface: "static" as const },
    ];
    const derived = deriveEasyLoaderOptions(layout, true);
    expect(new Set(derived.map((d) => d.role))).toEqual(new Set(EL_MODULE_ROLE_LIST));
    for (const width of EL_WIDTHS) {
      for (const role of EL_MODULE_ROLE_LIST) {
        const matches = options.filter((o) => o.role === role && o.parentProductCode === width);
        expect(matches.map((o) => o.code), `${width} ${role}`).toHaveLength(1);
        expect(matches[0].unitLengthM, `${width} ${role}`).toBe(1.2);
      }
    }
  });

  it("the roll holders are per width and the roll feed has no unit length", () => {
    for (const width of ["EL-2020", "EL-2420"]) {
      const holder = options.find((o) => o.role === "EL_ROLL_HOLDER" && o.parentProductCode === width);
      expect(holder?.code, width).toBe(`ST620-${width.slice(3)}`);
      const feed = options.find((o) => o.role === "EL_ROLL_FEED" && o.parentProductCode === width);
      expect(feed?.unitLengthM, width).toBeNull();
    }
  });

  it("MTS travel is sold per metre", () => {
    const travel = options.filter((o) => o.role === "MTS_TRAVEL");
    expect(travel.map((o) => o.code)).toEqual(["MTS-M"]);
    expect(travel[0].unitLengthM).toBe(1);
  });

  it("every crate pays no commission", () => {
    const crates = options.filter((o) => o.role === "CRATE");
    expect(crates.length).toBeGreaterThan(0);
    for (const o of crates) expect(o.noCommission, o.code).toBe(true);
  });

  it("X-Calibre only takes the options the US X sheet lists", () => {
    const x = options.filter((o) => o.compatibleSeries.includes("X")).map((o) => o.code);
    expect(new Set(x)).toEqual(
      new Set(["MTS", "MTS-M", "PRM-M", "OFD-M", "OFP-M", "OFJ", "HDC-M", "BCR-M", "TR220", "Crate-M-180", "Crate-M-220"])
    );
    for (const code of x) expect(options.find((o) => o.code === code)?.compatibleSeries, code).toContain("M");
  });

  it("service options are scoped to the SERVICE product and carry an INSTALL/TRAINING role", () => {
    const svc = options.filter((o) => o.code.startsWith("SVC-"));
    expect(svc.length).toBeGreaterThan(0);
    for (const o of svc) {
      expect(o.compatibleProducts, o.code).toEqual(["SERVICE"]);
      expect(["INSTALL", "TRAINING"], o.code).toContain(o.role);
    }
    expect(svc.map((o) => o.code)).toEqual(expect.arrayContaining(["SVC-L-INSTALL-S", "SVC-L-INSTALL-L", "SVC-EF-INSTALL"]));
  });

  it("JTP is the one JetPen", () => {
    expect(options.filter((o) => o.role === "JTP").map((o) => o.code)).toEqual(["JTP"]);
    expect(options.find((o) => o.code === "JTP")?.price).toBe(7500);
  });
});

describe("catalog.json: prices", () => {
  it("a null price is always flagged needsReview, and a needsReview price is never a non-zero amount", () => {
    for (const item of allItems) {
      if (item.price === null) expect(item.needsReview, item.code).toBe(true);
      if (item.needsReview) expect(item.price ?? 0, item.code).toBe(0);
    }
  });

  /** Priced at 0 on purpose: assembled from options / a container for
   *  SVC-* lines. Everything else at 0 is a gap and must be flagged. */
  const FREE_BY_DESIGN = new Set(["EL-2020", "EL-2420", "EL-3220", "EL-4030", "SERVICE"]);

  it("every item has a positive AU price or is flagged for review", () => {
    for (const item of allItems) {
      if (FREE_BY_DESIGN.has(item.code)) {
        expect(item.price, item.code).toBe(0);
        expect(item.needsReview, item.code).toBe(false);
        continue;
      }
      expect((item.price !== null && item.price > 0) || item.needsReview, item.code).toBe(true);
    }
  });

  it("spot checks against the AU price list", () => {
    const au = new Map(allItems.map((i) => [i.code, i.price]));
    expect(au.get("M-3180")).toBe(175000);
    expect(au.get("L-180")).toBe(135000);
    expect(au.get("EF-4030")).toBe(17540);
    expect(au.get("LSC")).toBe(9018);
    expect(au.get("PTW-I")).toBe(3500);
    expect(au.get("EL-2020-DM1")).toBe(4050);
    expect(au.get("HDRF-320")).toBe(21400);
    expect(au.get("TRADE-IN")).toBe(20000);
  });
});

describe("catalog.json: series", () => {
  it("has the eleven series in the owner's order", () => {
    expect(catalog.series.map((s) => s.seriesCode)).toEqual([
      "X",
      "M",
      "L",
      "SW",
      "LNS",
      "EL",
      "EF",
      "HDRF",
      "FP",
      "FPT",
      "SVC",
    ]);
    expect(catalog.series.find((s) => s.seriesCode === "L")?.maxDiscountPct).toBe(10);
  });

  it("every series has at least one product and no option is series-scoped to EF", () => {
    for (const s of catalog.series) expect(s.products.length, s.seriesCode).toBeGreaterThan(0);
    expect(options.filter((o) => o.compatibleSeries.includes("EF"))).toEqual([]);
  });

  it("has a valid extractedAt timestamp", () => {
    expect(new Date(catalog.extractedAt).getTime()).toBeGreaterThan(0);
  });
});
