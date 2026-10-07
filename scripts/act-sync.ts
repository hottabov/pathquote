/**
 * Pull contacts from ACT! into PathQuote.
 *
 *   npm run act:sync -- --dry-run --limit 50   # read and report, write nothing
 *   npm run act:sync -- --limit 200            # a careful first write
 *   npm run act:sync                           # delta since the stored cursor
 *   npm run act:sync -- --full                 # ignore the cursor, read all
 *
 * The `--` matters. Without it npm keeps the flags for itself and the script
 * starts with none -- a full write. The script detects that and refuses.
 *
 * Arguments are strict: exactly --full, --dry-run and --limit (as `--limit N`
 * or `--limit=N`, N a positive whole number). Anything else is an error.
 * A banner naming the mode, the limit and the target database is printed first.
 *
 * Exit status: 0 clean, 1 the run threw or some contacts failed to store,
 * 2 bad arguments or no identifiable database. Run it on the VPS: the ACT!
 * API only answers to that address.
 *
 * Environment (see docs/act-integration-reference.md section 10):
 *   ACT_BASE=https://actapi.pathfindercut.com/act.web.api
 *   ACT_DB=Pathfinder
 *   ACT_USER='Marketing'     # the Act! display name, not a login id
 *   ACT_PASS=...
 *   DATABASE_URL=...         # shown in the banner as host:port/name only
 */
import "dotenv/config";
import { actClientFromEnv } from "../src/lib/act/client";
import { describeDatabase, formatBanner, parseActSyncArgs } from "../src/lib/act/cli-args";
import { syncContacts, readCursor } from "../src/lib/act/sync";

function row(label: string, value: string | number): void {
  console.log(`${label.padEnd(24)}${value}`);
}

async function main() {
  const parsed = parseActSyncArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    console.error(`act:sync: ${parsed.error}`);
    process.exit(2);
  }
  const { args } = parsed;

  // A run that cannot say which database it is about to touch does not start.
  const database = describeDatabase(process.env.DATABASE_URL);
  if (!database) {
    console.error(
      "act:sync: DATABASE_URL is missing or is not a postgres URL with a host and a database name, so the run cannot say which database it would use. Refusing to start.",
    );
    process.exit(2);
  }

  console.log(formatBanner(args, database));
  console.log("");

  const client = actClientFromEnv();

  // Logged every run so an Act! upgrade is visible in our own output before it
  // is visible as a bug.
  const system = await client.system();
  console.log(`Act! Web API ${system.apiVersion}, SDK ${system.sdkVersion}`);

  const cursor = await readCursor();
  console.log(`cursor: ${cursor ? cursor.toISOString() : "none (first run)"}`);

  const result = await syncContacts(client, {
    full: args.full,
    dryRun: args.dryRun,
    limit: args.limit,
    onProgress: (scanned) => {
      if (scanned % 500 === 0) console.log(`  ${scanned} scanned`);
    },
  });

  console.log("");
  row("scanned", result.scanned);
  row("contacts created", result.contactsCreated);
  row("contacts updated", result.contactsUpdated);
  row("companies created", result.companiesCreated);
  row("company key collisions", result.companiesKeyCollisions);
  row("phones unresolved", result.unresolvedPhones);
  row("failed", result.failed);
  console.log("skipped:");
  for (const [reason, count] of Object.entries(result.skipped)) {
    if (count > 0) console.log(`  ${reason.padEnd(22)}${count}`);
  }

  if (result.companiesKeyCollisions > 0) {
    console.log("");
    console.log(`!! COMPANY KEY COLLISIONS: ${result.companiesKeyCollisions}`);
    console.log("!! Two different ACT! companies have names that normalise to the same key.");
    console.log("!! The later one was created with no key. Two different firms may be sharing");
    console.log("!! a name, and a person needs to look at them.");
  }

  if (result.failed > 0) {
    console.log("");
    console.log(`!! FAILED: ${result.failed} contact(s) could not be stored.`);
    console.log("!! The cursor stopped advancing at the first failure, so the next run");
    console.log("!! reads them again.");
    console.log(`!! first failure: ACT contact ${result.firstFailureActContactId}`);
    console.log(`!!   ${result.firstFailureMessage}`);
  }

  if (result.unknownIndustries.length > 0) {
    console.log("");
    console.log(`industry values with no alias (${result.unknownIndustries.length}):`);
    for (const value of result.unknownIndustries) console.log(`  ${value}`);
    console.log("Add the real ones to scripts/data/act-industries.json. Never let the");
    console.log("importer create industries: free text is what produced 335 spellings.");
  }
  console.log("");
  const cursorLabel = args.dryRun ? "cursor would move to" : "cursor now";
  console.log(`${cursorLabel}: ${result.cursorTo ? result.cursorTo.toISOString() : "unchanged"}`);

  if (result.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
