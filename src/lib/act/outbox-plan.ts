// What a queued ACT! write still has to do, decided from what has already been
// stored and the quote as it stands now.
//
// One finalise queues one outbox row for one revision -- the revision that
// finalise created, or the one it kept when nothing had changed (planRevision
// in src/lib/documents/revision-plan.ts keeps the number for an unchanged
// snapshot). The row is a short sequence of steps, each one a single request
// to ACT!:
//
//   create-contact      only when the quote's contact exists only in PathQuote
//   create-opportunity  only when the deal has no opportunity yet
//   update-opportunity  instead, when an earlier revision already made one
//   write-history       one History record for this revision
//
// THE STORED FIELDS THIS PLANNER READS, and the model each lives on. The
// schema (Task 4) is built from this list: a result stored anywhere else is a
// result the planner cannot see, and a step it cannot see done is a step it
// runs again.
//
//   Progress -- each one written by the step named beside it:
//
//   Contact.actContactId         create-contact (or the import, for a contact
//                                that was always in ACT!). On the contact, so
//                                a contact created for one quote is already
//                                "in ACT!" for every later one.
//   Document.actOpportunityId    create-opportunity. The deal's opportunity,
//                                one per quote, for every later revision.
//   ActOutbox.opportunityActId   create-opportunity and update-opportunity.
//                                This row's opportunity step is done. An
//                                update mints no new id, so the row records
//                                which opportunity it updated; that is what
//                                stops a resumed row updating it twice.
//   QuoteRevision.actHistoryId   write-history, on the revision the row was
//                                queued for. So the row has to say which:
//                                ActOutbox.quoteRevisionId, which the drain
//                                follows to hand this planner that revision's
//                                actHistoryId.
//
//   The quote -- existing columns, read as they stand now:
//
//   Document.contactId           null means no contact (blocked).
//   Contact.firstName/lastName   whether a contact ACT! must create has a name.
//   Region.code                  of Document.regionId: which sales process.
//
// Of these, Contact.actContactId already exists; ActOutbox.opportunityActId,
// ActOutbox.quoteRevisionId, Document.actOpportunityId and
// QuoteRevision.actHistoryId are Task 4's to add.
//
// ONE HISTORY PER REVISION, so its progress is on the revision, not the row. A
// manager can unfinalise a quote whose row has finished and re-finalise it
// without changing anything; planRevision then keeps the revision number and
// creates no new revision, but a new row is queued all the same (the plan has
// Task 6 hold one UNFINISHED row per document, and the old one has finished).
// Held on the row, "history written" would start null on that new row and
// journal the same revision twice. Held on QuoteRevision, the new row finds it
// set and is done.
//
// ONE OPPORTUNITY PER DEAL. Document.actOpportunityId is per quote, not per
// revision, so a re-finalise after a revision finds it set and updates rather
// than creating a second opportunity for the same deal.
//
// STEPS RESUME, AND ONE WINDOW REPEATS. Every step stores its result before the
// next step begins, and this planner looks at nothing but those stored
// results. So a row that fails halfway -- a timeout, a restart, ACT! down for
// the night -- is re-planned from what it actually got done, and resumes at
// the next step instead of starting again. That is the whole of this design's
// idempotency, and the reason the write is a sequence of steps rather than one
// call.
//
// The window: a step that succeeded in ACT! but died before its result was
// stored runs again, and only that step. What a repeat costs depends on the
// step -- a repeated create-contact is a DUPLICATE CONTACT in ACT!, a repeated
// create-opportunity is a SECOND OPPORTUNITY FOR THE DEAL, a repeated
// write-history is a second History for the revision; a repeated
// update-opportunity sends the same patch again and is harmless. Nothing here
// can close that window; the drain (Task 7) can only keep it short, by storing
// each result the moment ACT! answers, before doing anything else with it.
//
// A REQUIREMENT ON THE DRAIN (Task 7): after create-opportunity, the two
// stores -- Document.actOpportunityId and the row's opportunityActId -- MUST be
// one database transaction. If the row's is saved and the Document's is not,
// this row moves on to write-history believing the deal has its opportunity,
// and the next revision's row finds Document.actOpportunityId null and creates
// a second opportunity for the same deal. (The other way round only re-runs
// this row's step as an update, which is harmless.)
//
// BLOCKED REASONS ARE READ BY A MANAGER on the quote, so they are sentences
// that say what to do, in the voice of src/lib/act/sync-view.ts: a fault the
// manager can fix names the fix; a fault only PathQuote's configuration can
// fix says "ask your developer". The blocking checks run before every step,
// not once: for a fresh row that means before anything is created in ACT!, so
// a row blocked from the start leaves nothing behind. A row can also become
// blocked partway -- unfinalise it after its contact or opportunity was
// created, pick a company with no contacts -- and then it keeps what it
// already created: the contact and the opportunity stay in ACT!, recorded on
// Contact and Document, and nothing here undoes them.
//
// Pure: no I/O. The drain reads the row, its revision and the quote, calls
// nextStep, performs the one step it names, stores its result, and asks again.

import { processForRegion } from "@/lib/act/opportunity-stages";

/** What this outbox row (ActOutbox) has stored of its own. */
export type OutboxProgress = {
  /**
   * ActOutbox.opportunityActId: the opportunity this row's opportunity step
   * created or updated. Null until that step has succeeded and been stored.
   */
  opportunityActId: string | null;
};

/** What the revision this row was queued for (ActOutbox.quoteRevisionId) has stored. */
export type RevisionProgress = {
  /**
   * QuoteRevision.actHistoryId: this revision's History record in ACT!. Null
   * until some row has written it and stored it -- not necessarily this row.
   */
  actHistoryId: string | null;
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
 * (setDocumentClient in src/lib/actions/documents/lifecycle.ts). "Choose or
 * add": the usual cause is a company with no contacts at all, where there is
 * nobody to choose and the builder's "New contact" is the way out.
 */
export const NO_CONTACT_REASON =
  "This quote has no contact, so there is nobody in ACT! to attach it to — unfinalize it, choose or add a contact, and finalize it again.";

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

export function nextStep(
  progress: OutboxProgress,
  revision: RevisionProgress,
  quote: QuoteState,
): OutboxStep {
  // A revision already journaled is finished, whichever row journaled it.
  // Nothing that has happened to the quote since -- an unfinalize, a contact
  // removed -- reaches back into a write that has already gone through.
  if (revision.actHistoryId) return { kind: "done" };

  // Blocking checks, before every step: on a fresh row, before anything is
  // made in ACT!; on a row that has made something already, it keeps it (see
  // the header). The contact first: it is the common case, and the one the
  // reader can fix.
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
