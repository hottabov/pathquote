// What a queued ACT! write still has to do, decided from what it has already
// stored and the quote as it stands now.
//
// One finalise queues one outbox row, and the row is a short sequence of
// steps, each one a single request to ACT!:
//
//   create-contact      only when the quote's contact exists only in PathQuote
//   create-opportunity  only when the deal has no opportunity yet
//   update-opportunity  instead, when an earlier revision already made one
//   write-history       one History record for this revision
//
// THE PROPERTY THE DESIGN RESTS ON. Every step stores its result before the
// next step begins, and this planner looks at nothing but those stored
// results. So a row that fails halfway -- a timeout, a restart, ACT! down for
// the night -- is re-planned from what it actually got done, and resumes at
// the next step instead of starting again. That is the whole of this design's
// idempotency, and the reason the write is a sequence of steps rather than one
// call. A step that succeeded in ACT! but died before its result was stored is
// the one window that can repeat, and only that one step.
//
// Where each result lives:
//
//   create-contact      Contact.actContactId -- on the contact itself, so a
//                       contact created for one quote is already "in ACT!"
//                       for every later one, exactly like an imported contact.
//   create-opportunity  Document.actOpportunityId (the deal's opportunity, for
//                       every revision after this one) and the row's own
//                       opportunityActId (this row's step is done).
//   update-opportunity  the row's opportunityActId. An update mints no new id,
//                       so the row records which opportunity it updated; that
//                       is what stops a resumed row updating it twice.
//   write-history       the row's historyActId.
//
// ONE OPPORTUNITY PER DEAL. Document.actOpportunityId is per quote, not per
// revision, so a re-finalise after a revision finds it set and updates rather
// than creating a second opportunity for the same deal.
//
// BLOCKED REASONS ARE READ BY A MANAGER on the quote, so they are sentences
// that say what to do, in the voice of src/lib/act/sync-view.ts: a fault the
// manager can fix names the fix; a fault only PathQuote's configuration can
// fix says "ask your developer". Every blocking check runs before the first
// step, so a row that cannot finish never leaves half a deal in ACT!.
//
// Pure: no I/O. The drain reads the row and the quote, calls nextStep, performs
// the one step it names, stores its result, and asks again.

import { processForRegion } from "@/lib/act/opportunity-stages";

/** What this outbox row has already stored. */
export type OutboxProgress = {
  /**
   * The opportunity this row's opportunity step created or updated. Null
   * until that step has succeeded and been stored.
   */
  opportunityActId: string | null;
  /** The History record this row wrote. Null until it has been written and stored. */
  historyActId: string | null;
};

/** The quote, as it stands now, reduced to what the plan depends on. */
export type QuoteState = {
  /** Region.code of Document.regionId. */
  regionCode: string;
  /** The quote's contact (Document.contactId), or null when it has none. */
  contact: {
    /** Contact.actContactId: null when the contact exists only in PathQuote. */
    actContactId: string | null;
    firstName: string;
    lastName: string | null;
  } | null;
  /** Document.actOpportunityId: the deal's opportunity, from this revision or an earlier one. */
  actOpportunityId: string | null;
};

export type OutboxStep =
  | { kind: "create-contact" }
  | { kind: "create-opportunity" }
  | { kind: "update-opportunity" }
  | { kind: "write-history" }
  | { kind: "done" }
  | { kind: "blocked"; reason: string };

/**
 * Finalize does not require a contact (validateFinalizable never looks at
 * one; see `hasContact` in src/lib/quote-readiness.ts). The builder fills in
 * a contact when a company is picked -- the primary one, else the first -- but
 * a company with no contacts leaves nothing to fill in, so a FINAL quote can
 * legally carry a company and nobody. An opportunity and a history both hang
 * off a contact.
 *
 * Unfinalize first, because only a draft's contact can be changed
 * (setDocumentClient in src/lib/actions/documents/lifecycle.ts).
 */
export const NO_CONTACT_REASON =
  "This quote has no contact, so there is nobody in ACT! to attach it to — unfinalize it, choose a contact and finalize it again.";

/** ACT! is asked to create the contact, and a contact with no name is nothing to create. */
export const NAMELESS_CONTACT_REASON =
  "This quote's contact has no name, so ACT! has nothing to create them under — give the contact a name in Clients.";

/**
 * A region processForRegion has no entry for. Not something a manager can
 * fix: the mapping is in src/lib/act/opportunity-stages.ts.
 */
export function unmappedRegionReason(regionCode: string): string {
  return `This quote is in the ${regionCode} region, and PathQuote has no ACT! sales process for ${regionCode}, so there is no pipeline to put it in — ask your developer to map ${regionCode} to one.`;
}

function hasName(contact: { firstName: string; lastName: string | null }): boolean {
  return `${contact.firstName} ${contact.lastName ?? ""}`.trim() !== "";
}

export function nextStep(progress: OutboxProgress, quote: QuoteState): OutboxStep {
  // A finished row is finished. Nothing that has happened to the quote since
  // -- an unfinalize, a contact removed -- reaches back into a write that has
  // already gone through.
  if (progress.historyActId) return { kind: "done" };

  // Blocking checks, all before any step, so nothing is half-made in ACT!.
  // The contact first: it is the common case, and the one the reader can fix.
  if (!quote.contact) return { kind: "blocked", reason: NO_CONTACT_REASON };
  if (!processForRegion(quote.regionCode)) {
    return { kind: "blocked", reason: unmappedRegionReason(quote.regionCode) };
  }

  if (!quote.contact.actContactId) {
    // The name only matters when ACT! is about to be asked to create one.
    if (!hasName(quote.contact)) return { kind: "blocked", reason: NAMELESS_CONTACT_REASON };
    return { kind: "create-contact" };
  }

  if (!progress.opportunityActId) {
    return quote.actOpportunityId ? { kind: "update-opportunity" } : { kind: "create-opportunity" };
  }

  return { kind: "write-history" };
}
