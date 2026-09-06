import "dotenv/config";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { buildCatalogWorkbook, defaultExportPath, type CatalogExportSnapshot } from "./lib/catalog-export";

/**
 * Export the live catalogue to an .xlsx for the director to review
 * (README, Products, Options, Prices). Read-only against the database.
 *
 *   npm run catalog:export
 *   npm run catalog:export -- --out RAW/review.xlsx
 *
 * Default output: RAW/catalog-export-<YYYY-MM-DD>.xlsx. The sheet layout and
 * editing rules are in docs/reference/catalog-export.md; the builder itself
 * (snapshot -> workbook) is scripts/lib/catalog-export.ts.
 */
function parseArgs(argv: string[]): { out: string } {
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      out = argv[++i];
      if (!out) throw new Error("--out needs a path");
    } else if (a.startsWith("--out=")) {
      out = a.slice("--out=".length);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { out: out ?? defaultExportPath() };
}

async function readSnapshot(): Promise<CatalogExportSnapshot> {
  const { db } = await import("../src/lib/db");
  try {
    const [regions, series, products, options] = await Promise.all([
      db.region.findMany({ orderBy: { code: "asc" } }),
      db.series.findMany({ orderBy: { sortOrder: "asc" } }),
      db.product.findMany({
        include: { series: true, prices: { include: { region: true } } },
      }),
      db.option.findMany({
        include: {
          parentProduct: true,
          prices: { include: { region: true } },
          compat: { include: { series: true, product: true } },
        },
      }),
    ]);

    const priceMap = (prices: { region: { code: string }; amount: { toString(): string }; needsReview: boolean }[]) =>
      Object.fromEntries(prices.map((pr) => [pr.region.code, { amount: pr.amount.toString(), needsReview: pr.needsReview }]));

    return {
      generatedAt: new Date().toISOString(),
      regions: regions.map((r) => ({ code: r.code, name: r.name, currency: r.currency })),
      series: series.map((s) => ({ id: s.id, code: s.code, name: s.name, sortOrder: s.sortOrder })),
      products: products.map((p) => ({
        id: p.id,
        code: p.code,
        legacyCodes: p.legacyCodes,
        series: p.series.code,
        name: p.name,
        description: p.description,
        kind: p.kind,
        form: p.form,
        specs: p.specs,
        contentBlockKey: p.contentBlockKey,
        isCredit: p.isCredit,
        noCommission: p.noCommission,
        active: p.active,
        sortOrder: p.sortOrder,
        imageUrl: p.imageUrl,
        prices: priceMap(p.prices),
      })),
      options: options.map((o) => ({
        id: o.id,
        code: o.code,
        legacyCodes: o.legacyCodes,
        name: o.name,
        shortDescription: o.shortDescription,
        role: o.role,
        parentProduct: o.parentProduct?.code ?? null,
        unitLengthM: o.unitLengthM === null ? null : o.unitLengthM.toString(),
        compatSeries: o.compat.filter((c) => c.series).map((c) => c.series!.code),
        compatProducts: o.compat.filter((c) => c.product).map((c) => c.product!.code),
        contentBlockKey: o.contentBlockKey,
        noCommission: o.noCommission,
        active: o.active,
        sortOrder: o.sortOrder,
        imageUrl: o.imageUrl,
        attributeSchema: o.attributeSchema,
        prices: priceMap(o.prices),
      })),
    };
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const snapshot = await readSnapshot();
  const wb = buildCatalogWorkbook(snapshot);
  mkdirSync(path.dirname(out), { recursive: true });
  XLSX.writeFile(wb, out);
  const prices = snapshot.products.reduce((n, p) => n + Object.keys(p.prices).length, 0) +
    snapshot.options.reduce((n, o) => n + Object.keys(o.prices).length, 0);
  console.log(`wrote ${out}: ${snapshot.products.length} products, ${snapshot.options.length} options, ${prices} prices`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
