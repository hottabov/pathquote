// Everything the ACT! sync section says, decided here instead of in the page.
//
// The section answers four questions in order -- when did it last run, what did
// it do, is anything wrong, can I run it now -- and a fifth beside them, about
// the write side rather than any run: which quotes are still waiting to go to
// ACT!, and which of those are held for a person. Every one of them has cases
// that are easy to get wrong in a way that looks right: "Never run" about a
// sync that runs nightly, a Sync now button offered when pressing it would
// start a ten-minute import, a 504 reported as a failed sync. Those are
// decisions, not markup, so they live in one pure function with a test per case
// (tests/act-sync-view.test.ts) and the page renders what it is handed. Same
// reasoning that put describeRun in ./run-record.ts rather than in a component.
//
// The line drawn: this module decides WHAT the section says and which of the
// three tones it says it in. The page decides how a tone looks, which card a
// sentence sits in, and nothing else -- it contains no sentence about the sync
// and no `if` that picks one.
//
// WHO READS THESE SENTENCES. Every one of them was written for the company
// director, and the section was then opened to managers as well -- now to the
// managers an admin has ticked it for, one user at a time, because a
// distributor with no ACT! access has no use for any of this (see the ACT!
// sync entry in src/lib/settings-nav.ts and `canSeeActSync` in
// src/lib/roles.ts). That narrowing changes nothing below: the audience to
// write for is still the director and a manager who works in ACT!, and
// everybody else now never reaches the page. The sentences were re-read
// against both and kept as they are, which is a decision worth recording so
// it is not reopened by halves:
//
//   - "ask your developer" is not a dead end to a manager who does not know
//     who that is. It names the one thing to do about a PathQuote fault, and
//     the means is on the same screen: PathQuote Support, a nav row below
//     this section, is open to every signed-in user and addresses its message
//     to whoever holds DEVELOPER (src/lib/actions/support.ts). Rewriting the
//     sentences to say "report it through PathQuote Support" would route the
//     director around a person he can simply telephone.
//   - `runNowFor`'s withheld state still tells a manager that the first
//     import belongs on the server, although a manager cannot run it. It is
//     the only honest explanation for a card with no button, and the question
//     it answers -- why has nothing come across from ACT! -- is one a manager
//     asks. Naming who does it beats leaving them to guess.
//   - Nothing here asks the reader for server access. The log and the server
//     are named as the developer's business, never as something to go and do.
//
// Pure: no database, no React. `ActSyncStatus` is imported as a type only, so
// nothing from @/lib/queries (and therefore nothing from Prisma) is pulled in
// at runtime and the no-database test suite can import this file. The type
// import is still worth having: a field renamed on the query's side becomes a
// compile error here rather than an `undefined` on the page.

import { describeRun, type ActSyncRun, type RunDescription } from "@/lib/act/run-record";
import { relativeTime } from "@/lib/format";
import { formatCount, plural } from "@/lib/plural";
import type { ActOutboxStanding, ActSyncStatus } from "@/lib/queries/act-sync";

/**
 * The nightly timer's schedule in the reader's words.
 *
 * Kept in step by hand with `scripts/ops/pq-act-sync.timer`, which is the thing
 * that actually decides it (`OnCalendar=*-*-* 03:00:00 Australia/Melbourne`).
 * Nothing in the app can read a systemd unit, so this is a transcription: if
 * that line changes, this one has to change with it.
 *
 * An exact hour, which the timer now keeps exact on purpose: it carried a
 * `RandomizedDelaySec=300` that made an on-time run start at 03:04 and this
 * sentence untrue. The jitter went rather than this sentence, because it was
 * spreading a herd of one machine off an endpoint of one. The comment beside
 * `OnCalendar` says so, so nobody adds it back without reading why.
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
  /**
   * A few sentences -- more on a night the drain has things to say about the
   * quotes it sent (describeDrain in src/lib/act/run-record.ts); render it as
   * a paragraph.
   */
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

/** One held quote, as the queue section lists it. */
export type ActSyncHeldQuote = {
  /** The quote's number, or words for a quote that has none. */
  label: string;
  /** The quote's own page. */
  href: string;
  /** ActOutbox.blockedReason: the sentence a manager reads about it. */
  reason: string;
};

/**
 * The quotes queued for ACT! as they stand -- the queue section, apart from
 * the last run. See describeOutbox.
 */
export type ActSyncOutboxView = {
  /** `warn` while any quote is held for a person; `ok` otherwise. */
  tone: "ok" | "warn";
  headline: string;
  /** Whole sentences, a paragraph; null when the headline says it all. */
  detail: string | null;
  /** The held quotes, longest-queued first, at most HELD_QUOTES_LISTED. */
  held: ActSyncHeldQuote[];
  /** "and 3 more quotes", for held quotes past the list; null when all are listed. */
  more: string | null;
  /** For a reader counted only their own quotes, a sentence saying so; null for an admin. */
  scope: string | null;
};

export type ActSyncView = {
  when: ActSyncWhen | null;
  summary: ActSyncSummary;
  outbox: ActSyncOutboxView;
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
 * `describeRun` owns every word about a record that can be read. The branches
 * below are the states it has no record to describe, and every one of them is a
 * state where saying the obvious thing would be wrong:
 *
 *   - `lastRunUnreadable`: a sync HAS run and left a record this version cannot
 *     parse (see parseStoredRun). "Never run" would be wrong about a job that
 *     runs every night, and wrong in the way nobody investigates. It is also
 *     not an ACT! problem and not something the director can act on, so it says
 *     whose problem it is.
 *   - no record and a stored position: a sync has run; nothing recorded it.
 *     This is the state the release that added this page lands in, because the
 *     first full import (production, 2026-10-08) ran before `act.sync.lastRun`
 *     existed -- it left a cursor and no run record. So this is the FIRST thing
 *     the director reads here, and "Never run" is three false statements at
 *     once: 17,529 contacts have come across, the first import does not need
 *     running on the server, and the Caught up to card two inches below names
 *     the date it got to. The cursor is what separates this from the branch
 *     under it, which is why this function is given it.
 *   - no record and no stored position: the sync has never run.
 *
 * `running` is checked before any of them, because a live sync makes all those
 * headlines false -- and a missing record while a run is going is worth saying
 * out loud, since the worker writes one before it reads its first contact. (In
 * the deploy state above, that branch is also what a `--dry-run` shows while it
 * holds the lock, since a dry run records nothing at either end. Its "should
 * not happen" is an overstatement of that one case: transient, developer-only,
 * and gone when the dry run ends.)
 */
function summaryFor(
  lastRun: ActSyncRun | null,
  lastRunUnreadable: boolean,
  running: boolean,
  cursor: Date | null,
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

  // A stored position with no record: contacts are in, the bookkeeping is not.
  // Tone `ok` rather than `warn`, which is the one judgement in this branch.
  // Nothing is wrong and there is nothing to do: the state fixes itself at the
  // next run, tonight at the latest, and it is what every install of this
  // release opens on. Amber across the top of a working page on day one is how
  // a reader learns that amber here means nothing.
  //
  // The nightly hour is deliberately not repeated in this sentence. It is
  // transcribed from the timer unit in exactly one place (NIGHTLY_SCHEDULE),
  // printed by the card below this one, and a second hand-kept copy is how the
  // page comes to disagree with the unit that decides it.
  if (cursor) {
    return {
      tone: "ok",
      headline: "No run recorded yet",
      detail:
        "Contacts have already come across from ACT! — PathQuote has read everything edited up to the date shown under Caught up to below. What is missing is only the record of the run that did it: this page starts reporting runs from the first one after this release, so tonight's nightly sync will fill it in. Press Sync now if you would rather not wait for it.",
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
 * ACT! -- ~17,500 of them, 88 pages -- which is ten minutes at best, and ten
 * times the 60 seconds nginx waits on the VPS (measured 2026-10-10: the
 * directive is set nowhere in 21,450 lines of live configuration, so nginx's
 * compiled-in default applies -- see the HOW LONG THIS BLOCKS note on
 * runActSyncNow). The click would leave a gateway error on screen, a sync still
 * running behind it, and nobody able to tell which. So that state gets an
 * explanation and no button at all.
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
        "PathQuote has not caught up to any point in ACT!'s history yet, so there is no short list of recent changes to fetch — this would read every contact in ACT!, about 17,500 of them, and take ten minutes or more. This page will most likely stop waiting before it finishes, which would leave you unable to tell a working import from a stuck one. Ask your developer to run the first import on the server. After that there is only ever a night's worth of changes to fetch and this takes a few seconds.",
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

/** How many held quotes the queue section lists by number; the rest are counted. */
export const HELD_QUOTES_LISTED = 20;

/**
 * The queue, in words: which quotes are still to go to ACT!, which of them
 * are held for a person, and whether sending is switched on.
 *
 * From the rows as they stand (ActOutboxStanding, read by getActSyncStatus),
 * not from any run's record. That is the whole reason this is a section of
 * its own: the 15-minute drain runs 96 times a day and is nearly always the
 * pass that blocks a row, and no later pass counts it again -- so the
 * nightly record says nothing of a quote that has been held all week, while
 * the row itself has said so the whole time (describeDrain in
 * src/lib/act/run-record.ts has the other half).
 *
 * `warn` for a quote held back, and nothing else. A held row stays held until
 * somebody acts -- a manager fixes what its reason names, the developer looks
 * in ACT! -- which is what amber means on this page. Quotes waiting while
 * sending is switched off are somebody's decision, and quotes waiting while
 * it is on go by themselves: both `ok`, as describeDrain words them.
 *
 * Each held quote is listed by number, as a link to it, with its reason --
 * the sentence the drain or the planner stored for its manager. That list is
 * the only place in the app a reader can find out which quotes are held and
 * why (the drain's log aside): the quote's own page does not show it yet. FOR TASK 9: once the quote page
 * shows the ACT! state and the reason, the sentence that introduces the list
 * can say so too ("and on the quote's own page"); until then it must not.
 */
export function describeOutbox(outbox: ActOutboxStanding, now: Date): ActSyncOutboxView {
  const scope =
    outbox.scope === "yours"
      ? "Only the quotes you can open are counted here; an administrator sees every quote."
      : null;
  const notes: string[] = [];

  if (outbox.held > 0) {
    const one = outbox.held === 1;

    if (outbox.heldForContact > 0) {
      const all = outbox.heldForContact === outbox.held;
      // Which contact, and where not to touch it: the contact on the quote,
      // in PathQuote. Deleting it there and adding it again makes a contact
      // with no record that its create may have gone through, and the next
      // send would create the same person in ACT! a second time.
      notes.push(
        outbox.heldForContact === 1
          ? `${one ? "It is" : "1 of them is"} held because PathQuote asked ACT! to create the contact on that quote and never heard whether it did — somebody has to look in ACT! before it can go on, so ask your developer, and do not delete or re-add that contact in PathQuote.`
          : `${all ? (outbox.held === 2 ? "Both are" : "All of them are") : `${formatCount(outbox.heldForContact)} of them are`} held because PathQuote asked ACT! to create the contact on each and never heard whether it did — somebody has to look in ACT! before they can go on, so ask your developer, and do not delete or re-add those contacts in PathQuote.`,
      );
    }

    const listed = Math.min(outbox.held, outbox.heldQuotes.length);
    notes.push(
      one
        ? "It is listed below with the reason PathQuote gives for holding it."
        : listed < outbox.held
          ? `The ${formatCount(listed)} queued longest are listed below, each with the reason PathQuote gives for holding it.`
          : "Each is listed below with the reason PathQuote gives for holding it.",
    );
    if (outbox.oldestHeldQueuedAt) {
      notes.push(
        `${one ? "It" : "The oldest"} was queued for ACT! ${relativeTime(outbox.oldestHeldQueuedAt, now)}.`,
      );
    }
  }

  if (outbox.waiting > 0) {
    const one = outbox.waiting === 1;
    // With nothing held the headline has already given the count, so the
    // sentence carries only what follows from it.
    const count =
      outbox.held > 0
        ? `${plural(outbox.waiting, "other quote is", "other quotes are")} waiting to go to ACT!`
        : null;
    if (!outbox.sendingOn) {
      notes.push(
        count
          ? `${count}, but sending to ACT! is switched off — ${one ? "it goes" : "they go"} as soon as it is switched on.`
          : `Sending to ACT! is switched off — ${one ? "it goes" : "they go"} as soon as it is switched on.`,
      );
    } else {
      notes.push(
        count
          ? `${count}, and ${one ? "goes" : "go"} on ${one ? "its" : "their"} own — PathQuote sends queued quotes every 15 minutes.`
          : `${one ? "It goes" : "They go"} on ${one ? "its" : "their"} own — PathQuote sends queued quotes every 15 minutes.`,
      );
      if (outbox.retrying > 0) {
        notes.push(
          `${outbox.retrying === outbox.waiting ? (one ? "It has" : outbox.waiting === 2 ? "Both have" : "All of them have") : `${formatCount(outbox.retrying)} of them ${outbox.retrying === 1 ? "has" : "have"}`} failed to get through at least once — PathQuote keeps trying, waiting longer each time.`,
        );
      }
    }
  }

  if (outbox.held === 0 && outbox.waiting === 0 && !outbox.sendingOn) {
    // The state the write-back ships in: nothing queued yet, and sending off
    // on purpose. Said without amber, and said, because the reader's next
    // question -- will a quote finalised now reach ACT!? -- has an answer.
    notes.push(
      "Sending to ACT! is switched off. Quotes finalised, signed or accepted while it is off wait here, and go once it is switched on.",
    );
  }

  const headline =
    outbox.held > 0
      ? `${plural(outbox.held, "quote is", "quotes are")} held back from ACT!`
      : outbox.waiting > 0
        ? `${plural(outbox.waiting, "quote is", "quotes are")} waiting to go to ACT!`
        : "Nothing waiting to go to ACT!";

  const held = outbox.heldQuotes.slice(0, HELD_QUOTES_LISTED).map((quote) => ({
    label: quote.number ?? "A quote with no number",
    href: `/quotes/${quote.documentId}`,
    reason: quote.reason,
  }));
  const unlisted = outbox.held - held.length;

  return {
    tone: outbox.held > 0 ? "warn" : "ok",
    headline,
    detail: notes.length > 0 ? notes.join(" ") : null,
    held,
    more: unlisted > 0 ? `and ${plural(unlisted, "more quote", "more quotes")}` : null,
    scope,
  };
}

/**
 * The whole section, from one read of the status.
 *
 * `now` is a parameter so every state can be driven and printed without a clock
 * or a browser; the page passes `new Date()`.
 */
export function describeActSyncStatus(status: ActSyncStatus, now: Date = new Date()): ActSyncView {
  const { lastRun, lastRunUnreadable, running, cursor, outbox } = status;

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
    summary: summaryFor(lastRun, lastRunUnreadable, running, cursor),
    outbox: describeOutbox(outbox, now),
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
      // Scoped to a sync that started, because this branch is reached by more
      // than the timeout it was written for. A node restart mid-request (502)
      // and a stale action id after a deploy (`E715`, the `x-action-redirect`
      // and content-type checks in Next's server-action-reducer) both land
      // here with no sync running at all -- the second with no sync ever having
      // been started. "The sync does not stop when that happens" is a promise
      // about a run that may not exist; that giving up waiting is not what
      // stops one is true in every case. The advice after it is conditioned on
      // what the reload actually says, so it routes all three correctly.
      message:
        "PathQuote gave up waiting for an answer, so it cannot say how the sync went — and giving up waiting does not stop a sync that had already started. Reload this page: if it says Running now, leave it alone and it will finish on its own.",
    };
  }

  // `error` before `warning`: a real failure is the thing to show, and nothing
  // in runActSyncNow returns both.
  if (settled.result.error) return { outcome: "failed", message: settled.result.error };
  if (settled.result.warning) return { outcome: "note", message: settled.result.warning };
  // Ends at "finished", and deliberately does not say PathQuote is now up to
  // date with ACT!. A clean run does not earn that: contacts whose company has
  // no usable name are counted as skipped, the stored position moves past them
  // anyway (see `newestEdited` being set before the `companyUsable` test in
  // src/lib/act/sync.ts), and the skipped counts are not in the stored record
  // or anywhere on this page -- only in the CLI's own output. So a run can
  // finish clean having left contacts behind, and the toast must not promise
  // otherwise. What changed is in the section beneath, which has the counts.
  return { outcome: "done", message: "Sync finished." };
}
