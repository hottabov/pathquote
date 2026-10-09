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
   * Null when the run did not come back: it threw, and `error` says why, or it
   * was killed outright and nothing ever wrote the ending. Those two are told
   * apart by `error`, and describeRun says something different for each.
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
 * The counters a record carries. SyncResult supplies every one of them, which
 * is why the three builders below take it directly.
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

/** The same record once the run came back: the counters it ended with, and an ending. */
export function finishedRun(started: ActSyncRun, counts: RunCounts, finishedAt: Date): ActSyncRun {
  return {
    ...started,
    contactsCreated: counts.contactsCreated,
    contactsUpdated: counts.contactsUpdated,
    companiesCreated: counts.companiesCreated,
    companiesFromNamelessContacts: counts.companiesFromNamelessContacts,
    companiesKeyCollisions: counts.companiesKeyCollisions,
    failed: counts.failed,
    finishedAt: finishedAt.toISOString(),
  };
}

/**
 * The same record once the run threw: the counters it had reached, no ending,
 * and the message.
 *
 * No `finishedAt`, deliberately. A run that threw did not finish, and the
 * record says so; `error` is what tells describeRun to lead with the message
 * rather than with "Started and never finished".
 */
export function failedRun(started: ActSyncRun, counts: RunCounts, error: unknown): ActSyncRun {
  return { ...finishedRun(started, counts, new Date()), finishedAt: null, error: messageOf(error) };
}

/**
 * Words for whatever was thrown.
 *
 * Never empty, because describeRun leads with `error` only when it is truthy:
 * an `new Error()` with no message -- or a driver error that arrives with a
 * blank one -- would otherwise fall through to the killed-run branch, and a run
 * that threw would be reported as one that was stopped partway. A run that has
 * an error gets words for it even when the error itself had none.
 */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "the sync threw an error that carried no message";
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
      // Not "the cursor did not move", which the branch below can say and this
      // one cannot: the cursor is checkpointed after every fully processed page
      // (see sync.ts), so a run that threw on page nine has moved it eight
      // times. What is true either way is that it only ever moves past records
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
      return {
        tone: "ok",
        headline: "Running now",
        detail:
          "It is reading ACT! at the moment. Reload this page in a few minutes and it will say what changed.",
        trigger,
      };
    }

    return {
      tone: "error",
      headline: "Started and never finished",
      detail:
        "The server restarted, or the sync was stopped partway. Nothing was lost — press Sync now to bring it up to date. If it keeps happening, ask your developer to check the service log.",
      trigger,
    };
  }

  if (run.failed > 0) {
    return {
      tone: "error",
      headline: `${plural(run.failed, "contact", "contacts")} failed`,
      detail:
        "The cursor did not move, so nothing was skipped — fix the cause and run it again.",
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
