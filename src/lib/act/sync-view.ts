// Everything the ACT! sync section says, decided here instead of in the page.
//
// The section answers four questions in order -- when did it last run, what did
// it do, is anything wrong, can I run it now -- and every one of them has cases
// that are easy to get wrong in a way that looks right: "Never run" about a
// sync that runs nightly, a Sync now button offered when pressing it would
// start a forty-minute import, a 504 reported as a failed sync. Those are
// decisions, not markup, so they live in one pure function with a test per case
// (tests/act-sync-view.test.ts) and the page renders what it is handed. Same
// reasoning that put describeRun in ./run-record.ts rather than in a component.
//
// The line drawn: this module decides WHAT the section says and which of the
// three tones it says it in. The page decides how a tone looks, which card a
// sentence sits in, and nothing else -- it contains no sentence about the sync
// and no `if` that picks one.
//
// Pure: no database, no React. `ActSyncStatus` is imported as a type only, so
// nothing from @/lib/queries (and therefore nothing from Prisma) is pulled in
// at runtime and the no-database test suite can import this file. The type
// import is still worth having: a field renamed on the query's side becomes a
// compile error here rather than an `undefined` on the page.

import { describeRun, type ActSyncRun, type RunDescription } from "@/lib/act/run-record";
import { relativeTime } from "@/lib/format";
import type { ActSyncStatus } from "@/lib/queries/act-sync";

/**
 * The nightly timer's schedule in the reader's words.
 *
 * Kept in step by hand with `scripts/ops/pq-act-sync.timer`, which is the thing
 * that actually decides it (`OnCalendar=*-*-* 03:00:00 Australia/Melbourne`).
 * Nothing in the app can read a systemd unit, so this is a transcription: if
 * that line changes, this one has to change with it.
 */
export const NIGHTLY_SCHEDULE = "Every night at 3:00 am, Melbourne time.";

/** When something happened, said twice over, because the two answer different questions. */
export type ActSyncWhen = {
  /**
   * "9 Oct 2026, 3:00 am Melbourne time" -- answers "was that before or after I
   * changed that record?", which a relative phrase cannot.
   */
  absolute: string;
  /** "2 hours ago" -- answers "is this stale?" without any arithmetic. */
  relative: string;
};

/** What the last run did, and whether anything is wrong with it. */
export type ActSyncSummary = {
  /** Drives the styling, the same three tones `describeRun` returns. */
  tone: RunDescription["tone"];
  headline: string;
  /** Up to three sentences; render it as a paragraph. */
  detail: string | null;
  /**
   * "Scheduled" / "Run by hand", or null when there is no readable record to
   * attribute -- a sync that has never run was not started by anybody.
   */
  trigger: string | null;
};

/**
 * The Sync now button, or the reason there isn't one.
 *
 * Two shapes rather than an `enabled` flag, because the withheld case is not a
 * greyed-out button: it is a different thing to read, with its own explanation
 * of whose job the first import is.
 */
export type ActSyncRunNow =
  | { kind: "offer"; hint: string }
  | { kind: "withhold"; headline: string; detail: string };

/** How far through ACT!'s own edit history PathQuote has read. */
export type ActSyncCaughtUp = { headline: string; detail: string };

export type ActSyncView = {
  when: ActSyncWhen | null;
  summary: ActSyncSummary;
  /**
   * Whether the page should offer a reload control.
   *
   * True exactly when a sync holds the lock, which is a superset of the states
   * whose wording says "Reload this page" -- describeRun says that sentence
   * only in its `running` branch, and this module says it only when `running`
   * is true as well. That direction is the one that matters: no sentence can
   * tell the reader to reload a page that is not offering him the control. The
   * reverse overlap is harmless, since a reload is never the wrong thing to
   * offer about a job that is going on right now.
   */
  reload: boolean;
  runNow: ActSyncRunNow;
  caughtUpTo: ActSyncCaughtUp;
  schedule: string;
};

const MELBOURNE_FORMAT = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Melbourne",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/**
 * A timestamp as the reader's own clock shows it: "9 Oct 2026, 3:00 am
 * Melbourne time".
 *
 * Melbourne rather than the server's zone, and said so in the string. The
 * schedule beside it is quoted in Melbourne (it is what the systemd unit says),
 * the company is in Melbourne, and the VPS's own clock is not something anybody
 * reading this page knows or should have to. An hour printed without its zone,
 * next to a schedule printed with one, is an invitation to subtract three from
 * the wrong number.
 *
 * Assembled from `formatToParts` rather than taken from `format()` so the order
 * and the separators are this module's rather than the host's CLDR data's --
 * the same reason `formatDateAU` in src/lib/format.ts is written out by hand.
 * `dayPeriod` is lowercased and stripped of full stops because en-AU renders it
 * "am", a locale fallback may render "AM", and some render "a.m."; all three
 * would otherwise show up as a difference nobody chose.
 */
function melbourneTime(date: Date): string {
  const parts = MELBOURNE_FORMAT.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const dayPeriod = part("dayPeriod").toLowerCase().replace(/\./g, "");
  return `${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")} ${dayPeriod} Melbourne time`;
}

/**
 * What the last run did.
 *
 * `describeRun` owns every word about a record that can be read. The two
 * branches below are the states it has no record to describe, and both of them
 * are states where saying the obvious thing would be wrong:
 *
 *   - `lastRunUnreadable`: a sync HAS run and left a record this version cannot
 *     parse (see parseStoredRun). "Never run" would be wrong about a job that
 *     runs every night, and wrong in the way nobody investigates. It is also
 *     not an ACT! problem and not something the director can act on, so it says
 *     whose problem it is.
 *   - no record at all: the sync has never run.
 *
 * `running` is checked before either, because a live sync makes both of those
 * headlines false -- and a missing record while a run is going is itself worth
 * saying out loud, since the worker writes one before it reads its first
 * contact.
 */
function summaryFor(
  lastRun: ActSyncRun | null,
  lastRunUnreadable: boolean,
  running: boolean,
): ActSyncSummary {
  if (lastRun) {
    const described = describeRun(lastRun, { running });
    return {
      tone: described.tone,
      headline: described.headline,
      detail: described.detail,
      trigger: described.trigger,
    };
  }

  if (running) {
    return {
      tone: "warn",
      headline: "Running now",
      detail: lastRunUnreadable
        ? "A sync is reading ACT! now. The one before it left a record this version of PathQuote cannot read, so there is nothing to say here about how that one went — ask your developer to look at it. Reload this page once this run has finished and it will say what changed."
        : "A sync is reading ACT! now, but nothing was recorded when it started, which should not happen. Reload this page once it has finished; if this is still all it says, ask your developer to look into it.",
      trigger: null,
    };
  }

  if (lastRunUnreadable) {
    return {
      tone: "warn",
      headline: "A sync has run — PathQuote cannot read what it recorded",
      detail:
        "The last run left a record this version of PathQuote does not understand, so there is no way to say here how it went. The sync itself may well be working: this is a PathQuote problem, not an ACT! one. Ask your developer to look at it.",
      trigger: null,
    };
  }

  return {
    tone: "warn",
    headline: "Never run",
    detail:
      "No sync has been recorded, so nothing has come across from ACT! yet. The first import is the one job here that has to be run on the server — see Sync now below.",
    trigger: null,
  };
}

/**
 * The button, or why there isn't one.
 *
 * A null cursor is the whole reason this is a decision rather than a button.
 * With nothing stored, "the changes since last time" means every contact in
 * ACT! -- ~17,500 of them, 88 pages -- which is ten minutes at best and is
 * capped by nginx's read timeout long before it finishes (see the HOW LONG THIS
 * BLOCKS note on runActSyncNow). The click would leave a gateway error on
 * screen, a sync still running behind it, and nobody able to tell which. So
 * that state gets an explanation and no button at all.
 *
 * A sync already running does NOT withhold the button: pressing it loses the
 * advisory-lock race and comes back with the lock's own sentence, which is a
 * true and harmless answer. The hint says so in advance rather than letting him
 * find out.
 */
function runNowFor(cursor: Date | null, running: boolean): ActSyncRunNow {
  if (!cursor) {
    return {
      kind: "withhold",
      headline: "The first import has to be run on the server",
      detail:
        "PathQuote has not caught up to any point in ACT!'s history yet, so there is no short list of recent changes to fetch — this would read every contact in ACT!, about 17,500 of them, and take ten minutes or more. This page stops waiting long before that, which would leave you unable to tell a working import from a stuck one. Ask your developer to run the first import on the server. After that there is only ever a night's worth of changes to fetch and this takes a few seconds.",
    };
  }

  return {
    kind: "offer",
    hint: running
      ? "A sync is already running, so this will not start a second one — it will come back and tell you to wait. Reload the page instead to see how the one that is going is getting on."
      : "Brings PathQuote up to date with the changes made in ACT! since the last sync. Usually a few seconds. Leave this page open while it works.",
  };
}

/**
 * The stored cursor, without the word "cursor".
 *
 * It is the one number that explains a surprising result, and reading it used
 * to need SQL. What it means to the reader is a point in ACT!'s own record of
 * when things were last edited: everything edited before it has been looked at,
 * and the next sync asks ACT! only for what changed after it. Which is exactly
 * why "no changes" can be the honest answer on a morning after somebody edited
 * ACT!, and why that is the first thing to tell a developer.
 */
function caughtUpToFor(cursor: Date | null): ActSyncCaughtUp {
  if (!cursor) {
    return {
      headline: "Nothing yet",
      detail:
        "PathQuote has not caught up to any point in ACT!'s history, so the next sync starts from the very beginning and reads every contact rather than just the recent changes.",
    };
  }

  return {
    headline: `Everything edited in ACT! up to ${melbourneTime(cursor)}`,
    detail:
      "That is how far through ACT!'s own record of edits PathQuote has read, and where the next sync picks up. A change made in ACT! earlier than that is not something the next sync will go back for — so if an edit of yours is missing from PathQuote, this date is the first thing to tell your developer.",
  };
}

/**
 * The whole section, from one read of the status.
 *
 * `now` is a parameter so every state can be driven and printed without a clock
 * or a browser; the page passes `new Date()`.
 */
export function describeActSyncStatus(status: ActSyncStatus, now: Date = new Date()): ActSyncView {
  const { lastRun, lastRunUnreadable, running, cursor } = status;

  return {
    // `startedAt`, not `finishedAt`: it is the one timestamp every record has
    // (a run that threw or was killed never wrote an ending), and "when did it
    // last run" is asking when it began. On an ordinary night the two are
    // seconds apart.
    when: lastRun
      ? {
          absolute: melbourneTime(new Date(lastRun.startedAt)),
          relative: relativeTime(new Date(lastRun.startedAt), now),
        }
      : null,
    summary: summaryFor(lastRun, lastRunUnreadable, running),
    reload: running,
    runNow: runNowFor(cursor, running),
    caughtUpTo: caughtUpToFor(cursor),
    schedule: NIGHTLY_SCHEDULE,
  };
}

/**
 * What one press of the button came back as.
 *
 * Four outcomes, and the fourth is the reason this is a function rather than
 * three lines in the panel's click handler. `runActSyncNow` returns `{}`,
 * `{ warning }` or `{ error }` -- but a server action call can also fail to
 * come back at all, and on this button that is a case the design has to expect
 * rather than survive: nginx stops waiting at its `proxy_read_timeout` and
 * answers 504, while the sync itself carries on, keeps the lock and writes its
 * own record at the end.
 *
 * What the client sees in that moment, read off Next.js 16's own code rather
 * than guessed (node_modules/next/dist/client/components/router-reducer/
 * reducers/server-action-reducer.js): `fetch` resolves, because the server did
 * answer; the response is nginx's HTML error page, so it has neither
 * `content-type: text/x-component` nor an `x-action-redirect` header; the
 * reducer therefore throws, and because nginx's page is `text/html` rather than
 * `text/plain` it throws the generic `Error("An unexpected response was
 * received from the server.")`, which `serverActionReducer` passes to the
 * action promise's `reject`. So **the awaited call rejects** -- the panel never
 * sees a result object -- and the thrown message says nothing about a sync.
 *
 * `answered: false` is therefore every way the call can fail to return, not
 * only a 504: the same branch covers a dropped connection, a restarted proxy
 * and a closed laptop lid. All of them mean the same thing to the reader -- no
 * answer arrived, and the sync may well still be running -- and none of them
 * may be reported as "the sync failed", which is the one wrong answer here.
 * Only `{ error }`, which can arrive solely from a sync that actually came back
 * having thrown, says that.
 */
export type SyncAttempt = {
  outcome: "done" | "note" | "failed" | "no-answer";
  message: string;
};

export function describeSyncAttempt(
  settled:
    | { answered: true; result: { error?: string; warning?: string } }
    | { answered: false },
): SyncAttempt {
  if (!settled.answered) {
    return {
      outcome: "no-answer",
      message:
        "PathQuote gave up waiting for an answer, so it cannot say how the sync went — but the sync does not stop when that happens. Reload this page: if it says Running now, leave it alone and it will finish on its own.",
    };
  }

  // `error` before `warning`: a real failure is the thing to show, and nothing
  // in runActSyncNow returns both.
  if (settled.result.error) return { outcome: "failed", message: settled.result.error };
  if (settled.result.warning) return { outcome: "note", message: settled.result.warning };
  return { outcome: "done", message: "Sync finished — PathQuote is up to date with ACT!" };
}
