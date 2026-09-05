import "dotenv/config";
import { backfillCatalogIdentity } from "./lib/catalog-identity-backfill";

/**
 * One-off after migration z31_catalog_identity: classify every existing
 * catalogue row (kind, form, specs, role, parent, unit length, content
 * block) from its legacy code. Overwrites -- the columns are all at their
 * defaults on a freshly migrated database and the defaults are wrong for
 * most rows.
 *
 *   npx tsx scripts/backfill-catalog-identity.ts          # overwrite all
 *   npx tsx scripts/backfill-catalog-identity.ts --missing # only unclassified
 *
 * The seed runs the "--missing" variant itself after every upsert, so a
 * fresh database never needs this script.
 */
async function main() {
  const { db } = await import("../src/lib/db");
  const mode = process.argv.includes("--missing") ? "missing" : "all";
  const report = await backfillCatalogIdentity(db, mode);
  console.log(`products: ${report.products.written}/${report.products.total} written`);
  console.log(`options:  ${report.options.written}/${report.options.total} written`);
  if (report.options.unresolvedParents.length) {
    console.warn(`options whose EasyLoader parent was not found: ${report.options.unresolvedParents.join(", ")}`);
  }
  if (report.options.blockKeysMissing.length) {
    console.warn(`options with a role but no content block: ${report.options.blockKeysMissing.join(", ")}`);
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
