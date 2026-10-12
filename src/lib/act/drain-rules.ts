// The decisions the ActOutbox drain makes that are not about what ACT! is
// sent: when a failed row is tried again, what a failure means for the row,
// what a manager is told, which date closes a won deal, who the service
// account is. Pure, so the suite can test them under `isolate: false` (see
// vitest.config.ts); src/lib/act/drain.ts does the I/O and carries out what
// these decide.

import {
  ActApiError,
  ActNoAnswerError,
  ActNotSentError,
  ActUntrackedCreateError,
} from "@/lib/act/client";
import { tryLaterStatus } from "@/lib/act/record-write";
import type { OpportunityNow, QuoteForAct } from "@/lib/act/write-payloads";
import type { OutboxStep } from "@/lib/act/outbox-plan";

/** The steps that call ACT!: every OutboxStep but `done` and `blocked`. */
export type ActStepKind = Exclude<OutboxStep["kind"], "done" | "blocked">;

/** The wait before a failed row's first retry. */
export const BACKOFF_FIRST_MS = 5 * 60 * 1000;
/** The longest wait between two tries of a row. */
export const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

/**
 * How long a row waits after its `attempts`-th failure (1 for the first):
 * 5 minutes, doubling -- 10, 20, 40, 80, 160, 320 -- to a cap of 6 hours from
 * the eighth failure on.
 *
 * Five minutes first because the usual failure is a blip -- a dropped
 * connection, ACT!'s IIS recycling -- and the manager who just finalised is
 * likely still looking at the quote. Doubling, so a real outage costs a
 * handful of requests rather than one every five minutes. Capped at six
 * hours, so a row that has been failing all night is still tried a few times
 * the next working day without waiting for the nightly drain. A row is never
 * given up on: a take-over (a new finalise, signature or acceptance) resets
 * attempts and makes it due at once, and a person can read attempts and
 * lastError off the row.
 */
export function backoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.floor(attempts) - 1);
  // 2^7 * 5 min is already past the cap; the exponent stops at 16 so a
  // huge count cannot reach Infinity.
  return Math.min(BACKOFF_FIRST_MS * 2 ** Math.min(exponent, 16), BACKOFF_CAP_MS);
}

/** The longest wait a Retry-After can impose on a row: a day. */
export const RETRY_AFTER_CAP_MS = 24 * 60 * 60 * 1000;

/**
 * When a row that has now failed `attempts` times is next due: the backoff,
 * or `retryAfterMs` -- what ACT! asked for with a 429 or a 408 -- when that
 * is longer. Retry-After is a floor, never a ceiling: the backoff still grows
 * when ACT! keeps asking for a short wait. The floor is capped at
 * RETRY_AFTER_CAP_MS, so a malformed or extravagant header cannot park a row
 * for good; a take-over still makes it due at once.
 */
export function nextAttemptAt(now: Date, attempts: number, retryAfterMs: number | null = null): Date {
  const floor = retryAfterMs === null ? 0 : Math.min(Math.max(0, retryAfterMs), RETRY_AFTER_CAP_MS);
  return new Date(now.getTime() + Math.max(backoffMs(attempts), floor));
}

/**
 * A Retry-After header as milliseconds from `now`, or null when there is
 * none or it says nothing readable. RFC 9110 allows two forms: a number of
 * seconds, or an HTTP-date, which is read relative to `now` (a date already
 * past is 0).
 */
export function retryAfterMs(header: string | null, now: Date): number | null {
  if (header === null) return null;
  const text = header.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  if (!/[a-z]/i.test(text)) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now.getTime());
}

/**
 * The close date a won deal is given: the later of the acceptance
 * (Document.acceptedAt) and the client's signature (Document.completedAt).
 *
 * The win needs both standing (THE WIN NEEDS A STANDING SIGNATURE in
 * src/lib/act/outbox-plan.ts), so the deal was won when the second of them
 * happened. In the ordinary order the client signs and the manager then
 * accepts, and that is acceptedAt. After accept, voidSignature, re-finalise
 * and re-sign, acceptedAt is still the first acceptance -- voidSignature
 * leaves it set -- and the commitment that wins the deal is the new
 * signature: completeSigning sets completedAt on every completion
 * (src/lib/actions/signing-client.ts), in the same write that makes the quote
 * SIGNED, and nothing clears it. A completedAt that is null, on a quote
 * signed before the column was written, leaves acceptedAt.
 */
export function wonCloseDate(acceptedAt: Date, completedAt: Date | null): Date {
  return completedAt && completedAt.getTime() > acceptedAt.getTime() ? completedAt : acceptedAt;
}

/**
 * The ACT! user id of the account PathQuote logs in as -- the record manager
 * of anything written for an author with no User.actUserId (WHO OWNS WHAT IS
 * WRITTEN in src/lib/act/write-payloads.ts). `login` is ACT_USER, a login
 * name and not a uuid; it is matched against each user's `username`, trimmed
 * and without regard to case, and must match exactly one. Null for none, or
 * for more than one: writing records under a guessed owner is the mistake
 * this refuses to make, and the drain stops its pass instead.
 */
export function serviceAccountUserId(
  users: readonly { id?: unknown; username?: unknown }[],
  login: string,
): string | null {
  const wanted = login.trim().toLowerCase();
  if (wanted === "") return null;
  const matches = users.filter(
    (user) => typeof user.username === "string" && user.username.trim().toLowerCase() === wanted,
  );
  const [only] = matches;
  return matches.length === 1 && typeof only.id === "string" && only.id !== "" ? only.id : null;
}

/**
 * An opportunity as ACT! returned it, as revisedOpportunityBody and
 * wonOpportunityBody read it: its stage's process and number, and its
 * status.
 *
 * AN OPPORTUNITY WITH NO READABLE STAGE IS IN NO PROCESS: its processId is
 * "", which matches no region's, so stageMove calls it `different-process`
 * and leaves the stage as it is -- the status is still decided. The other
 * reading, "no stage, so set one as if new", is a move backwards for a deal
 * somebody advanced in a way this cannot read, which the forward-only rule
 * exists to prevent. A missing status is "", which is not Open.
 */
export function opportunityNow(record: {
  status?: unknown;
  stage?: { number?: unknown; process?: { id?: unknown } | null } | null;
}): OpportunityNow {
  const processId = record.stage?.process?.id;
  const number = record.stage?.number;
  const readable = typeof processId === "string" && processId !== "" && typeof number === "number";
  return {
    processId: readable ? processId : "",
    number: readable ? number : 0,
    status: typeof record.status === "string" ? record.status : "",
  };
}

/** What a step does, as the end of "PathQuote could not ..." or "ACT! refused to ...". */
export function stepAction(kind: ActStepKind): string {
  switch (kind) {
    case "create-contact":
      return "create this quote's contact";
    case "create-opportunity":
      return "create this quote's opportunity";
    case "update-opportunity":
      return "update this quote's opportunity";
    case "write-product-line":
    case "write-accepted-line":
      return "write this quote's amount on its opportunity";
    case "write-history":
      return "record this revision in the contact's history";
    case "win-opportunity":
      return "mark this quote's opportunity Won";
    case "promote-contact":
      return "make this quote's contact a Customer";
  }
}

/** The most a sentence quotes of ACT!'s answer. */
const ANSWER_MAX = 200;
/** The most of an error lastError keeps. */
const LAST_ERROR_MAX = 500;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * What ACT! said, from the body of its answer, short enough to quote to a
 * manager: the `Message` (or `message`, `error_description`, `error`,
 * `title`) of a JSON error body, a JSON string as it is, or the text as
 * sent. Empty when there was nothing.
 */
export function answerDetail(body: string): string {
  const text = body.trim();
  if (text === "") return "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "string") return clip(parsed, ANSWER_MAX);
    if (typeof parsed === "object" && parsed !== null) {
      const fields = parsed as Record<string, unknown>;
      for (const key of ["Message", "message", "error_description", "error", "title"]) {
        const value = fields[key];
        if (typeof value === "string" && value.trim() !== "") return clip(value, ANSWER_MAX);
      }
    }
  } catch {
    // Not JSON: the text as sent.
  }
  return clip(text, ANSWER_MAX);
}

/**
 * What happens next to a write ACT! refused or denied, as the end of the
 * sentence a manager reads: it is held (BLOCKED_BY.act), and sent again only
 * by a take-over or a person. If what ACT! objects to is on its own record
 * (an off-list value on an old contact, say), fixing that record is what
 * lets the next attempt through.
 */
const HELD_UNTIL_RETRIED =
  "it is tried again when this quote is next finalised, signed or accepted, or when your developer retries it.";

/**
 * The blocked reason for a step ACT! refused: what was being done, ACT!'s
 * status and what it said, and what happens next. Read by a manager on the
 * quote (BLOCKED REASONS ARE READ BY A MANAGER in src/lib/act/outbox-plan.ts).
 *
 * A refusal is the same answer every time the same thing is sent, so the
 * row is blocked BLOCKED_BY.act and the drain's pass over blocked rows
 * leaves it alone (replanBlocked): sent every pass, a refused write would be
 * refused every pass -- and a refused contact create that ACT! had in fact
 * saved would put a new person in ACT! every pass.
 */
export function refusedReason(kind: ActStepKind, status: number, body: string): string {
  const said = answerDetail(body);
  return `ACT! refused to ${stepAction(kind)}, answering ${status}${said ? ` ("${said}")` : ""} — PathQuote will not send it again on its own: check the record in ACT!, and ${HELD_UNTIL_RETRIED}`;
}

/**
 * The blocked reason for a 403 on a request about a record: ACT! keeps some
 * records to some of its users, and the service account is not one of them
 * for this one. Not the service account's access as a whole -- a 403 to the
 * login, or to the users lookup, stops the pass instead (drainFailure) --
 * so only this row is held (BLOCKED_BY.act), and the rest of the pass goes
 * on. `method` says whether there was a record yet: a create has none.
 */
export function deniedReason(kind: ActStepKind, method: string, body: string): string {
  const said = answerDetail(body);
  const what = method === "POST" ? `access when it tried to ${stepAction(kind)}` : `access to the record it needed to ${stepAction(kind)}`;
  return `ACT! denied PathQuote ${what}, answering 403${said ? ` ("${said}")` : ""} — ACT! can keep a record to some of its users, and an ACT! administrator can give PathQuote's login access. PathQuote will not try again on its own: ${HELD_UNTIL_RETRIED}`;
}

/**
 * The values of ActOutbox.blockedBy, beside null for a row the planner
 * blocked. See the column in prisma/schema.prisma.
 *
 *   act    ACT! refused a write: held until a take-over or a person.
 *   drain  the drain's own check -- duplicates a lookup found, a revision it
 *          cannot describe: worked again first thing each pass.
 */
export const BLOCKED_BY = {
  act: "act",
  drain: "drain",
} as const;

/**
 * What the drain's pass over blocked rows does with one, from who blocked it
 * and what nextStep says now. No ACT! call is made deciding it.
 *
 *   keep     leave it blocked as it is: ACT! refused it (or blockedBy holds a
 *            value nothing here knows, which is left for a person), or the
 *            planner blocks it still, for the reason stored.
 *   reblock  the planner blocks it, for a reason other than the one stored:
 *            store the planner's, as the planner's.
 *   unblock  the planner blocked it and no longer does -- the cause was
 *            fixed in PathQuote: clear the reason, which is no longer true,
 *            and make the row due.
 *   recheck  the drain's own check blocked it, and the planner does not:
 *            work it again this pass, ahead of the due rows, keeping its
 *            reason until the moment it is worked -- the duplicates it names
 *            may still be in ACT!, and a pass that stops before reaching it
 *            would otherwise leave the manager with no reason at all.
 */
export type Replan =
  | { kind: "keep" }
  | { kind: "reblock"; reason: string }
  | { kind: "unblock" }
  | { kind: "recheck" };

export function replanBlocked(
  row: { blockedReason: string; blockedBy: string | null },
  step: OutboxStep,
): Replan {
  if (row.blockedBy !== null && row.blockedBy !== BLOCKED_BY.drain) return { kind: "keep" };
  if (step.kind === "blocked") {
    return step.reason === row.blockedReason && row.blockedBy === null
      ? { kind: "keep" }
      : { kind: "reblock", reason: step.reason };
  }
  return row.blockedBy === BLOCKED_BY.drain ? { kind: "recheck" } : { kind: "unblock" };
}

/**
 * What a failure means for the row that was being worked:
 *
 *   refused    ACT! answered no: an ActApiError `refused` with a 4xx other
 *              than 401 and 403. The row is blocked with refusedReason, and
 *              held there (BLOCKED_BY.act).
 *   denied     a 403 on a request about a record (ActApiError `authorizing`
 *              false): ACT! keeps that record from the service account. The
 *              row is blocked with deniedReason and held, like a refusal;
 *              the pass goes on, since the next row's records may well be
 *              open to it.
 *   stop       not about this row: a 401 (after re-authorising, or to the
 *              login itself), a 403 to the login (`authorizing`: the service
 *              account's licence or permissions -- a `Browse` licence
 *              surfaces here), or a redirect not followed (ACT_BASE or the
 *              box's setup). Every row would get the same answer, so the row
 *              backs off and the pass stops. (A 403 to the users lookup is
 *              the account's too; the drain stops for that where it makes
 *              the lookup.)
 *   try-later  ACT! said "not now": a 429 or a 408 (tryLaterStatus in
 *              src/lib/act/record-write.ts), on any request. The row backs
 *              off -- for at least as long as its Retry-After asks
 *              (nextAttemptAt) -- and the pass stops: the rest would be
 *              sent to a server that has just said it is overloaded.
 *   unreachable
 *              ACT! not answering at all: ActNotSentError (no connection, or
 *              the login before the request failed), ActNoAnswerError (a GET
 *              or PATCH with no answer to any of its attempts), or a create
 *              that got no answer (ActUntrackedCreateError `noAnswer`). The
 *              row backs off and the pass stops: every further row would
 *              wait out the same timeouts -- up to 93 seconds a GET -- and
 *              fail the same way.
 *   untracked  a create whose record PathQuote may not have
 *              (ActUntrackedCreateError) though ACT! answered -- a 5xx, or a
 *              success it could not read. The drain deals with it where the
 *              create is made; this is what reaches the row if it did not.
 *              (A create with no answer is `unreachable`, and just as
 *              untracked: its marker stays.)
 *   failed     safe to try again later: an ActApiError `failed` (a 5xx, an
 *              unreadable answer). The row backs off.
 *   foreign    anything else -- the drain's own code, the database. Backs
 *              off like `failed`, but says nothing about ACT!.
 */
export type DrainFailure =
  | "refused"
  | "denied"
  | "stop"
  | "try-later"
  | "unreachable"
  | "untracked"
  | "failed"
  | "foreign";

/** The failures after which the pass goes no further: see DrainFailure. */
export function stopsPass(failure: DrainFailure): boolean {
  return failure === "stop" || failure === "try-later" || failure === "unreachable";
}

export function drainFailure(error: unknown): DrainFailure {
  if (error instanceof ActUntrackedCreateError) return error.noAnswer ? "unreachable" : "untracked";
  if (error instanceof ActApiError) {
    if (tryLaterStatus(error.status)) return "try-later";
    if (error.failure === "failed") return "failed";
    if (error.status === 403) return error.authorizing ? "stop" : "denied";
    if (error.status === 401 || (error.status >= 300 && error.status < 400)) return "stop";
    return error.failure === "refused" ? "refused" : "failed";
  }
  if (error instanceof ActNotSentError || error instanceof ActNoAnswerError) return "unreachable";
  return "foreign";
}

/**
 * ActOutbox.lastError for a step that failed and will be tried again: short,
 * for a person (Task 9 shows it on the quote), and saying whether the fault
 * was ACT!'s or PathQuote's own.
 */
export function lastErrorText(kind: ActStepKind, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let text: string;
  if (error instanceof ActNotSentError) {
    text = `PathQuote could not ${stepAction(kind)}: ACT! could not be reached — ${message}`;
  } else if (error instanceof ActNoAnswerError) {
    text = `PathQuote could not ${stepAction(kind)}: ACT! did not answer — ${message}`;
  } else if (error instanceof ActUntrackedCreateError) {
    // A contact is never looked up (A CREATE IN FLIGHT in outbox-plan.ts):
    // its marker holds it for a person instead.
    const next =
      kind === "create-contact"
        ? "it is not tried again until a person has checked ACT! for the contact"
        : "the next attempt looks for it in ACT! before creating anything";
    text = `PathQuote asked ACT! to ${stepAction(kind)} and ${error.noAnswer ? "got no answer, so " : ""}did not learn whether it did — ${next}.`;
  } else if (error instanceof ActApiError && tryLaterStatus(error.status)) {
    const wait = error.retryAfter ? ` (Retry-After: ${error.retryAfter.trim()})` : "";
    text = `PathQuote could not ${stepAction(kind)}: ACT! answered ${error.status}, not now, try later${wait} — ${message}`;
  } else if (error instanceof ActApiError) {
    text = `PathQuote could not ${stepAction(kind)}: ACT! answered ${error.status} — ${message}`;
  } else {
    text = `PathQuote could not ${stepAction(kind)}: something in PathQuote failed — ${message}`;
  }
  return clip(text, LAST_ERROR_MAX);
}

/**
 * The revision a row writes, as the request bodies take it (QuoteForAct in
 * src/lib/act/write-payloads.ts): the figures from the QuoteRevision the row
 * points at and its frozen snapshot, never the live Document, which an
 * unfinalise makes editable again after the row was queued. Only `number`
 * and `regionCode` are read live, for the reasons QuoteForAct gives.
 *
 * `unreadable`, with the blocked reason, when the revision cannot be
 * described without guessing: no quote number, no currency in the snapshot,
 * a total that is not a number, or no validity -- a revision 0 written by
 * scripts/backfill-quote-revisions.ts can hold a null one, and QuoteForAct
 * says to refuse it rather than default it.
 */
export type RevisionForAct = { kind: "quote"; quote: QuoteForAct } | { kind: "unreadable"; reason: string };

const ASK_DEVELOPER = "ask your developer.";

export function revisionForAct(input: {
  /** Document.number. */
  number: string | null;
  /** Region.code of Document.regionId. */
  regionCode: string;
  /** QuoteRevision.revision. */
  revision: number;
  /** QuoteRevision.total, a Decimal(12,2): anything whose string is the figure. */
  total: { toString(): string };
  /** QuoteRevision.snapshot, as stored. */
  snapshot: unknown;
  /** QuoteRevision.createdAt. */
  createdAt: Date;
}): RevisionForAct {
  if (!input.number) {
    return { kind: "unreadable", reason: `This quote has no number, so PathQuote has nothing to name it by in ACT! — ${ASK_DEVELOPER}` };
  }
  const snapshot = typeof input.snapshot === "object" && input.snapshot !== null ? (input.snapshot as Record<string, unknown>) : {};
  const currency = snapshot.currency;
  if (typeof currency !== "string" || currency.trim() === "") {
    return {
      kind: "unreadable",
      reason: `The revision of this quote being written to ACT! has no currency on record, so PathQuote cannot say what its amount is in — ${ASK_DEVELOPER}`,
    };
  }
  const terms = typeof snapshot.terms === "object" && snapshot.terms !== null ? (snapshot.terms as Record<string, unknown>) : {};
  const validityDays = terms.validityDays;
  if (typeof validityDays !== "number" || !Number.isFinite(validityDays)) {
    return {
      kind: "unreadable",
      reason: `The revision of this quote being written to ACT! has no validity on record, and PathQuote will not write it with a guessed one — ${ASK_DEVELOPER}`,
    };
  }
  const total = Number(input.total.toString());
  if (!Number.isFinite(total)) {
    return {
      kind: "unreadable",
      reason: `The revision of this quote being written to ACT! has no total PathQuote can read — ${ASK_DEVELOPER}`,
    };
  }
  return {
    kind: "quote",
    quote: {
      number: input.number,
      revision: input.revision,
      regionCode: input.regionCode,
      total,
      currency,
      validityDays,
      finalizedAt: input.createdAt,
    },
  };
}
