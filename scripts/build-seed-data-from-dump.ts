import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSeedDataFromDump, type CatalogDump } from "./lib/catalog-seed-from-dump";
import type { Catalog } from "../prisma/seed-lib";

/**
 * Regenerates prisma/seed-data/catalog.json and prisma/seed-data/prices-us.json
 * from RAW/catalog-dump.json, so a fresh database seeds to what the live
 * catalogue actually contains.
 *
 *   npx tsx scripts/dump-catalog.ts          # snapshot the live database
 *   npx tsx scripts/build-seed-data-from-dump.ts
 *
 * Reads nothing but files: the dump is taken separately, against the
 * database, so this half runs anywhere. Pure logic lives in
 * scripts/lib/catalog-seed-from-dump.ts.
 *
 * Supersedes scripts/build-seed-data-from-target.ts, which built the same
 * two files from docs/reference/catalog-v2-target.json -- a one-off cleanup
 * plan that stopped matching reality as soon as people edited the catalogue
 * in the app.
 */
function main() {
  const root = path.resolve(__dirname, "..");
  const dumpPath = path.join(root, "RAW", "catalog-dump.json");
  const catalogPath = path.join(root, "prisma", "seed-data", "catalog.json");
  const usPricesPath = path.join(root, "prisma", "seed-data", "prices-us.json");

  const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as CatalogDump;
  const current = JSON.parse(readFileSync(catalogPath, "utf8")) as Catalog;

  const { catalog, usPrices, skippedInactive, seriesWithoutDiscountCap } = buildSeedDataFromDump(
    dump,
    current.series
  );

  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
  writeFileSync(usPricesPath, JSON.stringify(usPrices, null, 2) + "\n");

  const productCount = catalog.series.reduce((n, s) => n + s.products.length, 0);
  console.log(`read  ${path.relative(root, dumpPath)} (dumped ${dump.dumpedAt})`);
  console.log(
    `wrote ${path.relative(root, catalogPath)}: ${catalog.series.length} series, ${productCount} products, ${catalog.options.length} options`
  );
  console.log(`wrote ${path.relative(root, usPricesPath)}: ${usPrices.prices.length} US prices`);

  if (skippedInactive.length > 0) {
    console.log(`skipped ${skippedInactive.length} deactivated row(s): ${skippedInactive.join(", ")}`);
  }
  if (seriesWithoutDiscountCap.length > 0) {
    console.log(
      `no discount cap carried over for series: ${seriesWithoutDiscountCap.join(", ")} — set one in the app if it needs one`
    );
  }
}

main();
