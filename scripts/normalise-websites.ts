/**
 * Rewrite every `Company.website` into the canonical stored form.
 *
 * The z63 migration already strips `https://` and `http://` from the rows that
 * carry one, which is the bulk of them. It deliberately leaves everything else
 * alone, because the rest needs judgement a migration cannot apply: the ACT!
 * import brought in `/3dbelt.com/our-brands`, `.mareclean.com`,
 * `@sweetvictorian.com`, a markdown link somebody pasted into Act! years ago,
 * and values like `???` that are not websites at all.
 *
 * This finishes the job by running each value through `normaliseWebsite` -- the
 * same function the form, the importer and the renderer use. Doing it here
 * rather than in SQL is the point: a second implementation in `regexp_replace`
 * would drift from the first, and the first is the one with the tests.
 *
 * What it does to each row:
 *   already canonical        left alone
 *   recoverable              rewritten  ("/3dbelt.com/x" -> "3dbelt.com/x")
 *   not a website            left alone and listed, for a person to fix or clear
 *
 * It never clears a value. A row holding `???` keeps it: the link is already
 * suppressed on screen, the text is shown so someone can see what is wrong, and
 * deciding it is rubbish is not this script's call to make.
 *
 * Usage:
 *     npm run clients:normalise-websites              # report, writes nothing
 *     npm run clients:normalise-websites -- --apply   # writes
 */
import "dotenv/config";
import { normaliseWebsite } from "../src/lib/website";

const APPLY = "--apply";

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== APPLY);
  if (unknown.length > 0) {
    console.error(`unknown argument: ${unknown.join(", ")}. The only option is ${APPLY}.`);
    process.exit(2);
  }
  // npm keeps a flag that is not after `--`, so the script would run in report
  // mode while the operator believed they had asked for a write -- or worse,
  // the other way round. Refuse rather than guess.
  if (process.env.npm_config_apply) {
    console.error(`put ${APPLY} after a bare -- : npm run clients:normalise-websites -- ${APPLY}`);
    process.exit(2);
  }
  const apply = args.includes(APPLY);

  // Imported late, as the other operator scripts do: Prisma 7 needs an explicit
  // driver adapter, so a client at module scope throws before main() runs.
  const { db } = await import("../src/lib/db");

  const rows = await db.company.findMany({
    where: { website: { not: null } },
    select: { id: true, name: true, website: true },
    orderBy: { name: "asc" },
  });

  const changes: { id: string; name: string; from: string; to: string }[] = [];
  const unusable: { name: string; value: string }[] = [];

  for (const row of rows) {
    const current = row.website!;
    const canonical = normaliseWebsite(current);
    if (canonical === null) {
      unusable.push({ name: row.name, value: current });
    } else if (canonical !== current) {
      changes.push({ id: row.id, name: row.name, from: current, to: canonical });
    }
  }

  console.log(`${rows.length} companies have a website`);
  console.log(`  already canonical   ${rows.length - changes.length - unusable.length}`);
  console.log(`  to rewrite          ${changes.length}`);
  console.log(`  not a website       ${unusable.length}`);

  if (changes.length > 0) {
    console.log("");
    console.log("REWRITE");
    for (const change of changes) {
      console.log(`  ${change.name}`);
      console.log(`    ${change.from}  ->  ${change.to}`);
    }
  }

  if (unusable.length > 0) {
    console.log("");
    console.log("NOT A WEBSITE -- left as they are, no link is drawn for them");
    for (const row of unusable) console.log(`  ${row.name}: ${row.value}`);
    console.log("");
    console.log("  Fix or clear these on the client's page. They are shown as plain");
    console.log("  text there so the wrong value is visible rather than hidden.");
  }

  if (!apply) {
    console.log("");
    console.log(
      changes.length > 0
        ? `Report only. Re-run with ${APPLY} to write the ${changes.length} rewrites.`
        : "Report only. Nothing to rewrite.",
    );
    await db.$disconnect();
    return;
  }

  let written = 0;
  for (const change of changes) {
    await db.company.update({ where: { id: change.id }, data: { website: change.to } });
    written += 1;
  }
  console.log("");
  console.log(`wrote ${written} of ${changes.length}`);
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
