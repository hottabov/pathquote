// The ActOutbox drain: the code that writes queued quotes into ACT!, the
// company's production CRM.
//
// What a row means and what each step must do is decided elsewhere, and this
// file only carries it out: the planner (nextStep in
// src/lib/act/outbox-plan.ts, whose header is the contract), the request
// bodies and the decisions made on a fresh read (src/lib/act/write-payloads.ts),
// the client (src/lib/act/client.ts), and the drain's own rules -- backoff,
// what a failure means for the row, the close date, the service account
// (src/lib/act/drain-rules.ts). The requirements on this file are numbered
// in src/lib/act/outbox.ts; each is marked below where it is met.
//
// ONE PASS: take the drain's advisory lock; re-plan the blocked rows; work
// the rows the drain's own checks blocked, then a batch of due rows, oldest
// first; for each, plan a step, do it, store its result, and plan again,
// until the row is done, blocked, or fails. A pass sends nothing while the
// off switch (src/lib/act/write-switch.ts) is off, and stops the moment it is
// turned off (requirement 2). It also stops at the first failure every row
// would meet -- ACT! not answering, answering "not now", refusing the login
// -- and once its time budget (DRAIN_TIME_BUDGET_MS) is spent, leaving the
// rows it did not reach due for the next pass.
//
// Called after a finalise, a client's signature or an acceptance for that
// one quote (`onlyDocumentId`, drainAfterResponse in
// src/lib/act/drain-after.ts) -- today, the only caller. Task 8 adds the
// drains over every row: a periodic one every 15 minutes (a systemd timer in
// the `tools` container), and the nightly sync's, before it reads ACT!.
// Until then the backoff only says when a row may be tried again; what tries
// it is its quote's next event.
//
// A REQUIREMENT ON TASK 8: THE NIGHTLY SYNC HOLDS THE DRAIN'S LOCK TOO, for
// the whole run. Today the inbound sync holds only its own key (8_472_001),
// not DRAIN_LOCK_KEY, so a fast-path contact create near 03:00 can race it:
// ACT! answers the POST, the sync reads the new contact (its `edited` is
// newer than the sync's cursor) and imports it as a new PathQuote Contact
// before the drain has stored the id, and the drain's store then hits
// Contact.actContactId's unique key. Nothing is created twice -- the contact
// keeps its in-flight marker, and every quote on it is blocked with
// UNTRACKED_CONTACT_REASON -- but PathQuote ends up with two contacts for one
// person, for somebody to merge. Not fixed here: Task 8 takes DRAIN_LOCK_KEY
// (as well as its own) for the whole of the nightly run, drain and read
// together, so no fast path can write between them.

import { Prisma, type PrismaClient } from "@prisma/client";
import { createPrismaClient, db } from "@/lib/db";
import {
  ActApiError,
  ActUntrackedCreateError,
  COUNTRIES_PICKLIST_ID,
  createMadeNothing,
  type ActClient,
} from "@/lib/act/client";
import {
  CREATE_IN_FLIGHT,
  UNTRACKED_CONTACT_REASON,
  duplicateOpportunitiesReason,
  duplicateProductLinesReason,
  nextStep,
  type OutboxStep,
  type QuoteState,
} from "@/lib/act/outbox-plan";
import {
  OPPORTUNITY_STATUS,
  contactPromotion,
  historyBody,
  historyLookup,
  historyRegarding,
  newContactBody,
  newOpportunityBody,
  opportunityLookup,
  opportunityName,
  productLineLookup,
  productLineWrite,
  revisedOpportunityBody,
  summaryProductBody,
  summaryProductPatch,
  wonOpportunityBody,
  type ActParties,
  type QuoteForAct,
} from "@/lib/act/write-payloads";
import {
  BLOCKED_BY,
  deniedReason,
  drainFailure,
  lastErrorText,
  nextAttemptAt,
  stopsPass,
  opportunityNow,
  refusedReason,
  replanBlocked,
  retryAfterMs,
  revisionForAct,
  serviceAccountUserId,
  wonCloseDate,
  type ActStepKind,
} from "@/lib/act/drain-rules";
import { actCountryValue, countryPicklistCoverage } from "@/lib/act/country-picklist";
import { ACT_WRITE_SWITCH_KEY, actWriteEnabled } from "@/lib/act/write-switch";
import { COUNTRIES } from "@/lib/countries";
import type { ActContact, ActPicklistItem } from "@/lib/act/types";

/**
 * The drain's advisory lock key. 8_472_001 is the inbound sync's
 * (SYNC_LOCK_KEY in src/lib/act/sync.ts, whose comment says a second feature
 * takes a different number and writes it down beside it -- it is written down
 * there too). The next number, so the two read as a pair in pg_locks.
 *
 * A key of its own, not the sync's: the two do different work, and Task 8
 * runs the drain inside a sync, which already holds 8_472_001 -- on another
 * connection, so the sync's own key would refuse it. What this lock keeps
 * apart is two drains: the nightly one and a fast path after a finalise, or
 * two fast paths. Two at once could both find a row due, both look a record
 * up, find nothing, and both create it.
 */
export const DRAIN_LOCK_KEY = 8_472_002;

/** How many due rows one pass takes on. A backlog drains over several passes. */
const BATCH = 50;

/**
 * How long one pass may keep working: 5 minutes. Checked before each row and
 * before each step, so a pass that runs over finishes the step it is in --
 * its result stored -- and stops there, leaving the rest due for the next.
 *
 * Why 5 minutes. While a pass runs it holds DRAIN_LOCK_KEY and a database
 * connection, every fast path after a finalise, signature or acceptance finds
 * the lock busy and leaves its row for the next pass, and -- once Task 8
 * drains before the nightly inbound read -- that read waits for it. Task 8's
 * periodic drain is to run every 15 minutes, so 5 is a third of that: a pass
 * is over long before the next one is due, and a backlog drains 5 minutes in
 * every 15 rather than in one sitting. A healthy step is a few requests of
 * well under a second each, so 5 minutes is dozens of rows; a hung ACT! stops
 * the pass at its first unanswered request (`unreachable` in
 * src/lib/act/drain-rules.ts) rather than spending the budget on it. The
 * most a pass can run past it is the step in flight when it ran out.
 */
export const DRAIN_TIME_BUDGET_MS = 5 * 60 * 1000;

/**
 * How many steps one row may take in one pass. The longest plan is seven
 * (create-contact through promote-contact), each adoption by a lookup adds
 * one, and a take-over re-plans from where it left the row; a row
 * still planning after this is not settling -- a store that changes nothing
 * the planner reads -- and is backed off rather than run round forever.
 */
const MAX_STEPS = 20;

export type DrainOptions = {
  /**
   * The time the pass works to: rows due at or before it are taken, and it
   * is the time every store records. Defaults to the clock, read afresh for
   * each store. A JS Date, compared as a parameter: never SQL now(), which
   * lands in these timestamp-without-time-zone columns as the session's
   * local time (EVERY TIMESTAMP IS `now` in src/lib/act/outbox-sql.ts).
   */
  now?: Date;
  /** Only this quote's rows: the fast path after one quote's event. */
  onlyDocumentId?: string;
  /**
   * How long the pass may work, in real time whatever `now` says.
   * DRAIN_TIME_BUDGET_MS unless given; a script or a check may pass less.
   */
  timeBudgetMs?: number;
};

/**
 * What a pass did, for the inbound sync to report (Task 8).
 *
 * `status`: `ran`; `busy`, another drain held the lock and nothing was done;
 * `switched-off`, the switch was off at the start or turned off part way, and
 * nothing more was sent; `stopped`, a fault every row would meet (the
 * service account not found or its lookup failing, the login refused, a 403
 * to the login or the users lookup -- not to one record, which blocks that
 * row), ACT! answering "not now" (a 429 or a 408), or ACT! not answering at
 * all, ended the pass; `out-of-time`, the pass used up its time budget
 * (DRAIN_TIME_BUDGET_MS) and left the rest for the next. `stopReason` says
 * which.
 */
export type DrainResult = {
  status: "ran" | "busy" | "switched-off" | "stopped" | "out-of-time";
  /** Rows the planner reported done, and marked finished. */
  rowsDone: number;
  /** Steps that called ACT! and stored their result. */
  stepsWritten: number;
  /** Rows blocked this pass, with the sentence a manager reads. */
  blocked: { documentId: string; reason: string }[];
  /** Rows that failed and will be tried again, with what was stored as lastError. */
  failed: { documentId: string; error: string }[];
  /** Creates whose answer was lost, so PathQuote may not know a record it made. */
  untracked: number;
  /**
   * Blocked rows made due again: the planner's, once it no longer blocks
   * them, and the drain's own checks', reopened to be worked again.
   */
  unblocked: number;
  /**
   * Due rows not tried because the switch was off: all of them when it was
   * off at the start; when it was turned off part way, the rows the pass had
   * not yet begun -- not the one it was working, which may be partly written.
   */
  skippedSwitchOff: number;
  stopReason: string | null;
};

function emptyResult(): DrainResult {
  return {
    status: "ran",
    rowsDone: 0,
    stepsWritten: 0,
    blocked: [],
    failed: [],
    untracked: 0,
    unblocked: 0,
    skippedSwitchOff: 0,
    stopReason: null,
  };
}

/** Whether the off switch is on now: the Setting row, read afresh. */
export async function readActWriteSwitch(): Promise<boolean> {
  return actWriteEnabled(await db.setting.findUnique({ where: { key: ACT_WRITE_SWITCH_KEY } }));
}

/**
 * Ends the pass, and says how (DrainResult's status): the switch went off, a
 * fault every row would meet, or the time budget ran out. `failed`, when
 * set, is the ACT! failure behind it, which the row being worked backs off
 * for; without it the row is left as it is, still due.
 */
class StopPass extends Error {
  constructor(
    readonly status: "switched-off" | "stopped" | "out-of-time",
    message: string,
    readonly failed?: unknown,
  ) {
    super(message);
    this.name = "StopPass";
  }
}

/**
 * Blocks the row being worked, with a sentence for its manager, and who
 * blocked it (ActOutbox.blockedBy): null when the planner will block it from
 * now on too, BLOCKED_BY.drain for the drain's own checks. Never about ACT!
 * having refused anything: that is handled where the failure is. `failed`,
 * when set, is the ACT! failure behind the block; once the row is blocked,
 * the pass stops if that failure stops a pass (stopsPass).
 */
class BlockRow extends Error {
  constructor(
    readonly reason: string,
    readonly by: typeof BLOCKED_BY.drain | null,
    readonly failed?: unknown,
  ) {
    super(reason);
    this.name = "BlockRow";
  }
}

/**
 * A connection of the drain's own for its advisory lock, exactly as the sync
 * opens one and for the same reasons (openLockConnection in
 * src/lib/act/sync.ts): a session lock belongs to its connection, `db` is a
 * pool that hands a connection back after every query and reaps idle ones,
 * and closing this one -- `$disconnect()` -- is the only release, so a
 * killed drain releases it too.
 */
function openDrainLock(): PrismaClient {
  return createPrismaClient(
    { max: 1, idleTimeoutMillis: 0, keepAlive: true },
    {
      onPoolError: (error) => {
        console.error(
          "act: the drain's lock connection failed; the advisory lock is gone and another drain could start alongside this one",
          error,
        );
      },
    },
  );
}

/** The rows a pass may take: unfinished, not blocked, due by `now`. */
function dueWhere(now: Date, onlyDocumentId: string | undefined): Prisma.ActOutboxWhereInput {
  return {
    completedAt: null,
    blockedReason: null,
    nextAttemptAt: { lte: now },
    ...(onlyDocumentId ? { documentId: onlyDocumentId } : {}),
  };
}

/**
 * Write unfinished rows into ACT!. Never throws for a row's own failure --
 * that is stored on the row -- only when the database itself fails.
 */
export async function drainActOutbox(client: ActClient, options: DrainOptions = {}): Promise<DrainResult> {
  const result = emptyResult();
  const clock = () => options.now ?? new Date();

  // Off: nothing is sent, and nothing about any row changes.
  if (!(await readActWriteSwitch())) {
    result.status = "switched-off";
    result.skippedSwitchOff = await db.actOutbox.count({ where: dueWhere(clock(), options.onlyDocumentId) });
    return result;
  }

  const lock = openDrainLock();
  try {
    // Non-blocking, as the sync's: a fast path that finds another drain at
    // work leaves its row for the next pass rather than wait.
    const [{ locked }] = await lock.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${DRAIN_LOCK_KEY}) AS locked
    `;
    if (!locked) {
      result.status = "busy";
      return result;
    }

    const pass = new Pass(client, result, clock, Date.now() + (options.timeBudgetMs ?? DRAIN_TIME_BUDGET_MS));
    // The rows the drain's own checks blocked go first, each reopened only
    // as it is worked (Pass.recheck); then the due rows, up to BATCH in all.
    const rechecks = (await pass.replanBlocked(options.onlyDocumentId)).slice(0, BATCH);
    const due = await db.actOutbox.findMany({
      where: dueWhere(clock(), options.onlyDocumentId),
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
      take: BATCH - rechecks.length,
      select: { id: true },
    });
    const work = [...rechecks.map((id) => ({ id, recheck: true })), ...due.map(({ id }) => ({ id, recheck: false }))];
    for (let i = 0; i < work.length; i++) {
      try {
        pass.checkTime();
        if (work[i].recheck && !(await pass.recheck(work[i].id))) continue;
        await pass.drainRow(work[i].id);
      } catch (error) {
        if (!(error instanceof StopPass)) throw error;
        result.status = error.status;
        result.stopReason = error.message;
        // Row i was begun when the switch went off, so it is not "not tried".
        if (error.status === "switched-off") result.skippedSwitchOff = work.length - i - 1;
        console.warn(`act: drain pass stopped: ${error.message}`);
        break;
      }
    }

    if (result.stepsWritten > 0 || result.blocked.length > 0 || result.failed.length > 0 || result.status !== "ran") {
      console.info("act: drain pass", {
        status: result.status,
        rowsDone: result.rowsDone,
        stepsWritten: result.stepsWritten,
        blocked: result.blocked.length,
        failed: result.failed.length,
        untracked: result.untracked,
        unblocked: result.unblocked,
      });
    }
    return result;
  } finally {
    // The release: see openDrainLock.
    await lock.$disconnect().catch((error: unknown) => {
      console.error("act: drain lock not released; held until this connection dies", error);
    });
  }
}

/** Everything the planner and the bodies need of one row, read together, afresh before every step. */
const ROW_SELECT = {
  id: true,
  documentId: true,
  generation: true,
  opportunityActId: true,
  productLineSkippedAt: true,
  createInFlight: true,
  attempts: true,
  completedAt: true,
  blockedReason: true,
  blockedBy: true,
  quoteRevision: {
    select: { id: true, revision: true, total: true, snapshot: true, createdAt: true, actHistoryId: true },
  },
  document: {
    select: {
      id: true,
      number: true,
      signingStatus: true,
      acceptedAt: true,
      completedAt: true,
      actOpportunityId: true,
      actProductLineId: true,
      actProductLineRevision: true,
      actContactPromotedForId: true,
      actOpportunityWonAt: true,
      region: { select: { code: true } },
      author: { select: { actUserId: true, actAccountMgr: true } },
      company: { select: { actCompanyId: true } },
      contact: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          position: true,
          actContactId: true,
          actCreateInFlightAt: true,
          company: { select: { name: true, country: true } },
        },
      },
    },
  },
} satisfies Prisma.ActOutboxSelect;

type Row = Prisma.ActOutboxGetPayload<{ select: typeof ROW_SELECT }>;

function loadRow(id: string): Promise<Row | null> {
  return db.actOutbox.findUnique({ where: { id }, select: ROW_SELECT });
}

function quoteStateOf(row: Row): QuoteState {
  const doc = row.document;
  return {
    regionCode: doc.region.code,
    contact: doc.contact
      ? {
          actContactId: doc.contact.actContactId,
          actCreateInFlightAt: doc.contact.actCreateInFlightAt,
          firstName: doc.contact.firstName,
          lastName: doc.contact.lastName,
        }
      : null,
    actOpportunityId: doc.actOpportunityId,
    actProductLineId: doc.actProductLineId,
    actProductLineRevision: doc.actProductLineRevision,
    signingStatus: doc.signingStatus,
    acceptedAt: doc.acceptedAt,
    actContactPromotedForId: doc.actContactPromotedForId,
    actOpportunityWonAt: doc.actOpportunityWonAt,
  };
}

function plan(row: Row): OutboxStep {
  return nextStep(
    {
      opportunityActId: row.opportunityActId,
      productLineSkippedAt: row.productLineSkippedAt,
      createInFlight: row.createInFlight,
    },
    { revision: row.quoteRevision.revision, actHistoryId: row.quoteRevision.actHistoryId },
    quoteStateOf(row),
  );
}

/**
 * The step stored its result; or `stale`: what it was planned on had changed
 * -- the row taken over, or the contact given an id or a marker since it was
 * read -- so it stored nothing, and the row is planned again.
 */
type StepOutcome = "stored" | "stale";

/** ACT!'s `edited` as a Date, or null when it is missing or unreadable. */
function editedAt(record: { edited?: unknown }): Date | null {
  if (typeof record.edited !== "string") return null;
  const time = new Date(record.edited);
  return Number.isNaN(time.getTime()) ? null : time;
}

/**
 * One pass's state: the client, the counts, and what is read from ACT! once
 * a pass -- the service account's id and the Countries picklist.
 */
class Pass {
  private serviceAccountId: string | null = null;
  private countryItems: readonly ActPicklistItem[] | null = null;

  constructor(
    private readonly client: ActClient,
    private readonly result: DrainResult,
    private readonly clock: () => Date,
    /** When the pass's time budget runs out, as Date.now() reads it. */
    private readonly deadline: number,
  ) {}

  /** Stop the pass once its time budget is spent (DRAIN_TIME_BUDGET_MS). */
  checkTime(): void {
    if (Date.now() >= this.deadline) {
      throw new StopPass(
        "out-of-time",
        "the pass used up its time budget; the rows not reached wait for the next pass",
      );
    }
  }

  // --- the row ---------------------------------------------------------------

  /**
   * Store on the row, guarded as requirement 1 says: only if the row is still
   * the generation that was read and unfinished. False when no row was
   * updated -- the row was taken over, and the caller drops its plan and reads
   * the row again. Every store on the row goes through here but clearing
   * createInFlight (clearMarker), and two that are the same guard inside a
   * transaction: the opportunity create's (storeOpportunityCreated) and the
   * one before a contact POST (setContactMarker).
   *
   * Requirement 3: no store holds a lock on the row across a call into ACT!.
   * Each is one statement or one short transaction, committed before the
   * next call into ACT! is made; no SELECT ... FOR UPDATE, no transaction
   * left open while ACT! works.
   */
  private async storeRow(row: Row, data: Prisma.ActOutboxUpdateManyMutationInput): Promise<boolean> {
    const { count } = await db.actOutbox.updateMany({
      where: { id: row.id, generation: row.generation, completedAt: null },
      data,
    });
    if (count === 0) console.info("act: outbox row taken over while the drain worked it; planning it again", { id: row.id });
    return count === 1;
  }

  /**
   * Clear the row's createInFlight, in the same transaction as the store of
   * the record's id or alone after a create that made nothing. NOT guarded by
   * generation (requirement 1's one exception): a take-over keeps the marker,
   * so it is still the one this drain set. Guarded by its value instead, so it
   * clears only the marker this step set.
   */
  private clearMarker(row: Row, marker: string) {
    return db.actOutbox.updateMany({
      where: { id: row.id, completedAt: null, createInFlight: marker },
      data: { createInFlight: null },
    });
  }

  /**
   * Re-plan every blocked row, as replanBlocked in src/lib/act/drain-rules.ts
   * decides from who blocked it. No ACT! calls. The fixes a planner's reason
   * asks for -- name a contact, map a region -- take no re-finalise, so
   * without this a fixed cause would leave the row stranded: such a row has
   * its blockedReason cleared and is made due. A row ACT! refused is left
   * alone: the same request would be refused again, and only a take-over or
   * a person sends it again. A row the drain's own check blocked (a lookup's
   * duplicates, a revision it cannot describe) is returned, to be worked
   * again first this pass, its reason kept until then: still blocked while
   * the cause stands, on its way once a person has dealt with it. A row
   * nextStep blocks for a different reason now has that reason stored
   * instead, as the planner's.
   */
  async replanBlocked(onlyDocumentId: string | undefined): Promise<string[]> {
    const blocked = await db.actOutbox.findMany({
      where: { completedAt: null, blockedReason: { not: null }, ...(onlyDocumentId ? { documentId: onlyDocumentId } : {}) },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const rechecks: string[] = [];
    for (const { id } of blocked) {
      const row = await loadRow(id);
      if (!row || row.completedAt || !row.blockedReason) continue;
      const decision = replanBlocked({ blockedReason: row.blockedReason, blockedBy: row.blockedBy }, plan(row));
      switch (decision.kind) {
        case "keep":
          break;
        case "reblock":
          await this.storeRow(row, { blockedReason: decision.reason, blockedBy: null });
          break;
        case "unblock":
          if (await this.storeRow(row, { blockedReason: null, blockedBy: null, nextAttemptAt: this.clock() })) {
            this.result.unblocked += 1;
          }
          break;
        case "recheck":
          rechecks.push(id);
          break;
      }
    }
    return rechecks;
  }

  /**
   * Reopen a row the drain's own check blocked, immediately before it is
   * worked again: its reason cleared, guarded like every store. False when
   * the row has changed since the re-plan (taken over, finished), and is not
   * worked as a recheck.
   */
  async recheck(id: string): Promise<boolean> {
    const row = await loadRow(id);
    if (!row || row.completedAt || row.blockedBy !== BLOCKED_BY.drain) return false;
    if (!(await this.storeRow(row, { blockedReason: null, blockedBy: null }))) return false;
    this.result.unblocked += 1;
    return true;
  }

  /** Plan, do, store, repeat, until the row is done, blocked or failing. */
  async drainRow(id: string): Promise<void> {
    let last: Row | null = null;
    let lastKind: ActStepKind | null = null;
    for (let steps = 0; steps < MAX_STEPS; steps++) {
      const row = await loadRow(id);
      // Gone (its quote deleted), finished, or blocked since it was picked.
      if (!row || row.completedAt || row.blockedReason) return;
      last = row;
      const step = plan(row);

      if (step.kind === "done") {
        if (await this.storeRow(row, { completedAt: this.clock() })) {
          this.result.rowsDone += 1;
          return;
        }
        continue;
      }
      if (step.kind === "blocked") {
        if (await this.block(row, step.reason, null)) return;
        continue;
      }

      // Out of time: the step before this one is stored; this one is not
      // begun, and the row stays due for the next pass.
      this.checkTime();
      lastKind = step.kind;
      let outcome: StepOutcome;
      try {
        outcome = await this.execute(row, step);
      } catch (error) {
        // The switch, or the service account: not this row's fault. The row
        // backs off for the ACT! failure behind the stop, if there was one,
        // and is otherwise left as it is, still due, for the next pass.
        if (error instanceof StopPass) {
          if (error.failed !== undefined) await this.backOff(row, step.kind, error.failed);
          throw error;
        }
        if (error instanceof BlockRow) {
          const blocked = await this.block(row, error.reason, error.by);
          if (error.failed !== undefined && stopsPass(drainFailure(error.failed))) {
            throw new StopPass("stopped", lastErrorText(step.kind, error.failed));
          }
          if (blocked) return;
          continue;
        }
        const failure = drainFailure(error);
        if ((failure === "refused" || failure === "denied") && error instanceof ActApiError) {
          // Held: the drain's pass over blocked rows leaves it for a
          // take-over or a person (BLOCKED_BY.act). A 403 here is this
          // record's, so the pass goes on to the next row.
          console.warn(`act: ACT! ${failure} ${step.kind}`, { id: row.id, status: error.status, body: error.body.slice(0, 500) });
          const reason =
            failure === "denied"
              ? deniedReason(step.kind, error.method, error.body)
              : refusedReason(step.kind, error.status, error.body);
          if (await this.block(row, reason, BLOCKED_BY.act)) return;
          continue;
        }
        if (error instanceof ActUntrackedCreateError) this.result.untracked += 1;
        const stored = await this.backOff(row, step.kind, error);
        if (stopsPass(failure)) throw new StopPass("stopped", lastErrorText(step.kind, error));
        if (stored) return;
        continue;
      }
      if (outcome === "stored") this.result.stepsWritten += 1;
    }
    // Still planning: something stored changes nothing the planner reads.
    if (last && lastKind) {
      await this.backOff(last, lastKind, new Error(`the plan did not settle after ${MAX_STEPS} steps`));
    }
  }

  /** Block the row: its reason, and who blocked it (ActOutbox.blockedBy; null for the planner). */
  private async block(row: Row, reason: string, by: string | null): Promise<boolean> {
    if (!(await this.storeRow(row, { blockedReason: reason, blockedBy: by }))) return false;
    this.result.blocked.push({ documentId: row.documentId, reason });
    console.warn("act: outbox row blocked", { id: row.id, documentId: row.documentId, reason });
    return true;
  }

  /**
   * attempts + 1, lastError, and the next attempt by the backoff -- no sooner
   * than an answer's Retry-After asked, when it carried one (a 429 or a 408,
   * above all).
   */
  private async backOff(row: Row, kind: ActStepKind, error: unknown): Promise<boolean> {
    const attempts = row.attempts + 1;
    const lastError = lastErrorText(kind, error);
    const now = this.clock();
    const floor = error instanceof ActApiError ? retryAfterMs(error.retryAfter, now) : null;
    console.warn(`act: ${kind} failed; backing off`, { id: row.id, attempts, error });
    const stored = await this.storeRow(row, {
      attempts,
      lastError,
      nextAttemptAt: nextAttemptAt(now, attempts, floor),
    });
    if (stored) this.result.failed.push({ documentId: row.documentId, error: lastError });
    return stored;
  }

  // --- what is read once a pass ----------------------------------------------

  /**
   * Requirement 2: the switch, read immediately before each call into ACT!.
   * Off ends the pass. Nothing has been sent for the call this guards, and
   * every create sets its createInFlight marker after this, so a pass
   * stopped here leaves no marker for a POST that never left.
   */
  private async beforeCall(): Promise<void> {
    if (!(await readActWriteSwitch())) {
      throw new StopPass("switched-off", "the ACT! write switch was turned off part way through the pass, so nothing more was sent");
    }
  }

  /**
   * The service account's ACT! user id, looked up once a pass; a pass that
   * cannot find it stops. So does a lookup that FAILS, however it fails: it
   * is not cached on failure, so going on would ask again for every row that
   * needs it -- each time waiting out the same timeouts, or meeting the same
   * answer. A 403 to it is the service account's own access, not any one
   * record's. The row being worked backs off for the failure (StopPass's
   * `failed`); the rest are left for the next pass.
   */
  private async serviceAccount(): Promise<string> {
    if (this.serviceAccountId) return this.serviceAccountId;
    await this.beforeCall();
    let users: Awaited<ReturnType<ActClient["users"]>>;
    try {
      users = await this.client.users();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new StopPass(
        "stopped",
        error instanceof ActApiError && error.status === 403
          ? `ACT! answered 403 to the users lookup, so PathQuote's login "${this.client.loginName}" (ACT_USER) is not allowed to read ACT!'s users -- check its licence and permissions`
          : `the lookup of ACT!'s users failed, and the service account cannot be known without it: ${message}`,
        error,
      );
    }
    const id = serviceAccountUserId(users, this.client.loginName);
    if (!id) {
      throw new StopPass(
        "stopped",
        `no ACT! user, or more than one, has the login "${this.client.loginName}" (ACT_USER), so there is no record manager for a quote whose author has no ACT! user -- check ACT_USER against ACT!'s users`,
      );
    }
    this.serviceAccountId = id;
    return id;
  }

  /**
   * The Countries picklist, read once a pass. A list ACT! will not hand over
   * (refused or denied on both paths picklistItems tries) is no reason to
   * hold back every contact: the pass goes on with no items, so no country
   * is sent, and ACT!'s answer to a create without one is what decides. A
   * failure that may pass (a 5xx, no answer, a 429) fails the step, and the
   * row backs off; a 401 or a redirect stops the pass, as anywhere.
   */
  private async countries(): Promise<readonly ActPicklistItem[]> {
    if (this.countryItems) return this.countryItems;
    await this.beforeCall();
    let items: ActPicklistItem[];
    try {
      items = await this.client.picklistItems(COUNTRIES_PICKLIST_ID);
    } catch (error) {
      const failure = drainFailure(error);
      if (failure !== "refused" && failure !== "denied") throw error;
      console.warn("act: ACT! refused the Countries picklist; contacts are created with no country this pass", error);
      items = [];
    }
    const coverage = countryPicklistCoverage(
      COUNTRIES.map((country) => country.code),
      items,
    );
    console.info(
      `act: the Countries picklist has ${items.length} items; ${coverage.mapped} of ${COUNTRIES.length} ISO countries match one`,
      coverage.missing.length > 0 ? `none for: ${coverage.missing.join(" ")}` : "",
    );
    this.countryItems = items;
    return items;
  }

  // --- the steps -------------------------------------------------------------

  private execute(row: Row, step: Exclude<OutboxStep, { kind: "done" } | { kind: "blocked" }>): Promise<StepOutcome> {
    switch (step.kind) {
      case "create-contact":
        return this.createContact(row);
      case "create-opportunity":
        return this.createOpportunity(row);
      case "update-opportunity":
        return this.updateOpportunity(row);
      case "write-product-line":
        return this.writeLine(row, step.line, { askFirst: true });
      case "write-accepted-line":
        // Whatever the deal's status: productLineWrite is not asked (THE
        // LINE IS WRITTEN BEFORE THE WIN).
        return this.writeLine(row, step.line, { askFirst: false });
      case "write-history":
        return this.writeHistory(row);
      case "win-opportunity":
        return this.winOpportunity(row);
      case "promote-contact":
        return this.promoteContact(row);
    }
  }

  /** The row's revision as the bodies take it, from the frozen revision; unreadable blocks the row. */
  private quote(row: Row): QuoteForAct {
    const described = revisionForAct({
      number: row.document.number,
      regionCode: row.document.region.code,
      revision: row.quoteRevision.revision,
      total: row.quoteRevision.total,
      snapshot: row.quoteRevision.snapshot,
      createdAt: row.quoteRevision.createdAt,
    });
    if (described.kind === "unreadable") throw new BlockRow(described.reason, BLOCKED_BY.drain);
    return described.quote;
  }

  /** The contact's ACT! id: the planner plans no step that needs one without it. */
  private contactActId(row: Row): string {
    const id = row.document.contact?.actContactId;
    if (!id) throw new Error("the planner planned a step on a contact ACT! does not have");
    return id;
  }

  private opportunityId(row: Row): string {
    const id = row.document.actOpportunityId;
    if (!id) throw new Error("the planner planned a step on an opportunity the quote does not have");
    return id;
  }

  private async parties(row: Row): Promise<ActParties> {
    return {
      contactActId: this.contactActId(row),
      companyActId: row.document.company?.actCompanyId ?? null,
      authorActUserId: row.document.author.actUserId,
      serviceAccountUserId: await this.serviceAccount(),
    };
  }

  /**
   * Set createInFlight before a POST, guarded like every store on the row:
   * false means the row was taken over, and the POST is not sent
   * (requirement 1). Committed on its own, before the POST leaves.
   */
  private setMarker(row: Row, marker: string): Promise<boolean> {
    return this.storeRow(row, { createInFlight: marker });
  }

  /**
   * After a create threw. The marker is cleared only where the header allows
   * (A CREATE IN FLIGHT in src/lib/act/outbox-plan.ts): with an id stored --
   * an ActUntrackedCreateError that names the record it made is stored as if
   * ACT! had answered -- or when the error says the create made nothing
   * (createMadeNothing: not sent, or refused). Any other error leaves the
   * marker set and goes on to the row's failure handling; for an
   * opportunity, a line or a History the next attempt's lookup resolves it.
   */
  private async afterCreateError(
    row: Row,
    marker: string,
    error: unknown,
    storeId: (id: string) => Promise<StepOutcome>,
  ): Promise<StepOutcome> {
    if (error instanceof ActUntrackedCreateError && error.createdId) {
      console.warn(`act: a ${marker} create's answer could not be read back; storing the id ACT! gave`, {
        id: row.id,
        createdId: error.createdId,
      });
      return storeId(error.createdId);
    }
    if (createMadeNothing(error)) await this.clearMarker(row, marker);
    throw error;
  }

  /**
   * create-contact: no lookup (A CREATE IN FLIGHT says why), a POST, and the
   * contact's id and snapshot. The in-flight marker is the Contact's, not the
   * row's (A CONTACT CREATE IN FLIGHT in src/lib/act/outbox-plan.ts):
   *
   *   - set before the POST by setContactMarker, which sends nothing when the
   *     row was taken over or the contact has an id or a marker already;
   *   - cleared in the update that stores actContactId -- an
   *     ActUntrackedCreateError naming the record it made included -- or
   *     when the POST made nothing (createMadeNothing);
   *   - kept on anything else. The planner then blocks create-contact for
   *     every quote on this contact until a person has looked in ACT!, and
   *     this row is blocked now, with the same sentence, rather than when its
   *     backoff runs out.
   */
  private async createContact(row: Row): Promise<StepOutcome> {
    const contact = row.document.contact;
    if (!contact) throw new Error("the planner planned create-contact for a quote with no contact");
    const body = newContactBody(
      {
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        phone: contact.phone,
        position: contact.position,
        companyName: contact.company.name,
        country: actCountryValue(contact.company.country, await this.countries()),
      },
      {
        authorActUserId: row.document.author.actUserId,
        authorActAccountMgr: row.document.author.actAccountMgr,
        serviceAccountUserId: await this.serviceAccount(),
      },
    );

    await this.beforeCall();
    const marker = this.clock();
    if (!(await this.setContactMarker(row, contact.id, marker))) return "stale";
    let created: ActContact;
    try {
      created = await this.client.createContact(body);
    } catch (error) {
      if (error instanceof ActUntrackedCreateError && error.createdId) {
        console.warn("act: a contact create's answer could not be read back; storing the id ACT! gave", {
          id: row.id,
          createdId: error.createdId,
        });
        return this.storeContactCreated(contact.id, error.createdId, null);
      }
      if (createMadeNothing(error)) {
        await this.clearContactMarker(contact.id, marker);
        throw error;
      }
      if (error instanceof ActUntrackedCreateError) {
        // The marker stays; a person has to look in ACT! before any quote on
        // this contact goes on. A POST with no answer at all also stops the
        // pass, once this row is blocked (BlockRow's `failed`).
        this.result.untracked += 1;
        throw new BlockRow(UNTRACKED_CONTACT_REASON, null, error);
      }
      // Not from a request (writeFailureOf's `foreign`): it says nothing about
      // what ACT! did, so the marker stays, and the row's failure handling
      // backs it off; the planner blocks it from then on.
      throw error;
    }
    try {
      return await this.storeContactCreated(contact.id, created.id, created);
    } catch (error) {
      // ACT! made the person and PathQuote could not record it: the marker
      // stays, so no quote creates them again. The id is logged for whoever
      // looks.
      console.error("act: ACT! created a contact whose id PathQuote could not store; the contact stays marked in flight", {
        id: row.id,
        contactId: contact.id,
        actContactId: created.id,
        error,
      });
      throw new BlockRow(UNTRACKED_CONTACT_REASON, null);
    }
  }

  /**
   * Mark the contact's create in flight, before its POST. One transaction:
   * first a write to the row guarded as storeRow's (it sets generation to the
   * value read, so it changes nothing but updatedAt) -- no row updated means
   * taken over, and nothing is sent, as for every create (requirement 1);
   * then the marker, set only while the contact has neither an ACT! id nor a
   * marker. False, and no POST, when either finds otherwise: the next plan
   * reads what changed.
   */
  private async setContactMarker(row: Row, contactId: string, at: Date): Promise<boolean> {
    return db.$transaction(async (tx) => {
      const own = await tx.actOutbox.updateMany({
        where: { id: row.id, generation: row.generation, completedAt: null },
        data: { generation: row.generation },
      });
      if (own.count === 0) {
        console.info("act: outbox row taken over while the drain worked it; planning it again", { id: row.id });
        return false;
      }
      const marked = await tx.contact.updateMany({
        where: { id: contactId, actContactId: null, actCreateInFlightAt: null },
        data: { actCreateInFlightAt: at },
      });
      if (marked.count === 0) {
        console.info("act: the contact has an ACT! id or a create in flight since it was read; planning again", {
          id: row.id,
          contactId,
        });
      }
      return marked.count === 1;
    });
  }

  /** Clear the contact's marker after a POST that made nothing: only the one this step set. */
  private clearContactMarker(contactId: string, at: Date) {
    return db.contact.updateMany({
      where: { id: contactId, actCreateInFlightAt: at },
      data: { actCreateInFlightAt: null },
    });
  }

  /**
   * The created contact's id on the Contact, with the record ACT! returned as
   * its ActSnapshot and its `edited` as actSourceEditedAt -- the two the
   * inbound sync writes for a contact it reads (src/lib/act/sync.ts). A
   * BASELINE, not echo suppression: the create bumps `edited`, the sync's
   * cursor, so the next sync reads this contact again (its filter is `edited
   * ge`), and for a contact PathQuote already holds it rewrites
   * actSourceEditedAt, the snapshot and actAccountMgr and fills empty fields
   * without comparing anything with what is stored -- harmless here, because
   * what it reads back is what the drain sent. What is stored here is what
   * ACT! holds until then, and what a conflict check would compare against;
   * nothing compares against it yet. With no record -- only the id came back
   * -- the snapshot waits for that sync to write it. The contact's in-flight
   * marker is cleared in the same update. Nothing on the row: the step's
   * result is the Contact's.
   */
  private async storeContactCreated(
    contactId: string,
    actContactId: string,
    record: ActContact | null,
  ): Promise<StepOutcome> {
    const edited = record ? editedAt(record) : null;
    const payload = record as unknown as Prisma.InputJsonValue;
    await db.$transaction([
      db.contact.update({
        where: { id: contactId },
        data: {
          actContactId,
          actCreateInFlightAt: null,
          actSyncState: "SYNCED",
          actSyncedAt: new Date(),
          ...(edited ? { actSourceEditedAt: edited } : {}),
        },
      }),
      ...(record
        ? [db.actSnapshot.upsert({ where: { contactId }, create: { contactId, payload }, update: { payload } })]
        : []),
    ]);
    return "stored";
  }

  /** create-opportunity: look it up by its fixed name, adopt one, block on several, else POST. */
  private async createOpportunity(row: Row): Promise<StepOutcome> {
    const quote = this.quote(row);
    const parties = await this.parties(row);
    const name = opportunityName(quote);

    await this.beforeCall();
    const found = opportunityLookup(await this.client.opportunitiesNamed(name, parties.contactActId), quote);
    if (found.kind === "block") throw new BlockRow(duplicateOpportunitiesReason(name, found.count), BLOCKED_BY.drain);
    if (found.kind === "adopt") {
      // Stored alone: the next plan is the update, on a fresh read.
      await db.$transaction([
        db.document.update({ where: { id: row.document.id }, data: { actOpportunityId: found.id } }),
        this.clearMarker(row, CREATE_IN_FLIGHT.opportunity),
      ]);
      return "stored";
    }

    await this.beforeCall();
    if (!(await this.setMarker(row, CREATE_IN_FLIGHT.opportunity))) return "stale";
    let createdId: string;
    try {
      createdId = (await this.client.createOpportunity(newOpportunityBody(quote, parties))).id;
    } catch (error) {
      return this.afterCreateError(row, CREATE_IN_FLIGHT.opportunity, error, (id) => this.storeOpportunityCreated(row, id));
    }
    return this.storeOpportunityCreated(row, createdId);
  }

  /**
   * Document.actOpportunityId and the row's opportunityActId in one
   * transaction, the Document first (requirement 4, and the header's
   * requirement after create-opportunity). The row's store is guarded; if it
   * finds the row taken over it updates nothing, and the Document's id is
   * committed all the same -- without it the next pass would create a second
   * opportunity for the deal.
   */
  private async storeOpportunityCreated(row: Row, id: string): Promise<StepOutcome> {
    const [, own] = await db.$transaction([
      db.document.update({ where: { id: row.document.id }, data: { actOpportunityId: id } }),
      db.actOutbox.updateMany({
        where: { id: row.id, generation: row.generation, completedAt: null },
        data: { opportunityActId: id },
      }),
      this.clearMarker(row, CREATE_IN_FLIGHT.opportunity),
    ]);
    if (own.count === 0) console.info("act: outbox row taken over while its opportunity was created; the id is kept", { id: row.id });
    return "stored";
  }

  /**
   * update-opportunity: decided on the record about to be overwritten
   * (revisedOpportunityBody), which sends nothing to a closed deal. The row's
   * opportunityActId is stored either way, so the row moves on. No snapshot:
   * the inbound sync reads contacts only, never an opportunity, a product
   * line or a History, so PathQuote keeps no baseline of one.
   */
  private async updateOpportunity(row: Row): Promise<StepOutcome> {
    const quote = this.quote(row);
    const id = this.opportunityId(row);
    await this.beforeCall();
    await this.client.updateOpportunity(id, (current) => {
      const update = revisedOpportunityBody(quote, opportunityNow(current));
      if (update.kind === "closed") {
        console.info("act: the deal's opportunity is closed; the revision is journaled and the opportunity left alone", {
          id: row.id,
          status: update.status,
        });
        return null;
      }
      return update.patch;
    });
    return (await this.storeRow(row, { opportunityActId: id })) ? "stored" : "stale";
  }

  /**
   * write-product-line (`askFirst`: the opportunity is read and
   * productLineWrite decides, and a `skip` is stored as the row's
   * productLineSkippedAt) or write-accepted-line (written whatever the
   * status). A create looks the line up by its item number first.
   */
  private async writeLine(row: Row, line: "create" | "update", { askFirst }: { askFirst: boolean }): Promise<StepOutcome> {
    const quote = this.quote(row);
    const opportunityId = this.opportunityId(row);

    if (askFirst) {
      await this.beforeCall();
      const opportunity = await this.client.getOpportunity(opportunityId);
      const decision = productLineWrite(opportunity.status, {
        accepted: row.document.acceptedAt !== null,
        signed: row.document.signingStatus === "SIGNED",
      });
      if (decision.kind === "skip") {
        console.info("act: the deal is not open; its product line is left alone", { id: row.id, status: decision.status });
        return (await this.storeRow(row, { productLineSkippedAt: this.clock() })) ? "stored" : "stale";
      }
    }

    if (line === "update") {
      const lineId = row.document.actProductLineId;
      if (!lineId) throw new Error("the planner planned a line update for a quote with no line");
      await this.beforeCall();
      await this.client.updateProductLine(opportunityId, lineId, () => summaryProductPatch(quote));
      // What the line shows now, written or found already showing it. Not
      // guarded: it is a fact about ACT!'s line, true whatever the row carries.
      await db.document.update({ where: { id: row.document.id }, data: { actProductLineRevision: quote.revision } });
      return "stored";
    }

    await this.beforeCall();
    const found = productLineLookup(await this.client.listProductLines(opportunityId), quote);
    if (found.kind === "block") throw new BlockRow(duplicateProductLinesReason(quote.number, found.count), BLOCKED_BY.drain);
    if (found.kind === "adopt") {
      // The id alone, with no revision: the next plan PATCHes it to this one.
      await db.$transaction([
        db.document.update({ where: { id: row.document.id }, data: { actProductLineId: found.id } }),
        this.clearMarker(row, CREATE_IN_FLIGHT.productLine),
      ]);
      return "stored";
    }

    await this.beforeCall();
    if (!(await this.setMarker(row, CREATE_IN_FLIGHT.productLine))) return "stale";
    let createdId: string;
    try {
      createdId = (await this.client.createProductLine(opportunityId, summaryProductBody(quote))).id;
    } catch (error) {
      return this.afterCreateError(row, CREATE_IN_FLIGHT.productLine, error, (id) =>
        this.storeLineCreated(row, id, quote.revision),
      );
    }
    return this.storeLineCreated(row, createdId, quote.revision);
  }

  /** The line's id and the revision it shows in ONE update of the Document, and the marker cleared with it. */
  private async storeLineCreated(row: Row, id: string, revision: number): Promise<StepOutcome> {
    await db.$transaction([
      db.document.update({
        where: { id: row.document.id },
        data: { actProductLineId: id, actProductLineRevision: revision },
      }),
      this.clearMarker(row, CREATE_IN_FLIGHT.productLine),
    ]);
    return "stored";
  }

  /** write-history: look among the contact's Histories first; adopt the oldest match; else POST. */
  private async writeHistory(row: Row): Promise<StepOutcome> {
    const quote = this.quote(row);
    const parties = await this.parties(row);

    await this.beforeCall();
    const found = historyLookup(await this.client.contactHistories(parties.contactActId, historyRegarding(quote)), quote);
    if (found.kind === "adopt") {
      if (found.matches > 1) {
        console.warn("act: ACT! holds this revision's History more than once; the oldest is adopted and the rest left", {
          id: row.id,
          matches: found.matches,
        });
      }
      return this.storeHistory(row, found.id);
    }

    await this.beforeCall();
    if (!(await this.setMarker(row, CREATE_IN_FLIGHT.history))) return "stale";
    let createdId: string;
    try {
      createdId = (await this.client.createHistory(historyBody(quote, parties, row.document.actOpportunityId))).id;
    } catch (error) {
      return this.afterCreateError(row, CREATE_IN_FLIGHT.history, error, (id) => this.storeHistory(row, id));
    }
    return this.storeHistory(row, createdId);
  }

  /** On the revision the History was written for -- the row's, as read -- with the marker cleared. */
  private async storeHistory(row: Row, id: string): Promise<StepOutcome> {
    await db.$transaction([
      db.quoteRevision.update({ where: { id: row.quoteRevision.id }, data: { actHistoryId: id } }),
      this.clearMarker(row, CREATE_IN_FLIGHT.history),
    ]);
    return "stored";
  }

  /**
   * win-opportunity: Won, decided on the record about to be overwritten
   * (wonOpportunityBody sends nothing to a deal already Won), closed on the
   * later of the acceptance and the signature (wonCloseDate). Then
   * Document.actOpportunityWonAt, which nothing clears.
   */
  private async winOpportunity(row: Row): Promise<StepOutcome> {
    const acceptedAt = row.document.acceptedAt;
    if (!acceptedAt) throw new Error("the planner planned the win for a quote not accepted");
    const id = this.opportunityId(row);
    const closedAt = wonCloseDate(acceptedAt, row.document.completedAt);
    await this.beforeCall();
    await this.client.updateOpportunity(id, (current) => {
      const won = wonOpportunityBody(row.document.region.code, opportunityNow(current), closedAt);
      if (won.kind === "already-won") return null;
      if (won.found !== OPPORTUNITY_STATUS.open) console.info("act: a closed deal is won by its acceptance", { id: row.id, found: won.found });
      return won.patch;
    });
    await db.document.update({ where: { id: row.document.id }, data: { actOpportunityWonAt: this.clock() } });
    return "stored";
  }

  /**
   * promote-contact: Prospect to Customer, decided on the record about to be
   * overwritten (contactPromotion leaves any other status alone). Then
   * Document.actContactPromotedForId -- the ACT! id read and patched -- and,
   * when a PATCH went out, the record read back after it as the contact's
   * ActSnapshot and its `edited` as actSourceEditedAt, the baseline
   * storeContactCreated describes. The Document first, then the Contact.
   */
  private async promoteContact(row: Row): Promise<StepOutcome> {
    const contact = row.document.contact;
    const actContactId = this.contactActId(row);
    await this.beforeCall();
    const updated = await this.client.updateContact(actContactId, (current) => {
      const promotion = contactPromotion(current.idStatus);
      return promotion.kind === "promote" ? promotion.patch : null;
    });
    const edited = updated.written ? editedAt(updated.record) : null;
    const payload = updated.record as unknown as Prisma.InputJsonValue;
    await db.$transaction([
      db.document.update({ where: { id: row.document.id }, data: { actContactPromotedForId: actContactId } }),
      ...(updated.written && contact
        ? [
            db.contact.update({
              where: { id: contact.id },
              data: { actSyncedAt: new Date(), ...(edited ? { actSourceEditedAt: edited } : {}) },
            }),
            db.actSnapshot.upsert({
              where: { contactId: contact.id },
              create: { contactId: contact.id, payload },
              update: { payload },
            }),
          ]
        : []),
    ]);
    return "stored";
  }
}
