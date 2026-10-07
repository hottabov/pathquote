/**
 * Reconcile existing PathQuote companies with the ACT! sync BEFORE its first
 * write, so the sync adopts them instead of creating a second copy of each.
 *
 *   npm run act:sync-preflight               # report only, writes nothing
 *   npm run act:sync-preflight -- --apply    # write the keys listed as unambiguous
 *
 * Why it exists: every Company row that predates the actCompanyKey column has
 * that column null, and the sync finds a company by that key and creates one on
 * a miss. Without this step each contact at an already-known client would
 * create a duplicate company; the quotes would stay on the old row and the
 * client picker would offer two of everything. This computes the key each
 * existing company would have, with the same companyKey() the sync uses, and
 * where exactly one company computes to it and nothing else holds it, writes it
 * onto the existing row. The sync then finds that row and keeps it, quote
 * history and all.
 *
 * Five groups are reported, and only the first is ever written:
 *   unambiguous    one company computes to the key, nothing else holds it
 *   ambiguous      two or more companies compute to the same key
 *   no country     the stored country does not resolve, so the key would end
 *                  in |?? (held back: the sync can never match such a key, and
 *                  a written key is never re-examined. Set the country, re-run)
 *   already taken  the key is already held by a different company
 *   no key         the name normalises to nothing
 *
 * `--apply` sets actCompanyKey on the unambiguous rows, one statement each, and
 * only where the key is still null at the moment of the write. It never
 * touches a name, an address, actCompanyId, or deletes anything. Re-running is
 * safe: a keyed row is counted and skipped.
 *
 * The `--` matters. Without it npm keeps --apply for itself and the script
 * starts with no flag. The script detects that and refuses.
 *
 * Arguments are strict: exactly --apply, or nothing. Anything else is an error.
 * A banner naming the mode and the target database (host:port/name, never the
 * password) is printed first.
 *
 * Exit status: 0 clean, 1 the run threw or some keys failed to write, 2 bad
 * arguments or no identifiable database. Run it once against the production
 * database before the first `npm run act:sync` that writes, and again after
 * fixing anything it listed. It adds nothing once every company is accounted
 * for.
 *
 * Environment:
 *   DATABASE_URL=...   shown in the banner as host:port/name only
 */
import "dotenv/config";
import { describeDatabase } from "../src/lib/act/cli-args";
import { formatReport, planBackfill, type CompanyRow } from "../src/lib/act/preflight";
import { formatPreflightBanner, parsePreflightArgs } from "../src/lib/act/preflight-args";

async function main() {
  const parsed = parsePreflightArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    console.error(`act:sync-preflight: ${parsed.error}`);
    process.exit(2);
  }
  const { args } = parsed;

  // A run that cannot say which database it is about to touch does not start.
  const database = describeDatabase(process.env.DATABASE_URL);
  if (!database) {
    console.error(
      "act:sync-preflight: DATABASE_URL is missing or is not a postgres URL with a host and a database name, so the run cannot say which database it would use. Refusing to start.",
    );
    process.exit(2);
  }

  console.log(formatPreflightBanner(args, database));
  console.log("");

  // Imported here, not at module scope, so the argument and DATABASE_URL checks
  // above end in their own message and exit code 2. src/lib/db.ts builds its
  // client on import and throws when DATABASE_URL is unset (Prisma 7 needs an
  // explicit driver adapter, see src/lib/db.ts), which at module scope would
  // surface as an uncaught stack trace before main() ran. Same reason as
  // scripts/import-act-industries.ts.
  const { db } = await import("../src/lib/db");

  try {
    const companies = await db.company.findMany({
      select: {
        id: true,
        name: true,
        country: true,
        actCompanyId: true,
        actCompanyKey: true,
        _count: { select: { contacts: true, documents: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    const rows: CompanyRow[] = companies.map((company) => ({
      id: company.id,
      name: company.name,
      country: company.country,
      actCompanyId: company.actCompanyId,
      actCompanyKey: company.actCompanyKey,
      contactCount: company._count.contacts,
      documentCount: company._count.documents,
    }));

    const plan = planBackfill(rows);
    for (const line of formatReport(plan)) console.log(line);
    console.log("");

    if (!args.apply) {
      console.log("Report only. Nothing was written.");
      if (plan.unambiguous.length > 0) {
        console.log("To write the unambiguous keys: npm run act:sync-preflight -- --apply");
      }
      return;
    }

    // The only write in this script: one statement per company, touching one
    // column. It is updateMany rather than update because Prisma's unique
    // filter cannot say `actCompanyKey IS NULL`, and the write must be
    // conditional: if the row gained a key since it was read, nothing is
    // overwritten and the miss is counted as a failure instead.
    let written = 0;
    const failures: { id: string; message: string }[] = [];
    for (const { company, key } of plan.unambiguous) {
      try {
        const { count } = await db.company.updateMany({
          where: { id: company.id, actCompanyKey: null },
          data: { actCompanyKey: key },
        });
        if (count !== 1) {
          throw new Error(`row no longer has a null actCompanyKey (updated ${count})`);
        }
        written += 1;
      } catch (error) {
        failures.push({
          id: company.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.log(`written ${written} of ${plan.unambiguous.length}`);
    if (failures.length > 0) {
      console.log("");
      console.log(`!! FAILED: ${failures.length} key(s) were not written.`);
      console.log("!! Typically the row was changed, or another row took the key, after it was");
      console.log("!! read. Nothing else was modified. Re-run to see where each stands.");
      console.log(`!! first failure: company ${failures[0].id}`);
      console.log(`!!   ${failures[0].message}`);
      process.exitCode = 1;
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
