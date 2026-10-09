/**
 * Pull contacts from ACT! into PathQuote.
 *
 *   npm run act:sync -- --dry-run --limit 50   # read and report, write nothing
 *   npm run act:sync -- --limit 200            # a careful first write
 *   npm run act:sync                           # delta since the stored cursor
 *   npm run act:sync -- --full                 # ignore the cursor, read all
 *   npm run act:sync -- --trigger=schedule     # what the nightly timer runs
 *
 * The `--` matters. Without it npm keeps the flags for itself and the script
 * starts with none -- a full write. The script detects that and refuses.
 *
 * Arguments are strict: exactly --full, --dry-run, --limit (as `--limit N` or
 * `--limit=N`, N a positive whole number) and --trigger (schedule or manual,
 * default manual). Anything else is an error. A banner naming the mode, the
 * limit, the trigger and the target database is printed first.
 *
 * Every run that writes also leaves a last-run record for Settings to show --
 * once when it starts and again when it ends, so a run killed partway still
 * says it began. A dry run leaves none.
 *
 * Exit status: 0 clean -- and 0 when another sync already holds the lock, which
 * is not this invocation's failure, 1 the run threw or some contacts failed to
 * store, 2 bad arguments or no identifiable database. Run it on the VPS: the
 * ACT! API only answers to that address.
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
import { SyncAlreadyRunningError, syncContacts, readCursor } from "../src/lib/act/sync";

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
    trigger: args.trigger,
    onProgress: (scanned) => {
      if (scanned % 500 === 0) console.log(`  ${scanned} scanned`);
    },
  });

  console.log("");
  row("scanned", result.scanned);
  row("contacts created", result.contactsCreated);
  row("contacts updated", result.contactsUpdated);
  row("companies created", result.companiesCreated);
  row("companies, no contact", result.companiesFromNamelessContacts);
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
    console.log("Map each in src/lib/act/act-industries.json: to a segment, or to null if it");
    console.log("is not an industry. Never let the importer create industries: free text is");
    console.log("what produced 335 spellings.");
  }
  console.log("");
  const cursorLabel = args.dryRun ? "cursor would move to" : "cursor now";
  console.log(`${cursorLabel}: ${result.cursorTo ? result.cursorTo.toISOString() : "unchanged"}`);

  // So a `systemctl start` log says whether Settings will show this run, and
  // under which name. A record that did not get written is not a failure of
  // the sync -- the contacts are in -- but it is why the page would say
  // something odd tomorrow, and this is the line that explains it.
  console.log(`trigger: ${args.trigger}`);
  console.log(
    args.dryRun
      ? "last-run record: none (a dry run is never recorded)"
      : result.recorded
        ? "last-run record: written"
        : "last-run record: NOT written -- the error is above; Settings will say this run never finished",
  );

  if (result.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  // Losing the lock race is not a failure of this invocation. Somebody else --
  // the nightly timer, or an admin who pressed Sync now at 03:00 -- is doing
  // the work right now, there is nothing for anyone to fix, and the run that
  // holds the lock owns the record Settings will show. Exiting non-zero here
  // would fail pq-act-sync.service, which would start pq-backup-alert@ and
  // email the director that ACT! and PathQuote have drifted -- about a sync
  // that is going fine. An alert that cries wolf is worse than no alert.
  //
  // Caught by type, not by matching the message: the message is written for the
  // Sync now button ("try again"), and a CLI run is not going to try again.
  //
  // Exit 0 for a hand run as well as the nightly, and deliberately the same
  // code and the same words for both. The exit status answers one question --
  // did this invocation fail -- and the answer does not change because somebody
  // was watching. The operator standing at the terminal reads the line below;
  // they are not reading $?, and anything that does read $? (a retry loop, a
  // `&&` chain, systemd) would be told something false. Making it depend on
  // --trigger would also turn a flag whose whole job is labelling the run
  // record into a second thing, a mode switch, which is how flags start doing
  // what their author did not intend.
  //
  // Which leaves the log honest: exit 0 has never meant work was done -- a
  // quiet night with nothing to import exits 0 too -- so the line has to say
  // plainly that this run imported nothing, or the next person to read it will
  // take the silence for a successful sync.
  if (error instanceof SyncAlreadyRunningError) {
    console.log(
      "act:sync: another sync is already running, so this run did nothing -- it read nothing from ACT! and wrote nothing to the database. The run that holds the lock is still going, and its result is the one Settings will show. Nothing to do here: tonight's changes come in with that run.",
    );
    return;
  }
  console.error(error);
  process.exit(1);
});
