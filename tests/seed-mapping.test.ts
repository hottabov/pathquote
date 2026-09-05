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
  shouldMigrateBlock,
  BLOCK_BODY_MIGRATIONS,
  M_SERIES_OLD_BODY,
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
 */
const FIXTURE: Catalog = {
  extractedAt: "2026-01-01T00:00:00.000Z",
  series: [
    {
      seriesCode: "A",
      seriesName: "Series A",
      maxDiscountPct: 10,
      products: [
        { code: "A-100", name: "Widget", description: "A widget", price: 500, needsReview: false },
        { code: "A-200", name: "Gadget", description: "A gadget", price: null, needsReview: true },
      ],
    },
    {
      seriesCode: "B",
      seriesName: "Series B",
      maxDiscountPct: null,
      products: [
        { code: "B-100", name: "Doohickey", description: "A doohickey", price: 1000, needsReview: false },
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
    },
    {
      code: "OPT-2",
      name: "Option Two",
      description: "Second option",
      price: 0,
      needsReview: true,
      compatibleSeries: ["B"],
    },
    {
      code: "OPT-3",
      name: "Widget Accessory",
      description: "Product-scoped accessory",
      price: 25,
      needsReview: false,
      compatibleSeries: [],
      compatibleProducts: ["A-100"],
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
      { code: "A-100", name: "Widget", description: "A widget", seriesCode: "A", sortOrder: 0, isCredit: false },
      { code: "A-200", name: "Gadget", description: "A gadget", seriesCode: "A", sortOrder: 1, isCredit: false },
      { code: "B-100", name: "Doohickey", description: "A doohickey", seriesCode: "B", sortOrder: 0, isCredit: false },
    ]);
  });

  it("mapProducts defaults isCredit to false when the catalog entry omits it, and passes it through when set", () => {
    const withCredit: Catalog = {
      ...FIXTURE,
      series: [
        {
          ...FIXTURE.series[0],
          products: [
            ...FIXTURE.series[0].products,
            { code: "A-300", name: "Trade-in", description: "Terms.", price: 999, needsReview: false, isCredit: true },
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
      { code: "OPT-1", name: "Option One", shortDescription: "First option", sortOrder: 0 },
      { code: "OPT-2", name: "Option Two", shortDescription: "Second option", sortOrder: 1 },
      { code: "OPT-3", name: "Widget Accessory", shortDescription: "Product-scoped accessory", sortOrder: 2 },
    ]);
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
  // "HDRF" series (owner decision -- see MANUAL_PRODUCTS.HDRF in
  // scripts/extract-catalog.ts and tests/catalog.test.ts's "Series Structure"
  // describe block).
  it("has exactly 10 series", () => {
    expect(mapSeries(catalog)).toHaveLength(10);
  });

  it("has exactly 66 total products", () => {
    expect(mapProducts(catalog)).toHaveLength(66);
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

  it("real content-blocks.json has exactly 51 blocks", () => {
    expect(mapContentBlocks(contentBlocksJson)).toHaveLength(51);
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

  it("machine.m-series's registered old body differs from the current seed-data body", () => {
    // Guards against the migration entry going stale: the hardcoded
    // M_SERIES_OLD_BODY (captured pre-315e089) must not equal what
    // content-blocks.json seeds today, or shouldMigrateBlock would never
    // fire for an already-current-format DB.
    const current = contentBlocksJson.blocks.find((b) => b.key === "machine.m-series");
    expect(current).toBeDefined();
    expect(current!.body).not.toBe(M_SERIES_OLD_BODY);
    expect(shouldMigrateBlock(M_SERIES_OLD_BODY, BLOCK_BODY_MIGRATIONS["machine.m-series"].oldBody)).toBe(true);
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

  it("M3180 = 163350", () => {
    expect(byCode.get("M3180")).toBe(163350);
  });

  it("X-10180 = 248000", () => {
    expect(byCode.get("X-10180")).toBe(248000);
  });

  it("L-180 = 118029", () => {
    expect(byCode.get("L-180")).toBe(118029);
  });

  it("PTW(S) = 3621", () => {
    expect(byCode.get("PTW(S)")).toBe(3621);
  });

  it("LNS-2020 = 27534", () => {
    expect(byCode.get("LNS-2020")).toBe(27534);
  });

  // HDRF was split into three width variants -- HDRF-180 is the one that
  // absorbed the old width-less "HDRF" code's US price (see extractHDRF in
  // scripts/extract-us-prices.ts).
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
