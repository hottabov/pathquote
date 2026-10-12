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
// No call into ACT! is made here, and no transaction is held open across
// one (requirement 3 in src/lib/act/outbox.ts): each write is one statement
// or one short transaction.

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  CONTACT_NOT_HELD_ERROR,
  ROW_CHANGED_ERROR,
  BAD_ACT_ID_ERROR,
  contactAbsentDecision,
  contactFoundDecision,
  dontSendDecision,
  duplicateContactError,
  heldForContactRelease,
  parseActContactId,
  tryAgainDecision,
  type AdminContact,
  type AdminRow,
  type DuplicateContact,
} from "@/lib/act/outbox-admin";
import { LATEST_ROW } from "@/lib/queries/act-quote";

/**
 * What an action came to: done, refused with a sentence for the
 * administrator, or no such quote -- which the server action turns into its
 * own NOT_FOUND_ERROR (src/lib/actions/_shared.ts), as every action does.
 */
export type AdminOutcome = { ok: true } | { ok: false; error: string } | { ok: false; notFound: true };

const NOT_FOUND = { ok: false, notFound: true } as const;

/** The quote's latest row and its contact, as the decisions read them; null for no such quote. */
async function readState(documentId: string): Promise<{ row: AdminRow | null; contact: AdminContact | null } | null> {
  const document = await db.document.findUnique({
    where: { id: documentId },
    select: {
      contact: { select: { id: true, actContactId: true, actCreateInFlightAt: true } },
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
 * two cannot deadlock. If the contact's guarded write finds it no longer held,
 * nothing is released either.
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
 * "ACT! has this person". The duplicate is looked for before the write, to
 * refuse with its name; and the write is caught for the unique key besides,
 * for a duplicate an inbound sync imports between the two.
 */
export async function contactFound(documentId: string, typedId: string, now: Date): Promise<AdminOutcome> {
  const actContactId = parseActContactId(typedId);
  if (!actContactId) return { ok: false, error: BAD_ACT_ID_ERROR };
  const state = await readState(documentId);
  if (!state) return NOT_FOUND;
  const duplicate = state.contact ? await duplicateOf(actContactId, state.contact.id) : null;
  const decision = contactFoundDecision({ row: state.row, contact: state.contact, actContactId, duplicate });
  if (!decision.ok) return decision;
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
