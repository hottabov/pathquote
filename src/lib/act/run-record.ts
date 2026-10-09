// What one sync run leaves behind, and how the Settings page says it.
//
// Stored as JSON in the `Setting` row `act.sync.lastRun`. A row rather than a
// table because exactly one is ever wanted: the question the page answers is
// "did last night work", not "show me the history". A table would be a nicer
// answer to a question nobody has asked yet.
//
// Pure: no database, no React. The wording is the part worth testing, and the
// counts it reads come straight from SyncResult.

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

// Grouped counts, matching the `plural` in catalog-visibility-summary.ts and
// contacts-visibility.ts -- same shape, same "en-US", so a count reads the same
// wherever the app prints one. The grouping earns its place at this scale: the
// first full import is ~12,000 contacts, and "12,000 updated" is read at a
// glance where "12000 updated" has to be counted.
function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
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
 * 3. `failed` -- individual contacts threw and the run carried on past them.
 */
export function describeRun(run: ActSyncRun): RunDescription {
  const trigger = run.trigger === "manual" ? "Run by hand" : "Scheduled";

  if (run.error) {
    return {
      tone: "error",
      headline: `Failed: ${run.error}`,
      detail:
        run.failed > 0
          ? `${plural(run.failed, "contact", "contacts")} had already failed before this.`
          : null,
      trigger,
    };
  }

  if (!run.finishedAt) {
    return {
      tone: "error",
      headline: "Started and never finished",
      detail:
        "Nothing recorded how it ended, so it was stopped rather than having failed on its own — a reboot, or the service being killed. The journal for the run will say.",
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
  if (run.contactsUpdated > 0) changes.push(`${run.contactsUpdated.toLocaleString("en-US")} updated`);
  if (run.companiesCreated > 0) {
    changes.push(`${plural(run.companiesCreated, "company", "companies")} added`);
  }

  // The ordinary outcome once this runs nightly: nobody touched ACT!
  // yesterday. "0 contacts added, 0 updated" reads like something went wrong.
  const headline = changes.length > 0 ? changes.join(", ") : "No changes";

  const notes: string[] = [];
  if (run.companiesKeyCollisions > 0) {
    notes.push(
      `${plural(run.companiesKeyCollisions, "company key collision", "company key collisions")} — different firms whose names normalise to the same key`,
    );
  }
  if (run.companiesFromNamelessContacts > 0) {
    notes.push(
      `${plural(run.companiesFromNamelessContacts, "company", "companies")} had no named contact`,
    );
  }

  return {
    tone: run.companiesKeyCollisions > 0 ? "warn" : "ok",
    headline,
    detail: notes.length > 0 ? notes.join(". ") : null,
    trigger,
  };
}
