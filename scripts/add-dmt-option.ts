import "dotenv/config";

/**
 * Adds the DuctMasTer (`DMT`) option to the live catalogue: compatible with
 * the M-Series and X-Calibre, A$18,240 and US$12,768.
 *
 *   npx tsx scripts/add-dmt-option.ts
 *
 * Why a script. `DMT` is a role the M-Series order form has ticked since the
 * form was written, but no option ever carried it, so the box could never be
 * ticked and a sold DuctMasTer had nowhere to appear. The owner supplied the
 * two prices on 2026-09-11. Writing them here rather than into
 * prisma/seed-data means the change lands in the database people actually
 * quote from; the seed files are a photograph of that database
 * (scripts/build-seed-data-from-dump.ts), so they pick it up on the next
 * dump rather than being edited in parallel and drifting.
 *
 * Idempotent: upserts by code, so a second run changes nothing. Safe to run
 * against a database that already has the row.
 *
 * Afterwards, refresh the seed:
 *
 *   npx tsx scripts/dump-catalog.ts
 *   npm run catalog:seed-from-dump
 */

const CODE = "DMT";
const NAME = "DuctMasTer";
/** The order form's own label for the box, and all the description there is
 * until somebody writes a proper one in the catalogue screen. */
const DESCRIPTION = "DuctMasTer";
const COMPATIBLE_SERIES = ["M", "X"];
const PRICES: Record<string, number> = { AU: 18240, US: 12768 };

async function main() {
  const { db } = await import("../src/lib/db");

  const option = await db.option.upsert({
    where: { code: CODE },
    update: { name: NAME, shortDescription: DESCRIPTION, role: "DMT" },
    create: { code: CODE, name: NAME, shortDescription: DESCRIPTION, role: "DMT" },
  });
  console.log(`option ${CODE}: ${option.id}`);

  for (const seriesCode of COMPATIBLE_SERIES) {
    const series = await db.series.findUnique({ where: { code: seriesCode } });
    if (!series) throw new Error(`series ${seriesCode} not found`);
    // The unique is (optionId, seriesId, productId), so a series-level row is
    // found by all three with productId null -- which `upsert` cannot express
    // through a null in a compound unique. Check then create.
    const existing = await db.optionCompatibility.findFirst({
      where: { optionId: option.id, seriesId: series.id, productId: null },
    });
    if (existing) {
      console.log(`  compatible with ${seriesCode}: already`);
      continue;
    }
    await db.optionCompatibility.create({ data: { optionId: option.id, seriesId: series.id } });
    console.log(`  compatible with ${seriesCode}: added`);
  }

  for (const [regionCode, amount] of Object.entries(PRICES)) {
    const region = await db.region.findUnique({ where: { code: regionCode } });
    if (!region) {
      console.log(`  ${regionCode}: no such region, skipped`);
      continue;
    }
    await db.price.upsert({
      where: { optionId_regionId: { optionId: option.id, regionId: region.id } },
      update: { amount, needsReview: false },
      create: { optionId: option.id, regionId: region.id, amount, needsReview: false },
    });
    console.log(`  ${regionCode}: ${amount}`);
  }

  console.log("\nNow refresh the seed:\n  npx tsx scripts/dump-catalog.ts\n  npm run catalog:seed-from-dump");
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
