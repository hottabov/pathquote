// What a queued ACT! write still has to do, decided from what has already been
// stored and the quote as it stands now.
//
// One finalise queues one outbox row, or takes over the unfinished one, for one
// revision -- the revision that finalise created, or the one it kept when
// nothing had changed (planRevision in src/lib/documents/revision-plan.ts
// keeps the number for an unchanged snapshot). The plan's addendum of
// 2026-10-12 has the client's signature (completeSigning) and acceptQuote
// queue a row the same way; see DEAL EVENTS below. The row is a short
// sequence of steps, each one a single change to one ACT! record -- or a
// decision, made on a fresh read, to change nothing -- in this order. A step
// is not a single request: a create is one POST, but an update is a GET, a
// PATCH and a GET again (ActClient's `update` in src/lib/act/client.ts), and
// write-product-line reads the opportunity before it touches the line.
//
//   create-contact      only when the quote's contact exists only in PathQuote
//   create-opportunity  only when the deal has no opportunity yet
//   update-opportunity  instead, when an earlier revision already made one
//   write-product-line  the deal's one product line, which carries its amount:
//                       created the first time, PATCHed in place for a newer
//                       revision, left alone when productLineWrite says so
//                       (see THE PRODUCT LINE)
//   write-history       one History record for this revision
//   promote-contact     once the client has signed or the quote is accepted:
//                       the contact goes from Prospect to Customer
//   write-product-line  again, after the journal, when the client's signature
//                       stands and the line is still behind this revision
//                       (see A WON DEAL SHOWS THE LATEST SIGNED FIGURE)
//   write-accepted-line once the quote is accepted and the client's signature
//                       stands, when the line does not show this revision:
//                       the line is written whatever the deal's status (see
//                       THE LINE IS WRITTEN BEFORE THE WIN)
//   win-opportunity     once the quote is accepted, the client's signature
//                       stands and the line shows this revision: the
//                       opportunity is Won (see THE WIN NEEDS A STANDING
//                       SIGNATURE)
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
//   Document.actOpportunityId    create-opportunity, on creating it or on
//                                adopting the one its lookup found (then
//                                alone; see A CREATE IN FLIGHT). The deal's
//                                opportunity, one per quote, for every later
//                                revision.
//   ActOutbox.opportunityActId   create-opportunity and update-opportunity.
//                                This row's opportunity step is done. An
//                                update mints no new id, so the row records
//                                which opportunity it updated; that is what
//                                stops a resumed row updating it twice.
//   Document.actProductLineId    write-product-line or write-accepted-line,
//                                when it creates the line or adopts the one
//                                its lookup found. The deal's one product
//                                line, for every later revision to PATCH.
//   Document.actProductLineRevision
//                                write-product-line or write-accepted-line,
//                                every time it writes the line: the
//                                QuoteRevision.revision the line now shows.
//                                Only ever what was written -- never stored
//                                for a line left alone.
//   ActOutbox.productLineSkippedAt
//                                write-product-line, when productLineWrite
//                                said `skip` and the line was left alone.
//                                This row's line step is done without the
//                                line showing its revision (see A CLOSED
//                                OPPORTUNITY'S LINE IS LEFT ALONE).
//   QuoteRevision.actHistoryId   write-history, on creating the History or on
//                                adopting the one its lookup found (A CREATE
//                                IN FLIGHT), on the revision the row was
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
//   QuoteRevision.revision       of the row's revision: whether the product
//                                line already shows it.
//
// Of these, Contact.actContactId dates from z60_act_sync;
// ActOutbox.opportunityActId, ActOutbox.productLineSkippedAt,
// ActOutbox.quoteRevisionId, Document.actOpportunityId,
// Document.actProductLineId, Document.actProductLineRevision,
// QuoteRevision.actHistoryId, Document.actContactPromotedForId and
// Document.actOpportunityWonAt were added by z65_act_outbox.
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
// THE PRODUCT LINE. ACT! computes an opportunity's amount from its products
// and will not take one directly, so the deal's amount is one product line,
// created once and PATCHed in place by every later revision -- never deleted
// and re-created (THE DEAL AMOUNT IS ONE PRODUCT LINE in
// src/lib/act/write-payloads.ts). The step comes after the opportunity step,
// because the line belongs to the opportunity, and before write-history, so
// by the time a revision is journaled its line step has run: the line shows
// the revision's amount, or productLineWrite decided to leave it alone (A
// CLOSED OPPORTUNITY'S LINE IS LEFT ALONE). A journaled revision is not
// proof that ACT! has its amount.
//
// Its progress is ONE NUMBER ON THE DOCUMENT: actProductLineRevision, the
// revision the line in ACT! actually shows, beside actProductLineId, the line.
// The step is due while that number is null or older than the row's revision
// (and the row has not skipped it; see below); it creates the line when
// actProductLineId is null and updates it otherwise. A number rather than a
// fact per row or per revision because the question is about the line, of
// which the deal has one, and "which revision does it show" answers it for
// whichever row asks. So a new row for a revision the line already shows does
// not patch it again; a row taken over for a newer revision -- which clears
// the row's opportunityActId, not this -- does; and should a row ever carry an
// older revision than the line shows, the newer figure stands rather than an
// older one being written over it.
//
// A CLOSED OPPORTUNITY'S LINE IS LEFT ALONE, by the rule that leaves the
// opportunity alone (revisedOpportunityBody): its amount is part of the record
// of how the deal ended. The planner never sees the status, as above. The
// drain reads the opportunity first and asks productLineWrite
// (src/lib/act/write-payloads.ts), which says `skip` for a deal that is not
// Open -- unless it is Won and the quote is both accepted and signed, when
// the signed figure is the won deal's (see A WON DEAL SHOWS THE LATEST SIGNED
// FIGURE). On a skip the drain sends nothing and stores
// ActOutbox.productLineSkippedAt, and NOT actProductLineRevision: that number
// says what the line shows, and a line left alone still shows the older
// revision, or nothing at all. Stored as the revision it was not written for,
// it would tell this planner the line was current, so no write-accepted-line
// would come before the win -- which overturns a Lost deal to Won -- and ACT!
// would record a Won deal at an earlier revision's figure, or at none.
//
// The skip is on the ROW, not the Document, for two reasons. It is not a fact
// about ACT!'s line, which the Document's two columns are kept for. And it is
// this row's answer about this row's revision: a take-over (which points the
// row at the revision the enqueue is for, usually a newer one) clears it with
// opportunityActId, so that revision asks ACT! again, and any later row
// starts without it. A deal that
// is reopened in ACT! therefore gets the next revision's figure as usual,
// creating the line then if it never had one.
//
// THE LINE IS WRITTEN BEFORE THE WIN. A Won deal must show the accepted,
// signed figure, and the win overturns any closed status but Won
// (wonOpportunityBody). So while the win is due and the line does not show
// the row's revision, this planner returns write-accepted-line -- `create` or
// `update`, as for write-product-line -- and returns win-opportunity only once
// the line shows it. write-accepted-line writes the line for the row's
// revision whatever the deal's status, without asking productLineWrite: the
// acceptance is what overturns the status, and the deal it wins has to carry
// the accepted, signed figure. The drain stores the line's id and
// actProductLineRevision exactly as write-product-line does, and the next
// plan is the win. Two steps, so the order is the plan's rather than a
// promise about the drain: a failure between them, or a line write ACT!
// refuses, leaves the deal at its old status -- the next attempt plans
// write-accepted-line again, or the win once the line is stored -- where the
// other order would leave a deal Won at the wrong figure, or at none.
//
// The row's revision is taken to be the accepted one, which makes it a
// requirement on the enqueue (Task 6): acceptQuote's row, like finalise's and
// any take-over, points at the quote's newest revision -- the one the client
// signed and the manager accepted. There is no re-acceptance to wait for:
// acceptQuote returns early for a quote already accepted.
//
// THE WIN NEEDS A STANDING SIGNATURE. voidSignature leaves acceptedAt set, so
// a quote re-finalised after a void still reads as accepted: a stale flag,
// not a new acceptance. Vadym's rule is "PathQuote confirms", and the
// confirmation is the client's signature -- the rule the won deal's line
// follows (next section) -- so the win is due only while the quote is
// accepted AND signingStatus is SIGNED, until actOpportunityWonAt is set.
// Without that, a quote accepted, then voided and re-finalised at a new
// figure before the drain ran the win would be won at a figure nobody has
// signed. Instead:
//
//   - The re-finalised revision's row -- the acceptance's, taken over, since
//     it had not finished -- runs its steps as any revision's does: the
//     opportunity, the line as productLineWrite decides (an Open deal's takes
//     the new figure, as it would for any revision; a closed deal's is left
//     alone), the History, and the promotion if one is due (PROMOTION IS ONCE
//     PER CONTACT). Then it is done: no win, and no write-accepted-line,
//     which belongs to the win.
//   - When the client signs that revision, completeSigning's row finds
//     acceptedAt still set, the signature standing and actOpportunityWonAt
//     null: the win is due. write-accepted-line brings the line to that
//     revision first if it does not show it, and the deal is won at the
//     figure the client signed.
//   - A void after the win changes nothing: actOpportunityWonAt is set, so the
//     win is never planned again (THE WIN IS ONCE PER DEAL).
//
// A WON DEAL SHOWS THE LATEST SIGNED FIGURE. Once actOpportunityWonAt is set
// the win is never planned again (THE WIN IS ONCE PER DEAL), but the quote can
// still change: voidSignature, a changed re-finalise, and the client signing
// the new revision. Vadym's rule is "PathQuote confirms", and the
// confirmation is the client's signature, so the won deal's line follows the
// latest SIGNED revision and nothing else:
//
//   - The re-finalised revision's row reaches write-product-line with the
//     quote unsigned (voidSignature put it back to NOT_SENT).
//     productLineWrite says `skip` for a Won deal without a signature
//     standing; the row stores productLineSkippedAt, and
//     actProductLineRevision stays at the revision the line shows -- the
//     signed one.
//   - When the client signs the new revision, completeSigning queues a row
//     for it: a fresh one, since the finalise row has finished (were it still
//     unfinished, the signature would take it over, and a take-over clears
//     the skip). That row finds the revision journaled, the line behind it
//     and nothing skipped of its own, and with the signature standing plans
//     write-product-line again, after promote-contact and before `done`.
//     productLineWrite, asked with the signature standing, says `write`.
//
// Only a standing signature brings the line step back after the journal: an
// acceptance has write-accepted-line, and nothing else PathQuote does to a
// journaled revision changes productLineWrite's answer. A deal that is not
// Won is asked the same and answered as before: an Open one (reopened by
// hand after a skip) gets the signed figure, and one somebody set to Lost
// after the win keeps its line, with its status -- that row's step skips it
// again.
//
// DEAL EVENTS: promote-contact and win-opportunity, from the plan's addendum
// of 2026-10-12. They come after write-history and are checked before "done",
// as are the two line steps that can follow the journal.
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
// now; the win while the quote is accepted and the client's signature stands,
// until Document.actOpportunityWonAt is set (THE WIN NEEDS A STANDING
// SIGNATURE). FORWARD ONLY: no step undoes either, so a voidSignature or an
// unfinalise after the step ran changes nothing in ACT!. A signature voided
// BEFORE the step ran leaves the win no longer due, until the client signs
// again. It leaves the promotion no longer due too -- unless the quote was
// accepted, since voidSignature does not clear acceptedAt.
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
// revisedOpportunityBody leaves any closed deal alone -- as productLineWrite
// leaves the line of any deal that is not Open, unless it is Won with the
// quote accepted and signed. It stays Lost, at its figure, which is the second
// half of the same decision.
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
// STEPS RESUME, AND NO CREATE REPEATS BLIND. Every step stores its result before the
// next step begins, and this planner looks at nothing but those stored
// results. So a row that fails halfway -- a timeout, a restart, ACT! down for
// the night -- is re-planned from what it actually got done, and resumes at
// the next step instead of starting again. That is the whole of this design's
// idempotency, and the reason the write is a sequence of steps rather than one
// call.
//
// The window: a step that succeeded in ACT! but died before its result was
// stored runs again, and only that step. For an update that is harmless: a
// repeated update-opportunity, or a line PATCHed again, sends the same patch
// (or nothing -- patchToSend in src/lib/act/record-write.ts drops a patch the
// record already shows), and a repeated promote-contact or win-opportunity
// reads back the Customer or Won it already wrote and sends nothing (see DEAL
// EVENTS). For a create it is not: a repeated create-contact is a DUPLICATE
// CONTACT in ACT!, a repeated create-opportunity a SECOND OPPORTUNITY FOR THE
// DEAL, a repeated line create a SECOND PRODUCT LINE, which DOUBLES THE
// DEAL'S AMOUNT, a repeated write-history a second History for the revision.
// So no create is repeated blind; see A CREATE IN FLIGHT. The drain (Task 7)
// still stores each result the moment ACT! answers, before doing anything
// else with it, which keeps the window as short as it can be.
//
// A CREATE IN FLIGHT. ActOutbox.createInFlight names the record a POST of this
// row may have made: one of CREATE_IN_FLIGHT -- "contact", "opportunity",
// "product-line" (from write-product-line or write-accepted-line) or
// "history". A REQUIREMENT ON THE DRAIN: it sets the marker in a write of its
// own, committed before the POST leaves, and clears it in these cases and no
// others:
//
//   - in the same transaction that stores the record's id, created or adopted
//     -- an ActUntrackedCreateError whose `createdId` is set included, since
//     ACT! named the record it made;
//   - when the create throws ActNotSentError (src/lib/act/client.ts): the
//     request never left, so nothing was made;
//   - when the create throws an ActApiError whose `failure` is `refused`:
//     ACT! answered and turned it away, which made nothing.
//
// NEVER ON ANYTHING ELSE: not on writeFailureOf's `failed` or `foreign`, and
// above all not on an error the drain's own code throws. That last is the
// case the marker exists for -- the POST succeeded, and the transaction
// storing its id threw. The catch around it holds an error that says nothing
// about ACT!; cleared for it, the marker would let the next attempt create
// the record again. createMadeNothing (src/lib/act/client.ts) is the rule
// above as code, for the drain to call rather than restate. So the marker
// stays set when the answer was lost (ActUntrackedCreateError with no
// createdId), when the drain failed after ACT! answered, and when the drain
// itself died between ACT!'s answer and the store -- the case no error
// reports at all. What happens next depends on the record:
//
//   contact            nextStep blocks, before anything else (`done`
//                      included): a person must look in ACT! before the row
//                      goes on (UNTRACKED_CONTACT_REASON). The contact is NOT
//                      looked up by email: among ACT!'s 17.5k contacts an
//                      email is no identity -- shared inboxes, duplicates
//                      already there, contacts with none -- and adopting a
//                      match could take over another manager's Customer.
//   opportunity,       nextStep plans as usual, because the drain looks up
//   product-line,      before EVERY create of these three, marker or not: the
//   history            opportunity by its fixed name across ACT!'s
//                      opportunities, the line by its item number among the
//                      opportunity's, the History by its `regarding` among
//                      the contact's (opportunityLookup, productLineLookup,
//                      historyLookup in src/lib/act/write-payloads.ts). None
//                      found: the record is created. One opportunity or line
//                      found is adopted: its id is stored alone, and the next
//                      step planned is the update, which decides on a fresh
//                      read like any other. More than one opportunity or line
//                      blocks, with duplicateOpportunitiesReason or
//                      duplicateProductLinesReason, for a person to settle --
//                      PathQuote never deletes in ACT!. A History found, one
//                      or several, is adopted -- the oldest, the rest noted --
//                      as QuoteRevision.actHistoryId, and the row goes on: a
//                      duplicate journal entry is not worth holding back the
//                      promote-contact and the win that follow it, which carry
//                      the deal's status. The lookup is what resolves the
//                      marker.
//
// Anything else in the column blocks as well (untrackedCreateReason): a
// record nobody here can name may exist. A take-over does NOT clear the
// marker -- a record an earlier revision's step may have made is in ACT!
// whatever revision the row carries now -- and the drain's pass over blocked
// rows clears blockedReason only when nextStep no longer blocks, which for a
// contact, or a value nothing here knows, needs the marker gone. A row the
// drain blocked on a lookup's duplicates is not blocked by nextStep, so that
// pass makes it due again and the lookup runs again: blocked while the
// duplicates stand, on its way once a person has dealt with them.
//
// A REQUIREMENT ON THE DRAIN (Task 7): after create-opportunity, the two
// stores -- Document.actOpportunityId and the row's opportunityActId -- MUST be
// one database transaction. If the row's is saved and the Document's is not,
// this row moves on to write-history believing the deal has its opportunity,
// and the next revision's row finds Document.actOpportunityId null and creates
// a second opportunity for the same deal. (The other way round only re-runs
// this row's step as an update, which is harmless.) Likewise after
// write-product-line or write-accepted-line creates the line:
// Document.actProductLineId and Document.actProductLineRevision are stored by
// one UPDATE of the Document. The revision without the id would create a
// second line on the next revision; the id without the revision only re-runs
// this step as an update. The win is a step of its own, which this planner
// returns only once that UPDATE says the line shows the row's revision (THE
// LINE IS WRITTEN BEFORE THE WIN).
//
// BLOCKED REASONS ARE READ BY A MANAGER on the quote, so they are sentences
// that say what to do, in the voice of src/lib/act/sync-view.ts: a fault the
// manager can fix names the fix; a fault only PathQuote's configuration can
// fix says "ask your developer"; a record that may or may not be in ACT!
// says what happened and that ACT! must be checked before the write is tried
// again (a way to hand PathQuote what was found there is Task 9's). The
// blocking checks run before every step,
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

/**
 * The values of ActOutbox.createInFlight: the record a POST of this row may
 * have made. See A CREATE IN FLIGHT.
 */
export const CREATE_IN_FLIGHT = {
  contact: "contact",
  opportunity: "opportunity",
  productLine: "product-line",
  history: "history",
} as const;

/** What this outbox row (ActOutbox) has stored of its own. */
export type OutboxProgress = {
  /**
   * ActOutbox.opportunityActId: the opportunity this row's opportunity step
   * created or updated. Null until that step has succeeded and been stored.
   */
  opportunityActId: string | null;
  /**
   * ActOutbox.productLineSkippedAt: set when this row's write-product-line
   * left the line alone because productLineWrite in
   * src/lib/act/write-payloads.ts said `skip` -- a deal not Open, and not Won
   * with the quote accepted and signed. Null otherwise. The step is then done
   * for this row although the line does not show its revision, before the
   * journal and after it; see A CLOSED OPPORTUNITY'S LINE IS LEFT ALONE.
   */
  productLineSkippedAt: Date | null;
  /**
   * ActOutbox.createInFlight: the record a POST of this row may have made
   * without its id being stored -- a CREATE_IN_FLIGHT value -- or null. A
   * string, not the union, because it is read off a TEXT column, and a value
   * this module does not know has to block rather than be trusted.
   */
  createInFlight: string | null;
};

/** What the revision this row was queued for (ActOutbox.quoteRevisionId) has stored. */
export type RevisionProgress = {
  /**
   * QuoteRevision.revision: 0, 1, 2... Not progress but which revision this
   * is, compared with Document.actProductLineRevision (THE PRODUCT LINE).
   */
  revision: number;
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
  /** Document.actProductLineId: the deal's product line, or null until it is created. */
  actProductLineId: string | null;
  /**
   * Document.actProductLineRevision: the QuoteRevision.revision the product
   * line in ACT! shows -- the last one written to it -- or null when nothing
   * has been written. Never the revision of a line left alone.
   */
  actProductLineRevision: number | null;
  /**
   * Document.signingStatus, as its enum name. "SIGNED" is the client's
   * signature standing; voidSignature puts it back to NOT_SENT. A string
   * rather than Prisma's enum type, to keep this module free of Prisma. Read
   * for promotion, for the win (THE WIN NEEDS A STANDING SIGNATURE), and for
   * the line step after the journal (A WON DEAL SHOWS THE LATEST SIGNED
   * FIGURE).
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
  /**
   * `create` when the deal has no line yet (Document.actProductLineId null),
   * `update` otherwise. The drain asks productLineWrite first, and may leave
   * the line alone (A CLOSED OPPORTUNITY'S LINE IS LEFT ALONE).
   */
  | { kind: "write-product-line"; line: "create" | "update" }
  | { kind: "write-history" }
  | { kind: "promote-contact" }
  /**
   * The line brought to the row's revision before the win, `create` or
   * `update` as for write-product-line, whatever the deal's status:
   * productLineWrite is not asked. See THE LINE IS WRITTEN BEFORE THE WIN.
   */
  | { kind: "write-accepted-line"; line: "create" | "update" }
  /** The opportunity patched to Won. Planned only once the line shows the row's revision. */
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

/**
 * A contact create whose answer never reached the store (A CREATE IN FLIGHT).
 * Nothing in PathQuote can tell whether ACT! made the contact, and creating
 * it again could put the same person in ACT! twice, so a person has to look.
 */
export const UNTRACKED_CONTACT_REASON =
  "PathQuote asked ACT! to create this quote's contact but never learned whether it did, so they may be in ACT! already — check ACT! for them before this is tried again, or ACT! could end up with the same person twice.";

/**
 * The sentence for a createInFlight value nextStep blocks on: the contact's
 * above, or one for a value nothing here knows. (An opportunity, a line or a
 * History in flight does not block: the drain's lookup resolves it.)
 */
export function untrackedCreateReason(createInFlight: string): string {
  if (createInFlight === CREATE_IN_FLIGHT.contact) return UNTRACKED_CONTACT_REASON;
  return `PathQuote asked ACT! to create a record for this quote ("${createInFlight}") but never learned whether it did, and does not know how to look for it — ask your developer to check ACT! before this is tried again.`;
}

/**
 * The drain's block when opportunityLookup finds more than one opportunity
 * with this deal's name -- across ACT!, or among the contact's on the
 * lookup's fallback (ActClient.opportunitiesNamed). Not returned by nextStep:
 * the drain sets it from the lookup, and the lookup runs again on the next
 * pass.
 */
export function duplicateOpportunitiesReason(name: string, count: number): string {
  return `ACT! has ${count} opportunities named "${name}", and PathQuote makes one per quote, so it cannot tell which is this deal — in ACT!, rename or remove the ones that are not this quote's, and this will carry on.`;
}

/**
 * The drain's block when productLineLookup finds more than one product line
 * with this quote's number on the deal's opportunity. Every one of them adds
 * to the deal's total in ACT!, which is why this says so.
 */
export function duplicateProductLinesReason(itemNumber: string, count: number): string {
  return `ACT! has ${count} product lines numbered ${itemNumber} on this quote's opportunity, so the deal's total there counts this quote ${count} times, and PathQuote keeps exactly one line — remove the extra ones in ACT!, and this will carry on.`;
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

/** The line does not show this revision yet; see THE PRODUCT LINE. */
function lineBehind(revision: RevisionProgress, quote: QuoteState): boolean {
  return quote.actProductLineRevision === null || quote.actProductLineRevision < revision.revision;
}

/** Create the line, or update the one the deal has. */
function lineWrite(quote: QuoteState): "create" | "update" {
  return quote.actProductLineId ? "update" : "create";
}

/**
 * The quote is accepted, the client's signature stands, and the win is not
 * recorded. acceptedAt alone is not enough: voidSignature leaves it set. See
 * THE WIN NEEDS A STANDING SIGNATURE.
 */
function winDue(quote: QuoteState): boolean {
  return quote.acceptedAt !== null && quote.signingStatus === "SIGNED" && quote.actOpportunityWonAt === null;
}

/**
 * The line step again, after the journal: the client's signature stands, the
 * line is still behind the row's revision, and this row has not already had
 * productLineWrite's `skip` for it. Not while the win is due, which brings
 * the line up to date itself (write-accepted-line). See A WON DEAL SHOWS THE
 * LATEST SIGNED FIGURE.
 */
function signedLineDue(progress: OutboxProgress, revision: RevisionProgress, quote: QuoteState): boolean {
  return (
    !winDue(quote) &&
    quote.signingStatus === "SIGNED" &&
    lineBehind(revision, quote) &&
    progress.productLineSkippedAt === null
  );
}

export function nextStep(
  progress: OutboxProgress,
  revision: RevisionProgress,
  quote: QuoteState,
): OutboxStep {
  // A create that may have made a contact PathQuote cannot name -- or a
  // record of a kind nothing here knows -- stops everything, `done`
  // included, until a person has looked (A CREATE IN FLIGHT). An opportunity,
  // a line or a History resolves itself: the drain looks it up before
  // creating it.
  const inFlight = progress.createInFlight;
  if (
    inFlight !== null &&
    inFlight !== CREATE_IN_FLIGHT.opportunity &&
    inFlight !== CREATE_IN_FLIGHT.productLine &&
    inFlight !== CREATE_IN_FLIGHT.history
  ) {
    return { kind: "blocked", reason: untrackedCreateReason(inFlight) };
  }

  // A revision already journaled is finished, whichever row journaled it.
  // Nothing that has happened to the quote since -- an unfinalize, a contact
  // removed -- reaches back into a write that has already gone through. What
  // can still be due is a deal event, or the line again for a signature,
  // which is new work rather than that revision's.
  const journaled = revision.actHistoryId !== null;
  const promote = promotionDue(quote);
  const win = winDue(quote);
  const signedLine = signedLineDue(progress, revision, quote);
  if (journaled && !promote && !win && !signedLine) return { kind: "done" };

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
    // Behind and not skipped by this row. A line productLineWrite left alone
    // is brought up to date by write-accepted-line when the win is due, and
    // asked about again by a later signature's row.
    if (lineBehind(revision, quote) && progress.productLineSkippedAt === null) {
      return { kind: "write-product-line", line: lineWrite(quote) };
    }
    return { kind: "write-history" };
  }

  if (promote) return { kind: "promote-contact" };

  // Only line work and the win are left. The row that journaled this revision
  // did its opportunity step first, and nothing clears
  // Document.actOpportunityId, so it is set here unless the database was
  // edited by hand; if it is not, the opportunity is created before its line
  // is written or it is won, rather than either being sent to nothing.
  if (!quote.actOpportunityId) return { kind: "create-opportunity" };
  if (win) {
    // Whatever this row skipped: the win overturns a closed status, and a won
    // deal shows the accepted, signed figure -- written first, as a step of
    // its own.
    return lineBehind(revision, quote)
      ? { kind: "write-accepted-line", line: lineWrite(quote) }
      : { kind: "win-opportunity" };
  }
  // A signature, with the line behind: the line step again.
  return { kind: "write-product-line", line: lineWrite(quote) };
}
