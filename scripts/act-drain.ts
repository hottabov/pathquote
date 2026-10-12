/**
 * Send ACT! the quotes queued for it: one pass of the drain over every due
 * row (drainActOutbox, src/lib/act/drain.ts).
 *
 *   npm run act:drain                       # every due row: what the timer runs
 *   npm run act:drain -- --document <id>    # only that quote's rows
 *
 * The `--` matters, as for act:sync: without it npm keeps the flag and the
 * script would drain every due row. The script detects that and refuses.
 *
 * Run every 15 minutes by pq-act-drain.timer (scripts/ops/pq-act-drain.sh),
 * which is what makes the drain's backoff a schedule: a row that failed is
 * tried again at the first tick after it falls due. The pass takes the
 * drain's own advisory lock, without waiting -- a tick that finds another
 * drain at work (the nightly sync's, around 03:00, or a fast path after a
 * finalise) does nothing and says `busy` -- and sends nothing while the off
 * switch (src/lib/act/write-switch.ts) is off.
 *
 * Exit status -- what fails pq-act-drain.service, and so emails:
 *   0  every normal outcome: rows sent, held back or backing off, nothing
 *      due, another drain busy, sending switched off, the time budget spent,
 *      or ACT! busy or away (drainExitStatus in src/lib/act/drain-args.ts
 *      says why each is not a failure of the unit);
 *   1  the pass stopped on a fault that needs a person -- the service account
 *      not found, the login refused, a 403 to the login or the users lookup,
 *      IIS turning the VPS away -- or the pass threw (the database);
 *   2  it could not start: bad arguments, no identifiable DATABASE_URL, or an
 *      ACT_* variable missing.
 *
 * Run it on the VPS: the ACT! API only answers to that address.
 *
 * Environment: ACT_BASE, ACT_DB, ACT_USER, ACT_PASS and DATABASE_URL, as for
 * act:sync (see its header).
 */
import "dotenv/config";
import { actClientFromEnv, type ActClient } from "../src/lib/act/client";
import { describeDatabase } from "../src/lib/act/cli-args";
import { drainActOutbox, type DrainResult } from "../src/lib/act/drain";
import {
  ALERT_REARM_LINE,
  drainExitStatus,
  drainRearmsAlert,
  formatDrainBanner,
  parseActDrainArgs,
} from "../src/lib/act/drain-args";

function row(label: string, value: string | number): void {
  console.log(`${label.padEnd(24)}${value}`);
}

/**
 * At most this many held-back and backing-off rows are listed each. The
 * failure email tails the last 40 lines of the log, and the pass that failed
 * has to fit in them; the rest are on their rows, and the count says how
 * many there are.
 */
const LISTED = 5;

function list(title: string, items: { documentId: string; text: string }[]): void {
  if (items.length === 0) return;
  console.log(`${title}:`);
  for (const item of items.slice(0, LISTED)) console.log(`  ${item.documentId}: ${item.text}`);
  if (items.length > LISTED) console.log(`  ...and ${items.length - LISTED} more`);
}

/** One line for a tick with nothing to say, which is most of them; the counts otherwise. */
function report(result: DrainResult): void {
  const quiet =
    result.status === "ran" &&
    result.stepsWritten === 0 &&
    result.rowsDone === 0 &&
    result.blocked.length === 0 &&
    result.failed.length === 0 &&
    result.unblocked === 0;
  if (quiet) {
    console.log("nothing due -- nothing was sent");
    return;
  }
  if (result.status === "busy") {
    console.log(
      "busy -- another drain holds the lock (the nightly sync's, or a fast path after a finalise), so this pass sent nothing; the next tick tries again",
    );
    return;
  }
  if (result.status === "switched-off" && result.rowsDone === 0 && result.stepsWritten === 0) {
    console.log(
      `switched off -- sending to ACT! is off (Setting act.write.enabled), so nothing was sent; ${result.skippedSwitchOff} due row(s) wait for it`,
    );
    return;
  }
  row("status", result.stopCause ? `${result.status} (${result.stopCause})` : result.status);
  row("quotes done", result.rowsDone);
  row("writes to ACT!", result.stepsWritten);
  row("held back", result.blocked.length);
  row("backing off", result.failed.length);
  row("untracked creates", result.untracked);
  row("made due again", result.unblocked);
  if (result.status === "switched-off") row("waiting, switch off", result.skippedSwitchOff);
  if (result.stopReason) console.log(`why: ${result.stopReason}`);
  list(
    "held back",
    result.blocked.map(({ documentId, reason }) => ({ documentId, text: reason })),
  );
  list(
    "backing off",
    result.failed.map(({ documentId, error }) => ({ documentId, text: error })),
  );
}

async function main(): Promise<void> {
  const parsed = parseActDrainArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    console.error(`act:drain: ${parsed.error}`);
    process.exit(2);
  }
  const { args } = parsed;

  const database = describeDatabase(process.env.DATABASE_URL);
  if (!database) {
    console.error(
      "act:drain: DATABASE_URL is missing or is not a postgres URL with a host and a database name, so the run cannot say which database it would use. Refusing to start.",
    );
    process.exit(2);
  }

  console.log(formatDrainBanner(args, database));

  // Before the switch is known, unlike the fast path (drainAfterResponse in
  // src/lib/act/drain-after.ts), which builds the client only once the
  // switch is on. A request in the app has no business failing for a
  // variable it did not need; this unit does: the tools container that runs
  // it also runs the nightly sync, which needs every one of them, so a
  // missing one is a broken box whatever the switch says -- and finding out
  // only on the day sending is switched on is the worse time.
  let client: ActClient;
  try {
    client = actClientFromEnv();
  } catch (error) {
    console.error(`act:drain: ${error instanceof Error ? error.message : String(error)}. Refusing to start.`);
    process.exit(2);
  }

  const result = await drainActOutbox(client, { onlyDocumentId: args.documentId });
  report(result);
  // For pq-act-drain.sh, which re-arms the failure alert on this line and on
  // nothing else (drainRearmsAlert says why exit 0 alone is not enough).
  if (drainRearmsAlert(result)) console.log(ALERT_REARM_LINE);
  process.exitCode = drainExitStatus(result);
}

main().catch((error) => {
  // The database failing under the pass, or something in PathQuote's own
  // code: drainActOutbox stores a row's own failure on the row and throws
  // only for these. Not a normal outcome, so the unit fails and emails.
  console.error(error);
  process.exit(1);
});
