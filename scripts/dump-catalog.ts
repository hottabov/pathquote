import "dotenv/config";
import { writeFileSync } from "node:fs";

/**
 * Read-only snapshot of the live catalogue for offline reconciliation
 * (products, options, identity columns, prices per region, compatibility).
 * Writes RAW/catalog-dump.json in the `CatalogSnapshot` shape
 * scripts/lib/catalog-v2-plan.ts plans against. Changes nothing.
 *
 *   npx tsx scripts/dump-catalog.ts
 */
async function main() {
  const { db } = await import("../src/lib/db");

  const [series, products, options, regions] = await Promise.all([
    db.series.findMany({ orderBy: { sortOrder: "asc" } }),
    db.product.findMany({
      include: { series: true, prices: { include: { region: true } } },
      orderBy: [{ seriesId: "asc" }, { sortOrder: "asc" }, { code: "asc" }],
    }),
    db.option.findMany({
      include: {
        parentProduct: { select: { code: true } },
        prices: { include: { region: true } },
        compat: { include: { series: true, product: true } },
      },
      orderBy: { code: "asc" },
    }),
    db.region.findMany(),
  ]);

  const out = {
    dumpedAt: new Date().toISOString(),
    regions: regions.map((r) => ({ code: r.code, name: r.name })),
    series: series.map((s) => ({ id: s.id, code: s.code, name: s.name, sortOrder: s.sortOrder })),
    products: products.map((p) => ({
      id: p.id,
      code: p.code,
      series: p.series.code,
      name: p.name,
      description: p.description,
      kind: p.kind,
      form: p.form,
      specs: p.specs,
      contentBlockKey: p.contentBlockKey,
      active: p.active,
      isCredit: p.isCredit,
      noCommission: p.noCommission,
      imageUrl: p.imageUrl,
      prices: Object.fromEntries(
        p.prices.map((pr) => [pr.region.code, { amount: pr.amount.toString(), needsReview: pr.needsReview }])
      ),
    })),
    options: options.map((o) => ({
      id: o.id,
      code: o.code,
      name: o.name,
      shortDescription: o.shortDescription,
      role: o.role,
      parentProductCode: o.parentProduct?.code ?? null,
      unitLengthM: o.unitLengthM === null ? null : o.unitLengthM.toNumber(),
      contentBlockKey: o.contentBlockKey,
      attributeSchema: o.attributeSchema,
      active: o.active,
      noCommission: o.noCommission,
      imageUrl: o.imageUrl,
      compatSeries: o.compat.filter((c) => c.series).map((c) => c.series!.code),
      compatProducts: o.compat.filter((c) => c.product).map((c) => c.product!.code),
      prices: Object.fromEntries(
        o.prices.map((pr) => [pr.region.code, { amount: pr.amount.toString(), needsReview: pr.needsReview }])
      ),
    })),
  };

  const path = "RAW/catalog-dump.json";
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(
    `wrote ${path}: ${out.series.length} series, ${out.products.length} products, ${out.options.length} options`
  );
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
