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
  createMadeNothing,
} from "@/lib/act/client";
import { tryLaterStatus } from "@/lib/act/record-write";
import { readOpportunityStatus, type OpportunityNow, type QuoteForAct } from "@/lib/act/write-payloads";
import type { OutboxStep } from "@/lib/act/outbox-plan";

/** The steps that call ACT!: every OutboxStep but `done` and `blocked`. */
export type ActStepKind = Exclude<OutboxStep["kind"], "done" | "blocked">;

/** How long the backoff holds a row back after its first failure. */
export const BACKOFF_FIRST_MS = 5 * 60 * 1000;
/**
 * The most the backoff alone holds a row back. A Retry-After can ask for
 * longer, up to RETRY_AFTER_CAP_MS (nextAttemptAt).
 */
export const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

/**
 * How long a row is held back after its `attempts`-th failure (1 for the
 * first): 5 minutes, doubling -- 10, 20, 40, 80, 160, 320 -- to a cap of 6
 * hours from the eighth failure on.
 *
 * This says when a row MAY next be tried, not when it is: nothing retries a
 * row on a clock of its own. A pass of the drain does -- the periodic one
 * every 15 minutes (scripts/act-drain.ts, pq-act-drain.timer in the `tools`
 * container) and the inbound sync's, each over every due row, besides the
 * fast path after the quote's own next finalise, signature or acceptance. A
 * row is tried at the first pass after it falls due, so each wait below is
 * rounded up to that timer.
 *
 * Five minutes first because the usual failure is a blip -- a dropped
 * connection, ACT!'s IIS recycling -- which is over by the next periodic
 * pass. Doubling, so a real outage costs a handful of requests rather than
 * one every pass. Capped at six hours, so that a row that has been failing
 * all night is tried a few times the next working day, not only by the
 * nightly sync's drain. A row is never given up on: a take-over
 * (a new finalise, signature or acceptance) resets attempts and makes it due
 * at once, and a person can read attempts and lastError off the row.
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
    status: readOpportunityStatus(record.status),
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
 * by a take-over or a person -- the person being an administrator, with "Try
 * again now" on the quote's page (tryAgainDecision in
 * src/lib/act/outbox-admin.ts). If what ACT! objects to is on its own record
 * (an off-list value on an old contact, say), fixing that record is what
 * lets the next attempt through.
 *
 * A row already held keeps the sentence it was blocked with: the drain's pass
 * over blocked rows leaves a BLOCKED_BY.act row as it is (replanBlocked), so
 * this wording reaches only rows refused from now on.
 */
const HELD_UNTIL_RETRIED =
  "it is tried again when this quote is next finalised, signed or accepted, or when an administrator sends it again from this quote's page.";

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
 * login, or to the users lookup, or one whose body is not ACT!'s JSON
 * (actForbidden), stops the pass instead (drainFailure) --
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
 * blocked for anything but its contact. See the column in
 * prisma/schema.prisma.
 *
 *   contact   held over the contact's create: PathQuote asked ACT! to create
 *             the quote's contact and has no record of whether it did
 *             (A CONTACT CREATE IN FLIGHT in src/lib/act/outbox-plan.ts).
 *             Set by the planner -- nextStep's block for a contact whose
 *             marker stands, which carries `by: "contact"` (plannerBlockedBy)
 *             -- and by the drain where a contact create goes unaccounted
 *             for (createContact and storeCreated in src/lib/act/drain.ts).
 *             Re-planned each pass like the planner's own blocks: it stays
 *             blocked while the contact's marker stands and the row still
 *             needs the contact, and is unblocked once an administrator has
 *             settled the contact. This, and not
 *             the blockedReason sentence, is what every reader asks to know
 *             a quote is held for its contact -- the quote's ACT! card and
 *             the two contact actions (heldForContact in
 *             src/lib/act/outbox-admin.ts), the release of the contact's
 *             other quotes (heldForContactRelease, same file), the Settings
 *             count (readOutboxStanding in src/lib/queries/act-sync.ts) and
 *             a pass's own (drainSummary in src/lib/act/run-record.ts) -- so
 *             rewording UNTRACKED_CONTACT_REASON changes what a person reads
 *             and nothing else.
 *   act       ACT! refused a write, or denied PathQuote access to a record:
 *             held until a take-over or a person.
 *   revision  the row's revision cannot be described (revisionForAct's
 *             `unreadable`): held until a take-over or a person, like `act`.
 *             What it reads is frozen -- the revision's snapshot and total,
 *             and the quote's number, which a finalised quote keeps -- so the
 *             answer cannot change by itself, and checking it every pass
 *             would only spend a place in the pass on a row that cannot move.
 *             A value of its own rather than `act`, because `act` says ACT!
 *             objected, and whoever reads the column -- a person, the
 *             quote's ACT! card (adminHelpFor in src/lib/act/quote-act-view.ts,
 *             which words "Try again now" by it), Task 10's runbook -- would
 *             look in ACT! for a
 *             refusal that never happened; the fix here is PathQuote's own
 *             data, which is why its reasons say "ask your developer".
 *   drain     duplicates a lookup found in ACT!: rechecked by later passes,
 *             after the due rows and at most RECHECKS_PER_PASS a pass.
 *             Somebody removing the extra records in ACT! is what lets it on,
 *             and PathQuote is not told of that, so it asks again.
 *   admin     on a FINISHED row only: an administrator chose not to send the
 *             quote ("Don't send this quote to ACT!", dontSendDecision in
 *             src/lib/act/outbox-admin.ts). Written in the same statement that
 *             sets completedAt, so no pass ever sees it -- every pass reads
 *             unfinished rows only -- and replanBlocked never meets it. It is
 *             what tells the quote's page "not sent" from "in ACT!", which a
 *             finished row otherwise means.
 *
 * `act`, `revision` and `drain`, on an unfinished row, can also be cleared
 * by an administrator's "Try again now" (tryAgainDecision in
 * src/lib/act/outbox-admin.ts).
 */
export const BLOCKED_BY = {
  contact: "contact",
  act: "act",
  revision: "revision",
  drain: "drain",
  admin: "admin",
} as const;

/**
 * ActOutbox.blockedBy for a block nextStep returned: BLOCKED_BY.contact for
 * the contact held over its create (the step's `by`), null -- the planner's
 * -- for every other.
 */
export function plannerBlockedBy(step: Extract<OutboxStep, { kind: "blocked" }>): typeof BLOCKED_BY.contact | null {
  return step.by === BLOCKED_BY.contact ? BLOCKED_BY.contact : null;
}

/**
 * How many rows the drain's own lookups blocked (BLOCKED_BY.drain) one pass
 * rechecks: 10, after its due rows. A recheck is one lookup in ACT! for a row
 * that is usually still blocked, so it comes after the work that is certainly
 * due, and however many such rows pile up they take no more than this from a
 * pass. Pass.replanBlocked in src/lib/act/drain.ts hands them over least
 * recently worked first, so beyond 10 they are rechecked in turn rather than
 * the same 10 every pass. 10 is a fifth of
 * the pass's 50 due rows: with the periodic drain every 15 minutes, 40 such
 * rows are each asked about once an hour.
 */
export const RECHECKS_PER_PASS = 10;

/**
 * The rows one pass works, in order: every due row it was given (the drain
 * takes at most BATCH of them), then the first RECHECKS_PER_PASS of
 * `rechecks` -- rows its own lookups blocked, least recently worked first --
 * that are not also due. Due rows first, so a pile of rows waiting on
 * somebody to tidy ACT! never stands between a fresh quote and ACT!.
 */
export function passWork(
  due: readonly string[],
  rechecks: readonly string[],
): { id: string; recheck: boolean }[] {
  const dueIds = new Set(due);
  return [
    ...due.map((id) => ({ id, recheck: false })),
    ...rechecks
      .filter((id) => !dueIds.has(id))
      .slice(0, RECHECKS_PER_PASS)
      .map((id) => ({ id, recheck: true })),
  ];
}

/**
 * What the drain's pass over blocked rows does with one, from who blocked it
 * and what nextStep says now. No ACT! call is made deciding it.
 *
 *   keep     leave it blocked as it is: ACT! refused it, its revision cannot
 *            be described (BLOCKED_BY.revision), or blockedBy holds a value
 *            nothing here knows, which is left for a person; or the planner
 *            blocks it still, for the reason stored and as the blocker
 *            stored.
 *   reblock  the planner blocks it, for a reason or as a blocker other than
 *            the one stored: store the planner's reason, and `by` --
 *            plannerBlockedBy, BLOCKED_BY.contact for a contact held over
 *            its create, null for the rest.
 *   unblock  the planner blocked it and no longer does -- the cause was
 *            fixed in PathQuote: clear the reason, which is no longer true,
 *            and make the row due.
 *   recheck  a lookup's duplicates blocked it (BLOCKED_BY.drain), and the
 *            planner does not: a candidate to work again this pass, after
 *            the due rows and within RECHECKS_PER_PASS (passWork), keeping
 *            its reason until the moment it is worked -- the duplicates it
 *            names may still be in ACT!, and a pass that stops or runs out
 *            of rechecks before reaching it would otherwise leave the manager
 *            with no reason at all.
 *
 * A row held for its contact (BLOCKED_BY.contact) is re-planned as the
 * planner's own blocks are, whoever set it -- the planner, or the drain where
 * the contact's create went unaccounted for. Either way the contact's marker
 * (Contact.actCreateInFlightAt) was set and left set. While the quote's
 * contact has that marker and no actContactId, nextStep returns one of three
 * things for the row: this same block, wherever the row would need the
 * contact -- `keep` (or `reblock` with the same `by`, should the sentence
 * have been reworded since); a block it checks first, a quote with no contact say
 * -- `reblock`, as the planner's; or `done`, for a row that needs the
 * contact no more -- `unblock`, and the next pass finishes it. Never a step
 * that calls ACT!: nextStep plans create-contact only once the marker is
 * gone, and every later step only once actContactId is set. So the row moves
 * on when an administrator has settled the contact ("ACT! has this person"
 * sets actContactId, "ACT! has nobody" clears the marker): `unblock`, and the
 * next pass sends what the plan then says. Nothing is sent deciding any of
 * this.
 */
export type Replan =
  | { kind: "keep" }
  | { kind: "reblock"; reason: string; by: typeof BLOCKED_BY.contact | null }
  | { kind: "unblock" }
  | { kind: "recheck" };

/** The blockers the pass over blocked rows re-plans: the planner's (null), the contact's and the drain's lookups'. */
const REPLANNED: ReadonlySet<string | null> = new Set([null, BLOCKED_BY.contact, BLOCKED_BY.drain]);

export function replanBlocked(
  row: { blockedReason: string; blockedBy: string | null },
  step: OutboxStep,
): Replan {
  if (!REPLANNED.has(row.blockedBy)) return { kind: "keep" };
  if (step.kind === "blocked") {
    const by = plannerBlockedBy(step);
    return step.reason === row.blockedReason && row.blockedBy === by
      ? { kind: "keep" }
      : { kind: "reblock", reason: step.reason, by };
  }
  return row.blockedBy === BLOCKED_BY.drain ? { kind: "recheck" } : { kind: "unblock" };
}

/**
 * What a failure means for the row that was being worked:
 *
 *   refused    ACT! answered no: an ActApiError `refused` with a 4xx other
 *              than 401 and 403. The row is blocked with refusedReason, and
 *              held there (BLOCKED_BY.act).
 *   denied     a 403 from ACT! itself on a request about a record
 *              (ActApiError `authorizing` false, and a JSON body:
 *              actForbidden): ACT! keeps that record from the service
 *              account. The row is blocked with deniedReason and
 *              held, like a refusal; the pass goes on, since the next row's
 *              records may well be open to it.
 *   stop       not about this row: a 401 (after re-authorising, or to the
 *              login itself), a 403 to the login (`authorizing`: the service
 *              account's licence or permissions -- a `Browse` licence
 *              surfaces here), a 403 whose body is not JSON (actForbidden),
 *              or a redirect not followed (ACT_BASE or the box's setup).
 *              Every row would get the same answer, so the row backs off and
 *              the pass stops. A 403 that is not JSON is not ACT!'s Web API
 *              keeping one record back but what stands in front of it -- IIS,
 *              whose 403 is an HTML page -- turning PathQuote away: above
 *              all, the IP allow-list no longer letting the VPS in. A pass
 *              logs in once and keeps the token (for up to 55 minutes), so an
 *              allow-list that starts refusing the VPS part way through a
 *              pass answers a record's request, not the login; read as
 *              `denied`, it would hold every row left in the pass, one by
 *              one, each for a person to send again. (A 403 to the users
 *              lookup is the account's too; the drain stops for that where
 *              it makes the lookup.) A redirect to a CREATE stops the pass as well:
 *              it is still untracked for its marker -- a 303 is how a
 *              server answers a POST it acted on, so the marker stays, and
 *              a contact is held for a person -- but it almost certainly
 *              means the same setup error, which would leave every further
 *              create as unaccounted for.
 *   try-later  ACT! said "not now": a 429 or a 408 (tryLaterStatus in
 *              src/lib/act/record-write.ts), on any request. The row backs
 *              off -- for at least as long as its Retry-After asks
 *              (nextAttemptAt) -- and the pass stops: the rest would be
 *              sent to a server that has just said it is overloaded. (A 408
 *              to a contact's POST may follow a person ACT! saved, so that
 *              row is blocked instead, the contact's marker kept --
 *              createContact in src/lib/act/drain.ts -- and the pass stops
 *              all the same.)
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

/**
 * Whether a create's error leaves a record that ACT! may hold and PathQuote
 * has not stored -- what the drain counts as DrainResult's `untracked`, and
 * keeps the create's in-flight marker for: an ActUntrackedCreateError with no
 * `createdId` (one with it names the record, which the drain stores), or the
 * POST's own ActApiError when createMadeNothing does not clear it, which is
 * a 408 (see createMadeNothing in src/lib/act/client.ts).
 */
export function createUnaccounted(error: unknown): boolean {
  if (error instanceof ActUntrackedCreateError) return error.createdId === null;
  return error instanceof ActApiError && error.method === "POST" && !createMadeNothing(error);
}

/** The failures after which the pass goes no further: see DrainFailure. */
export function stopsPass(failure: DrainFailure): boolean {
  return failure === "stop" || failure === "try-later" || failure === "unreachable";
}

/**
 * Why a pass stopped, for whoever runs it to judge (DrainResult's
 * `stopCause`): `unavailable` when ACT! was busy or away -- it said "not
 * now", did not answer, or answered with a failure worth trying again (a
 * 5xx) -- which clears by itself; `setup` for everything else, which does
 * not: a 401, a 403 to the login or one that is not ACT!'s own answer, a
 * redirect (DrainFailure's `stop`), a refusal of a request every row needs
 * (the users lookup), or PathQuote's own code failing. The periodic drain's
 * CLI (scripts/act-drain.ts) fails its unit on `setup` and not on
 * `unavailable`: an ACT! that is down for a weekend would otherwise email
 * about it, while a wrong ACT_PASS, or the VPS's address dropped from IIS's
 * allow-list -- which answers with its HTML 403 -- will not mend until
 * somebody is told. The VPS cut off by a firewall or the NAT rule instead is
 * not told apart from ACT! being down: no answer at all, `unreachable`, so
 * `unavailable`, exit 0, and no email from the drain. What catches that is
 * the nightly sync's failure email: its run asks ACT! before it reads
 * (scripts/act-sync.ts), gets no answer either, and fails its unit.
 */
export function stopCause(failure: DrainFailure): "setup" | "unavailable" {
  return failure === "try-later" || failure === "unreachable" || failure === "failed" ? "unavailable" : "setup";
}

/**
 * Whether a 403's body is ACT!'s own: JSON, the form ASP.NET Web API gives
 * its errors, `{"Message": ...}` and the like. An HTML page -- what IIS sends
 * when its IP allow-list turns a request away -- plain text, or nothing at
 * all is not, and the 403 is then taken to be about PathQuote's access as a
 * whole rather than one record (`stop` in DrainFailure). ACT!'s own 403 to a
 * record has not been captured from this server; if it turns out not to be
 * JSON, such a 403 stops the pass and backs its row off rather than holding
 * that one row. That is the side to err on: the other way, every row left in
 * the pass is held for a person.
 */
export function actForbidden(body: string): boolean {
  const text = body.trim();
  if (text === "") return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function drainFailure(error: unknown): DrainFailure {
  if (error instanceof ActUntrackedCreateError) {
    if (error.noAnswer) return "unreachable";
    return error.status !== null && error.status >= 300 && error.status < 400 ? "stop" : "untracked";
  }
  if (error instanceof ActApiError) {
    if (tryLaterStatus(error.status)) return "try-later";
    if (error.failure === "failed") return "failed";
    if (error.status === 403) return error.authorizing || !actForbidden(error.body) ? "stop" : "denied";
    if (error.status === 401 || (error.status >= 300 && error.status < 400)) return "stop";
    return error.failure === "refused" ? "refused" : "failed";
  }
  if (error instanceof ActNotSentError || error instanceof ActNoAnswerError) return "unreachable";
  return "foreign";
}

/**
 * ActOutbox.lastError for a step that failed and will be tried again: short,
 * for a person (the quote's ACT! card shows it as written, describeQuoteAct
 * in src/lib/act/quote-act-view.ts), and saying whether the fault
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
    // A redirect's message names where it pointed, and what to check.
    if (error.status !== null && error.status >= 300 && error.status < 400) text += ` ${message}`;
  } else if (error instanceof ActApiError && tryLaterStatus(error.status)) {
    const wait = error.retryAfter ? ` (Retry-After: ${error.retryAfter.trim()})` : "";
    text = `PathQuote could not ${stepAction(kind)}: ACT! answered ${error.status}, not now, try later${wait} — ${message}`;
  } else if (error instanceof ActApiError && error.status === 403 && !error.authorizing && !actForbidden(error.body)) {
    text = `PathQuote could not ${stepAction(kind)}: it was answered 403 with something other than ACT!'s own answer, most likely ACT!'s IIS no longer letting the VPS's address in — ${message}`;
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
 * no validity -- a revision 0 written by scripts/backfill-quote-revisions.ts
 * can hold a null one, and QuoteForAct says to refuse it rather than default
 * it -- or no amount excluding tax (revisionAmount).
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
  const snapshot = snapshotObject(input.snapshot);
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
  const amount = revisionAmount(input.total, input.snapshot);
  if (amount.kind === "unreadable") return amount;
  return {
    kind: "quote",
    quote: {
      number: input.number,
      revision: input.revision,
      regionCode: input.regionCode,
      amountExTax: amount.amountExTax,
      total: amount.total,
      taxName: amount.taxName,
      currency,
      validityDays,
      finalizedAt: input.createdAt,
    },
  };
}

/**
 * What a revision is worth in ACT!: its amount EXCLUDING TAX, with the
 * tax-inclusive total beside it for reference and the name of the tax.
 *
 * EXCLUDING TAX, by Vadym's decision (2026-10-13): an AU quote carries GST and
 * a UK one VAT where an export quote carries none, so tax-inclusive amounts
 * leave the pipeline in ACT! incomparable from one region to the next, and an
 * amount before tax is the usual pipeline base whatever the region.
 *
 * NOT THE SNAPSHOT'S `totals.subtotal`, although that is the field the
 * decision was first put in terms of. The pricing engine's `subtotal` is the
 * items and extra lines BEFORE the document-level discount (computeTotals in
 * src/lib/pricing.ts: taxableBase = subtotal - discountAmount, total =
 * taxableBase + taxAmount), so on a quote with a document discount it is
 * more than the client is asked to pay before tax. The amount before tax is
 * the taxable base, and the snapshot keeps no field of that name; it is
 * exactly the total less the tax, and both of those are frozen. So:
 *
 *   total        QuoteRevision.total, the same figure as the snapshot's
 *                `totals.total` -- finalizeDocument writes both from one
 *                read, and the backfill both from Document.total.
 *   taxAmount    the snapshot's `totals.taxAmount`: a canonical decimal
 *                string, as every Money in a snapshot is
 *                (src/lib/documents/revision-snapshot.ts).
 *   amountExTax  total - taxAmount, worked in whole cents so the figure is
 *                exact. On a quote that charges no tax it is the total.
 *
 * A REVISION WITHOUT A READABLE `totals.taxAmount` IS UNREADABLE, never
 * written at its tax-inclusive total instead -- that would put a figure with
 * tax in among the figures without, unmarked. Every snapshot both builders
 * have written carries it (finalizeDocument and
 * scripts/backfill-quote-revisions.ts both go through
 * documentToRevisionSnapshotInput, from a non-null Decimal, in version 1 and
 * version 2 alike), so this is a revision no finalise produced, refused the
 * way a missing validity is.
 *
 * `taxName` is the snapshot's: the tax the quote names, frozen at finalise --
 * the region's (GST, VAT, Sales Tax) on an Auto quote, export and reverse
 * charge included (src/lib/documents/tax-rules.ts keeps the name and charges
 * 0), or the salesperson's own on a Custom one. Null when the snapshot has
 * none, which only labels the amount: the body then says "ex tax".
 */
export type RevisionAmount =
  | { kind: "amount"; amountExTax: number; total: number; taxName: string | null }
  | { kind: "unreadable"; reason: string };

export function revisionAmount(total: { toString(): string }, snapshot: unknown): RevisionAmount {
  const totalCents = moneyCents(total.toString());
  if (totalCents === null) {
    return {
      kind: "unreadable",
      reason: `The revision of this quote being written to ACT! has no total PathQuote can read — ${ASK_DEVELOPER}`,
    };
  }
  const frozen = snapshotObject(snapshot);
  const totals = typeof frozen.totals === "object" && frozen.totals !== null ? (frozen.totals as Record<string, unknown>) : {};
  const taxCents = typeof totals.taxAmount === "string" ? moneyCents(totals.taxAmount) : null;
  if (taxCents === null) {
    return {
      kind: "unreadable",
      reason: `The revision of this quote being written to ACT! has no tax amount on record, so PathQuote cannot say what it comes to before tax, and will not send its total with tax in its place — ${ASK_DEVELOPER}`,
    };
  }
  const taxName = typeof frozen.taxName === "string" && frozen.taxName.trim() !== "" ? frozen.taxName.trim() : null;
  return { kind: "amount", amountExTax: (totalCents - taxCents) / 100, total: totalCents / 100, taxName };
}

function snapshotObject(snapshot: unknown): Record<string, unknown> {
  return typeof snapshot === "object" && snapshot !== null ? (snapshot as Record<string, unknown>) : {};
}

/**
 * A decimal string -- a Decimal(12,2)'s, or a snapshot's Money -- as whole
 * cents, or null when it is not one. Strict, where Number() is not: Number
 * reads "" and " " as 0, which would turn a blank figure into a real one.
 */
function moneyCents(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100);
}
