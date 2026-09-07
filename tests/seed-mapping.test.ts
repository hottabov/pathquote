import { describe, it, expect } from "vitest";
import catalogData from "../prisma/seed-data/catalog.json";
import contentBlocksData from "../prisma/seed-data/content-blocks.json";
import usPricesData from "../prisma/seed-data/prices-us.json";
import {
  type Catalog,
  type ContentBlocksJson,
  type UsPricesJson,
  REGIONS,
  mapUsPrices,
  missingUsPriceCodes,
  mapSeries,
  mapProducts,
  mapOptions,
  mapPrices,
  mapCompatibility,
  mapContentBlocks,
  resolveOptionIdentity,
  resolveProductIdentity,
  shouldMigrateBlock,
  BLOCK_BODY_MIGRATIONS,
  isRetiredContentBlockKey,
} from "../prisma/seed-lib";

const catalog = catalogData as Catalog;
const contentBlocksJson = contentBlocksData as ContentBlocksJson;

/**
 * Small, handcrafted catalog used to assert literal expected outputs of the
 * mapping functions, independent of whatever the real catalog.json happens
 * to contain -- so these assertions don't just re-derive their own expected
 * value from the same source (tautological) and don't silently drift if the
 * real catalog is regenerated.
 *
 * 2 series ("A", "B"), 3 products (A has 2, including one with a null price
 * to exercise the amount-0/needsReview-true path; B has 1), 3 options:
 * two series-scoped with distinct compatibleSeries (one spanning both
 * series, one series-exclusive) so mapCompatibility's series fan-out can be
 * checked against known pairs, and one product-scoped (compatibleSeries: [],
 * compatibleProducts: ["A-100"]) mirroring EasyLoader-style accessories, so
 * mapCompatibility's product fan-out is exercised too.
 *
 * Every entry carries its identity explicitly (kind/form/specs/
 * contentBlockKey on products, role/parentProductCode/unitLengthM/
 * contentBlockKey on options): the seed has no rule that derives any of
 * them from a code, and refuses an entry that omits `kind` or the `role`
 * key (see the "refuses" tests below).
 */
const FIXTURE: Catalog = {
  extractedAt: "2026-01-01T00:00:00.000Z",
  series: [
    {
      seriesCode: "A",
      seriesName: "Series A",
      maxDiscountPct: 10,
      products: [
        {
          code: "A-100",
          name: "Widget",
          description: "A widget",
          price: 500,
          needsReview: false,
          kind: "MACHINE",
          form: "M_SERIES",
          specs: { cutHeightCm: 3, cutWidthCm: 180, modelTier: "M3", widthCode: 180 },
          contentBlockKey: "machine.m-series",
        },
        {
          code: "A-200",
          name: "Gadget",
          description: "A gadget",
          price: null,
          needsReview: true,
          kind: "ACCESSORY",
          form: null,
          specs: null,
          contentBlockKey: null,
        },
      ],
    },
    {
      seriesCode: "B",
      seriesName: "Series B",
      maxDiscountPct: null,
      products: [
        {
          code: "B-100",
          name: "Doohickey",
          description: "A doohickey",
          price: 1000,
          needsReview: false,
          kind: "TABLE",
          form: "EASYLOADER",
          specs: { tableWidthMm: 2000 },
          contentBlockKey: "equipment.easy-loader",
        },
      ],
    },
  ],
  options: [
    {
      code: "OPT-1",
      name: "Option One",
      description: "First option",
      price: 50,
      needsReview: false,
      compatibleSeries: ["A", "B"],
      role: "MTS",
      parentProductCode: null,
      unitLengthM: null,
      contentBlockKey: "option.MTS",
    },
    {
      code: "OPT-2",
      name: "Option Two",
      description: "Second option",
      price: 0,
      needsReview: true,
      compatibleSeries: ["B"],
      role: null,
      parentProductCode: null,
      unitLengthM: null,
      contentBlockKey: null,
    },
    {
      code: "OPT-3",
      name: "Widget Accessory",
      description: "Product-scoped accessory",
      price: 25,
      needsReview: false,
      compatibleSeries: [],
      compatibleProducts: ["A-100"],
      role: "EL_CONVEYOR",
      parentProductCode: "A-100",
      unitLengthM: 1.2,
      contentBlockKey: null,
    },
  ],
};

describe("seed-lib: pure mapping (FIXTURE -> literal expected outputs)", () => {
  it("mapSeries produces the exact series payload", () => {
    expect(mapSeries(FIXTURE)).toEqual([
      { code: "A", name: "Series A", maxDiscountPct: 10, sortOrder: 0 },
      { code: "B", name: "Series B", maxDiscountPct: null, sortOrder: 1 },
    ]);
  });

  it("mapProducts produces the exact product payload with per-series sortOrder", () => {
    expect(mapProducts(FIXTURE)).toEqual([
      {
        code: "A-100",
        name: "Widget",
        description: "A widget",
        seriesCode: "A",
        sortOrder: 0,
        isCredit: false,
        noCommission: false,
        kind: "MACHINE",
        form: "M_SERIES",
        specs: { cutHeightCm: 3, cutWidthCm: 180, modelTier: "M3", widthCode: 180 },
        contentBlockKey: "machine.m-series",
      },
      {
        code: "A-200",
        name: "Gadget",
        description: "A gadget",
        seriesCode: "A",
        sortOrder: 1,
        isCredit: false,
        noCommission: false,
        kind: "ACCESSORY",
        form: null,
        specs: null,
        contentBlockKey: null,
      },
      {
        code: "B-100",
        name: "Doohickey",
        description: "A doohickey",
        seriesCode: "B",
        sortOrder: 0,
        isCredit: false,
        noCommission: false,
        kind: "TABLE",
        form: "EASYLOADER",
        specs: { tableWidthMm: 2000 },
        contentBlockKey: "equipment.easy-loader",
      },
    ]);
  });

  it("mapProducts passes noCommission through and normalises absent form/specs/contentBlockKey to null", () => {
    const explicit: Catalog = {
      ...FIXTURE,
      series: [
        {
          ...FIXTURE.series[0],
          products: [
            {
              code: "M-3180",
              name: "M",
              description: "",
              price: 1,
              needsReview: false,
              noCommission: true,
              kind: "MACHINE",
              form: "M_SERIES",
              specs: { cutHeightCm: 3, cutWidthCm: 180 },
              contentBlockKey: "machine.m-series",
            },
            // Only `kind` given: form/specs/contentBlockKey absent (not null)
            // and an empty specs object all map to null.
            { code: "PTW-S", name: "PW", description: "", price: 1, needsReview: false, kind: "SOFTWARE" },
            { code: "EMPTY", name: "E", description: "", price: 1, needsReview: false, kind: "ACCESSORY", specs: {} },
          ],
        },
      ],
    };
    const [m, ptw, empty] = mapProducts(explicit);
    expect(m).toMatchObject({
      noCommission: true,
      kind: "MACHINE",
      form: "M_SERIES",
      specs: { cutHeightCm: 3, cutWidthCm: 180 },
      contentBlockKey: "machine.m-series",
    });
    expect(ptw).toMatchObject({ kind: "SOFTWARE", form: null, specs: null, contentBlockKey: null });
    expect(empty).toMatchObject({ noCommission: false, kind: "ACCESSORY", specs: null });
  });

  it("mapProducts refuses a product without a kind, naming the code and series", () => {
    const missingKind: Catalog = {
      ...FIXTURE,
      series: [
        {
          ...FIXTURE.series[0],
          products: [{ code: "NO-KIND", name: "x", description: "", price: 1, needsReview: false, form: null, specs: null }],
        },
      ],
    };
    expect(() => mapProducts(missingKind)).toThrow(/product NO-KIND \(series A\) has no kind/);
    expect(() => resolveProductIdentity(missingKind.series[0].products[0], "A")).toThrow(/NO-KIND/);
  });

  it("mapProducts defaults isCredit to false when the catalog entry omits it, and passes it through when set", () => {
    const withCredit: Catalog = {
      ...FIXTURE,
      series: [
        {
          ...FIXTURE.series[0],
          products: [
            ...FIXTURE.series[0].products,
            { code: "A-300", name: "Trade-in", description: "Terms.", price: 999, needsReview: false, isCredit: true, kind: "CREDIT" },
          ],
        },
        FIXTURE.series[1],
      ],
    };
    const mapped = mapProducts(withCredit);
    expect(mapped.find((p) => p.code === "A-100")?.isCredit).toBe(false);
    expect(mapped.find((p) => p.code === "A-300")?.isCredit).toBe(true);
  });

  it("mapOptions produces the exact option payload", () => {
    expect(mapOptions(FIXTURE)).toEqual([
      {
        code: "OPT-1",
        name: "Option One",
        shortDescription: "First option",
        sortOrder: 0,
        noCommission: false,
        role: "MTS",
        parentProductCode: null,
        unitLengthM: null,
        contentBlockKey: "option.MTS",
      },
      {
        code: "OPT-2",
        name: "Option Two",
        shortDescription: "Second option",
        sortOrder: 1,
        noCommission: false,
        role: null,
        parentProductCode: null,
        unitLengthM: null,
        contentBlockKey: null,
      },
      {
        code: "OPT-3",
        name: "Widget Accessory",
        shortDescription: "Product-scoped accessory",
        sortOrder: 2,
        noCommission: false,
        role: "EL_CONVEYOR",
        parentProductCode: "A-100",
        unitLengthM: 1.2,
        contentBlockKey: null,
      },
    ]);
  });

  it("mapOptions takes role/parentProductCode/unitLengthM/contentBlockKey from the entry, with absent ones as null", () => {
    const opts: Catalog = {
      ...FIXTURE,
      options: [
        {
          code: "EL-2020-DM12",
          name: "x",
          description: "",
          price: 1,
          needsReview: false,
          compatibleSeries: [],
          compatibleProducts: ["EL-2020"],
          role: "EL_CONVEYOR",
          parentProductCode: "EL-2020",
          unitLengthM: 1.2,
          contentBlockKey: null,
        },
        // Only the `role` key: nothing is inferred from the code.
        { code: "MTS-M", name: "x", description: "", price: 1, needsReview: false, compatibleSeries: ["M"], role: "MTS_TRAVEL" },
        { code: "ABR-M", name: "x", description: "", price: 1, needsReview: false, compatibleSeries: ["M"], role: null, noCommission: true },
      ],
    };
    const [dm12, mts, abr] = mapOptions(opts);
    expect(dm12).toMatchObject({ role: "EL_CONVEYOR", parentProductCode: "EL-2020", unitLengthM: 1.2, contentBlockKey: null });
    expect(mts).toMatchObject({ role: "MTS_TRAVEL", parentProductCode: null, unitLengthM: null, contentBlockKey: null });
    expect(abr).toMatchObject({ role: null, parentProductCode: null, unitLengthM: null, contentBlockKey: null, noCommission: true });
  });

  it("mapOptions refuses an option without a role key (null is fine, absent is not), naming the code", () => {
    const missingRole: Catalog = {
      ...FIXTURE,
      options: [{ code: "NO-ROLE", name: "x", description: "", price: 1, needsReview: false, compatibleSeries: ["A"] }],
    };
    expect(() => mapOptions(missingRole)).toThrow(/option NO-ROLE has no role key/);
    expect(() => resolveOptionIdentity(missingRole.options[0])).toThrow(/NO-ROLE/);
    const nullRole: Catalog = { ...missingRole, options: [{ ...missingRole.options[0], role: null }] };
    expect(mapOptions(nullRole)[0].role).toBeNull();
  });

  it("mapPrices produces the exact price payload, incl. null-price -> amount 0 + needsReview true", () => {
    expect(mapPrices(FIXTURE, "AU")).toEqual([
      { kind: "product", code: "A-100", regionCode: "AU", amount: 500, needsReview: false },
      { kind: "product", code: "A-200", regionCode: "AU", amount: 0, needsReview: true },
      { kind: "product", code: "B-100", regionCode: "AU", amount: 1000, needsReview: false },
      { kind: "option", code: "OPT-1", regionCode: "AU", amount: 50, needsReview: false },
      { kind: "option", code: "OPT-2", regionCode: "AU", amount: 0, needsReview: true },
      { kind: "option", code: "OPT-3", regionCode: "AU", amount: 25, needsReview: false },
    ]);
  });

  it("mapCompatibility produces the exact (option, series) and (option, product) pairs", () => {
    expect(mapCompatibility(FIXTURE)).toEqual([
      { optionCode: "OPT-1", seriesCode: "A" },
      { optionCode: "OPT-1", seriesCode: "B" },
      { optionCode: "OPT-2", seriesCode: "B" },
      { optionCode: "OPT-3", productCode: "A-100" },
    ]);
  });
});

describe("seed-lib: smoke assertions against the real catalog.json (counts only)", () => {
  it("has exactly 3 regions", () => {
    expect(REGIONS).toHaveLength(3);
  });

  // 9 -> 10: HDRF was split out of the EasyFeeder ("EF") series into its own
  // "HDRF" series (owner decision -- see docs/reference/catalog-v2-decisions.md
  // and tests/catalog.test.ts's "catalog.json: series" describe block).
  // 10 -> 11: FP-TROLLEY was split out of the FabricPro ("FP") series into
  // its own "FPT" series, same reasoning as the HDRF split -- an ACCESSORY
  // does not belong under a SPREADER's quote copy (see
  // docs/superpowers/plans/2026-09-07-category-quote-copy.md).
  it("has exactly 11 series", () => {
    expect(mapSeries(catalog)).toHaveLength(11);
  });

  it("has as many product payloads as catalog.json has products, and one option payload per option", () => {
    expect(mapProducts(catalog)).toHaveLength(catalog.series.reduce((n, s) => n + s.products.length, 0));
    expect(mapOptions(catalog)).toHaveLength(catalog.options.length);
  });

  it("every AU price payload for a null-priced entry is amount 0 + needsReview", () => {
    for (const p of mapPrices(catalog, "AU")) {
      if (p.needsReview) expect(p.amount, p.code).toBe(0);
    }
  });
});

describe("mapContentBlocks", () => {
  const FIXTURE_JSON: ContentBlocksJson = {
    blocks: [
      { key: "terms.delivery", title: "Delivery", sortOrder: 1, body: "Delivered in {{weeks}} weeks." },
      { key: "option.OFD", title: "OFD", sortOrder: 2, body: "**OFD** offload display." },
    ],
    placeholders: { weeks: "Delivery time in weeks" },
  };

  it("maps each block's key/title/body/sortOrder 1:1 from the JSON", () => {
    expect(mapContentBlocks(FIXTURE_JSON)).toEqual([
      { key: "terms.delivery", title: "Delivery", body: "Delivered in {{weeks}} weeks.", sortOrder: 1 },
      { key: "option.OFD", title: "OFD", body: "**OFD** offload display.", sortOrder: 2 },
    ]);
  });

  // 51 -> 23: the category-quote-copy migration (Task 10) removed
  // machine.m-series, equipment.easy-loader, equipment.fabric-pro (migrated
  // onto Series.quoteDescription), the equipment.fabric-master/
  // equipment.spreading-table orphans, all 17 option.* blocks and all 6
  // software.* blocks -- 28 removed, leaving only terms.* (7) + conditions.*
  // (14) + rsp.* (2) = 23. See scripts/migrate-content-blocks-to-series.ts.
  it("real content-blocks.json has exactly 23 blocks", () => {
    expect(mapContentBlocks(contentBlocksJson)).toHaveLength(23);
  });

  it("real content-blocks.json has unique keys", () => {
    const keys = mapContentBlocks(contentBlocksJson).map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("real content-blocks.json has no empty (or whitespace-only) bodies", () => {
    for (const block of mapContentBlocks(contentBlocksJson)) {
      expect(block.body.trim().length, `expected "${block.key}" to have a non-empty body`).toBeGreaterThan(0);
    }
  });

  it("real content-blocks.json has no empty titles and non-negative sort orders", () => {
    for (const block of mapContentBlocks(contentBlocksJson)) {
      expect(block.title.trim().length, `expected "${block.key}" to have a non-empty title`).toBeGreaterThan(0);
      expect(block.sortOrder).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("shouldMigrateBlock / BLOCK_BODY_MIGRATIONS", () => {
  it("returns true when the existing body exactly matches the old body", () => {
    expect(shouldMigrateBlock("old text", "old text")).toBe(true);
  });

  it("returns false when the existing body differs at all (admin-edited, or already migrated)", () => {
    expect(shouldMigrateBlock("old text, tweaked", "old text")).toBe(false);
    expect(shouldMigrateBlock("new text", "old text")).toBe(false);
    expect(shouldMigrateBlock("", "old text")).toBe(false);
  });

  // BLOCK_BODY_MIGRATIONS is empty today -- its one past entry
  // ("machine.m-series") was removed by the category-quote-copy migration
  // (Task 10): that key no longer exists in content-blocks.json at all, so
  // there is nothing left to register a body migration against. See
  // BLOCK_BODY_MIGRATIONS's doc comment in prisma/seed-lib.ts.
  it("BLOCK_BODY_MIGRATIONS has no entries", () => {
    expect(Object.keys(BLOCK_BODY_MIGRATIONS)).toEqual([]);
  });
});

describe("isRetiredContentBlockKey", () => {
  it("recognises every prefix the category-quote-copy migration deleted", () => {
    for (const key of ["machine.m-series", "equipment.easy-loader", "equipment.fabric-pro", "equipment.fabric-master", "software.pathworks-i", "option.MTS"]) {
      expect(isRetiredContentBlockKey(key), key).toBe(true);
    }
  });

  it("does not flag a key the migration left alone", () => {
    for (const key of ["terms.delivery", "conditions.1", "rsp.agreement"]) {
      expect(isRetiredContentBlockKey(key), key).toBe(false);
    }
  });
});


// --- was tests/us-prices.test.ts: prices-us.json (mapUsPrices / missingUsPriceCodes) ------------------

const usPrices = usPricesData as UsPricesJson;

describe("prices-us.json well-formedness", () => {
  it("has a valid extractedAt timestamp", () => {
    expect(usPrices.extractedAt).toBeDefined();
    const timestamp = new Date(usPrices.extractedAt);
    expect(timestamp).toBeInstanceOf(Date);
    expect(timestamp.getTime()).toBeGreaterThan(0);
  });

  it("prices is a non-empty array of {code, amountUsd}", () => {
    expect(Array.isArray(usPrices.prices)).toBe(true);
    expect(usPrices.prices.length).toBeGreaterThan(0);
    for (const p of usPrices.prices) {
      expect(typeof p.code).toBe("string");
      expect(p.code.length).toBeGreaterThan(0);
      expect(typeof p.amountUsd).toBe("number");
      expect(Number.isFinite(p.amountUsd)).toBe(true);
    }
  });

  it("unmatched is an array of {sheet, label, price}", () => {
    expect(Array.isArray(usPrices.unmatched)).toBe(true);
    for (const u of usPrices.unmatched) {
      expect(typeof u.sheet).toBe("string");
      expect(u.sheet.length).toBeGreaterThan(0);
      expect(typeof u.label).toBe("string");
      expect(u.label.length).toBeGreaterThan(0);
      expect(typeof u.price).toBe("number");
    }
  });

  it("has no duplicate codes", () => {
    const codes = usPrices.prices.map((p) => p.code);
    const duplicates = codes.filter((c, i) => codes.indexOf(c) !== i);
    expect(duplicates).toEqual([]);
  });

  it("every price amount is rounded to at most 2 decimal places", () => {
    for (const p of usPrices.prices) {
      expect(Math.round(p.amountUsd * 100) / 100).toBe(p.amountUsd);
    }
  });
});

describe("prices-us.json <-> catalog.json consistency", () => {
  it("every priced code exists in catalog.json (as a product or an option)", () => {
    const productCodes = new Set(catalog.series.flatMap((s) => s.products.map((p) => p.code)));
    const optionCodes = new Set(catalog.options.map((o) => o.code));

    const missing = usPrices.prices.filter((p) => !productCodes.has(p.code) && !optionCodes.has(p.code));
    expect(missing.map((p) => p.code)).toEqual([]);
  });

  it("mapUsPrices resolves every priced entry to a product or option (no unknownCodes)", () => {
    const mapping = mapUsPrices(catalog, usPrices);
    expect(mapping.unknownCodes).toEqual([]);
    expect(mapping.payloads).toHaveLength(usPrices.prices.length);
    for (const payload of mapping.payloads) {
      expect(payload.regionCode).toBe("US");
      expect(payload.needsReview).toBe(false);
    }
  });

  it("missingUsPriceCodes only lists real catalog codes, never a priced one", () => {
    const missing = missingUsPriceCodes(catalog, usPrices);
    const pricedCodes = new Set(usPrices.prices.map((p) => p.code));
    for (const code of missing) {
      expect(pricedCodes.has(code)).toBe(false);
    }
  });
});

describe("Spot Price Validation (USD)", () => {
  const byCode = new Map(usPrices.prices.map((p) => [p.code, p.amountUsd]));

  it("M-3180 = 163350", () => {
    expect(byCode.get("M-3180")).toBe(163350);
  });

  it("X-10180 = 248000", () => {
    expect(byCode.get("X-10180")).toBe(248000);
  });

  it("L-180 = 118029", () => {
    expect(byCode.get("L-180")).toBe(118029);
  });

  it("PTW-S = 3621", () => {
    expect(byCode.get("PTW-S")).toBe(3621);
  });

  it("L-320EF = 154864 and L-320F has no US price (it moved to L-320EF)", () => {
    expect(byCode.get("L-320EF")).toBe(154864);
    expect(byCode.has("L-320F")).toBe(false);
  });

  it("no US price is 0 -- a missing US price is simply absent from the file", () => {
    for (const p of usPrices.prices) expect(p.amountUsd, p.code).toBeGreaterThan(0);
  });

  it("LNS-2020 = 27534", () => {
    expect(byCode.get("LNS-2020")).toBe(27534);
  });

  // HDRF was split into three width variants -- HDRF-180 is the one that
  // absorbed the old width-less "HDRF" code's US price (see
  // docs/reference/catalog-v2-decisions.md).
  it("HDRF-180 = 12500", () => {
    expect(byCode.get("HDRF-180")).toBe(12500);
  });

  it("HDRF-220 = 13900", () => {
    expect(byCode.get("HDRF-220")).toBe(13900);
  });

  it("HDRF-320 = 15290", () => {
    expect(byCode.get("HDRF-320")).toBe(15290);
  });
});
