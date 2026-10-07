/**
 * Pull contacts from ACT! into PathQuote.
 *
 *   npm run act:sync -- --dry-run --limit 50   # read and report, write nothing
 *   npm run act:sync -- --limit 200            # a careful first write
 *   npm run act:sync                           # delta since the stored cursor
 *   npm run act:sync -- --full                 # ignore the cursor, read all
 *
 * Environment (see docs/act-integration-reference.md):
 *   ACT_BASE=https://actapi.pathfindercut.com/act.web.api
 *   ACT_DB=Pathfinder
 *   ACT_USER='Marketing'
 *   ACT_PASS=...
 */
import "dotenv/config";
import { actClientFromEnv } from "../src/lib/act/client";
import { syncContacts, readCursor } from "../src/lib/act/sync";

async function main() {
  const args = new Set(process.argv.slice(2));
  const limitArg = process.argv.find((a) => a.startsWith("--limit"));
  const limit = limitArg ? Number(limitArg.split("=")[1] ?? process.argv[process.argv.indexOf(limitArg) + 1]) : undefined;

  const client = actClientFromEnv();

  // Logged every run so an Act! upgrade is visible in our own output before it
  // is visible as a bug.
  const system = await client.system();
  console.log(`Act! Web API ${system.apiVersion}, SDK ${system.sdkVersion}`);

  const cursor = await readCursor();
  console.log(`cursor: ${cursor ? cursor.toISOString() : "none (first run)"}`);

  const result = await syncContacts(client, {
    full: args.has("--full"),
    dryRun: args.has("--dry-run"),
    limit: Number.isFinite(limit) ? limit : undefined,
    onProgress: (scanned) => {
      if (scanned % 500 === 0) console.log(`  ${scanned} scanned`);
    },
  });

  console.log("");
  console.log(`scanned            ${result.scanned}`);
  console.log(`contacts created   ${result.contactsCreated}`);
  console.log(`contacts updated   ${result.contactsUpdated}`);
  console.log(`companies created  ${result.companiesCreated}`);
  console.log(`phones unresolved  ${result.unresolvedPhones}`);
  console.log("skipped:");
  for (const [reason, count] of Object.entries(result.skipped)) {
    if (count > 0) console.log(`  ${reason.padEnd(18)} ${count}`);
  }
  if (result.unknownIndustries.length > 0) {
    console.log("");
    console.log(`industry values with no alias (${result.unknownIndustries.length}):`);
    for (const value of result.unknownIndustries) console.log(`  ${value}`);
    console.log("Add the real ones to scripts/data/act-industries.json. Never let the");
    console.log("importer create industries: free text is what produced 335 spellings.");
  }
  console.log("");
  console.log(`cursor now: ${result.cursorTo ? result.cursorTo.toISOString() : "unchanged"}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
