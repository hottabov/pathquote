// What an administrator may do about a quote's write into ACT!, from the
// quote's own page, and exactly what each of those writes to the database.
//
// Four actions, each a pure decision here -- is it allowed for this row, and
// what does it write -- carried out by src/lib/act/outbox-admin-store.ts,
// which reads the rows, calls these, and runs what they return, for the
// server actions in src/lib/actions/act-outbox.ts:
//
//   Try again now          a row held by ACT!'s answer, by its frozen
//                          revision, or by a lookup's duplicates
//                          (tryAgainDecision)
//   ACT! has this person   a quote held over a contact create whose outcome
//                          PathQuote never learned (contactFoundDecision),
//                          with the typed id checked against ACT! first
//                          (actContactCheck)
//   ACT! has nobody        the same quote, the other answer
//                          (contactAbsentDecision)
//   Don't send             any unfinished row (dontSendDecision)
//
// EVERY WRITE TO AN ActOutbox ROW IS GUARDED AS THE DRAIN'S ARE: on the row's
// id, the generation read with it, and completedAt IS NULL (requirement 1 in
// src/lib/act/outbox.ts, storeRow in src/lib/act/drain.ts) -- and it ADDS 1
// TO generation, as a take-over does. Both halves matter:
//
//   - The guard: an action decided on a row a drain or a take-over has
//     changed since the action read it writes nothing, and says so, rather
//     than clearing a block the drain has just set for a new reason or
//     finishing a row a signature has just taken over.
//   - The bump: a drain that read the row before the action stores guarded on
//     the generation IT read, so whatever it decided then finds no row; it
//     reads the row again and plans from what the administrator left -- the
//     same footing as a take-over. For "Don't send" the drain's own
//     `completedAt IS NULL` already stops it. For "Try again now" and the
//     release of a contact's quotes the row is held, which the drain works
//     only after its own guarded store has reopened it (a `drain` recheck),
//     but its pass over blocked rows reads them, and a re-block, an unblock
//     or a recheck it decided on the row as it was would otherwise land on
//     the row the administrator just released. The one
//     store of the drain's not guarded by generation is clearing a create's
//     marker on the row (requirement 1's exception), which an administrator's
//     action never sets or clears.
//
// What a drain cannot be stopped from is an ACT! call already on its way. A
// record that call makes is still stored where the drain keeps such things --
// the Document, the Contact, the QuoteRevision, none of them guarded by the
// row (requirement 1 again) -- so nothing ACT! made is lost track of; only
// the row's own progress is dropped, and the row is planned again from what
// the administrator left it.
//
// The Contact's writes are guarded on its own state instead, as the FOR TASK
// 10 SQL in src/lib/act/outbox-plan.ts is: the hold must still be there --
// no ACT! id, and the very marker the action read, so a hold released and
// set again by a newer create since the read is not the one settled.
//
// Pure: no I/O. `Prisma` is imported for its types only, so the no-database
// test suite (vitest.config.ts) can import this file; the ACT! client's
// error classes are imported to tell its failures apart, never to call it.

import type { Prisma } from "@prisma/client";
import { BLOCKED_BY } from "@/lib/act/drain-rules";
import { ActApiError, ActNoAnswerError, ActNotSentError, type ActRequestLimits } from "@/lib/act/client";
import { tryLaterStatus } from "@/lib/act/record-write";

/** The ActOutbox row, as an action reads it. */
export type AdminRow = {
  id: string;
  generation: number;
  completedAt: Date | null;
  blockedReason: string | null;
  blockedBy: string | null;
};

/** The quote's contact, as an action reads it. */
export type AdminContact = {
  id: string;
  actContactId: string | null;
  actCreateInFlightAt: Date | null;
};

/** A write to one ActOutbox row, guarded as the module header says. */
export type RowWrite = {
  where: { id: string; generation: number; completedAt: null };
  data: Prisma.ActOutboxUpdateManyMutationInput & { generation: number };
};

/** A write to the Contact, guarded on the hold still being there. */
export type ContactWrite = {
  where: Prisma.ContactWhereInput & { id: string };
  data: Prisma.ContactUpdateManyMutationInput;
};

export type Decision<W> = { ok: true; write: W } | { ok: false; error: string };

/** The rows a "Try again now" may release: held by one of these. */
const RETRYABLE: ReadonlySet<string> = new Set([BLOCKED_BY.act, BLOCKED_BY.revision, BLOCKED_BY.drain]);

/**
 * The row, guarded as the drain guards its own stores, with its generation
 * moved on. See the module header.
 */
function guarded(row: AdminRow, data: Prisma.ActOutboxUpdateManyMutationInput): RowWrite {
  return {
    where: { id: row.id, generation: row.generation, completedAt: null },
    data: { ...data, generation: row.generation + 1 },
  };
}

/**
 * Shown when the row is not in a state the action applies to any more, or
 * never was: finished, released, taken over. The page the administrator
 * pressed it on is out of date, and reloading it says where the quote stands.
 */
export const ROW_CHANGED_ERROR =
  "This quote's place in the queue for ACT! has changed since the page was opened — reload the page to see where it stands now.";

/** A quote with no row at all: nothing to act on. */
export const NO_ROW_ERROR = "This quote is not queued for ACT!, so there is nothing to change.";

/**
 * Whether the quote is held over its contact's create: its row unfinished and
 * held for its contact (blockedBy BLOCKED_BY.contact, set by the planner or
 * the drain's create), and its contact still held -- a create in flight and
 * no ACT! id.
 *
 * Blocked for exactly that, not merely unfinished: the marker is also set for
 * the second or so that every contact create takes, and "ACT! has nobody"
 * pressed in that second would clear the mark of a POST still in flight. A
 * row is held for its contact only once the drain has seen a create go
 * unaccounted for, or the planner has found the mark it left. A row the
 * planner holds for something it checks first -- an unmapped region -- is not
 * offered them, though its contact may be held: the reason it shows is not
 * about the contact.
 *
 * Read off blockedBy, never off blockedReason: that is a sentence for a
 * manager, and a reworded one must not take the contact actions away from a
 * quote still held for its contact.
 */
export function heldForContact(
  row: Pick<AdminRow, "completedAt" | "blockedBy"> | null,
  contact: Pick<AdminContact, "actContactId" | "actCreateInFlightAt"> | null,
): boolean {
  return (
    row !== null &&
    row.completedAt === null &&
    row.blockedBy === BLOCKED_BY.contact &&
    contact !== null &&
    contact.actContactId === null &&
    contact.actCreateInFlightAt !== null
  );
}

/** Which of the four actions the quote's page offers an administrator. */
export type AdminActions = {
  tryAgain: boolean;
  contactFound: boolean;
  contactAbsent: boolean;
  dontSend: boolean;
};

/**
 * What the page offers, from the same rules the decisions below enforce: a
 * button the page shows is one whose action would be allowed against the row
 * as the page read it.
 */
export function adminActionsFor(row: AdminRow | null, contact: AdminContact | null): AdminActions {
  const unfinished = row !== null && row.completedAt === null;
  const held = heldForContact(row, contact);
  return {
    tryAgain: unfinished && row.blockedReason !== null && row.blockedBy !== null && RETRYABLE.has(row.blockedBy),
    contactFound: held,
    contactAbsent: held,
    dontSend: unfinished,
  };
}

/**
 * "Try again now": a row held by ACT!'s answer (BLOCKED_BY.act), by a
 * revision the drain could not describe (`revision`), or by a lookup's
 * duplicates (`drain`). Its reason and who held it are cleared, attempts and
 * lastError reset, and it is due now -- the take-over's reset
 * (enqueueStatement in src/lib/act/outbox-sql.ts) without the take-over's
 * new revision: what it already got done stays done (opportunityActId,
 * productLineSkippedAt), and so does a create in flight (createInFlight),
 * which a take-over keeps too. So the next pass sends the same step again.
 *
 * Not for a row the planner blocked (blockedBy null), nor one held for its
 * contact (BLOCKED_BY.contact): the drain re-plans those every pass and
 * releases them itself once the cause is fixed -- for a contact, once it is
 * settled by the two contact actions -- and releasing one by hand before then
 * only has the next pass block it again.
 */
export function tryAgainDecision(row: AdminRow | null, now: Date): Decision<RowWrite> {
  if (!row) return { ok: false, error: NO_ROW_ERROR };
  if (!adminActionsFor(row, null).tryAgain) return { ok: false, error: ROW_CHANGED_ERROR };
  return {
    ok: true,
    write: guarded(row, {
      blockedReason: null,
      blockedBy: null,
      attempts: 0,
      lastError: null,
      nextAttemptAt: now,
    }),
  };
}

/**
 * "Don't send this quote to ACT!": any unfinished row, held or waiting, is
 * finished without being sent -- completedAt now, and blockedBy
 * BLOCKED_BY.admin, which is what the quote's page reads as "not sent" rather
 * than "in ACT!". blockedReason is cleared: it is a sentence about why the
 * write cannot go on, and nothing is going on.
 *
 * Not undone by anything here. The quote's next finalise, signature or
 * acceptance queues it afresh: the enqueue's ON CONFLICT takes over only an
 * UNFINISHED row (the partial unique index ActOutbox_documentId_unfinished_key
 * covers no other), so it inserts a new row, which the drain sends as usual.
 * That is the only way back, and the button's helper text says so.
 */
export function dontSendDecision(row: AdminRow | null, now: Date): Decision<RowWrite> {
  if (!row) return { ok: false, error: NO_ROW_ERROR };
  if (row.completedAt !== null) return { ok: false, error: ROW_CHANGED_ERROR };
  return {
    ok: true,
    write: guarded(row, { completedAt: now, blockedBy: BLOCKED_BY.admin, blockedReason: null }),
  };
}

/** ACT!'s ids are uuids: 8-4-4-4-12 hex digits. */
const ACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The ACT! contact id an administrator typed, trimmed and lowercased, or null
 * when it is not a uuid. Lowercased because ACT! writes its ids that way and
 * every id PathQuote holds came from ACT! as written (actContactId in
 * src/lib/act/map.ts): the same id pasted in capitals would otherwise slip
 * past both the duplicate check and Contact_actContactId_key, and one ACT!
 * person would have two PathQuote contacts.
 */
export function parseActContactId(text: string): string | null {
  const id = text.trim().toLowerCase();
  return ACT_ID.test(id) ? id : null;
}

/** Shown for an id that is not a uuid. */
export const BAD_ACT_ID_ERROR =
  "That is not an ACT! contact id. It is 36 characters: letters a to f and digits in five groups joined by dashes, like 2f6c1a9e-4b7d-4c2e-9a51-0d3e8f7b6a10.";

/** Shown when the contact is not held any more, or not as it was read: somebody, or the drain, got there first. */
export const CONTACT_NOT_HELD_ERROR =
  "This quote's contact is not held as it was any more — it has an ACT! id, or the hold was released. Reload the page to see where the quote stands now.";

/** Another PathQuote contact that already carries the ACT! id, as the refusal names it. */
export type DuplicateContact = { name: string; companyName: string };

/**
 * The refusal when another PathQuote contact already has the ACT! id --
 * usually the person ACT! did create, imported by an inbound sync as a second
 * contact (THE MERGE STAYS SQL, in FOR TASK 10 in src/lib/act/outbox-plan.ts).
 * Contact_actContactId_key would refuse the write anyway; this says what to do
 * about it. No merge is attempted here: moving quotes and signing requests
 * between contacts and deleting one is the developer's, by the runbook.
 */
export function duplicateContactError(actContactId: string, duplicate: DuplicateContact): string {
  return `${duplicate.name} at ${duplicate.companyName} is already in PathQuote with ACT! id ${actContactId} — most likely the same person, brought across from ACT! by a sync. PathQuote cannot give one ACT! id to two contacts, so the two have to be merged first: ask your developer to merge them, then this quote carries on.`;
}

/**
 * "ACT! has this person": the held contact is given the ACT! id an
 * administrator found -- the FOR TASK 10 UPDATE in src/lib/act/outbox-plan.ts,
 * as the drain's own store sets it: actContactId, actSyncState SYNCED, and
 * the marker cleared, guarded on the marker read still being there and no id
 * yet.
 *
 * `actContactId` is the typed text, parsed here (parseActContactId).
 * `duplicate` is whichever other contact carries that id, which the caller
 * looks up with the parsed id: present, it refuses.
 *
 * Not the whole of the check: before running the write, the caller asks ACT!
 * for the contact and refuses on actContactCheck's verdict. Decided here
 * first, so that a quote no longer held, or an id another contact carries,
 * is refused without a call into ACT!.
 */
export function contactFoundDecision(input: {
  row: AdminRow | null;
  contact: AdminContact | null;
  actContactId: string;
  duplicate: DuplicateContact | null;
}): Decision<ContactWrite> {
  const id = parseActContactId(input.actContactId);
  if (!id) return { ok: false, error: BAD_ACT_ID_ERROR };
  if (!input.row) return { ok: false, error: NO_ROW_ERROR };
  if (!heldForContact(input.row, input.contact) || !input.contact) {
    return { ok: false, error: CONTACT_NOT_HELD_ERROR };
  }
  if (input.duplicate) return { ok: false, error: duplicateContactError(id, input.duplicate) };
  return {
    ok: true,
    write: {
      where: { id: input.contact.id, actCreateInFlightAt: input.contact.actCreateInFlightAt, actContactId: null },
      data: { actContactId: id, actSyncState: "SYNCED", actCreateInFlightAt: null },
    },
  };
}

/**
 * The ACT! client's limits for the check behind "ACT! has this person": one
 * attempt per request, of 10 seconds.
 *
 * The administrator's browser waits on the server action behind nginx, which
 * on the VPS stops waiting after 60 seconds (its proxy_read_timeout default,
 * measured 2026-10-10; the HOW LONG THIS BLOCKS note on runActSyncNow in
 * src/lib/actions/act-sync.ts). Under the client's
 * usual limits (DEFAULT_REQUEST_LIMITS in src/lib/act/client.ts: three
 * attempts of 30 seconds, with 1s and 2s between them) a single GET to a hung
 * ACT! takes 93 seconds to give up, and the login before it as long again:
 * the button would spin past nginx's limit and show a gateway error, while
 * the action might still link the contact behind it. Under these, the check's
 * four requests at most -- the login, the GET, and after a 401 the login and
 * the GET again (singleReadBudgetMs) -- give up within 40 seconds, which
 * leaves the action's database reads and its write the rest of nginx's 60.
 *
 * 10 seconds because what is asked for is one contact by its id, a single
 * small record, where the usual 30 seconds and three attempts were set for
 * the inbound sync -- ~88 pages of 200 contacts, which one hung connection
 * must not end (the note on REQUEST_TIMEOUT_MS in client.ts); an ACT! that
 * has not answered one record in 10 seconds will not answer in time for
 * this. One attempt because a
 * second would double the wait for an ACT! that is not answering, and the
 * refusal (ACT_UNREACHABLE_ERROR) already says to try again in a few minutes:
 * the administrator's next press is the retry.
 */
export const ACT_CONTACT_CHECK_LIMITS: ActRequestLimits = { timeoutMs: 10_000, attempts: 1 };

/** What ACT! said when asked for the contact behind a typed id. */
export type ActContactLookup =
  | { kind: "found"; firstName: string | null; lastName: string | null; email: string | null }
  /** ACT! answered 404: it has no contact with that id. */
  | { kind: "missing" }
  /** No answer, or one that says to come back: worth trying again shortly. */
  | { kind: "unreachable" }
  /** Anything else -- a login refused, a record denied, PathQuote's own setup: not mended by waiting. */
  | { kind: "failed" };

/**
 * The lookup's verdict for an error the ACT! client threw asking for one
 * contact (ActClient.getContact). Unreachable is what retrying can mend:
 * nothing sent or no answer (ActNotSentError, ActNoAnswerError -- which,
 * under ACT_CONTACT_CHECK_LIMITS, is a request that timed out once, or a
 * login that did, which the client reports as ActNotSentError), a 408 or
 * 429, or a 5xx. Everything else, a missing ACT_* variable included, is
 * `failed`.
 */
export function actLookupFailure(error: unknown): ActContactLookup {
  if (error instanceof ActApiError) {
    if (error.status === 404) return { kind: "missing" };
    if (tryLaterStatus(error.status) || error.status >= 500) return { kind: "unreachable" };
    return { kind: "failed" };
  }
  if (error instanceof ActNotSentError || error instanceof ActNoAnswerError) return { kind: "unreachable" };
  return { kind: "failed" };
}

/** Shown when ACT! answers that it has no contact with the typed id. */
export function noSuchActContactError(actContactId: string): string {
  return `ACT! has no contact with the id ${actContactId}, so nothing was linked. Copy the id from the person's record in ACT! again, and check it is a contact's id rather than a company's or an opportunity's.`;
}

/** Shown when ACT! could not be asked about the id. Nothing is written on an id ACT! has not confirmed. */
export const ACT_UNREACHABLE_ERROR =
  "PathQuote could not reach ACT! to check that id, so nothing was linked. Try again in a few minutes.";

/** Shown when ACT! was reached but would not give the contact, for a reason waiting does not mend. */
export const ACT_LOOKUP_FAILED_ERROR =
  "PathQuote could not read that contact from ACT! to check it, so nothing was linked. Ask your developer — PathQuote's log says what ACT! answered.";

/** The PathQuote contact being linked, as actContactCheck compares it. */
export type HeldContactIdentity = { firstName: string; lastName: string | null; email: string | null };

/** A name as compared: first and last, trimmed, spaces collapsed, case ignored. */
function comparableName(first: string | null, last: string | null): string {
  return `${first ?? ""} ${last ?? ""}`.trim().replace(/\s+/g, " ").toLowerCase();
}

/** An email as compared: trimmed, case ignored; empty is no email. */
function comparableEmail(email: string | null): string {
  return (email ?? "").trim().toLowerCase();
}

/** A person as the mismatch refusal prints them: name, and email or "no email". */
function printed(name: string, email: string | null): string {
  const shownName = name.trim() === "" ? "no name" : name.trim();
  const shownEmail = (email ?? "").trim();
  return `${shownName} (${shownEmail === "" ? "no email" : shownEmail})`;
}

/**
 * Whether the contact ACT! holds under the typed id can be linked to the
 * held PathQuote contact: null when it can, else the sentence refusing it.
 *
 *   missing      ACT! has no contact with that id: refused, naming the id.
 *   unreachable  refused, and nothing written -- an id ACT! has not
 *                confirmed is never linked: try again.
 *   failed       refused, for the developer.
 *   found        refused only when NEITHER the name NOR the email matches.
 *
 * The rule for `found` is deliberately the floor, not more. Requiring both
 * to match would refuse the legitimate cases this action exists for: the
 * person's email changed in ACT! since, or their name was spelt differently
 * there, or ACT! holds no email for them. What it catches is an id copied
 * from the wrong record -- a different person entirely -- before every later
 * write for this contact goes to them. A name matches on first and last
 * together (comparableName); an email only when both sides have one.
 */
export function actContactCheck(input: {
  actContactId: string;
  lookup: ActContactLookup;
  held: HeldContactIdentity;
}): string | null {
  const { lookup, held } = input;
  switch (lookup.kind) {
    case "missing":
      return noSuchActContactError(input.actContactId);
    case "unreachable":
      return ACT_UNREACHABLE_ERROR;
    case "failed":
      return ACT_LOOKUP_FAILED_ERROR;
    case "found": {
      const heldName = comparableName(held.firstName, held.lastName);
      const actName = comparableName(lookup.firstName, lookup.lastName);
      const heldEmail = comparableEmail(held.email);
      const actEmail = comparableEmail(lookup.email);
      const nameMatches = heldName !== "" && heldName === actName;
      const emailMatches = heldEmail !== "" && heldEmail === actEmail;
      if (nameMatches || emailMatches) return null;
      const ours = printed(`${held.firstName} ${held.lastName ?? ""}`, held.email);
      const theirs = printed(`${lookup.firstName ?? ""} ${lookup.lastName ?? ""}`, lookup.email);
      return `The ACT! contact with that id is ${theirs}, but this quote's contact is ${ours} — neither the name nor the email matches, so nothing was linked. Check the id was copied from the right person in ACT!. If it is the same person, correct the name or the email on one side so that one of them matches, then try again.`;
    }
  }
}

/**
 * "ACT! has nobody": the hold is released -- the marker cleared, guarded on
 * the contact still having no ACT! id, as the FOR TASK 10 release is, and on
 * the marker being the one read -- and
 * the next pass creates the contact in ACT!. If ACT! did hold them, that is a
 * second person in ACT!; the button's helper text and its confirmation say
 * so, and that is the whole of the protection.
 */
export function contactAbsentDecision(row: AdminRow | null, contact: AdminContact | null): Decision<ContactWrite> {
  if (!row) return { ok: false, error: NO_ROW_ERROR };
  if (!heldForContact(row, contact) || !contact) return { ok: false, error: CONTACT_NOT_HELD_ERROR };
  return {
    ok: true,
    write: {
      where: { id: contact.id, actContactId: null, actCreateInFlightAt: contact.actCreateInFlightAt },
      data: { actCreateInFlightAt: null },
    },
  };
}

/**
 * After either contact action: every quote on the contact that the hold kept
 * back is made due now -- its reason and who held it cleared, due now,
 * guarded like any row write.
 *
 * NOT NEEDED FOR CORRECTNESS. The drain re-plans every blocked row at the
 * start of each pass, finds nextStep no longer blocking on the contact, and
 * unblocks these rows itself (replanBlocked in src/lib/act/drain-rules.ts) --
 * within 15 minutes, at the periodic drain. Done here so that every quote on
 * the contact, and the Settings list, stops saying it is held for the contact
 * the moment an administrator has settled it, rather than for up to a quarter
 * of an hour after.
 *
 * Only rows still held for exactly that: unfinished, and held for their
 * contact (blockedBy BLOCKED_BY.contact), whatever their blockedReason says.
 * A row on the same contact the planner holds for something else -- an
 * unmapped region, which nextStep checks first -- is left to the drain, which
 * would only block it again. attempts and lastError
 * are left as they are: the row was not refused, and its history of failures
 * before the hold, if any, still stands.
 */
export function heldForContactRelease(rows: readonly AdminRow[], now: Date): RowWrite[] {
  return rows
    .filter((row) => row.completedAt === null && row.blockedBy === BLOCKED_BY.contact)
    .map((row) => guarded(row, { blockedReason: null, blockedBy: null, nextAttemptAt: now }));
}
