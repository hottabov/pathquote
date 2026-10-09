// What one sync run leaves behind, and how the Settings page says it.
//
// Stored as JSON in the `Setting` row `act.sync.lastRun`. A row rather than a
// table because exactly one is ever wanted: the question the page answers is
// "did last night work", not "show me the history". A table would be a nicer
// answer to a question nobody has asked yet.
//
// Pure: no database, no React. The wording is the part worth testing, and the
// counts it reads come straight from SyncResult.

import { formatCount, plural } from "@/lib/plural";

/** The Setting key the record lives under. */
export const LAST_RUN_KEY = "act.sync.lastRun";

export type SyncTrigger = "schedule" | "manual";

export type ActSyncRun = {
  startedAt: string;
  /**
   * Null in three different situations: the run is going on right now, it threw
   * (and `error` says why), or it was killed outright and nothing ever wrote the
   * ending.
   *
   * `error` separates the thrown run from the other two. It does NOT separate a
   * run that is still going from one that was killed -- both leave a null ending
   * and no error, because the record written at the start of a run is the same
   * record either way. Only isSyncRunning() in sync.ts can tell those apart, by
   * asking whether the advisory lock is still held, and describeRun takes its
   * answer as the `running` option. Read "null with no error" as killed on its
   * own and you report a live sync as a dead one.
   */
  finishedAt: string | null;
  trigger: SyncTrigger;
  contactsCreated: number;
  contactsUpdated: number;
  companiesCreated: number;
  companiesFromNamelessContacts: number;
  companiesKeyCollisions: number;
  failed: number;
  /** The message, when the run threw. */
  error: string | null;
};

export type RunDescription = {
  tone: "ok" | "warn" | "error";
  /** One line: what happened. */
  headline: string;
  /** A second line for things worth a look, or null. */
  detail: string | null;
  /** "Scheduled" or "Run by hand". */
  trigger: string;
};

/**
 * The counters a record carries.
 *
 * A Pick of ActSyncRun, not of SyncResult -- but SyncResult structurally
 * satisfies it, so sync.ts hands its own result object to the builders
 * unchanged, with no mapping step in between to be kept in sync with this list.
 *
 * Which is the reason the two closing builders copy these six across by name
 * (`onlyCounts` below) instead of spreading what they were given. SyncResult
 * also carries `scanned`, `skipped`, `unknownIndustries`,
 * `firstFailureActContactId`, `firstFailureMessage`, `recorded` and two Date
 * objects, and a spread would put every one of them in the stored JSON: a
 * Setting row quietly growing fields nobody asked for, two of them Dates that
 * come back from the round trip as strings. The named copy is what keeps the
 * stored record to the shape declared above.
 */
export type RunCounts = Pick<
  ActSyncRun,
  | "contactsCreated"
  | "contactsUpdated"
  | "companiesCreated"
  | "companiesFromNamelessContacts"
  | "companiesKeyCollisions"
  | "failed"
>;

/**
 * What a run that dropped some contacts leaves to say about them, said once.
 *
 * Two places need this sentence: describeRun's `failed` branch below, which the
 * Settings section renders, and the warning runActSyncNow returns to the admin
 * who pressed Sync now (src/lib/actions/act-sync.ts), which the toast shows on
 * top of that same section a moment before it refreshes. Two wordings of one
 * fact invite reading them as two different facts, so there is one wording and
 * both sites interpolate it.
 *
 * A const rather than two copies and a comment promising they match: the copy
 * in the action was pinned by nothing, so nothing would have failed when one of
 * them was reworded and the other was not.
 *
 * True because `failed > 0` freezes the checkpoint for the rest of the run (see
 * `checkpoint` in src/lib/act/sync.ts), so the next sync asks ACT! for a window
 * that still contains them. The thrown-run branch deliberately does not make
 * this promise and so does not use this string -- a run that threw on page nine
 * has already moved the position eight times.
 */
export const FAILED_CONTACTS_DETAIL =
  "Nothing was skipped — those contacts will be tried again on the next sync. If it keeps happening, ask your developer to look into it.";

const NO_COUNTS: RunCounts = {
  contactsCreated: 0,
  contactsUpdated: 0,
  companiesCreated: 0,
  companiesFromNamelessContacts: 0,
  companiesKeyCollisions: 0,
  failed: 0,
};

/**
 * The record a run writes when it starts -- counters at zero, no ending.
 *
 * Written before the first contact is read, which is what makes a run that is
 * killed outright (a reboot, an OOM, a `kill -9`) leave a record at all. See
 * the second branch of describeRun for what that record then says.
 */
export function startedRun(trigger: SyncTrigger, startedAt: Date): ActSyncRun {
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    trigger,
    ...NO_COUNTS,
    error: null,
  };
}

/**
 * The six counters, and nothing else that came with them.
 *
 * The one place the list is written out, so the two closing builders cannot
 * drift apart on it. See RunCounts for why it is a named copy rather than a
 * spread of the caller's object.
 */
function onlyCounts(counts: RunCounts): RunCounts {
  return {
    contactsCreated: counts.contactsCreated,
    contactsUpdated: counts.contactsUpdated,
    companiesCreated: counts.companiesCreated,
    companiesFromNamelessContacts: counts.companiesFromNamelessContacts,
    companiesKeyCollisions: counts.companiesKeyCollisions,
    failed: counts.failed,
  };
}

/** The same record once the run came back: the counters it ended with, and an ending. */
export function finishedRun(started: ActSyncRun, counts: RunCounts, finishedAt: Date): ActSyncRun {
  return { ...started, ...onlyCounts(counts), finishedAt: finishedAt.toISOString() };
}

/**
 * The same record once the run threw: the counters it had reached, no ending,
 * and the message.
 *
 * No `finishedAt`, deliberately. A run that threw did not finish, and the
 * record says so; `error` is what tells describeRun to lead with the message
 * rather than with "Started and never finished".
 *
 * Built here rather than through finishedRun, which would have meant handing
 * that function a `new Date()` only to throw it away a line later. Nothing in
 * this module reads the clock now, so every record it builds is a function of
 * its arguments alone and its tests can assert whole records rather than the
 * fields that happen to be stable.
 */
export function failedRun(started: ActSyncRun, counts: RunCounts, error: unknown): ActSyncRun {
  return { ...started, ...onlyCounts(counts), finishedAt: null, error: messageOf(error) };
}

/**
 * Words for whatever was thrown.
 *
 * Never empty, because describeRun leads with `error` only when it is truthy:
 * an `new Error()` with no message -- or a driver error that arrives with a
 * blank one -- would otherwise fall through to the killed-run branch, and a run
 * that threw would be reported as one that was stopped partway. A run that has
 * an error gets words for it even when the error itself had none.
 *
 * Exported for the Sync now action (src/lib/actions/act-sync.ts), which has the
 * same problem from the other side: it returns the thrown message to the admin
 * who pressed the button, and a blank one would paint an empty red banner. The
 * two go through here so the banner and the stored record say the same words
 * about the same failure.
 */
export function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "the sync threw an error that carried no message";
}

function isTrigger(value: unknown): value is SyncTrigger {
  return value === "schedule" || value === "manual";
}

/**
 * A stored error: words, not a blank.
 *
 * `typeof value === "string"` alone would admit `""`, and a blank message is
 * the one value messageOf above exists to prevent ever being written -- because
 * describeRun leads with `error` only when it is truthy, so an empty string
 * falls past the error branch and a run that threw is reported as "Started and
 * never finished". messageOf closes that for the records this module writes;
 * this closes it for a record the column already holds, written by a version
 * that had no messageOf or by a hand edit.
 */
function isErrorMessage(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * A stored timestamp: a string the clock can actually be read off.
 *
 * `typeof value === "string"` alone is not enough. Nothing in this module reads
 * either timestamp as a date -- describeRun only asks whether `finishedAt` is
 * null -- so being shown is the only reason `startedAt` is in the record at
 * all, and a string that is not a date reaches the reader as the literal words
 * "Invalid Date". Which looks like a bug in the page rather than a bad record,
 * and sends whoever sees it to the wrong file.
 */
function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * A stored counter.
 *
 * `typeof` is the check that does the work. `Number.isFinite` is belt and
 * braces: neither NaN nor Infinity can come back out of a jsonb column, since
 * nothing can put them in -- but both would survive the `typeof` test on their
 * own and print as themselves, so the pair costs one call and removes the need
 * to know that.
 *
 * Negative is rejected, because describeRun never formats a counter it has not
 * first put behind a `> 0` test -- and `-1 > 0` is false, so a stored -1 is
 * never printed as "-1": it is simply not mentioned, and the page reads a run
 * that updated something as "No changes". That is the silent zero
 * parseStoredRun's all-or-nothing rule exists to stop, reached from inside the
 * guard meant to stop it. The bound costs nothing real -- no writer in this
 * repo can produce a negative count, so the only record it turns away is one
 * that was already wrong, and turning it away makes the page say "cannot read
 * the record" rather than report a clean night.
 *
 * Not checked for being a whole number: nothing downstream depends on it, and
 * `formatCount` renders 3.5 as "3.5", which is neither a crash nor a number
 * that misleads anybody about what happened.
 */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * The record that was stored, or null when what came back is not one.
 *
 * `Setting.value` is a bare Json column: nothing in the database enforces the
 * shape declared at the top of this file, and the only writer is a version of
 * sync.ts that will change. So the page has to survive a record written by an
 * older or a newer version of this module.
 *
 * A crash is not the failure mode to worry about. Every counter describeRun
 * reads is behind a `> 0` test, and `undefined > 0` is false, so a record
 * missing `contactsUpdated` does not throw -- it reads as zero and the page
 * says "No changes" about a run that updated eleven contacts. That is the
 * wrong-and-looks-right answer the double write in sync.ts exists to prevent,
 * reached from a third side, and nobody investigates a page that looks calm.
 * (`formatCount(undefined)` IS a TypeError, so a reader that formats a counter
 * without gating it first does crash. Both are closed here rather than one of
 * them being closed again in every reader.)
 *
 * All or nothing, deliberately. The alternative -- keep the fields that parse,
 * default the ones that do not -- is that same silent zero by choice instead of
 * by accident, and it would let an unrecognised `trigger` label a hand run as
 * the nightly job. One unreadable field makes the record unreadable, and the
 * caller is left to say so rather than to guess.
 *
 * Fields this version does not know about are ignored rather than rejected, so
 * a newer version adding one does not blank the page for an older one.
 *
 * A type assertion plus named guards, which is what this repo does with a Json
 * column read back (`isCommissionTierArray`, src/lib/queries/settings.ts); no
 * schema library, because there is none in this layer to be consistent with.
 */
export function parseStoredRun(value: unknown): ActSyncRun | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { startedAt, finishedAt, trigger, error } = value as Record<string, unknown>;

  if (!isTimestamp(startedAt)) return null;
  if (!(finishedAt === null || isTimestamp(finishedAt))) return null;
  if (!isTrigger(trigger)) return null;
  if (!(error === null || isErrorMessage(error))) return null;

  // Through onlyCounts so the six names stay written in exactly one place: a
  // seventh counter added to RunCounts and not to this check would be read off
  // the row untested, and the compiler would not say a word. The cast is a lie
  // for the length of that one call -- the values may be anything, or absent --
  // which is what the line below is for.
  const counts = onlyCounts(value as RunCounts);
  if (!Object.values(counts).every(isCount)) return null;

  return { startedAt, finishedAt, trigger, ...counts, error };
}

/**
 * One run, in words.
 *
 * Three tones, and the middle one earns its place: a run that imported
 * everything cleanly but hit a company-key collision is not a failure and not
 * nothing. Two different firms whose names normalise alike need a person, and
 * no other screen would mention it.
 *
 * The branches are ordered by what a reader most needs to know first, and the
 * first three are all ways of not having worked:
 *
 * 1. `error` -- the run threw, and its message is the most specific thing
 *    anyone can act on. It takes precedence over `failed` because a thrown run
 *    stopped early, so its counters describe only the part that ran. The failed
 *    count is not discarded: it goes on the second line.
 * 2. `finishedAt` null with no `error` -- nothing wrote an ending, so the run
 *    was killed rather than having thrown. Reachable whenever the record is
 *    written at the start of a run (a reboot, an OOM kill, a `kill -9` of the
 *    systemd service). Without this branch such a record falls through to the
 *    clean-run path and a run that never came back is reported as "No changes",
 *    which is the one wrong answer this page can give.
 *
 *    `running` is what separates that from a run that is going on right now,
 *    which has the same record: no ending written yet. The record cannot tell
 *    them apart -- only whether the advisory lock is currently held can, which
 *    is isSyncRunning in sync.ts, and the caller passes the answer in.
 * 3. `failed` -- individual contacts threw and the run carried on past them.
 */
export function describeRun(
  run: ActSyncRun,
  { running = false }: { running?: boolean } = {},
): RunDescription {
  const trigger = run.trigger === "manual" ? "Run by hand" : "Scheduled";

  if (run.error) {
    return {
      tone: "error",
      headline: `Failed: ${run.error}`,
      // A thrown run and a run that merely had failures share the one thing the
      // reader most wants to know -- that nothing was lost -- so both say it.
      // Silence on that point reads as the worst case.
      //
      // What they do NOT share is a promise about where the next run starts.
      // The branch below can say those contacts will be tried again, because a
      // failed contact freezes the checkpoint for the rest of the run; this one
      // cannot, because the position IS checkpointed after every fully
      // processed page (see sync.ts), so a run that threw on page nine has
      // already moved it eight times and the pages before the throw are behind
      // it. What is true either way is that it only ever moves past records
      // already stored, so nothing was skipped and the next run resumes there.
      detail:
        run.failed > 0
          ? `${plural(run.failed, "contact", "contacts")} had already failed when it stopped. Nothing was skipped — everything it got through is saved, and the next run carries on from there.`
          : "Nothing was skipped — everything it got through is saved, and the next run carries on from there.",
      trigger,
    };
  }

  if (!run.finishedAt) {
    // Ordered after `error` on purpose: a run that threw records its message
    // and only then releases the lock, so for that instant the lock is still
    // held and `running` is true of a run that is already over. The message is
    // the better thing to say in that instant, and in every instant after it.
    if (running) {
      // No estimate of how long. The neighbouring comments in sync.ts call this
      // a ten-minute run and a `--full` import of ~17,500 contacts can go past
      // that, so any number named here is a promise the code cannot keep: a
      // director who reloads after four minutes, reads the same line again and
      // was told "a few minutes" cannot tell waiting from wedged.
      //
      // "Reload this page" assumes the reader does the reloading, and the
      // section built on this -- src/app/(app)/settings/act-sync/page.tsx --
      // kept that true rather than rewording it. The page does not poll.
      //
      // What made the sentence worth re-checking is that runActSyncNow
      // revalidates that route in a `finally`, so a click which comes back does
      // refresh the page on its own. It just never refreshes INTO this branch:
      // by the time the action returns, the run has ended and the record has an
      // ending, so the page renders what changed instead. The two states that
      // actually show this sentence are the two nothing refreshes -- the
      // nightly job running while an admin opens the page, and a click that got
      // a gateway timeout off a sync that is still going.
      //
      // Which is why the page puts a Reload control beside the sentence
      // whenever a sync holds the lock: that is a superset of the states this
      // branch is reached in, so the instruction is never given without the
      // means to follow it. See `reload` in src/lib/act/sync-view.ts.
      return {
        tone: "ok",
        headline: "Running now",
        detail:
          "It is reading ACT! now. Reload this page and it will say what changed once it has finished.",
        trigger,
      };
    }

    // No "press Sync now" here, and that is the second wording of this detail
    // rather than an oversight. The button is not always on the page: Settings
    // withholds it whenever there is no stored position (runNowFor in
    // src/lib/act/sync-view.ts), and a killed run with no stored position is
    // exactly the state a killed FIRST full import leaves behind -- nothing
    // checkpoints until a page completes. So the imperative named a control
    // that was not there, in the one state it was reachable in.
    //
    // Dropped rather than routed through sync-view.ts, which is where the
    // cursor is known. Doing that would mean this module handing out a detail
    // for somebody else to replace, and sync-view.ts re-deriving WHICH branch
    // was taken from a RunDescription that deliberately does not say. The
    // sentence that replaces it is true in both pairings and needs no cursor to
    // be sure of: the next run -- tonight's, or one somebody starts -- carries
    // on from where this one got to.
    return {
      tone: "error",
      headline: "Started and never finished",
      detail:
        "The server restarted, or the sync was stopped partway. Nothing was lost — the next sync carries on from where this one got to. If it keeps happening, ask your developer to check the service log.",
      trigger,
    };
  }

  if (run.failed > 0) {
    return {
      tone: "error",
      headline: `${plural(run.failed, "contact", "contacts")} failed`,
      // Was "The cursor did not move, so nothing was skipped". Accurate, and
      // the mechanism rather than the consequence -- "cursor" is this
      // repository's word, not a word on a page whose only reader is the
      // director. What it means to him is that the contacts that failed are
      // still waiting rather than lost, which is what the first half now says.
      //
      // Why the first half is true, and why the Sync now action interpolates
      // this same const rather than keeping its own copy: see
      // FAILED_CONTACTS_DETAIL above.
      //
      // The second half is the same offer the killed-run branch above makes,
      // and for the same reason: the count is all this record carries, so
      // "fix the cause" on its own is advice he cannot act on. The per-contact
      // message is in the service log, but only the nightly run prints it
      // there, so this does not promise he will find it -- it names the person
      // who can.
      detail: FAILED_CONTACTS_DETAIL,
      trigger,
    };
  }

  const changes: string[] = [];
  if (run.contactsCreated > 0) changes.push(`${plural(run.contactsCreated, "contact", "contacts")} added`);
  if (run.contactsUpdated > 0) {
    // "3 contacts added, 11 updated" can drop the second noun, but only
    // because the first phrase carried it. On the ordinary night nothing is
    // added and this phrase comes first, where a bare "11 updated" says
    // nothing about what was updated -- and "11 updated, 2 companies added"
    // invites reading the 11 as companies.
    changes.push(
      changes.length > 0
        ? `${formatCount(run.contactsUpdated)} updated`
        : `${plural(run.contactsUpdated, "contact", "contacts")} updated`,
    );
  }
  if (run.companiesCreated > 0) {
    changes.push(`${plural(run.companiesCreated, "company", "companies")} added`);
  }

  // The ordinary outcome once this runs nightly: nobody touched ACT!
  // yesterday. "0 contacts added, 0 updated" reads like something went wrong.
  const headline = changes.length > 0 ? changes.join(", ") : "No changes";

  // Each note is a whole sentence with its own full stop, so the last one is
  // not left bare when they are joined -- and so the consequence, not the
  // mechanism, is what the reader is given. "Company key collision" is our
  // word for it; what it means to him is two clients that look the same.
  const notes: string[] = [];
  if (run.companiesKeyCollisions > 0) {
    notes.push(
      run.companiesKeyCollisions === 1
        ? "1 new client has a name that looks like a client you already have — check the client list before quoting either of them."
        : `${plural(run.companiesKeyCollisions, "new client", "new clients")} have names that look like clients you already have — check the client list before quoting any of them.`,
    );
  }
  if (run.companiesFromNamelessContacts > 0) {
    // Records, not distinct companies: two nameless contacts at one firm count
    // twice (see companiesFromNamelessContacts in sync.ts). Saying "companies"
    // invites reconciling this number against the client list, where it will
    // not match.
    notes.push(
      `${plural(run.companiesFromNamelessContacts, "contact", "contacts")} arrived with a company but no person's name — the client came in, the person did not. Add the name in ACT! if you want them on a quote.`,
    );
  }

  return {
    tone: run.companiesKeyCollisions > 0 ? "warn" : "ok",
    headline,
    detail: notes.length > 0 ? notes.join(" ") : null,
    trigger,
  };
}
