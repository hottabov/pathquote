// What the Settings page needs to say about the ACT! sync: the last run, and
// whether one is going on right now.
//
// The I/O half only. Every judgement -- is this stored record usable, what do
// these counters mean in words -- lives in src/lib/act/run-record.ts, where it
// is unit-tested without a database.

import { db } from "@/lib/db";
import { LAST_RUN_KEY, parseStoredRun, type ActSyncRun } from "@/lib/act/run-record";
import { isSyncRunning, readCursor } from "@/lib/act/sync";

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
};

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
 * The cursor read is last because it is independent of both: it is a different
 * row, nothing pairs it with either answer, and no ordering of it can make the
 * page say something untrue.
 *
 * Not wrapped in React's `cache` like its neighbours in queries/settings.ts.
 * Those are read twice in one render from call sites that cannot see each
 * other. This has one caller -- the Settings section being built next -- so
 * the memo would be a wrapper with nothing to dedupe, and a memo over a
 * question whose answer changes while the page renders ("is a sync running")
 * is not the sort of wrapper to add for symmetry.
 */
export async function getActSyncStatus(): Promise<ActSyncStatus> {
  const running = await isSyncRunning();
  const row = await db.setting.findUnique({ where: { key: LAST_RUN_KEY } });
  const cursor = await readCursor();

  const lastRun = row ? parseStoredRun(row.value) : null;

  return {
    lastRun,
    lastRunUnreadable: row !== null && lastRun === null,
    running,
    cursor,
  };
}
