import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type CatalogTarget, validateTarget } from "../scripts/lib/catalog-v2-plan";
import { buildSeedDataFromTarget } from "../scripts/lib/catalog-v2-seed-data";
import catalogData from "../prisma/seed-data/catalog.json";
import usPricesData from "../prisma/seed-data/prices-us.json";
import type { Catalog, UsPricesJson } from "../prisma/seed-lib";

const ROOT = path.resolve(__dirname, "..");
const target = JSON.parse(readFileSync(path.join(ROOT, "docs/reference/catalog-v2-target.json"), "utf8")) as CatalogTarget;
const catalog = catalogData as Catalog;
const usPrices = usPricesData as UsPricesJson;

const products = target.products.filter((p) => p.action !== "delete");
const options = target.options.filter((o) => o.action !== "delete");
const productCodes = new Set(products.map((p) => p.code));

describe("catalog-v2-target.json: internal consistency", () => {
  it("passes the planner's validation", () => {
    expect(validateTarget(target)).toEqual([]);
  });

  it("non-deleted codes are unique among products and among options", () => {
    const p = products.map((x) => x.code);
    const o = options.map((x) => x.code);
    expect(p.filter((c, i) => p.indexOf(c) !== i)).toEqual([]);
    expect(o.filter((c, i) => o.indexOf(c) !== i)).toEqual([]);
    // ...and across both, since the seed's US price file keys on one namespace.
    expect(p.filter((c) => o.includes(c))).toEqual([]);
  });

  it("every parentProductCode and compatProducts code is a non-deleted product", () => {
    for (const o of options) {
      if (o.parentProductCode) expect(productCodes.has(o.parentProductCode), o.code).toBe(true);
      for (const c of o.compatProducts) expect(productCodes.has(c), `${o.code} -> ${c}`).toBe(true);
    }
  });

  it("every rename lists the code it renames from, and no keep pretends to", () => {
    for (const row of [...target.products, ...target.options]) {
      if (row.action === "rename") {
        expect(row.legacyCodes.length, row.code).toBeGreaterThan(0);
        expect(row.legacyCodes, row.code).not.toContain(row.code);
      }
    }
  });

  it("every add has a null id and every other action a database id", () => {
    for (const row of [...target.products, ...target.options]) {
      if (row.action === "add") expect(row.id, row.code).toBeNull();
      else expect(row.id, row.code).toMatch(/^c[a-z0-9]{20,}$/);
    }
  });

  it("ids are unique within products and within options", () => {
    const p = target.products.flatMap((x) => (x.id ? [x.id] : []));
    const o = target.options.flatMap((x) => (x.id ? [x.id] : []));
    expect(new Set(p).size).toBe(p.length);
    expect(new Set(o).size).toBe(o.length);
  });

  it("no legacy code of a surviving row is another surviving row's code", () => {
    const current = new Set([...products, ...options].map((r) => r.code));
    for (const row of [...products, ...options]) {
      for (const legacy of row.legacyCodes) expect(current.has(legacy), `${row.code} <- ${legacy}`).toBe(false);
    }
  });

  it("every surviving product has a kind, every surviving option a role, and neither is SOFTWARE-as-option", () => {
    for (const p of products) expect(p.kind, p.code).toBeDefined();
    for (const o of options) {
      expect(o.role, o.code).toBeDefined();
      expect(o.role, o.code).not.toBe("SOFTWARE");
    }
  });

  // The migration failed once on role "DRG" -- a value the planner cannot
  // check because it only sees strings. Read the enums straight out of the
  // schema so a typo in the target fails here, not inside the transaction.
  const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
  const enumValues = (name: string) =>
    new Set(
      schema
        .match(new RegExp(`enum ${name} \\{([^}]*)\\}`))![1]
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, "").trim())
        .filter(Boolean)
    );

  it("every role, kind and form is a value the Prisma enums know", () => {
    const roles = enumValues("OptionRole");
    const kinds = enumValues("ProductKind");
    const forms = enumValues("ProductionForm");
    for (const o of options) expect(roles.has(o.role ?? ""), `${o.code}: role ${o.role}`).toBe(true);
    for (const p of products) {
      expect(kinds.has(p.kind ?? ""), `${p.code}: kind ${p.kind}`).toBe(true);
      if (p.form) expect(forms.has(p.form), `${p.code}: form ${p.form}`).toBe(true);
    }
  });

  it("carries what the order forms read: model/width for M, width for FabricPro, module for PathWorks add-ons", () => {
    for (const p of products) {
      if (p.form === "M_SERIES") {
        expect(p.specs?.modelTier, p.code).toMatch(/^M(3|5|7|10)$/);
        expect(p.specs?.widthCode, p.code).toBeGreaterThan(0);
      }
      if (p.form === "FABRICPRO") expect(p.specs?.widthCode, p.code).toBeGreaterThan(0);
      if (["ANT-V5", "ANT-V6", "PDG", "WPL", "WPN"].includes(p.code)) {
        expect(p.specs?.pathworksModule, p.code).toBeDefined();
      }
      if (p.code === "PTW-I") expect(p.specs?.softwareMode).toBe("integrated");
      if (p.code === "PTW-S") expect(p.specs?.softwareMode).toBe("standalone");
    }
  });

  it("prices are non-negative numbers", () => {
    for (const row of [...target.products, ...target.options]) {
      for (const [region, amount] of Object.entries(row.prices)) {
        expect(typeof amount, `${row.code} ${region}`).toBe("number");
        expect(amount, `${row.code} ${region}`).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("buildSeedDataFromTarget", () => {
  const headers = catalog.series.map(({ seriesCode, seriesName, maxDiscountPct }) => ({ seriesCode, seriesName, maxDiscountPct }));
  const built = buildSeedDataFromTarget(target, headers, "2026-09-05T00:00:00.000Z");

  it("reproduces the committed catalog.json and prices-us.json (apart from the timestamp)", () => {
    expect({ ...built.catalog, extractedAt: catalog.extractedAt }).toEqual(catalog);
    expect({ ...built.usPrices, extractedAt: usPrices.extractedAt }).toEqual(usPrices);
  });

  it("writes only non-deleted rows under their new codes", () => {
    const seeded = new Set(built.catalog.series.flatMap((s) => s.products.map((p) => p.code)));
    expect(seeded).toEqual(productCodes);
    expect(built.catalog.options.map((o) => o.code)).toEqual(options.map((o) => o.code));
    for (const row of target.products.filter((p) => p.action === "delete")) expect(seeded.has(row.code)).toBe(false);
  });

  it("maps a 0 or absent AU price to null + needsReview, a real one to itself", () => {
    const byCode = new Map(built.catalog.series.flatMap((s) => s.products).map((p) => [p.code, p]));
    expect(byCode.get("M-3300")).toMatchObject({ price: null, needsReview: true });
    expect(byCode.get("L-320E")).toMatchObject({ price: null, needsReview: true });
    expect(byCode.get("M-3180")).toMatchObject({ price: 175000, needsReview: false });
    expect(byCode.get("TRADE-IN")).toMatchObject({ price: 20000, needsReview: false, isCredit: true });
  });

  it("keeps a genuine 0 unflagged when the target says needsReviewAU: false", () => {
    const t: CatalogTarget = {
      ...target,
      products: target.products.map((p) => (p.code === "SERVICE" ? { ...p, needsReviewAU: false } : p)),
    };
    const svc = buildSeedDataFromTarget(t, headers, "x").catalog.series.flatMap((s) => s.products).find((p) => p.code === "SERVICE");
    expect(svc).toMatchObject({ price: 0, needsReview: false });
  });

  it("writes the US file with only positive US prices, sorted, and no unmatched rows", () => {
    for (const p of built.usPrices.prices) expect(p.amountUsd, p.code).toBeGreaterThan(0);
    expect(built.usPrices.prices.map((p) => p.code)).toEqual([...built.usPrices.prices.map((p) => p.code)].sort((a, b) => a.localeCompare(b, "en")));
    expect(built.usPrices.unmatched).toEqual([]);
    const all = new Set([...productCodes, ...options.map((o) => o.code)]);
    for (const p of built.usPrices.prices) expect(all.has(p.code), p.code).toBe(true);
  });

  it("carries the series header (order, name, discount cap) from the catalog.json in place", () => {
    expect(built.catalog.series.map((s) => [s.seriesCode, s.seriesName, s.maxDiscountPct])).toEqual(
      headers.map((h) => [h.seriesCode, h.seriesName, h.maxDiscountPct])
    );
  });

  it("refuses a product in a series the catalog.json does not know", () => {
    expect(() => buildSeedDataFromTarget(target, headers.slice(1), "x")).toThrow(/series X/);
  });
});
