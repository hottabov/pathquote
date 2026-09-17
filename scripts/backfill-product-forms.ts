import type { ProductionForm } from "@prisma/client";

/**
 * Fills `Product.form` from the product's series, and the width specs the
 * HDRF form needs.
 *
 *   npx tsx scripts/backfill-product-forms.ts          # report only
 *   npx tsx scripts/backfill-product-forms.ts --apply  # write
 *
 * `form` decides which order form an item prints on
 * (src/lib/production-forms/resolve.ts). It was left null on every series
 * except M, EL and FP, so the nine forms built since then matched nothing --
 * the code was ready and the sheets simply never appeared.
 *
 * Nothing here is a judgement call: a series prints one form and only one, so
 * the mapping below is the whole of it. The catalogue is the source, exactly
 * as it should be -- this reads what is already there rather than asking
 * anybody to retype it.
 *
 * The ongoing path for a NEW product is the catalogue spreadsheet, which has
 * a `form` column (see src/lib/catalog-xlsx/columns.ts): export, fill it in,
 * import. This script exists for the backfill, and is safe to re-run.
 *
 * Afterwards, refresh the seed so a fresh database matches:
 *
 *   npx tsx scripts/dump-catalog.ts
 *   npm run catalog:seed-from-dump
 */

/** Series code -> the form its products print. Absent = prints no form. */
export const FORM_BY_SERIES: Record<string, ProductionForm> = {
  M: "M_SERIES",
  X: "X_CALIBRE",
  L: "L_SERIES",
  EL: "EASYLOADER",
  EF: "EASYFEEDER",
  HDRF: "HDRF",
  FP: "FABRICPRO",
  FPT: "FP_TROLLEY",
  LNS: "LNS",
  // SW (software) and SVC (service) print nothing: PathWorks appears on the
  // machine form it is licensed with, or on the Software Order Form, and a
  // service line is commercial rather than manufacturing information.
};

/**
 * The HDRF form ticks its model box from `Product.specs.widthCode`, which is
 * empty on all three rows. The figure is in the code and nowhere else, so it
 * is read from there -- a one-off backfill, not a rule: the app itself stopped
 * parsing codes deliberately (migration z31_catalog_identity), and this writes
 * the fact into the column so it never has to be parsed again.
 */
const WIDTH_FROM_CODE = /^HDRF-(\d{3})$/;

async function main() {
  await import("dotenv/config");
  const apply = process.argv.includes("--apply");
  const { db } = await import("../src/lib/db");

  const products = await db.product.findMany({
    include: { series: { select: { code: true } } },
    orderBy: [{ seriesId: "asc" }, { code: "asc" }],
  });

  const formChanges: Array<{ id: string; code: string; from: string; to: ProductionForm }> = [];
  const specChanges: Array<{ id: string; code: string; widthCode: number }> = [];

  for (const product of products) {
    const want = FORM_BY_SERIES[product.series.code];
    // Only fills a gap. A form set by hand to something other than its
    // series' own is a deliberate exception and is left alone -- the script
    // says so rather than overwriting it.
    if (want && product.form === null) {
      formChanges.push({ id: product.id, code: product.code, from: "—", to: want });
    } else if (want && product.form !== want) {
      console.log(`  ${product.code}: keeping ${product.form} (series ${product.series.code} would say ${want})`);
    }

    const width = WIDTH_FROM_CODE.exec(product.code);
    const specs = (product.specs ?? {}) as Record<string, unknown>;
    if (width && specs.widthCode === undefined) {
      specChanges.push({ id: product.id, code: product.code, widthCode: Number(width[1]) });
    }
  }

  console.log(`\n${formChanges.length} product(s) need a form:`);
  for (const change of formChanges) console.log(`  ${change.code.padEnd(12)} -> ${change.to}`);

  console.log(`\n${specChanges.length} product(s) need a widthCode:`);
  for (const change of specChanges) console.log(`  ${change.code.padEnd(12)} -> ${change.widthCode}`);

  if (!apply) {
    console.log("\nReport only. Re-run with --apply to write.");
    await db.$disconnect();
    return;
  }

  for (const change of formChanges) {
    await db.product.update({ where: { id: change.id }, data: { form: change.to } });
  }
  for (const change of specChanges) {
    const product = products.find((row) => row.id === change.id)!;
    const specs = (product.specs ?? {}) as Record<string, unknown>;
    await db.product.update({
      where: { id: change.id },
      data: { specs: { ...specs, widthCode: change.widthCode } },
    });
  }

  console.log(`\nWrote ${formChanges.length} form(s) and ${specChanges.length} spec(s).`);
  console.log("Now refresh the seed:\n  npx tsx scripts/dump-catalog.ts\n  npm run catalog:seed-from-dump");
  await db.$disconnect();
}

// Guarded so the mapping above can be imported by a test without opening a
// database connection.
if (process.argv[1]?.endsWith("backfill-product-forms.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
