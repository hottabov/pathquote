// What the Settings page needs to say about the ACT! sync: the last run,
// whether one is going on right now, and the quotes queued for ACT! as they
// stand.
//
// The I/O half only. Every judgement -- is this stored record usable, what do
// these counters mean in words -- lives in src/lib/act/run-record.ts and
// src/lib/act/sync-view.ts, where it is unit-tested without a database.

import { db } from "@/lib/db";
import { readActWriteSwitch } from "@/lib/act/drain";
import { BLOCKED_BY } from "@/lib/act/drain-rules";
import { LAST_RUN_KEY, parseStoredRun, type ActSyncRun } from "@/lib/act/run-record";
import { isSyncRunning, readCursor } from "@/lib/act/sync";
import { HELD_QUOTES_LISTED } from "@/lib/act/sync-view";
import { isAdminRole } from "@/lib/roles";
import { documentWhereForUser, type ScopeUser } from "@/lib/scope";

/**
 * The ActOutbox as it stands, for the section about the queue
 * (describeOutbox in src/lib/act/sync-view.ts): not what one drain pass did,
 * but what is unfinished now, whichever pass last touched it.
 *
 * Every count and the list cover the same quotes: those the reader can open
 * (`scope`, and getActSyncStatus says why).
 */
export type ActOutboxStanding = {
  /**
   * `all` for an admin or developer, whose quotes are every quote; `yours`
   * for a manager with the ACT! sync tick, who is counted only the quotes
   * documentWhereForUser (src/lib/scope.ts) lets them open -- their own, or
   * their region's.
   */
  scope: "all" | "yours";
  /** Whether sending to ACT! is switched on (src/lib/act/write-switch.ts). */
  sendingOn: boolean;
  /** Unfinished rows with a blockedReason: held back until somebody acts. */
  held: number;
  /**
   * Of `held`, the rows held for their contact (blockedBy
   * BLOCKED_BY.contact): PathQuote asked ACT! to create the quote's contact
   * and never learned whether it did. The row's blocker rather than
   * Contact.actCreateInFlightAt, because the marker is also set for the
   * second or so of every contact create that goes well, and stands on the
   * contact of a quote that is not blocked yet -- one due, not yet worked.
   * And the blocker rather than blockedReason, which is a sentence for a
   * manager and may be reworded: the planner and the drain store
   * BLOCKED_BY.contact on every such row, whatever it says.
   */
  heldForContact: number;
  /**
   * When the longest-held quote was first queued for ACT!: the oldest
   * ActOutbox.createdAt among the held rows, which a take-over keeps -- so
   * how long the quote has had writes waiting, not when it was blocked,
   * which nothing stores. Null when none is held.
   */
  oldestHeldQueuedAt: Date | null;
  /** The held quotes, longest-queued first, at most HELD_QUOTES_LISTED. */
  heldQuotes: { documentId: string; number: string | null; reason: string }[];
  /** Unfinished rows not blocked: due now, or backing off after a failure. */
  waiting: number;
  /** Of `waiting`, the rows whose last attempt failed (attempts above 0). */
  retrying: number;
};

export type ActSyncStatus = {
  /** The last run, or null when none has been recorded or the record cannot be read. */
  lastRun: ActSyncRun | null;
  /**
   * A record is stored but this version cannot read it (see `parseStoredRun`).
   *
   * Separate from `lastRun: null` because the two are different things to tell
   * a reader. Nothing recorded means the sync has never run; a record that will
   * not parse means it has run and we cannot say how it went, which is a
   * developer's problem rather than the director's. Collapsing them would
   * report "never run" about a sync that runs every night -- wrong, and it
   * looks right.
   */
  lastRunUnreadable: boolean;
  /** Whether a sync holds the advisory lock as this was read. */
  running: boolean;
  /**
   * The stored cursor: the `edited` timestamp the next delta starts from.
   *
   * Here because it is the one number that explains a surprising result.
   * "No changes" on a morning after somebody edited ACT! means the cursor is
   * ahead of their edit; a cursor of null means the next run -- including the
   * one behind the Sync now button -- reads every contact in ACT!, not a
   * delta. Its key and the `{ editedAt }` envelope it is wrapped in are
   * private to sync.ts, so `readCursor` is the only way to ask, and the page
   * cannot find out for itself.
   */
  cursor: Date | null;
  /** The queue as it stands: see ActOutboxStanding. */
  outbox: ActOutboxStanding;
};

/**
 * The queue as it stands, counted over what `user` may open.
 *
 * SCOPED BY documentWhereForUser, the rule every other count of quotes in the
 * app follows (the dashboard's, src/lib/queries/dashboard.ts), and the list
 * and its counts alike. The list is links to the quotes, and a manager sent
 * to a quote outside their scope gets the not-found page -- a broken link.
 * Counting wider than the list would leave a total that disagrees with the
 * rows under it, and the only honest way to explain the gap ("and 2 you
 * cannot open") tells a manager about other regions' quotes. An admin's
 * scope is every quote, so the director -- who needs the whole picture --
 * gets it. Whether sending is switched on is not a fact about any quote, and
 * is the same for everyone.
 *
 * One snapshot: the reads run in one REPEATABLE READ transaction, so the
 * counts and the list cannot disagree because a drain moved a row between
 * two of them.
 */
async function readOutboxStanding(user: ScopeUser): Promise<ActOutboxStanding> {
  const document = documentWhereForUser(user);
  const unfinished = { completedAt: null, document };
  const held = { ...unfinished, blockedReason: { not: null } };
  const waiting = { ...unfinished, blockedReason: null };

  const [heldCount, heldForContact, heldQuotes, waitingCount, retrying] = await db.$transaction(
    [
      db.actOutbox.count({ where: held }),
      db.actOutbox.count({ where: { ...held, blockedBy: BLOCKED_BY.contact } }),
      db.actOutbox.findMany({
        where: held,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: HELD_QUOTES_LISTED,
        select: { documentId: true, blockedReason: true, createdAt: true, document: { select: { number: true } } },
      }),
      db.actOutbox.count({ where: waiting }),
      db.actOutbox.count({ where: { ...waiting, attempts: { gt: 0 } } }),
    ],
    { isolationLevel: "RepeatableRead" },
  );

  return {
    scope: isAdminRole(user.role) ? "all" : "yours",
    sendingOn: await readActWriteSwitch(),
    held: heldCount,
    heldForContact,
    oldestHeldQueuedAt: heldQuotes[0]?.createdAt ?? null,
    heldQuotes: heldQuotes.map((row) => ({
      documentId: row.documentId,
      number: row.document.number,
      // Never null: the query asked for rows where it is not.
      reason: row.blockedReason ?? "",
    })),
    waiting: waitingCount,
    retrying,
  };
}

/**
 * Everything the Settings page shows about the sync, in one read.
 *
 * The reads are deliberately sequential and deliberately in THIS order, which
 * is the order isSyncRunning's own doc comment prescribes: ask about the lock
 * first, then read the record. The two cannot be made atomic, and this way
 * round the pair that a run starting or ending in between produces is the
 * alarming kind of wrong -- "Started and never finished" about a sync that is
 * working, corrected by the next reload. Record first, lock second gives the
 * silent kind: last night's "No changes", calmly, while a sync is going, with
 * nothing to prompt a reload. See isSyncRunning in src/lib/act/sync.ts for the
 * full argument.
 *
 * So: do not fold these into a `Promise.all`. It would read faster and it
 * would throw the ordering away -- two queries dispatched together have no
 * order at all, which is the record-first case half the time.
 *
 * The cursor read comes after them because it is independent of both: it is a
 * different row, nothing pairs it with either answer, and no ordering of it can
 * make the page say something untrue. The queue (readOutboxStanding) is the same:
 * it is about the rows as they stand, not about any run, and is read last.
 *
 * Not wrapped in React's `cache` like its neighbours in queries/settings.ts.
 * Those are read twice in one render from call sites that cannot see each
 * other. This has one caller -- `ActSyncPage` in
 * src/app/(app)/settings/act-sync/page.tsx, which reads it once -- so the memo
 * would be a wrapper with nothing to dedupe, and a memo over a
 * question whose answer changes while the page renders ("is a sync running")
 * is not the sort of wrapper to add for symmetry.
 */
export async function getActSyncStatus(user: ScopeUser): Promise<ActSyncStatus> {
  const running = await isSyncRunning();
  const row = await db.setting.findUnique({ where: { key: LAST_RUN_KEY } });
  const cursor = await readCursor();
  const outbox = await readOutboxStanding(user);

  const lastRun = row ? parseStoredRun(row.value) : null;

  return {
    lastRun,
    lastRunUnreadable: row !== null && lastRun === null,
    running,
    cursor,
    outbox,
  };
}
