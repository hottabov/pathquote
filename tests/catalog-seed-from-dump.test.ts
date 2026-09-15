import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  buildSeedDataFromDump,
  type CatalogDump,
  type DumpOption,
  type DumpProduct,
} from "../scripts/lib/catalog-seed-from-dump";
import type { Catalog, UsPricesJson } from "../prisma/seed-lib";

const root = path.resolve(__dirname, "..");
const read = <T,>(...parts: string[]) => JSON.parse(readFileSync(path.join(root, ...parts), "utf8")) as T;

// RAW/ is gitignored -- the dump is a snapshot of the live database, taken on
// a developer machine, and never lands in the repo or on a CI runner. The
// drift check below only means anything where that snapshot exists, so it is
// skipped rather than failing the whole file on import when it doesn't.
const dumpPath = path.join(root, "RAW", "catalog-dump.json");
const hasDump = existsSync(dumpPath);

describe.skipIf(!hasDump)("buildSeedDataFromDump", () => {
  it("reproduces the committed catalog.json and prices-us.json", () => {
    // The committed seed files are exactly what this builder writes from the
    // committed dump. Without this, the two drift the moment someone edits a
    // seed file by hand and the next `npm run catalog:seed-from-dump`
    // silently reverts them.
    const dump = read<CatalogDump>("RAW", "catalog-dump.json");
    const catalog = read<Catalog>("prisma", "seed-data", "catalog.json");
    const usPrices = read<UsPricesJson>("prisma", "seed-data", "prices-us.json");

    const headers = catalog.series.map(({ seriesCode, seriesName, maxDiscountPct }) => ({
      seriesCode,
      seriesName,
      maxDiscountPct,
    }));

    const built = buildSeedDataFromDump(dump, headers);

    expect(built.catalog).toEqual(catalog);
    expect(built.usPrices).toEqual(usPrices);
  });
});

describe("buildSeedDataFromDump rules", () => {
  const price = (amount: string, needsReview = false) => ({ amount, needsReview });

  const product = (over: Partial<DumpProduct> = {}): DumpProduct => ({
    code: "P-1",
    series: "M",
    name: "Machine",
    description: "A machine",
    kind: "MACHINE",
    form: "M_SERIES",
    specs: { widthCode: 180 },
    active: true,
    isCredit: false,
    noCommission: false,
    prices: { AU: price("1000"), US: price("900") },
    ...over,
  });

  const option = (over: Partial<DumpOption> = {}): DumpOption => ({
    code: "O-1",
    name: "Option",
    shortDescription: "An option",
    role: "CRATE",
    parentProductCode: null,
    unitLengthM: null,
    active: true,
    noCommission: false,
    compatSeries: ["M"],
    compatProducts: [],
    prices: { AU: price("100") },
    ...over,
  });

  const build = (over: Partial<CatalogDump> = {}) =>
    buildSeedDataFromDump(
      {
        dumpedAt: "2026-09-11T00:00:00.000Z",
        regions: [{ code: "AU", name: "Australia" }],
        series: [{ code: "M", name: "M-Series", sortOrder: 1 }],
        products: [product()],
        options: [option()],
        ...over,
      },
      [{ seriesCode: "M", seriesName: "M-Series", maxDiscountPct: 10 }]
    );

  const productsOf = (built: ReturnType<typeof build>) => built.catalog.series.flatMap((s) => s.products);

  it("carries the discount cap over from the catalog.json in place", () => {
    expect(build().catalog.series[0].maxDiscountPct).toBe(10);
  });

  it("names a series the catalog.json in place had no cap for", () => {
    const built = buildSeedDataFromDump(
      {
        dumpedAt: "x",
        regions: [],
        series: [{ code: "FPT", name: "Fabric Pro Trolley", sortOrder: 9 }],
        products: [],
        options: [],
      },
      []
    );

    expect(built.seriesWithoutDiscountCap).toEqual(["FPT"]);
    expect(built.catalog.series[0].maxDiscountPct).toBeNull();
  });

  it("orders series by the dump's own sortOrder", () => {
    const built = buildSeedDataFromDump(
      {
        dumpedAt: "x",
        regions: [],
        series: [
          { code: "B", name: "B", sortOrder: 2 },
          { code: "A", name: "A", sortOrder: 1 },
        ],
        products: [],
        options: [],
      },
      []
    );

    expect(built.catalog.series.map((s) => s.seriesCode)).toEqual(["A", "B"]);
  });

  it("leaves a deactivated row out and names it, rather than seeding it back on", () => {
    const built = build({ products: [product({ active: false })], options: [option({ active: false })] });

    expect(productsOf(built)).toEqual([]);
    expect(built.catalog.options).toEqual([]);
    expect(built.skippedInactive.sort()).toEqual(["O-1", "P-1"]);
  });

  it("copies an AU price across with its flag, and reads a row with none as unpriced", () => {
    expect(productsOf(build())[0]).toMatchObject({ price: 1000, needsReview: false });
    expect(productsOf(build({ products: [product({ prices: {} })] }))[0]).toMatchObject({
      price: null,
      needsReview: true,
    });
  });

  it("keeps a genuine unflagged zero — the EasyLoader costs nothing by design", () => {
    const built = build({ products: [product({ prices: { AU: price("0"), US: price("0") } })] });

    expect(productsOf(built)[0]).toMatchObject({ price: 0, needsReview: false });
    expect(built.usPrices.prices).toEqual([{ code: "P-1", amountUsd: 0 }]);
  });

  it("drops a US price still flagged for review rather than publishing a placeholder", () => {
    const built = build({ products: [product({ prices: { AU: price("1000"), US: price("0", true) } })] });

    expect(built.usPrices.prices.map((p) => p.code)).not.toContain("P-1");
  });

  it("omits compatibleProducts when the option is scoped to a series", () => {
    expect(build().catalog.options[0]).not.toHaveProperty("compatibleProducts");
    const scoped = build({ options: [option({ compatSeries: [], compatProducts: ["EL-2020"] })] });
    expect(scoped.catalog.options[0].compatibleProducts).toEqual(["EL-2020"]);
  });

  it("always writes a role key, null included — the seed refuses an entry without one", () => {
    expect(build({ options: [option({ role: null })] }).catalog.options[0]).toHaveProperty("role", null);
  });

  it("sorts US prices by code so the file has a stable order", () => {
    const built = build({
      products: [product({ code: "Z-1" }), product({ code: "A-1" })],
      options: [option({ code: "M-1", prices: { AU: price("1"), US: price("2") } })],
    });

    expect(built.usPrices.prices.map((p) => p.code)).toEqual(["A-1", "M-1", "Z-1"]);
  });
});
