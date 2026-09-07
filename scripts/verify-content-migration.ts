import "dotenv/config";

/**
 * Answers one question: has the category-copy migration
 * (scripts/migrate-content-blocks-to-series.ts --apply) actually run against
 * this database?
 *
 * It exists because `npx prisma db execute` runs a statement but prints no
 * rows, so a SELECT through it looks like it succeeded while telling you
 * nothing. The question matters before anything drops the contentBlockKey
 * columns or the ContentBlock table: both migrations move text out of places
 * those drops destroy, and neither is reversible without a restore.
 *
 *   npx tsx scripts/verify-content-migration.ts
 *
 * Read-only. Exits 0 when the migration has run, 1 when it has not, 2 when
 * the answer is mixed and a human should look.
 */
async function main() {
  const { db } = await import("../src/lib/db");

  const series = await db.series.findMany({
    select: { code: true, name: true, quoteDescription: true },
    orderBy: { code: "asc" },
  });

  const blocks = await db.contentBlock.findMany({ select: { key: true }, orderBy: { key: "asc" } });

  // The four categories scripts/migrate-content-blocks-to-series.ts writes.
  const MIGRATED_CODES = ["M", "X", "EL", "FP"];
  const withCopy = series.filter((s) => (s.quoteDescription ?? "").trim() !== "").map((s) => s.code);
  const migratedDone = MIGRATED_CODES.filter((code) => withCopy.includes(code));

  console.log("Series.quoteDescription");
  for (const s of series) {
    const has = (s.quoteDescription ?? "").trim() !== "";
    const expected = MIGRATED_CODES.includes(s.code);
    const mark = has ? "yes" : expected ? "NO  <- expected copy here" : "no";
    console.log(`  ${s.code.padEnd(5)} ${mark.padEnd(26)} ${s.name}`);
  }

  // The keys the category migration removes, versus the legal ones a later
  // plan migrates. Their presence is the second, independent signal.
  const retiredPrefixes = ["machine.", "equipment.", "software.", "option."];
  const retired = blocks.filter((b) => retiredPrefixes.some((p) => b.key.startsWith(p)));
  const legal = blocks.filter((b) => !retiredPrefixes.some((p) => b.key.startsWith(p)));

  console.log("");
  console.log(`ContentBlock rows: ${blocks.length}`);
  console.log(`  legal (terms./conditions./rsp.), migrated by a later plan: ${legal.length}`);
  console.log(`  category/option rows the migration deletes:                ${retired.length}`);
  if (retired.length > 0) {
    console.log(`    still present: ${retired.map((b) => b.key).join(", ")}`);
  }

  console.log("");
  if (migratedDone.length === MIGRATED_CODES.length && retired.length === 0) {
    console.log("VERDICT: the category-copy migration HAS run. Dropping contentBlockKey is safe.");
    await db.$disconnect();
    return;
  }
  if (migratedDone.length === 0 && retired.length > 0) {
    console.log("VERDICT: the category-copy migration has NOT run.");
    console.log("Run it before anything drops contentBlockKey or ContentBlock:");
    console.log("  npx tsx scripts/migrate-content-blocks-to-series.ts          # read this first");
    console.log("  npx tsx scripts/migrate-content-blocks-to-series.ts --apply");
    process.exitCode = 1;
    await db.$disconnect();
    return;
  }
  console.log("VERDICT: mixed state -- part migrated, part not. Do not drop anything yet.");
  console.log(`  categories written: ${migratedDone.join(", ") || "none"}`);
  console.log(`  rows still to delete: ${retired.length}`);
  process.exitCode = 2;
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
