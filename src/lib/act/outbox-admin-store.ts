// The administrator's four actions on a quote's ACT! write, against the
// database: read the row and the contact, ask the decision in
// src/lib/act/outbox-admin.ts, and run the guarded write it returns. Every
// rule is there; this file only reads, writes, and turns "no row matched"
// into the sentence for it.
//
// Not a "use server" module, and checks nobody's role: the server actions in
// src/lib/actions/act-outbox.ts call requireAdmin first and then these. Kept
// apart so the guarded writes can be run against a real PostgreSQL, racing a
// drain, without a session.
//
// One call into ACT! is made here: "ACT! has this person" reads the typed id
// back from ACT! (lookUpActContact) before it writes anything. It is made
// between the reads and the write, never inside a transaction, so no row or
// contact is locked while ACT! answers (requirement 3 in
// src/lib/act/outbox.ts): each write is one statement or one short
// transaction, and the contact's write is guarded on the hold the action read
// -- so a hold the drain or another administrator changed during the call is
// not settled on the strength of it.

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { actClientFromEnv } from "@/lib/act/client";
import {
  CONTACT_NOT_HELD_ERROR,
  ROW_CHANGED_ERROR,
  BAD_ACT_ID_ERROR,
  actContactCheck,
  actLookupFailure,
  contactAbsentDecision,
  contactFoundDecision,
  dontSendDecision,
  duplicateContactError,
  heldForContactRelease,
  parseActContactId,
  tryAgainDecision,
  type ActContactLookup,
  type AdminContact,
  type AdminRow,
  type DuplicateContact,
  type HeldContactIdentity,
} from "@/lib/act/outbox-admin";
import { LATEST_ROW } from "@/lib/queries/act-quote";

/**
 * What an action came to: done, refused with a sentence for the
 * administrator, or no such quote -- which the server action turns into its
 * own NOT_FOUND_ERROR (src/lib/actions/_shared.ts), as every action does.
 */
export type AdminOutcome = { ok: true } | { ok: false; error: string } | { ok: false; notFound: true };

const NOT_FOUND = { ok: false, notFound: true } as const;

/**
 * The quote's latest row and its contact, as the decisions read them, and the
 * contact's name and email for actContactCheck; null for no such quote.
 */
async function readState(
  documentId: string,
): Promise<{ row: AdminRow | null; contact: (AdminContact & HeldContactIdentity) | null } | null> {
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: {
      contact: {
        select: { id: true, actContactId: true, actCreateInFlightAt: true, firstName: true, lastName: true, email: true },
      },
      actOutbox: {
        orderBy: [...LATEST_ROW],
        take: 1,
        select: { id: true, generation: true, completedAt: true, blockedReason: true, blockedBy: true },
      },
    },
  });
  if (!document) return null;
  return { row: document.actOutbox[0] ?? null, contact: document.contact };
}

/** One guarded row write; no row matched means the row changed under the page. */
async function writeRow(write: { where: Prisma.ActOutboxWhereInput; data: Prisma.ActOutboxUpdateManyMutationInput }): Promise<AdminOutcome> {
  const { count } = await db.actOutbox.updateMany(write);
  return count === 1 ? { ok: true } : { ok: false, error: ROW_CHANGED_ERROR };
}

/** "Try again now". See tryAgainDecision. */
export async function tryAgainNow(documentId: string, now: Date): Promise<AdminOutcome> {
  const state = await readState(documentId);
  if (!state) return NOT_FOUND;
  const decision = tryAgainDecision(state.row, now);
  if (!decision.ok) return decision;
  return writeRow(decision.write);
}

/** "Don't send this quote to ACT!". See dontSendDecision. */
export async function dontSend(documentId: string, now: Date): Promise<AdminOutcome> {
  const state = await readState(documentId);
  if (!state) return NOT_FOUND;
  const decision = dontSendDecision(state.row, now);
  if (!decision.ok) return decision;
  return writeRow(decision.write);
}

/**
 * Another contact carrying this ACT! id, compared without regard to case: the
 * id is stored as ACT! wrote it, and Contact_actContactId_key compares
 * exactly, so an id held in other capitals would pass the key and still be
 * the same person.
 */
async function duplicateOf(actContactId: string, exceptContactId: string): Promise<DuplicateContact | null> {
  const other = await db.contact.findFirst({
    where: { actContactId: { equals: actContactId, mode: "insensitive" }, id: { not: exceptContactId } },
    select: { firstName: true, lastName: true, company: { select: { name: true } } },
  });
  return other
    ? { name: `${other.firstName} ${other.lastName ?? ""}`.trim(), companyName: other.company.name }
    : null;
}

/** Thrown inside a contact action's transaction to roll it back when the contact is no longer held. */
class ContactNotHeld extends Error {}

/**
 * Settle a held contact: its write, and the release of every quote held for
 * it (heldForContactRelease), in one transaction -- the rows first and the
 * contact second, the order in which the drain takes the same two locks
 * before a contact create (setContactMarker in src/lib/act/drain.ts), so the
 * two cannot deadlock. If the contact's guarded write finds it no longer held
 * as it was read, nothing is released either.
 */
async function settleContact(
  contactId: string,
  write: { where: Prisma.ContactWhereInput; data: Prisma.ContactUpdateManyMutationInput },
  now: Date,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const rows = await tx.actOutbox.findMany({
      where: { completedAt: null, document: { contactId } },
      select: { id: true, generation: true, completedAt: true, blockedReason: true, blockedBy: true },
    });
    for (const release of heldForContactRelease(rows, now)) {
      await tx.actOutbox.updateMany(release);
    }
    const { count } = await tx.contact.updateMany(write);
    if (count !== 1) throw new ContactNotHeld();
  });
}

/**
 * The contact ACT! holds under `actContactId`, or why it could not say
 * (actLookupFailure). A failure is logged for the developer, whom
 * ACT_LOOKUP_FAILED_ERROR sends the administrator to; a 404 is ACT!'s
 * answer, not a failure, and is not logged.
 */
async function lookUpActContact(actContactId: string): Promise<ActContactLookup> {
  try {
    const contact = await actClientFromEnv().getContact(actContactId);
    return { kind: "found", firstName: contact.firstName, lastName: contact.lastName, email: contact.emailAddress };
  } catch (error) {
    const lookup = actLookupFailure(error);
    if (lookup.kind !== "missing") {
      console.error("[act] could not read an ACT! contact an administrator typed in; nothing was linked", {
        actContactId,
        error,
      });
    }
    return lookup;
  }
}

/**
 * "ACT! has this person". The duplicate is looked for before the write, to
 * refuse with its name; and the write is caught for the unique key besides,
 * for a duplicate an inbound sync imports in between -- a window that
 * includes the call into ACT!.
 *
 * Then ACT! is asked for the id (lookUpActContact), after every check that
 * needs no ACT! and before any write, and outside any transaction: an id ACT!
 * does not confirm, or one that belongs to somebody else by both name and
 * email, is refused (actContactCheck) and nothing is written.
 */
export async function contactFound(documentId: string, typedId: string, now: Date): Promise<AdminOutcome> {
  const actContactId = parseActContactId(typedId);
  if (!actContactId) return { ok: false, error: BAD_ACT_ID_ERROR };
  const state = await readState(documentId);
  if (!state) return NOT_FOUND;
  const duplicate = state.contact ? await duplicateOf(actContactId, state.contact.id) : null;
  const decision = contactFoundDecision({ row: state.row, contact: state.contact, actContactId, duplicate });
  if (!decision.ok) return decision;
  // contactFoundDecision has already refused a quote with no contact.
  if (!state.contact) return { ok: false, error: CONTACT_NOT_HELD_ERROR };
  const refusal = actContactCheck({ actContactId, lookup: await lookUpActContact(actContactId), held: state.contact });
  if (refusal) return { ok: false, error: refusal };
  try {
    await settleContact(decision.write.where.id, decision.write, now);
    return { ok: true };
  } catch (error) {
    if (error instanceof ContactNotHeld) return { ok: false, error: CONTACT_NOT_HELD_ERROR };
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const late = await duplicateOf(actContactId, decision.write.where.id);
      if (late) return { ok: false, error: duplicateContactError(actContactId, late) };
    }
    throw error;
  }
}

/** "ACT! has nobody". See contactAbsentDecision. */
export async function contactAbsent(documentId: string, now: Date): Promise<AdminOutcome> {
  const state = await readState(documentId);
  if (!state) return NOT_FOUND;
  const decision = contactAbsentDecision(state.row, state.contact);
  if (!decision.ok) return decision;
  try {
    await settleContact(decision.write.where.id, decision.write, now);
    return { ok: true };
  } catch (error) {
    if (error instanceof ContactNotHeld) return { ok: false, error: CONTACT_NOT_HELD_ERROR };
    throw error;
  }
}
