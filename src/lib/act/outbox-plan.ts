// What a queued ACT! write still has to do, decided from what has already been
// stored and the quote as it stands now.
//
// One finalise queues one outbox row, or takes over the unfinished one, for one
// revision -- the revision that finalise created, or the one it kept when
// nothing had changed (planRevision in src/lib/documents/revision-plan.ts
// keeps the number for an unchanged snapshot). The plan's addendum of
// 2026-10-12 has the client's signature (completeSigning) and acceptQuote
// queue a row the same way; see DEAL EVENTS below. The row is a short
// sequence of steps, each one a single request to ACT!, in this order:
//
//   create-contact      only when the quote's contact exists only in PathQuote
//   create-opportunity  only when the deal has no opportunity yet
//   update-opportunity  instead, when an earlier revision already made one
//   write-history       one History record for this revision
//   promote-contact     once the client has signed or the quote is accepted:
//                       the contact goes from Prospect to Customer
//   win-opportunity     once the quote is accepted: the opportunity is Won
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
//   Document.actContactPromotedForId
//                                promote-contact: the ACT! id of the contact
//                                it was done for. On the Document, not the row
//                                or the revision, and an id rather than a
//                                time, because it is once per contact per
//                                deal (see DEAL EVENTS). Says the step is
//                                done, not that ACT! changed.
//   Document.actOpportunityWonAt
//                                win-opportunity. Once per deal: one
//                                opportunity per deal, won once.
//
//   The quote -- existing columns, read as they stand now:
//
//   Document.contactId           null means no contact (blocked).
//   Contact.firstName/lastName   whether a contact ACT! must create has a name.
//   Region.code                  of Document.regionId: which sales process.
//   Document.signingStatus       SIGNED: the client has signed.
//   Document.acceptedAt          set: the quote is accepted.
//
// Of these, Contact.actContactId dates from z60_act_sync;
// ActOutbox.opportunityActId, ActOutbox.quoteRevisionId,
// Document.actOpportunityId, QuoteRevision.actHistoryId,
// Document.actContactPromotedForId and Document.actOpportunityWonAt were added
// by z65_act_outbox.
//
// ONE HISTORY PER REVISION, so its progress is on the revision, not the row. A
// manager can unfinalise a quote whose row has finished and re-finalise it
// without changing anything; planRevision then keeps the revision number and
// creates no new revision, but a new row is queued all the same (only one
// UNFINISHED row per document is allowed -- the partial unique index
// ActOutbox_documentId_unfinished_key in z65_act_outbox -- and the old one has
// finished). Held on the row, "history written" would start null on that new
// row and journal the same revision twice. Held on QuoteRevision, the new row
// finds it set and skips every step up to write-history: it is done, unless a
// deal event is still due.
//
// SUPERSEDED REVISIONS ARE NOT JOURNALED. A row taken over before it wrote its
// History now points at the newer revision, so ACT! never records the older
// one. Because finalise IS the send for a manager who emails the PDF
// themselves, that older revision may have reached the customer. Accepted for
// now -- the alternative is one row per revision, which puts two live rows on
// one deal again -- and recoverable later without a migration: actHistoryId is
// on the revision, so a future planner could journal every revision of a
// document that has none.
//
// ONE OPPORTUNITY PER DEAL. Document.actOpportunityId is per quote, not per
// revision, so a re-finalise after a revision finds it set and updates rather
// than creating a second opportunity for the same deal. That holds whatever
// state the opportunity is in. A closed one (Won, Lost, Inactive) is still the
// deal's: the plan for a new revision is still update-opportunity then
// write-history, and the planner cannot create a second opportunity because
// the first is closed -- it never sees the status. What the update sends to a
// closed opportunity -- nothing at all -- is revisedOpportunityBody's decision
// (src/lib/act/write-payloads.ts); the drain still stores the row's
// opportunityActId when it sends nothing, so the row moves on to
// write-history and the revision is journaled.
//
// DEAL EVENTS: promote-contact and win-opportunity, from the plan's addendum
// of 2026-10-12. They come after write-history and are checked before "done".
// A row queued by a signature or an acceptance usually finds the finalise row
// long finished: its revision is journaled, so it skips straight to them --
// and is not done merely because that revision's History exists. A row that
// has not got that far (ACT! down since the finalise, say, and the signature
// took the unfinished row over) does the earlier steps first, in their usual
// order, so the contact is in ACT! before it is promoted and the opportunity
// exists before it is won.
//
// Both are read off the quote as it stands now. Promotion is due while the
// client's signature stands (signingStatus SIGNED) or the quote is accepted,
// until Document.actContactPromotedForId names the quote's contact as it is
// now; the win while the quote is accepted, until Document.actOpportunityWonAt
// is set. FORWARD ONLY: no step undoes either, so a voidSignature or an
// unfinalise after the step ran changes nothing in ACT!. A signature voided
// BEFORE the step ran leaves the promotion no longer due -- unless the quote
// was accepted, since voidSignature does not clear acceptedAt.
//
// Each fact records that the step is DONE, not that ACT! was changed. The
// drain reads the contact's idStatus, or the opportunity's status, just
// before, and contactPromotion or wonOpportunityBody
// (src/lib/act/write-payloads.ts) may send nothing: a contact that is not a
// Prospect is not PathQuote's to change, and an opportunity already Won needs
// nothing. Any other opportunity status, Lost included, is patched to Won:
// the acceptance overturns it, by Vadym's decision (see wonOpportunityBody).
//
// THE WIN IS ONCE PER DEAL, AND THAT IS WHAT LETS A LATER LOST STAND.
// Document.actOpportunityWonAt is never cleared, so once it is set this
// planner never returns win-opportunity again, for this row or any later one.
// If somebody then marks the deal Lost by hand in ACT!, nothing sends Won
// again: a later revision's update-opportunity does read the status, and
// revisedOpportunityBody leaves any closed deal alone. It stays Lost, which is
// the second half of the same decision.
//
// PROMOTION IS ONCE PER CONTACT. voidSignature exists for a wrong signatory,
// among other things: the quote goes back to DRAFT, its contact can be
// changed, and the quote is finalised and signed again. The contact who signs
// then is not the one promoted before, and is just as much a customer. So the
// fact is WHICH contact was promoted, compared with the quote's contact as it
// stands, rather than "promoted" for the deal as a whole. It is the contact's
// ACT! id, the record the step changed: a contact ACT! does not have yet
// (actContactId null) has not been promoted whatever is stored, and is
// created first. One consequence: a voided quote that had been ACCEPTED keeps
// acceptedAt, so its new contact is promoted at the re-finalise rather than at
// the next signature.
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
// update-opportunity sends the same patch again and is harmless, and a
// repeated promote-contact or win-opportunity reads back the Customer or Won
// it already wrote and sends nothing (see DEAL EVENTS). Nothing here
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
  /**
   * Document.signingStatus, as its enum name. "SIGNED" is the client's
   * signature standing; voidSignature puts it back to NOT_SENT. A string
   * rather than Prisma's enum type, to keep this module free of Prisma.
   */
  signingStatus: string;
  /** Document.acceptedAt: set once the quote is accepted (acceptQuote). */
  acceptedAt: Date | null;
  /**
   * Document.actContactPromotedForId: the ACT! contact id promote-contact was
   * last done for on this deal, or null when it has not run.
   */
  actContactPromotedForId: string | null;
  /** Document.actOpportunityWonAt: set once win-opportunity is done for this deal. */
  actOpportunityWonAt: Date | null;
};

export type OutboxStep =
  | { kind: "create-contact" }
  | { kind: "create-opportunity" }
  | { kind: "update-opportunity" }
  | { kind: "write-history" }
  | { kind: "promote-contact" }
  | { kind: "win-opportunity" }
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
 * (setDocumentClient in src/lib/actions/documents/lifecycle.ts) -- "if it is
 * final", because the quote may be a draft already: a voidSignature puts it
 * back to DRAFT, and its row can still be blocked. "Choose or add": the usual
 * cause is a company with no contacts at all, where there is nobody to choose
 * and the builder's "New contact" is the way out.
 */
export const NO_CONTACT_REASON =
  "This quote has no contact, so there is nobody in ACT! to attach it to — if it is final, unfinalize it, then choose or add a contact, and finalize it again.";

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

/**
 * The client's signature or the acceptance makes a customer of the quote's
 * contact as it stands -- unless that contact is the one already promoted; see
 * PROMOTION IS ONCE PER CONTACT.
 */
function promotionDue(quote: QuoteState): boolean {
  const won = quote.signingStatus === "SIGNED" || quote.acceptedAt !== null;
  if (!won) return false;
  // No contact, or one ACT! does not have yet, cannot be the one promoted.
  // Due, so the checks below block on it or create it.
  const actContactId = quote.contact?.actContactId ?? null;
  return actContactId === null || actContactId !== quote.actContactPromotedForId;
}

function winDue(quote: QuoteState): boolean {
  return quote.acceptedAt !== null && quote.actOpportunityWonAt === null;
}

export function nextStep(
  progress: OutboxProgress,
  revision: RevisionProgress,
  quote: QuoteState,
): OutboxStep {
  // A revision already journaled is finished, whichever row journaled it.
  // Nothing that has happened to the quote since -- an unfinalize, a contact
  // removed -- reaches back into a write that has already gone through. What
  // can still be due is a deal event, which is new work rather than that
  // revision's.
  const journaled = revision.actHistoryId !== null;
  const promote = promotionDue(quote);
  const win = winDue(quote);
  if (journaled && !promote && !win) return { kind: "done" };

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

  if (!journaled) {
    if (!progress.opportunityActId) {
      // Set means the deal has an opportunity, open or closed; either way it is
      // updated, never replaced (see ONE OPPORTUNITY PER DEAL above).
      return quote.actOpportunityId ? { kind: "update-opportunity" } : { kind: "create-opportunity" };
    }
    return { kind: "write-history" };
  }

  if (promote) return { kind: "promote-contact" };

  // Only a win is left. The row that journaled this revision did its
  // opportunity step first, and nothing clears Document.actOpportunityId, so
  // it is set here unless the database was edited by hand; if it is not, the
  // opportunity is created before it is won rather than a win sent to nothing.
  if (!quote.actOpportunityId) return { kind: "create-opportunity" };
  return { kind: "win-opportunity" };
}
