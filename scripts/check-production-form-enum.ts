/**
 * Prints what the *database* thinks `ProductionForm` contains, next to what
 * the generated Prisma client thinks it contains.
 *
 *   npx tsx scripts/check-production-form-enum.ts
 *
 * The two drift apart when a migration lands but `prisma generate` never
 * re-runs -- a dev server holding node_modules/.prisma/client open is the
 * usual reason, and on macOS the generate fails with EPERM rather than
 * loudly. The symptom is a *client-side*
 * `Invalid value for argument 'form'. Expected ProductionForm.` on a value
 * the database itself would have accepted, which sends you looking at
 * migrations that were in fact applied.
 */
import "dotenv/config";

async function main() {
  // Imported inside main() for the same reason as scripts/import-industries.ts:
  // Prisma 7 needs the driver adapter from src/lib/db, so a module-scope
  // client would throw before anything here could report why.
  const { db } = await import("../src/lib/db");
  const { ProductionForm } = await import("@prisma/client");

  const rows = await db.$queryRaw<{ enumlabel: string }[]>`
    SELECT e.enumlabel
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'ProductionForm'
    ORDER BY e.enumsortorder
  `;
  const inDb = rows.map((r) => r.enumlabel);
  const inClient = Object.keys(ProductionForm);

  console.log("database:", inDb.join(", ") || "(enum not found)");
  console.log("client:  ", inClient.join(", "));

  const missingInDb = inClient.filter((v) => !inDb.includes(v));
  const missingInClient = inDb.filter((v) => !inClient.includes(v));
  if (missingInDb.length) {
    console.log("\nmissing in DATABASE:", missingInDb.join(", "));
    console.log("  fix: npx prisma migrate deploy");
  }
  if (missingInClient.length) {
    console.log("\nmissing in CLIENT:", missingInClient.join(", "));
    console.log("  fix: stop `npm run dev`, then rm -rf node_modules/.prisma/client && npx prisma generate");
  }
  if (!missingInDb.length && !missingInClient.length) console.log("\nin sync");

  const applied = await db.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`
    SELECT migration_name, finished_at FROM "_prisma_migrations"
    WHERE migration_name LIKE 'z4%'
    ORDER BY migration_name
  `;
  console.log("\nmigrations z4*:");
  for (const m of applied) console.log(" ", m.migration_name, m.finished_at ? "applied" : "NOT FINISHED");

  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
