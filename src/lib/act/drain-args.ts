// What `npm run act:drain` was asked to do, what it says first, and how it
// exits.
//
// Pure, for the reason cli-args.ts is: the arguments and the exit status are
// the parts of the script worth testing, and they can be tested without a
// database or ACT!. A sibling rather than a widening of cli-args.ts, as
// preflight-args.ts is: none of the sync's flags (--full, --dry-run, --limit,
// --trigger) means anything to a drain. The rule is the same -- anything not
// understood is an error -- and the database description is shared.

import type { DatabaseTarget } from "@/lib/act/cli-args";
import type { DrainResult } from "@/lib/act/drain";
import type { NpmEnv } from "@/lib/npm-swallowed-flags";

export type DrainArgs = {
  /**
   * Only this quote's rows (DrainOptions.onlyDocumentId): for a person who
   * has fixed what held one quote back and wants it sent now rather than at
   * the next tick. The timer passes nothing and drains every due row.
   */
  documentId: string | undefined;
};

export type DrainParseResult = { ok: true; args: DrainArgs } | { ok: false; error: string };

export const DRAIN_ACCEPTED_ARGS =
  "--document ID (or --document=ID), the quote's id; with no flag every due row is drained";

function fail(message: string): DrainParseResult {
  return { ok: false, error: `${message}. Accepted: ${DRAIN_ACCEPTED_ARGS}` };
}

/**
 * `argv` is `process.argv.slice(2)`. `env` is `process.env`, read for one
 * reason: `npm run act:drain --document=<id>` -- no `--` -- does not hand the
 * flag to the script. npm keeps it as its own config and the script starts
 * with no arguments, which drains EVERY due row into ACT! where the operator
 * asked for one quote's. npm leaves npm_config_document behind, so that is
 * refused. (Written `--document <id>`, npm keeps the flag and passes the id
 * on as a bare argument, which is refused as an unknown argument anyway.)
 */
export function parseActDrainArgs(argv: readonly string[], env: NpmEnv = {}): DrainParseResult {
  let documentId: string | undefined;
  let documentSeen = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--document" || arg.startsWith("--document=")) {
      if (documentSeen) return fail("--document was given more than once");
      documentSeen = true;
      // Takes the next token whatever it is, as cli-args.ts's --limit does,
      // so `--document --something` is a bad id rather than a flag.
      const raw = arg === "--document" ? argv[++i] : arg.slice("--document=".length);
      // A quote's id is a cuid: letters and digits. Anything else -- blank, a
      // flag, a quote number such as Q-AU-2026-001 -- would match no row and
      // drain nothing, which reads as "nothing to send" rather than as a typo.
      if (raw === undefined || !/^[a-z0-9]+$/i.test(raw)) {
        const got = raw === undefined ? "nothing" : JSON.stringify(raw);
        return fail(`--document needs the quote's id (letters and digits, as in its address), got ${got}`);
      }
      documentId = raw;
    } else {
      return fail(`unknown argument ${JSON.stringify(arg)}`);
    }
  }

  // Not npmSwallowedFlag: that asks for "true", which is what npm leaves for
  // a bare `--document`; `--document=<id>` leaves the id.
  if (env.npm_config_document && !documentSeen) {
    return {
      ok: false,
      error:
        "npm swallowed --document and never passed it to the script, so this would have drained every due row instead of one quote's. Put -- before the flag: npm run act:drain -- --document <id>",
    };
  }

  return { ok: true, args: { documentId } };
}

export function formatDrainBanner(args: DrainArgs, database: DatabaseTarget): string {
  return [
    "act:drain",
    "  mode      WRITE -- sends queued quotes to ACT! if sending is on",
    `  rows      ${args.documentId ? `only quote ${args.documentId}'s` : "every due row"}`,
    `  database  ${database.host}:${database.port}/${database.name}`,
  ].join("\n");
}

/**
 * The exit status of a pass that came back, for pq-act-drain.service: 1
 * fails the unit and starts pq-backup-alert@, which emails; 0 does not.
 *
 * A unit that runs every 15 minutes fails every 15 minutes about whatever it
 * fails on -- the alert sends one email a day of it (pq-backup-alert.sh), but
 * a failure that was never a fault still costs that email, and teaches
 * people to ignore it -- so it fails only on what needs a person and will
 * not mend itself: a pass stopped by a `setup` fault (stopCause in
 * src/lib/act/drain-rules.ts) -- the service account not found, the login
 * refused, a 403 to the login or the users lookup, IIS turning the VPS
 * away, a redirect. Everything else is 0:
 *
 *   - `ran`, whatever it found: a row held back is listed, with its reason,
 *     on Settings (the queue card, describeOutbox in src/lib/act/sync-view.ts)
 *     -- not yet on its quote, which shows it from Task 9 -- and a row backing
 *     off is tried again by the next tick;
 *   - `busy`: another drain is doing the work -- at 03:00, the nightly sync's;
 *   - `switched-off`: somebody's decision, not a fault;
 *   - `out-of-time`: the rest go at the next tick;
 *   - `stopped` with `unavailable`: ACT! busy or away. A weekend with the
 *     office's ACT! server off is not a fault of PathQuote's, and would
 *     otherwise email about it every day it lasts.
 *
 * A pass that throws -- the database failing -- never reaches here; the
 * script exits 1 for it. A missing ACT_* variable never reaches a pass: the
 * script exits 2 for it, as for any run that cannot start.
 */
export function drainExitStatus(result: Pick<DrainResult, "status" | "stopCause">): 0 | 1 {
  return result.status === "stopped" && result.stopCause !== "unavailable" ? 1 : 0;
}

/**
 * The line act:drain prints after a pass that shows ACT! is taking
 * PathQuote's writes again, and the whole of the contract with
 * pq-act-drain.sh, which looks for exactly this line (grep -x) and, finding
 * it, removes the failure alert's stamp -- so the next fault emails at once
 * instead of waiting out the day the stamp holds it back for
 * (pq-backup-alert.sh, REPEAT_HOURS). Change it in both places or neither.
 */
export const ALERT_REARM_LINE = "act:drain: ACT! took writes on this pass -- pq-act-drain.sh re-arms the failure alert";

/**
 * Whether a pass shows the fault behind an alert is gone: it did not fail its
 * unit, and it wrote to ACT!.
 *
 * Exit 0 alone is not enough, and would make the alert's "once a day" untrue.
 * A pass that fails on a `setup` fault backs off the row it was working, and
 * the backoff doubles (backoffMs in src/lib/act/drain-rules.ts), so while the
 * fault stands, more and more ticks find nothing due and exit 0 without
 * asking ACT! anything -- as does the tick at 03:00 that finds the nightly
 * sync holding the lock (`busy`), and every tick while sending is switched
 * off. Each of those re-arming the alert would send another email at the
 * next failure. A write that ACT! took is what proves the login, the
 * licence and the allow-list are working again.
 */
export function drainRearmsAlert(result: Pick<DrainResult, "status" | "stopCause" | "stepsWritten">): boolean {
  return drainExitStatus(result) === 0 && result.stepsWritten > 0;
}
