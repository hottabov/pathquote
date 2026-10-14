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
//   promote-contact     once the client's signature stands: the contact goes
//                       from Prospect to Customer. Last of all (see PROMOTION
//                       GOES LAST)
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
//   Contact.actCreateInFlightAt  set while a contact create's answer is
//                                unaccounted for: create-contact blocks, for
//                                every quote on the contact (A CONTACT CREATE
//                                IN FLIGHT).
//   Region.code                  of Document.regionId: not read here since
//                                2026-10-13 -- every region has a sales
//                                process (processForRegion); the payloads
//                                read it to choose one.
//   Document.signingStatus       SIGNED: the client has signed.
//   Document.acceptedAt          set: the quote is accepted.
//   QuoteRevision.revision       of the row's revision: whether the product
//                                line already shows it.
//
// Of these, Contact.actContactId dates from z60_act_sync;
// ActOutbox.opportunityActId, ActOutbox.productLineSkippedAt,
// ActOutbox.quoteRevisionId, ActOutbox.createInFlight,
// Contact.actCreateInFlightAt, Document.actOpportunityId,
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
// row at the revision the enqueue is for -- a newer one after a changed
// re-finalise, the same one for a signature, an acceptance or an unchanged
// re-finalise) clears it with opportunityActId, so that revision asks ACT!
// again (A TAKE-OVER CAN LAND MID-STEP says why no stale store puts it back),
// and any later row
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
//     alone) and the History. Then it is done: no win, no write-accepted-line,
//     which belongs to the win, and no promotion, which needs the signature
//     too (promotionDue).
//   - When the client signs that revision, completeSigning's row finds
//     acceptedAt still set, the signature standing and actOpportunityWonAt
//     null: the win is due. write-accepted-line brings the line to that
//     revision if it does not show it; the deal is won at the figure the
//     client signed; and then the contact is promoted, if it has not been
//     (PROMOTION IS ONCE PER CONTACT, PROMOTION GOES LAST).
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
//     write-product-line again -- before promote-contact, when that is still
//     due, and before `done`. productLineWrite, asked with the signature
//     standing, says `write`.
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
// as are the two line steps that can follow the journal; of the four, the
// promotion comes last (PROMOTION GOES LAST).
// A row queued by a signature or an acceptance usually finds the finalise row
// long finished: its revision is journaled, so it skips straight to them --
// and is not done merely because that revision's History exists. A row that
// has not got that far (ACT! down since the finalise, say, and the signature
// took the unfinished row over) does the earlier steps first, in their usual
// order, so the contact is in ACT! before it is promoted and the opportunity
// exists before it is won.
//
// Both are read off the quote as it stands now. Promotion is due while the
// client's signature stands (signingStatus SIGNED), until
// Document.actContactPromotedForId names the quote's contact as it is now --
// the signature alone, not the acceptance (promotionDue says why); the win
// while the quote is accepted and the client's signature stands, until
// Document.actOpportunityWonAt is set (THE WIN NEEDS A STANDING SIGNATURE).
// FORWARD ONLY: no step undoes either, so a voidSignature or an unfinalise
// after the step ran changes nothing in ACT!. A signature voided BEFORE the
// step ran leaves neither due, until the client signs again -- accepted or
// not, since both need the signature.
//
// PROMOTION GOES LAST, after the line steps and the win. A contact PATCH sends
// the whole record back (mergeForWrite in src/lib/act/record-write.ts), and
// ACT! can refuse it over a value already on the record -- an Account Mgr or a
// country off its limited picklist, which the inbound data has on old
// contacts. The drain blocks a row on a refusal (a 4xx is the same answer
// every time), and holds it there until a take-over or a person sends it
// again. Before the line and the win, a refused promotion would hold
// back the deal's amount and its Won with it, over nothing but the contact's
// status; last, it holds back nothing but itself. Nothing the promotion does
// is needed by the steps before it: they read the contact's ACT! id, which
// create-contact has stored before any of them runs.
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
// created first. The corrected contact is promoted when they sign, and not
// before: a voided quote that had been ACCEPTED keeps acceptedAt, but
// promotion reads only the signature (promotionDue).
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
// So no create is repeated blind; see A CREATE IN FLIGHT. The drain
// (src/lib/act/drain.ts) still stores each result the moment ACT! answers, before doing anything
// else with it, which keeps the window as short as it can be.
//
// A CREATE IN FLIGHT. A marker says a POST may have made a record whose id
// was never stored. For the deal's records it is on the row:
// ActOutbox.createInFlight, one of CREATE_IN_FLIGHT -- "opportunity",
// "product-line" (from write-product-line or write-accepted-line) or
// "history". For a contact it is on the Contact: Contact.actCreateInFlightAt
// (A CONTACT CREATE IN FLIGHT, below). A REQUIREMENT ON THE DRAIN, for both:
// it sets the marker in a write of its own, committed before the POST leaves,
// and clears it in these cases and no others:
//
//   - in the same transaction that stores the record's id, created or adopted
//     -- an ActUntrackedCreateError whose `createdId` is set included, since
//     ACT! named the record it made;
//   - when the create throws ActNotSentError (src/lib/act/client.ts): the
//     request never left, so nothing was made;
//   - when the create throws an ActApiError whose `failure` is `refused` --
//     a 4xx other than 408 and 429, to the POST or to the login before it:
//     ACT! answered and turned it away, which made nothing;
//   - when the create throws an ActApiError with a 429: a rate limiter
//     answered before the request ran, which made nothing. (Also a 408 to
//     the LOGIN, `authorizing`: the POST it was getting a token for never
//     left.)
//
// NOT ON A 408 TO THE POST. A 408 is answered before the request runs only
// by convention -- HTTP.sys and Kestrel send it while the body is still
// arriving -- and application code can answer 408 for its own timeout after
// its database insert has committed. Cleared for it, a contact ACT! had saved
// was POSTed again on the next pass: the same person in ACT! twice.
//
// NOR ON ANYTHING ELSE: not on `untracked`, not on writeFailureOf's
// `foreign`, and above all not on an error the drain's own code throws. That
// last is the case the marker exists for -- the POST succeeded, and the
// transaction storing its id threw. The catch around it holds an error that
// says nothing about ACT!; cleared for it, the marker would let the next
// attempt create the record again. createMadeNothing (src/lib/act/client.ts)
// is the rule above as code, for the drain to call rather than restate. So
// the marker stays set when the answer was lost (ActUntrackedCreateError with
// no createdId), when ACT! answered 408, when the drain failed after ACT!
// answered, and when the drain itself died between ACT!'s answer and the
// store -- the case no error reports at all. What happens next depends on
// the record:
//
//   contact            nextStep blocks create-contact, for whichever row asks
//                      (A CONTACT CREATE IN FLIGHT): a person must look in
//                      ACT! first (UNTRACKED_CONTACT_REASON, and blockedBy
//                      "contact"; see THE BLOCKER, below). The contact is
//                      NOT looked up by email: among ACT!'s 17.5k contacts an
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
//                      line, the win and the promote-contact that may follow
//                      it, which carry the deal's amount and status. The
//                      lookup is what resolves the marker.
//
// Anything else in ActOutbox.createInFlight blocks the row, before anything
// else (untrackedCreateReason): a record nobody here can name may exist. A
// take-over does NOT clear the row's marker -- a record an earlier revision's
// step may have made is in ACT! whatever revision the row carries now -- and
// the drain's pass over blocked rows clears blockedReason only when nextStep
// no longer blocks, which for a value nothing here knows needs the marker
// gone. A row the drain blocked on a lookup's duplicates is not blocked by
// nextStep, so that pass works it again -- after the due rows, and no more
// than RECHECKS_PER_PASS of them a pass (src/lib/act/drain-rules.ts) -- and
// the lookup runs again: blocked while the duplicates stand, on its way once
// a person has dealt with them. (A row ACT! REFUSED is different: the drain
// holds it until a take-over or a person. So is a row whose revision the
// drain cannot describe, which reads the same each time. See THE BLOCKER.)
//
// THE BLOCKER. ActOutbox.blockedBy says who blocked a row, and decides what
// the drain's pass over blocked rows does with it (replanBlocked in
// src/lib/act/drain-rules.ts, whose BLOCKED_BY lists the values):
//
//   null        a block of this planner's: re-planned every pass, and lifted
//               once nextStep no longer returns it.
//   "contact"   the quote held over its contact's create (A CONTACT CREATE
//               IN FLIGHT, next): nextStep's block carries `by: "contact"`,
//               and the drain stores the same when it sees the create go
//               unaccounted for. Re-planned like null: held while the marker
//               stands and the row needs the contact, lifted once an
//               administrator has settled the contact.
//   "drain"     a lookup's duplicates: rechecked, as above.
//   "act"       a write ACT! refused, or a record it denied PathQuote: held
//               until a take-over or a person.
//   "revision"  a revision the drain cannot describe: held likewise.
//   "admin"     on a finished row only: an administrator chose not to send
//               the quote.
//
// Everything that asks why a row is held reads this column, never
// blockedReason, which is a sentence for a manager and can be reworded
// (BLOCKED REASONS ARE READ BY A MANAGER).
//
// A CONTACT CREATE IN FLIGHT is marked on the Contact, not the row, because
// the record being created is the contact, and a contact belongs to every
// quote that uses it. Marked on the row, a contact POST whose answer was lost
// blocked only that quote's row: the next quote on the same PathQuote contact
// found actContactId null and its own row clean, planned create-contact, and
// POSTed again -- a second person in ACT!. So the drain sets
// Contact.actCreateInFlightAt -- only while it and actContactId are both null,
// and in the same transaction as a guarded write to the row, so a taken-over
// row sends nothing -- and clears it in the update that stores actContactId,
// or when the POST made nothing (createMadeNothing). While it is set and
// actContactId is null, nextStep blocks wherever it would plan create-contact,
// whichever row is asking, with UNTRACKED_CONTACT_REASON and `by: "contact"`
// (blockedBy "contact", THE BLOCKER above). A row with nothing
// left that needs the contact -- its revision journaled, no deal event due --
// is still `done`: the marker is a fact about the contact, not about that
// row. The block lifts when a person has looked: actContactId set to the
// contact ACT! holds, or the marker cleared because ACT! holds nobody.
// NOTHING THE DRAIN DOES CLEARS IT ON ITS OWN. A take-over keeps the marker, a
// re-finalise is a take-over, and no pass clears it, however many hours
// apart. An administrator settles it on the quote's page -- "ACT! has this
// person" or "ACT! has nobody" (contactFoundDecision and
// contactAbsentDecision in src/lib/act/outbox-admin.ts) -- or the developer
// by hand when the app cannot (FOR TASK 10, next); UNTRACKED_CONTACT_REASON
// says so, and sends the manager to an administrator. Nor may the manager
// work round it: deleting the contact -- or its company, which deletes its
// contacts -- sets its quotes' Document.contactId to null, so nothing holds
// them any more, and the person added again is a new contact with no ACT! id
// and no marker, whom the next finalise POSTs: the same person in ACT! twice.
//
// FOR TASK 10 -- the runbook's section on a held contact, to be lifted from
// here as it stands. Every command runs on the VPS from /opt/pathquote.
//
//   Which contacts are held. A contact is held while its create's outcome is
//   unknown: actCreateInFlightAt set and actContactId null. Every quote on
//   it that still needs the contact in ACT! is blocked, once the drain has
//   reached it, with blockedBy "contact" and UNTRACKED_CONTACT_REASON.
//
//     docker compose exec -T postgres psql -U pathquote -d pathquote -c \
//       "select id, \"firstName\", \"lastName\", email, \"actCreateInFlightAt\" from \"Contact\" where \"actCreateInFlightAt\" is not null and \"actContactId\" is null;"
//
//   actCreateInFlightAt is when the POST was about to leave, in UTC.
//
//   Whether PathQuote learned ACT!'s id. When ACT! answered the create with
//   an id and PathQuote then failed to store it, the drain logged, with
//   console.error from Pass.storeCreated in src/lib/act/drain.ts:
//
//     act: ACT! created a contact whose id PathQuote could not store; the contact stays marked in flight
//
//   followed by the outbox row's `id`, the PathQuote `contactId` and the ACT!
//   id as `actContactId`. Which log it is in depends on the drain that made
//   the contact: the fast path after a finalise, a signature or an
//   acceptance runs in the app, the 15-minute drain and the nightly sync's
//   in the `tools` container, each into its unit's log on the VPS:
//
//     docker compose logs app 2>&1 | grep -A 8 'whose id PathQuote could not store'
//     grep -A 8 'whose id PathQuote could not store' /var/log/pq-act-drain.log /var/log/pq-act-sync.log
//
//   (A Sync now press drains in the app too.) With no such line for
//   the contact -- no answer, a 5xx or a redirect, a success PathQuote could
//   not read, or a 408; the log has "act: ACT! may have created this
//   contact" for it -- PathQuote never had an id: look for the person in
//   ACT! by name and email, created around actCreateInFlightAt.
//
//   If ACT! holds the person, give PathQuote that ACT! id:
//
//     docker compose exec -T postgres psql -U pathquote -d pathquote -c \
//       "UPDATE \"Contact\" SET \"actContactId\" = '<act id>', \"actSyncState\" = 'SYNCED', \"actCreateInFlightAt\" = NULL WHERE id = '<contact id>' AND \"actCreateInFlightAt\" IS NOT NULL;"
//
//   (actSyncState is set with actContactId, as the drain's own store sets
//   it.) If the nightly sync has already imported that ACT! person as a
//   second PathQuote contact, this UPDATE fails on Contact_actContactId_key.
//   That duplicate is the other Contact row with the same actContactId:
//
//     docker compose exec -T postgres psql -U pathquote -d pathquote -c \
//       "select id, \"firstName\", \"lastName\", email, \"companyId\" from \"Contact\" where \"actContactId\" = '<act id>';"
//
//   Merge it into the held contact first -- its quotes and signing requests
//   moved over, then the duplicate deleted (its ActSnapshot goes with it) --
//   and set the id, in one transaction. Every statement but the last also
//   checks that the held contact is still held, so if it is not, nothing at
//   all changes:
//
//     docker compose exec -T postgres psql -U pathquote -d pathquote -v ON_ERROR_STOP=1 -c \
//       "BEGIN; UPDATE \"Document\" SET \"contactId\" = '<contact id>' WHERE \"contactId\" = '<duplicate id>' AND EXISTS (SELECT 1 FROM \"Contact\" WHERE id = '<contact id>' AND \"actCreateInFlightAt\" IS NOT NULL AND \"actContactId\" IS NULL); UPDATE \"SigningRequest\" SET \"contactId\" = '<contact id>' WHERE \"contactId\" = '<duplicate id>' AND EXISTS (SELECT 1 FROM \"Contact\" WHERE id = '<contact id>' AND \"actCreateInFlightAt\" IS NOT NULL AND \"actContactId\" IS NULL); DELETE FROM \"Contact\" WHERE id = '<duplicate id>' AND \"actContactId\" = '<act id>' AND EXISTS (SELECT 1 FROM \"Contact\" WHERE id = '<contact id>' AND \"actCreateInFlightAt\" IS NOT NULL AND \"actContactId\" IS NULL); UPDATE \"Contact\" SET \"actContactId\" = '<act id>', \"actSyncState\" = 'SYNCED', \"actCreateInFlightAt\" = NULL WHERE id = '<contact id>' AND \"actCreateInFlightAt\" IS NOT NULL; COMMIT;"
//
//   psql prints each statement's count: DELETE 1 and the UPDATE after it,
//   UPDATE 1, is a merge done. DELETE 0 and UPDATE 0 is the held contact
//   not held any more, or a wrong contact id, and nothing was changed. An
//   error -- Contact_actContactId_key again, for a wrong duplicate id --
//   rolls the whole of it back.
//
//   If ACT! holds nobody, release the hold, and the next pass creates them:
//
//     docker compose exec -T postgres psql -U pathquote -d pathquote -c \
//       "UPDATE \"Contact\" SET \"actCreateInFlightAt\" = NULL WHERE id = '<contact id>' AND \"actContactId\" IS NULL;"
//
//   Then nothing else is needed: the next full drain pass re-plans every
//   blocked row, finds nextStep no longer blocking on this contact, and
//   unblocks every quote on it by itself (blockedBy "contact", which the pass
//   re-plans as the planner's own) -- the periodic drain, within 15 minutes,
//   or the nightly sync's.
//   (A fast path, over one quote, does the same for that quote alone.)
//
//   On the held quote's own page, an administrator has the two common cases
//   as actions (src/lib/act/outbox-admin.ts, src/lib/actions/act-outbox.ts):
//   "ACT! has this person", which takes the ACT! id and makes the first
//   UPDATE above, and "ACT! has nobody", which makes the release just above
//   -- each guarded the same way, and also on the contact having no ACT! id
//   yet and the marker being the one the action read. "ACT! has this
//   person" first reads the id back from ACT! (GET /api/contacts/{id}),
//   outside any transaction and within 40 seconds (ACT_CONTACT_CHECK_LIMITS,
//   one try of 10 seconds a request), and links nothing when ACT! has no such
//   contact, cannot be asked, or holds somebody whose name and email both
//   differ from the PathQuote contact's (actContactCheck). Each also makes
//   due, at once, every quote on the contact still held for it (blockedBy
//   "contact", whatever its blockedReason says), rather than leaving that to
//   the next full pass. The runbook points to them first, and keeps
//   the SQL for when the app cannot be used.
//
//   THE MERGE STAYS SQL. "ACT! has this person" refuses when another
//   PathQuote contact already carries that ACT! id, names it, and sends the
//   administrator to the developer for the merge above. Expect that to be
//   the usual case rather than the exception once an inbound sync has run
//   since the create: a person ACT! did make is a Prospect, edited after the
//   sync's cursor, so the nightly sync -- or a Sync now press -- imports them
//   as a new PathQuote contact, and the duplicate is there by morning.
//
//   FOLLOW-UP, not built: the inbound sync could ADOPT instead of import.
//   When it meets a NEW ACT! contact -- no PathQuote contact carries its id
//   -- whose `created` is at or after a PathQuote contact's
//   actCreateInFlightAt, and whose email and name match that held contact's
//   exactly, it could set the held contact's actContactId (and actSyncState
//   SYNCED) and clear its marker, rather than import a second contact. That
//   settles the common case of a lost contact-create answer by itself, with
//   no merge by the developer. Not built now because the window is rare --
//   a POST whose answer was lost, or whose id PathQuote failed to store --
//   and because among ACT!'s 17.5k contacts an email is no identity (shared
//   inboxes, duplicates, contacts with none; the reason the drain never
//   looks a contact up by email, A CREATE IN FLIGHT above). The
//   created-at-or-after-the-marker condition narrows it to one candidate,
//   which is what would make it safe enough; an adoption should still be
//   logged, and should refuse when more than one ACT! contact qualifies.
//
// A REQUIREMENT ON THE DRAIN (src/lib/act/drain.ts): after
// create-opportunity, the two stores -- Document.actOpportunityId and the
// row's opportunityActId -- MUST be one database transaction. If the row's
// is saved and the Document's is not, this row moves on to write-history
// believing the deal has its opportunity,
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
// A TAKE-OVER CAN LAND MID-STEP, between nextStep and the store of the step's
// result, and it usually keeps the revision -- a signature or an acceptance
// landing on the finalise's unfinished row, or a re-finalise that changed
// nothing. So the drain's stores on the row are guarded by
// ActOutbox.generation, which every take-over adds 1 to, and NOT by
// quoteRevisionId: a store on the row that finds the generation moved on
// changes nothing, and the row is planned again from what the take-over left
// it. Otherwise a `skip` decided before a signature's take-over and stored
// after it would put back the productLineSkippedAt the take-over cleared, and
// a Won deal would never show the signed figure (A WON DEAL SHOWS THE LATEST
// SIGNED FIGURE). The exact rule, and its one exception, is requirement 1 in
// src/lib/act/outbox.ts.
//
// BLOCKED REASONS ARE READ BY A MANAGER on the quote, so they are sentences
// that say what to do, in the voice of src/lib/act/sync-view.ts: a fault the
// manager can fix names the fix; a fault only PathQuote's configuration can
// fix says "ask your developer"; a record that may or may not be in ACT!
// says what happened and what has to happen before the write is tried again
// -- for a contact, that PathQuote will not try again on its own and an
// administrator settles it on the quote's page (FOR TASK 10 above). The
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


/**
 * The values of ActOutbox.createInFlight: the record a POST of this row may
 * have made. No contact: a contact create's marker is on the Contact. See A
 * CREATE IN FLIGHT.
 */
export const CREATE_IN_FLIGHT = {
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
    /**
     * Contact.actCreateInFlightAt: set while a create of this contact may
     * have made a person in ACT! whose id was never stored, by any quote's
     * row. See A CONTACT CREATE IN FLIGHT.
     */
    actCreateInFlightAt: Date | null;
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
  /**
   * `reason` is the sentence a manager reads (BLOCKED REASONS ARE READ BY A
   * MANAGER). `by` is "contact" -- BLOCKED_BY.contact in
   * src/lib/act/drain-rules.ts -- on the one block that holds the quote for
   * its contact's create (UNTRACKED_CONTACT_REASON), and absent on every
   * other: what the drain stores as ActOutbox.blockedBy (plannerBlockedBy),
   * and what everything that asks "is this quote held for its contact?"
   * reads, rather than the sentence.
   */
  | { kind: "blocked"; reason: string; by?: "contact" };

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
 * A contact create whose outcome never reached the store (A CONTACT CREATE IN
 * FLIGHT) -- made for this quote or for another quote on the same contact:
 * the answer was lost, ACT! answered 408, or it came back and storing it
 * failed. PathQuote holds no record of whether ACT! made the contact, and
 * creating it again could put the same person in ACT! twice, so a person has
 * to look -- and nothing in PathQuote will look for them: no pass, take-over
 * or re-finalise clears the hold, which an administrator settles on this
 * quote's page after looking in ACT! (A CONTACT CREATE IN FLIGHT, and FOR
 * TASK 10, in the header). The sentence says both, and warns off the
 * workaround a manager might try, deleting and re-adding the contact, which
 * lifts the hold and creates the person again.
 *
 * Read by a manager, who sees this sentence on the quote but not the
 * administrator's buttons under it, so it sends them to an administrator
 * rather than naming the buttons.
 *
 * A SENTENCE, NOT A KEY. Every block with it is stored with ActOutbox.blockedBy
 * "contact" (BLOCKED_BY.contact in src/lib/act/drain-rules.ts): nextStep's
 * carries `by: "contact"`, and the drain's own blocks with it pass that
 * blocker. Whatever asks "is this quote held for its contact?" reads that
 * column, never this text, so rewording it changes only what a person reads.
 * A row blocked before a rewording shows the old text until a drain pass
 * re-plans it (`reblock`, replanBlocked in src/lib/act/drain-rules.ts), and
 * is held for its contact all the same.
 */
export const UNTRACKED_CONTACT_REASON =
  "PathQuote asked ACT! to create this quote's contact and has no record of whether it did, so they may be in ACT! already, and creating them again could put the same person in ACT! twice — PathQuote will not try again on its own: an administrator has to look in ACT! and settle it on this quote's page, and nobody should delete or re-add this contact.";

/**
 * The sentence for a value in ActOutbox.createInFlight that nothing here
 * knows: the only value nextStep blocks on. (An opportunity, a line or a
 * History in flight does not block: the drain's lookup resolves it. A
 * contact's marker is on the Contact, and blocks with
 * UNTRACKED_CONTACT_REASON.)
 */
export function untrackedCreateReason(createInFlight: string): string {
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
 * The client's standing signature makes a customer of the quote's contact as
 * it stands -- unless that contact is the one already promoted; see PROMOTION
 * IS ONCE PER CONTACT.
 *
 * The signature alone, not "signature or acceptance". acceptQuote requires
 * signingStatus SIGNED, so an acceptance can never arrive before a signature
 * -- the "or accepted" arm only ever mattered after voidSignature, which
 * leaves acceptedAt set as a stale flag. Honouring it would promote a contact
 * corrected after a void before that person had signed anything, which is the
 * same unsigned-confirmation the win refuses (THE WIN NEEDS A STANDING
 * SIGNATURE). Vadym's own words for the trigger were "the contact signed the
 * quote". His other trigger, "the quote's status changed in PathQuote", is the
 * manual WON outcome in docs/specs/2026-10-12-quote-outcomes-and-reporting-
 * backlog.md, not acceptQuote, and arrives with that feature.
 */
function promotionDue(quote: QuoteState): boolean {
  const won = quote.signingStatus === "SIGNED";
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
  // A create that may have made a record of a kind nothing here knows stops
  // everything, `done` included, until a person has looked (A CREATE IN
  // FLIGHT). An opportunity, a line or a History resolves itself: the drain
  // looks it up before creating it. A contact's is on the Contact, below.
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
  // No region check: every region has a process (processForRegion's default).
  if (!quote.contact) return { kind: "blocked", reason: NO_CONTACT_REASON };

  if (!quote.contact.actContactId) {
    // A create of this contact may already have made them in ACT! -- for
    // this quote or another on the same contact (A CONTACT CREATE IN
    // FLIGHT). First, because it is the one a second POST makes worse.
    if (quote.contact.actCreateInFlightAt) return { kind: "blocked", reason: UNTRACKED_CONTACT_REASON, by: "contact" };
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

  // The deal's money first, the contact's status last (PROMOTION GOES LAST).
  if (win || signedLine) {
    // The row that journaled this revision did its opportunity step first,
    // and nothing clears Document.actOpportunityId, so it is set here unless
    // the database was edited by hand; if it is not, the opportunity is
    // created before its line is written or it is won, rather than either
    // being sent to nothing.
    if (!quote.actOpportunityId) return { kind: "create-opportunity" };
    if (win) {
      // Whatever this row skipped: the win overturns a closed status, and a
      // won deal shows the accepted, signed figure -- written first, as a
      // step of its own.
      return lineBehind(revision, quote)
        ? { kind: "write-accepted-line", line: lineWrite(quote) }
        : { kind: "win-opportunity" };
    }
    // A signature, with the line behind: the line step again.
    return { kind: "write-product-line", line: lineWrite(quote) };
  }

  // Journaled, and neither the win nor the line due: so the promotion is,
  // or `done` would have been returned above.
  return { kind: "promote-contact" };
}
