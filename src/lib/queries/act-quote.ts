// What a quote's own page needs to say about its write into ACT!, and what an
// administrator's actions there decide on. The I/O half only: the words are
// describeQuoteAct in src/lib/act/quote-act-view.ts, the decisions are in
// src/lib/act/outbox-admin.ts, and both are tested without a database.

import { db } from "@/lib/db";
import { readActWriteSwitch } from "@/lib/act/drain";
import type { AdminContact, AdminRow } from "@/lib/act/outbox-admin";
import type { QuoteActFacts } from "@/lib/act/quote-act-view";
import { documentWhereForUser, type ScopeUser } from "@/lib/scope";

/** A contact's name as the card prints it. */
function contactName(contact: { firstName: string; lastName: string | null }): string {
  return `${contact.firstName} ${contact.lastName ?? ""}`.trim();
}

/**
 * The quote's latest ActOutbox row: the unfinished one when there is one --
 * there is never more than one (ActOutbox_documentId_unfinished_key) -- or
 * else the one that finished last. `completedAt` descending with nulls first
 * says exactly that; `createdAt` and `id` break a tie between two rows
 * finished in the same millisecond, which only a test makes. The
 * administrator's actions read the row they act on the same way
 * (src/lib/act/outbox-admin-store.ts), so they act on the row the page showed.
 */
export const LATEST_ROW = [
  { completedAt: { sort: "desc", nulls: "first" } },
  { createdAt: "desc" },
  { id: "desc" },
] as const;

const ROW_SELECT = {
  id: true,
  generation: true,
  attempts: true,
  lastError: true,
  nextAttemptAt: true,
  completedAt: true,
  blockedReason: true,
  blockedBy: true,
  productLineSkippedAt: true,
  quoteRevision: { select: { revision: true, label: true, actHistoryId: true } },
} as const;

export type QuoteActState = {
  facts: QuoteActFacts;
  /** The latest row, as the administrator's decisions read it. */
  row: AdminRow | null;
  /** The quote's contact, as the administrator's decisions read it. */
  contact: AdminContact | null;
};

/**
 * Everything the quote's ACT! card and its buttons need, for a quote `user`
 * may open -- null for any other, scoped by documentWhereForUser exactly as
 * the page's own read (getDocumentForBuilder) is, so this never says more
 * about a quote than the page it sits on.
 */
export async function getQuoteActState(user: ScopeUser, documentId: string): Promise<QuoteActState | null> {
  const document = await db.document.findFirst({
    where: { id: documentId, ...documentWhereForUser(user) },
    select: {
      status: true,
      signingStatus: true,
      acceptedAt: true,
      number: true,
      currency: true,
      currencySymbol: true,
      actOpportunityId: true,
      actOpportunityWonAt: true,
      actContactPromotedForId: true,
      actProductLineRevision: true,
      contact: {
        select: { id: true, firstName: true, lastName: true, actContactId: true, actCreateInFlightAt: true },
      },
      actOutbox: { orderBy: [...LATEST_ROW], take: 1, select: ROW_SELECT },
      _count: { select: { revisions: true } },
    },
  });
  if (!document) return null;

  // The revision the product line shows, for its label and figure. By number,
  // since that is what Document.actProductLineRevision holds.
  const line =
    document.actProductLineRevision === null
      ? null
      : await db.quoteRevision.findFirst({
          where: { documentId, revision: document.actProductLineRevision },
          select: { revision: true, label: true, total: true },
        });

  const sendingOn = await readActWriteSwitch();
  const latest = document.actOutbox[0] ?? null;
  const contact = document.contact;

  return {
    facts: {
      status: document.status,
      signingStatus: document.signingStatus,
      acceptedAt: document.acceptedAt,
      number: document.number,
      currency: document.currency,
      currencySymbol: document.currencySymbol,
      hasRevision: document._count.revisions > 0,
      sendingOn,
      contact: contact
        ? {
            name: contactName(contact),
            actContactId: contact.actContactId,
            actCreateInFlightAt: contact.actCreateInFlightAt,
          }
        : null,
      actOpportunityId: document.actOpportunityId,
      actOpportunityWonAt: document.actOpportunityWonAt,
      actContactPromotedForId: document.actContactPromotedForId,
      line: line ? { revision: line.revision, label: line.label, total: line.total.toString() } : null,
      row: latest
        ? {
            attempts: latest.attempts,
            lastError: latest.lastError,
            nextAttemptAt: latest.nextAttemptAt,
            completedAt: latest.completedAt,
            blockedReason: latest.blockedReason,
            blockedBy: latest.blockedBy,
            productLineSkippedAt: latest.productLineSkippedAt,
            revision: latest.quoteRevision,
          }
        : null,
    },
    row: latest
      ? {
          id: latest.id,
          generation: latest.generation,
          completedAt: latest.completedAt,
          blockedReason: latest.blockedReason,
          blockedBy: latest.blockedBy,
        }
      : null,
    contact: contact
      ? { id: contact.id, actContactId: contact.actContactId, actCreateInFlightAt: contact.actCreateInFlightAt }
      : null,
  };
}
