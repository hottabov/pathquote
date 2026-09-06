import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CatalogTarget } from "./lib/catalog-v2-plan";
import { buildSeedDataFromTarget } from "./lib/catalog-v2-seed-data";
import type { Catalog } from "../prisma/seed-lib";

/**
 * Regenerates prisma/seed-data/catalog.json and prisma/seed-data/prices-us.json
 * from docs/reference/catalog-v2-target.json, so `npm run db:seed` on a
 * fresh database produces the cleaned catalogue (only non-deleted rows, new
 * codes, identity columns). The series list -- order, names, discount caps
 * -- is carried over from the catalog.json already in place; the target
 * file only names series by code.
 *
 *   npx tsx scripts/build-seed-data-from-target.ts
 *
 * This is the only writer of the two files: the spreadsheet extractors
 * that used to produce them from RAW/*.xlsx were deleted with the old code
 * contract (catalogue v2, phase 4). Corrections go into the target file,
 * then this is re-run. Pure logic lives in
 * scripts/lib/catalog-v2-seed-data.ts (tested in tests/catalog-v2-target.test.ts).
 */
function main() {
  const root = path.resolve(__dirname, "..");
  const targetPath = path.join(root, "docs", "reference", "catalog-v2-target.json");
  const catalogPath = path.join(root, "prisma", "seed-data", "catalog.json");
  const usPricesPath = path.join(root, "prisma", "seed-data", "prices-us.json");

  const target = JSON.parse(readFileSync(targetPath, "utf8")) as CatalogTarget;
  const current = JSON.parse(readFileSync(catalogPath, "utf8")) as Catalog;

  const { catalog, usPrices } = buildSeedDataFromTarget(target, current.series, new Date().toISOString());

  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
  writeFileSync(usPricesPath, JSON.stringify(usPrices, null, 2) + "\n");

  const productCount = catalog.series.reduce((n, s) => n + s.products.length, 0);
  console.log(`wrote ${path.relative(root, catalogPath)}: ${catalog.series.length} series, ${productCount} products, ${catalog.options.length} options`);
  console.log(`wrote ${path.relative(root, usPricesPath)}: ${usPrices.prices.length} US prices`);
}

main();
