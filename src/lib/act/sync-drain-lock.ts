// How an inbound sync takes the drain's lock, decided apart from the database
// so the decision can be tested without one (tests/act-sync-drain-lock.test.ts).
// syncContacts in src/lib/act/sync.ts carries it out.
//
// Pure: no database, no Prisma. The lock itself, the waiting and the record
// are sync.ts's; what is here is which of three things a run does, the
// sentence the Sync now button shows when the lock is taken, and how long the
// button's own drain may work.

/**
 * How a run that already holds the sync's lock (SYNC_LOCK_KEY in
 * src/lib/act/sync.ts) takes the drain's (DRAIN_LOCK_KEY in
 * src/lib/act/drain.ts):
 *
 *   none  a dry run. It sends nothing, by definition, and stores nothing, so
 *         there is no import for another drain's contact create to duplicate
 *         -- the race the lock closes needs the read to write.
 *   try   the Sync now button. Asked for once, with pg_try_advisory_lock,
 *         BEFORE the run writes its start record, and a drain already going
 *         ends the run there with DrainBusyError: nothing read, nothing
 *         recorded, the stored record left as it was -- the rule a run that
 *         loses the race for the sync's own lock follows. Waiting is not an
 *         option for a button: nginx stops waiting for the answer after 60
 *         seconds (HOW LONG THIS BLOCKS, on runActSyncNow in
 *         src/lib/actions/act-sync.ts), and another drain can take minutes.
 *   wait  every other run that writes: the nightly one, and a run by hand at
 *         a shell. Waited for, up to DRAIN_LOCK_WAIT_MS, AFTER the start
 *         record, because the night's read must not be skipped for a drain
 *         that will be over in a few minutes, and a run that is waiting
 *         should read on Settings as running.
 */
export type DrainLockApproach = "none" | "try" | "wait";

export function drainLockApproach(options: { dryRun?: boolean; waitForDrainLock: boolean }): DrainLockApproach {
  if (options.dryRun) return "none";
  return options.waitForDrainLock ? "wait" : "try";
}

/**
 * What the Sync now button says when another drain holds the lock: the
 * message of DrainBusyError (src/lib/act/sync.ts), which runActSyncNow returns
 * as `warning` -- the amber note, not the red error: nothing is wrong, and the
 * click changed nothing.
 *
 * "A few minutes" because that is how long the drains that can hold it take:
 * a fast path after a finalise is one quote, seconds; the 15-minute pass stops
 * starting work after DRAIN_TIME_BUDGET_MS, 5 minutes. The 03:00 sync holds it
 * too, but a press then finds the sync's own lock first and gets
 * SyncAlreadyRunningError's sentence instead of this one.
 */
export const DRAIN_BUSY_MESSAGE =
  "Quotes are being sent to ACT! right now, so the sync cannot start yet — try again in a few minutes.";

/**
 * How long the Sync now button's own drain may work before the read: 20
 * seconds, against DRAIN_TIME_BUDGET_MS's 5 minutes for every other pass.
 *
 * nginx gives the whole button 60 seconds. A drain is checked against its
 * budget before each row and each step, so it can run past it by the step in
 * flight -- a few requests, well under a second each when ACT! is well -- and
 * the read comes after it: a night's worth of edits, a page or two, seconds.
 * 20 leaves two thirds of the 60 for those two. A backlog bigger than 20
 * seconds of sending ends the pass `out-of-time`, which the record words as
 * "the rest are sent on their own shortly" -- true, because the 15-minute
 * drain carries on from where it stopped.
 *
 * What it cannot bound is ACT! being slow: one request can take 93 seconds
 * (REQUEST_TIMEOUT_MS and MAX_ATTEMPTS in src/lib/act/client.ts), which is
 * past nginx's 60 whatever the budget, and the read has the same problem
 * without any drain at all. That case is HOW LONG THIS BLOCKS's, not this
 * number's.
 */
export const SYNC_NOW_DRAIN_BUDGET_MS = 20 * 1000;
