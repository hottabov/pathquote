// The request bodies a finalised quote sends to ACT!: the contact, when ACT!
// does not have it yet; one History record per revision; the Opportunity that
// stands for the whole deal, and the one product line that carries its amount;
// and -- once the client signs or the quote is accepted -- the contact's
// promotion from Prospect to Customer and the opportunity's win. Where a body
// depends on what ACT! holds now (a later revision's opportunity update, its
// product line, the win, the promotion), the function here takes that state as
// read back by the drain and decides, including deciding to send nothing.
//
// Pure, and deliberately free of Prisma types: every input is a plain value
// the drain reads off the quote and hands in. That is what lets the suite test
// these under `isolate: false` (see vitest.config.ts), and it keeps the one
// part of the write that decides what ACT! is told out of the I/O shell.
//
// THE DEAL AMOUNT IS ONE PRODUCT LINE. ACT! computes an opportunity's amount
// rather than taking it: `productTotal` (shown as "Total"), `weightedTotal`
// and `grossMargin` are all `isReadOnly: true, isProtected: true` in
// RAW/ACT/meta/fields_all.json (the field metadata captured off the production
// box; a local capture, not committed), and `productTotal` is the sum of the
// opportunity's products. Swagger marks none of them read-only, which is how an
// earlier version of this module came to send `productTotal` on every create
// and revision. Nothing here sends any of the three now. The amount is carried
// by ONE SUMMARY PRODUCT LINE per deal instead -- summaryProductBody, posted to
// `/api/opportunities/{opportunityId}/products`: quantity 1, priced at the
// revision's total, named with the revision and the amount in its currency. A
// later revision PATCHes that same line in place (summaryProductPatch); it is
// never deleted and re-created.
//
// Why one line and not the quote's lines. The design spec
// (docs/superpowers/specs/2026-09-08-act-integration-design.md, "Quote line
// items go to /api/opportunities/{id}/products as free-form entries") wanted
// every line item. But a revision can add, drop and reprice lines, and keeping
// a set of products in step with that means deleting the ones that went --
// while the same spec's guardrail is that PathQuote never calls DELETE in
// ACT!. One line, patched in place, keeps the opportunity's amount right with
// no deletes. What was quoted, line by line, is in the quote PDF.
//
// THE CURRENCY PROBLEM. An ACT! opportunity has no currency field anywhere --
// `productTotal`, `weightedTotal`, `grossMargin` and the rest are bare numbers
// (act.web.api.models.Opportunities.Opportunity in RAW/ACT/swagger.json, a
// local capture, not committed) -- and neither has its product
// (act.web.api.models.Opportunities.OpportunityProduct: a name, prices, a
// quantity, a discount, no currency).
// PathQuote quotes exist in AUD, USD and GBP, and nothing in the schema
// converts between them. So the currency travels as text where people read it:
// in the opportunity's `name` ("Q-AU-2026-014 — AUD 45,000.00"), which every
// ACT! list and lookup shows, in the product line's `name`, and again in the
// History `details`. The amount still reaches `productTotal`, through the
// product line and in the quote's own currency, because it is the
// opportunity's amount field and an opportunity without one is a deal with no
// value anywhere ACT! reads it.
//
// WHAT THAT DOES NOT FIX. ACT!'s own pipeline analytics sum `productTotal`
// across every opportunity they cover, whatever currency each one was quoted
// in. A pipeline holding an AUD 45,000 quote and a USD 30,000 quote reports
// 75,000 of nothing. Putting the code in the name tells a person reading one
// opportunity what its number means; it does nothing for a total ACT!
// computes. Anyone reading ACT!'s pipeline or forecast figures across regions
// is reading a meaningless sum, and nothing here can stop that short of
// converting every figure to one currency -- which needs rates PathQuote does
// not have and a decision nobody has made.
//
// The money in those strings is formatted here rather than by `formatMoney` in
// src/lib/format.ts, which was checked and does not fit. It prints whatever
// Intl puts in front of the number for the locale: under its en-AU default
// that is "USD" and "GBP" for those two but a bare "$" for AUD -- so the one
// currency most in need of telling apart from USD is the one that loses its
// code -- and under en-US it is "$" for USD instead. And it drops the decimals
// from a whole amount ("$45,000"), where these strings always carry two. See
// `moneyWithCode`.
//
// WHO OWNS WHAT IS WRITTEN. The record manager is the quote author's mapped
// ACT! user (User.actUserId, filled by `npm run act:map-users`). An author with
// no mapping -- a distributor with no ACT! login, say -- falls back to the
// service account's own ACT! user id, passed in by the caller. Nothing in a
// body then claims a person: there is no second user field filled in to
// suggest otherwise.
//
// THAT ID HAS NO SOURCE YET -- Task 7 must give it one. The service account
// is the user `ACT_USER` logs in as, but `ACT_USER` is a login name, not a
// user uuid (actClientFromEnv in src/lib/act/client.ts passes it as
// `username`), and no setting holds the uuid. So the drain must either add a
// setting for the uuid, or look it up from `GET /api/users` by matching
// `username` against `ACT_USER` (docs/act-integration-reference.md lists the
// fields; it returns every user, unpaged). It is a parameter here rather than
// a constant so that changing the account stays a configuration change.

import { revisionLabel } from "@/lib/documents/revision-plan";
import { plural } from "@/lib/plural";
import { ACT_FIELD } from "@/lib/act/types";
import {
  processForRegion,
  stageMove,
  type StageDef,
  type StageMove,
  type StagePosition,
} from "@/lib/act/opportunity-stages";

/** ACT! history type 62, "Quote" -- "A Quote has been produced for an Opportunity". */
export const HISTORY_TYPE_QUOTE = 62;

/**
 * ACT!'s opportunity status values.
 *
 * From the `enum` declared on Opportunity.status in RAW/ACT/swagger.json (a
 * local capture, not committed):
 * `Open`, `Won`, `Lost`, `Inactive` ("This displays the status of the
 * opportunity (Open, Won, Lost, or inactive)"). That is ACT!'s own published
 * schema for this installation, not a guess -- but no opportunity has yet been
 * read back from the live API to see these strings on a real record, and a
 * schema can declare an enum the server serialises differently. Confirm
 * against a live `GET /api/opportunities` before the first write. Every status
 * this module sends comes from here, and so do the ones it reads back (`open`
 * in revisedOpportunityBody, `won` in wonOpportunityBody), so that check
 * changes one place. `Inactive` is absent only because nothing here sends it
 * or tests for it.
 */
export const OPPORTUNITY_STATUS = {
  open: "Open",
  won: "Won",
  lost: "Lost",
} as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUS)[keyof typeof OPPORTUNITY_STATUS];

/**
 * The two ACT! contact statuses (`idStatus`, "ID/Status") PathQuote reads or
 * writes.
 *
 * Both are values of the field's picklist, "Contact ID/Status", which is
 * `isLimitToList: true` and single select (RAW/ACT/meta/fields_contact.json,
 * a local capture, not committed), so a value written here has to be spelled
 * exactly as the list has it. (Whether the API itself refuses a value off the
 * list has not been tried.) They are also the two statuses the inbound sync
 * imports (ACTIVE_STATUSES in src/lib/act/types.ts), which is what keeps a
 * contact PathQuote creates (as a Prospect, newContactBody) or promotes in
 * PathQuote on the next sync; a test ties the two lists together.
 */
export const CONTACT_STATUS = {
  prospect: "Prospect",
  customer: "Customer",
} as const;

export type ContactStatus = (typeof CONTACT_STATUS)[keyof typeof CONTACT_STATUS];

/**
 * One finalised revision of a quote, as plain values.
 *
 * READ THESE FROM THE REVISION, NOT THE DOCUMENT. The figures come from the
 * QuoteRevision the outbox row was queued for (ActOutbox.quoteRevisionId) and
 * its frozen `snapshot` (RevisionSnapshot in
 * src/lib/documents/revision-snapshot.ts), never from the live Document.
 * Unfinalising a quote leaves Document.revision and Document.finalizedAt as
 * they were but makes the draft editable again -- its total, its validity,
 * every price -- and a row can be drained after that has happened. Read off
 * the Document, the History would say "Revision n" beside the draft's current
 * total: a figure no customer was ever sent. The revision row and its snapshot
 * are what was sent, and nothing edits them.
 *
 * Only `number` and `regionCode` are read live, each for the reason given on
 * it.
 */
export type QuoteForAct = {
  /**
   * Document.number, e.g. "Q-AU-2026-014". Safe to read live: allocated at the
   * first finalise, kept by unfinalise and reused by every later finalise
   * (finalizeDocument in src/lib/actions/finalize.ts), and edited by nothing.
   */
  number: string;
  /**
   * QuoteRevision.revision: 0 for the first, then 1, 2, ... Not
   * Document.revision, which a later finalise moves on to the next revision.
   */
  revision: number;
  /**
   * Region.code of Document.regionId. Safe to read live: createDraft sets the
   * region and no action on a draft changes it.
   */
  regionCode: string;
  /**
   * QuoteRevision.total (Decimal(12,2), the same figure as the snapshot's
   * `totals.total`), in `currency`, as a number. Not Document.total.
   */
  total: number;
  /**
   * The snapshot's `currency`, an ISO 4217 code. QuoteRevision has no currency
   * column. (Document.currency is set by createDraft and never changed, so the
   * two agree; the snapshot is named so every figure in a record comes from
   * the one frozen place.)
   */
  currency: string;
  /**
   * The snapshot's `terms.validityDays`: the validity the revision was sent
   * with, in days. No fallback is left for the caller to apply --
   * finalizeDocument resolves the org-wide default for a quote with no
   * override of its own and freezes the result, into Document.validityDays and
   * into this snapshot. The snapshot's type still allows null, which only a
   * revision 0 written by scripts/backfill-quote-revisions.ts can hold; a
   * finalise never writes one, and never keeps one either (its own snapshot
   * always carries a number, so the hashes differ and planRevision mints a new
   * revision). A null here therefore means a row pointing at a revision no
   * finalise produced: refuse it rather than default it.
   */
  validityDays: number;
  /**
   * QuoteRevision.createdAt: when this revision was first finalised, written
   * inside the finalise transaction that created it. Not
   * Document.finalizedAt, which every finalise overwrites -- an unchanged
   * re-finalise that keeps this revision, and the finalise of a later one.
   * (For a revision 0 written by the backfill it is when the backfill ran.)
   */
  finalizedAt: Date;
};

/** Who and what in ACT! the records attach to. */
export type ActParties = {
  /** The contact's ACT! id. Always present by the time a body is built. */
  contactActId: string;
  /** The company's ACT! id, or null: most PathQuote companies have none. */
  companyActId: string | null;
  /** The author's mapped ACT! user (User.actUserId), or null when unmapped. */
  authorActUserId: string | null;
  /**
   * The service account's ACT! user uuid. Not `ACT_USER`, which is its login
   * name; see WHO OWNS WHAT IS WRITTEN above for where Task 7 must get it.
   */
  serviceAccountUserId: string;
};

/** An embedded reference: ACT! needs only the uuid. */
export type ActRef = { id: string };

/** A stage as sent: the transcribed stage, with its process nested the way ACT!'s Stage nests it. */
export type StageBody = {
  id: string;
  name: string;
  probability: number;
  number: number;
  process: ActRef;
};

/** The body of `POST /api/History`. */
export type HistoryBody = {
  historyTypeID: number;
  regarding: string;
  details: string;
  startTime: string;
  endTime: string;
  recordManagerID: string;
  isPrivate: false;
  contacts: ActRef[];
  companies?: ActRef[];
  opportunities?: ActRef[];
};

/**
 * The body of `POST /api/opportunities`. No amount: ACT! computes
 * `productTotal` from the products (THE DEAL AMOUNT IS ONE PRODUCT LINE).
 */
export type NewOpportunityBody = {
  name: string;
  stage: StageBody;
  probability: number;
  status: OpportunityStatus;
  openDate: string;
  recordManagerID: string;
  contacts: ActRef[];
  companies?: ActRef[];
};

/**
 * An existing opportunity as the drain reads it back from ACT! before
 * patching it: where it sits, for "never backwards", and its status, for
 * "never rewrite a closed deal". All three come off the drain's
 * `GET /api/opportunities/{id}`: `stage.process.id`, `stage.number`, `status`.
 */
export type OpportunityNow = StagePosition & {
  /** Opportunity.status exactly as ACT! returned it -- not narrowed, because what it says is not ours to assume. */
  status: string;
};

/**
 * What a write changes on an opportunity, laid over the record as read
 * (mergeForWrite in src/lib/act/record-write.ts) before
 * `PATCH /api/opportunities/{id}`. No amount, for the reason NewOpportunityBody
 * has none.
 */
export type OpportunityPatch = {
  name?: string;
  stage?: StageBody;
  probability?: number;
  status?: OpportunityStatus;
  reason?: string;
  actualCloseDate?: string;
};

/**
 * An amount with its ISO currency code: "AUD 12,345.60".
 *
 * The code and not a symbol, because "$" is both AUD and USD and these
 * strings are the only place in ACT! the currency is recorded at all. Always
 * two decimals, because a figure in a list reads more evenly that way and an
 * amount on a quote is never meant as approximate. The grouping is en-AU's,
 * the same as the app's.
 */
export function moneyWithCode(amount: number, currency: string): string {
  const figure = new Intl.NumberFormat("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return `${currency} ${figure}`;
}

function recordManager(parties: Pick<ActParties, "authorActUserId" | "serviceAccountUserId">): string {
  return parties.authorActUserId ?? parties.serviceAccountUserId;
}

function companiesOf(parties: ActParties): { companies?: ActRef[] } {
  return parties.companyActId ? { companies: [{ id: parties.companyActId }] } : {};
}

function stageBody(stage: StageDef): StageBody {
  return {
    id: stage.id,
    name: stage.name,
    probability: stage.probability,
    number: stage.number,
    process: { id: stage.processId },
  };
}

/**
 * The opportunity's name: quote number, currency and total.
 *
 * The bare number, not the revision label: the opportunity is the whole deal,
 * and a revision of an open deal renames it with the new total rather than a
 * new suffix (a closed one is not renamed at all; see revisedOpportunityBody).
 */
function opportunityName(quote: QuoteForAct): string {
  return `${quote.number} — ${moneyWithCode(quote.total, quote.currency)}`;
}

/**
 * The region's process, or a thrown error.
 *
 * The planner (src/lib/act/outbox-plan.ts) blocks a row whose region is
 * unmapped before any body is built, so reaching the throw means a caller
 * skipped it. Throwing rather than defaulting keeps a mistake there from
 * writing a deal into another region's pipeline.
 */
function stagesFor(regionCode: string) {
  const process = processForRegion(regionCode);
  if (!process) {
    throw new Error(`No ACT! sales process is mapped for region ${regionCode}.`);
  }
  return process;
}

/**
 * The History record for one finalised revision.
 *
 * `opportunityActId` links it to the deal's opportunity when there is one;
 * ACT! does not require the link.
 */
export function historyBody(
  quote: QuoteForAct,
  parties: ActParties,
  opportunityActId: string | null,
): HistoryBody {
  const label = revisionLabel(quote.number, quote.revision) ?? quote.number;
  const at = quote.finalizedAt.toISOString();
  return {
    historyTypeID: HISTORY_TYPE_QUOTE,
    regarding: `Quote ${label} finalised in PathQuote`,
    details: [
      `Total: ${moneyWithCode(quote.total, quote.currency)}`,
      `Valid for ${plural(quote.validityDays, "day", "days")}`,
      `Revision ${quote.revision}`,
    ].join("\n"),
    startTime: at,
    endTime: at,
    recordManagerID: recordManager(parties),
    isPrivate: false,
    contacts: [{ id: parties.contactActId }],
    ...companiesOf(parties),
    ...(opportunityActId ? { opportunities: [{ id: opportunityActId }] } : {}),
  };
}

/** The opportunity a quote's first finalise opens, at its region's sent stage. */
export function newOpportunityBody(quote: QuoteForAct, parties: ActParties): NewOpportunityBody {
  const sent = stagesFor(quote.regionCode).sent;
  return {
    name: opportunityName(quote),
    stage: stageBody(sent),
    probability: sent.probability,
    status: OPPORTUNITY_STATUS.open,
    openDate: quote.finalizedAt.toISOString(),
    recordManagerID: recordManager(parties),
    contacts: [{ id: parties.contactActId }],
    ...companiesOf(parties),
  };
}

/**
 * Whether ACT! says this opportunity is Open: exactly OPPORTUNITY_STATUS.open,
 * and nothing else -- not a different case, not a status never seen before,
 * not a missing one. Everything that writes a revision's figures into an
 * existing deal asks this first: revisedOpportunityBody for the opportunity,
 * and productLineWrite for its product line. A deal that is not Open is left
 * alone by both -- the line of a won deal of an accepted quote apart.
 */
export function opportunityIsOpen(status: string | null): boolean {
  return status === OPPORTUNITY_STATUS.open;
}

/**
 * Whether write-product-line writes the deal's line for the row's revision,
 * decided on the opportunity as the drain reads it just before.
 *
 * - `write`: the deal is Open, so the revision's figure is the deal's; or it
 *   is Won and the quote is accepted (`accepted`: Document.acceptedAt is
 *   set), so the accepted quote's figure is what the deal was won at. That
 *   second case is a quote voided and re-finalised after its win: still
 *   accepted, at a new figure, and the win never planned again
 *   (src/lib/act/outbox-plan.ts, THE WIN WRITES THE LINE FIRST).
 * - `skip`: anything else -- Lost, Inactive, Won without an acceptance in
 *   PathQuote, a status never seen. The line is part of the record of how the
 *   deal ended, and is left alone, as revisedOpportunityBody leaves the
 *   opportunity. `status` is what ACT! said, for the drain to report.
 *
 * On `skip` the drain sends nothing and stores ActOutbox.productLineSkippedAt
 * -- never Document.actProductLineRevision, which says what the line shows.
 * A skipped line on a deal the quote's acceptance then wins is written by
 * win-opportunity, before the status.
 */
export type ProductLineWrite = { kind: "write" } | { kind: "skip"; status: string | null };

export function productLineWrite(status: string | null, accepted: boolean): ProductLineWrite {
  if (opportunityIsOpen(status)) return { kind: "write" };
  if (accepted && status === OPPORTUNITY_STATUS.won) return { kind: "write" };
  return { kind: "skip", status };
}

/**
 * What a later revision does to the deal's existing opportunity.
 *
 * - `patch`: the opportunity is Open. `patch` always carries the name, which
 *   carries the total, since a revision can change the price, and the stage
 *   (with its probability) only when `stage` -- stageMove's verdict, handed
 *   back so the drain can report a "different-process" opportunity it did not
 *   move -- is `move`. Never backwards, never across processes, never a
 *   status, and never an amount: the amount is the product line's
 *   (summaryProductPatch).
 * - `closed`: the opportunity is not Open. Send nothing at all; the revision
 *   is recorded by its History alone. `status` is what ACT! said, for the
 *   drain to report.
 *
 * A union rather than a patch that might be empty, or null: an Open patch is
 * never empty, so "nothing to send" is a different answer, not a smaller one,
 * and it should say why. A `{}` would not be sent anyway -- the client sends
 * no PATCH for a patch with nothing in it (patchToSend in
 * src/lib/act/record-write.ts), because writing the record back whole would
 * still rewrite the closed record and bump its `edited` -- but it would not
 * say that the deal was closed.
 */
export type RevisionUpdate =
  | { kind: "patch"; patch: OpportunityPatch; stage: StageMove }
  | { kind: "closed"; status: string };

/**
 * A later revision's effect on the deal's existing opportunity.
 *
 * AN OPPORTUNITY THAT IS NOT OPEN IS LEFT ENTIRELY ALONE: no stage, no
 * probability, no name -- and no product line either, which is what keeps its
 * total (productLineWrite). Won, Lost or Inactive, it is the record of
 * how the deal ended and at what figure, and silently rewriting a closed
 * record in somebody else's CRM is the worse harm. The
 * History is the journal: it still records that a new revision went out and
 * what its total was. Reached when an admin's voidSignature is followed by a
 * re-finalise, or when somebody closed the deal by hand in ACT!. If the deal
 * genuinely reopens, a person reopens it in ACT!, and the next revision then
 * updates it as normal.
 *
 * "Not Open" is any status other than exactly OPPORTUNITY_STATUS.open,
 * including one never seen before. If ACT! turned out to spell Open some other
 * way, the result would be open deals no longer updated -- visible, and
 * harmless to the CRM -- rather than closed ones rewritten.
 *
 * `current` is the opportunity as read back from ACT! before the patch. Not
 * nullable, on purpose: "never backwards" cannot be honoured without knowing
 * where it is, and a null here would mean "set it as if new", which is
 * exactly a backwards move when somebody has advanced the deal.
 */
export function revisedOpportunityBody(
  quote: QuoteForAct,
  current: OpportunityNow,
): RevisionUpdate {
  if (!opportunityIsOpen(current.status)) {
    return { kind: "closed", status: current.status };
  }
  const sent = stagesFor(quote.regionCode).sent;
  const stage = stageMove(current, sent);
  return {
    kind: "patch",
    stage,
    patch: {
      name: opportunityName(quote),
      ...(stage === "move" ? { stage: stageBody(sent), probability: sent.probability } : {}),
    },
  };
}

/**
 * What accepting the quote does to the deal's opportunity.
 *
 * - `patch`: the opportunity is not Won -- Open, Lost, Inactive, or a status
 *   never seen before. Close it as Won. `stage` is stageMove's verdict on the
 *   won stage, and `found` the status ACT! returned, both for the drain to
 *   report: a deal taken from Lost to Won is worth a line in the run report.
 * - `already-won`: it is Won already -- closed by hand in ACT!, or a resumed
 *   step whose patch went through before its result was stored. Nothing to
 *   send; sending it again would only move the close date.
 */
export type WonUpdate =
  | { kind: "patch"; patch: OpportunityPatch; stage: StageMove; found: string }
  | { kind: "already-won" };

/**
 * Closing the opportunity as won, when the quote is accepted.
 *
 * The status and close date always; the won stage only when `stageMove`
 * allows it. `current` is required for the same reason as in
 * `revisedOpportunityBody`: an opportunity being closed already exists, and
 * what it says now decides what is sent.
 *
 * ACCEPTANCE OVERTURNS A CLOSED DEAL. Vadym's decision, 2026-10-12: "Overwrite
 * to Won -- PathQuote confirms." Accepting needs the client's signature, the
 * manager's signature and acceptQuote, and that is the confirmation he means:
 * the deal is won, whatever somebody had recorded in ACT! before. Nothing in
 * that reasoning depends on which closed status it was, so Lost, Inactive and
 * any status other than exactly OPPORTUNITY_STATUS.won are all patched to Won
 * like an Open one. This is the opposite of revisedOpportunityBody, which
 * leaves every closed deal alone -- a new revision says nothing about how the
 * deal ended, and an acceptance says exactly that.
 *
 * ONCE, SO A LATER LOST STANDS. The rest of the same decision: "If after that
 * someone changes it to Lost by hand in ACT!, it stays that way." Nothing here
 * has to enforce it. When this step is done the drain stores
 * Document.actOpportunityWonAt; nothing clears it, and the planner
 * (src/lib/act/outbox-plan.ts) never plans win-opportunity again once it is
 * set -- not on a second acceptance, not on a later revision. So an
 * opportunity moved to Lost after the win is never read here, let alone
 * overturned; tests/act-outbox-plan.test.ts holds that. The one exception is
 * the planner's repeat window: a win that went through but was not yet stored
 * runs again, and overturns a Lost only if somebody set it in those seconds.
 *
 * THE STAGE ON AN OVERTURN follows the forward-only rule as for an Open deal.
 * The won stage is the last of both processes PathQuote writes into (AU 7 of
 * 7, US 5 of 5), so from wherever a Lost deal stopped in the same process it
 * is forward (`move`, with the stage's 100%) or already reached (`stay`). A
 * deal sitting in a different process from the region's still gets the Won
 * status, and keeps its stage and probability
 * (`different-process`): the status is what the acceptance decides, while
 * stage numbers cannot be compared across processes, and moving a deal into
 * another process is what stageMove refuses everywhere else.
 *
 * `reason` is not sent, so a reason somebody typed for the loss stays on the
 * record beside the Won status. It is that person's note, and PathQuote has
 * no reason of its own to put in its place.
 *
 * THE LINE COMES FIRST. A deal closed by hand before the acceptance may have
 * had its line left alone (productLineWrite), at an earlier revision's figure
 * or with no line at all; overturned to Won as it stands, ACT! would record
 * the win at that figure. So win-opportunity writes the line for the accepted
 * revision before this is asked, whenever it does not show it
 * (src/lib/act/outbox-plan.ts, THE WIN WRITES THE LINE FIRST) -- and an
 * `already-won` deal still gets that line.
 */
export function wonOpportunityBody(
  regionCode: string,
  current: OpportunityNow,
  acceptedAt: Date,
): WonUpdate {
  if (current.status === OPPORTUNITY_STATUS.won) return { kind: "already-won" };
  const won = stagesFor(regionCode).won;
  const stage = stageMove(current, won);
  return {
    kind: "patch",
    stage,
    found: current.status,
    patch: {
      status: OPPORTUNITY_STATUS.won,
      actualCloseDate: acceptedAt.toISOString(),
      ...(stage === "move" ? { stage: stageBody(won), probability: won.probability } : {}),
    },
  };
}

/**
 * Closing the opportunity as lost.
 *
 * No stage and no probability: a lost deal does not advance, and the stage it
 * reached is the record of how far it got.
 */
export function lostOpportunityBody(reason: string, closedAt: Date): OpportunityPatch {
  return {
    status: OPPORTUNITY_STATUS.lost,
    reason,
    actualCloseDate: closedAt.toISOString(),
  };
}

/**
 * What a revision changes on the deal's summary product line, laid over the
 * line as read before `PATCH /api/opportunities/{opportunityId}/products/{productId}`.
 * Field names are swagger's (act.web.api.models.Opportunities.OpportunityProduct);
 * the labels in brackets are ACT!'s, from the `TBL_PRODUCTSERVICE` entries of
 * RAW/ACT/meta/fields_all.json, which mark none of these read-only.
 *
 *   name           ("Name") the revision label and the amount with its
 *                  currency code. The product has no currency field, so this
 *                  is where the line says what its number means.
 *   quantity       ("Quantity") always 1: one line for the whole deal.
 *   price          ("Price") the revision's total.
 *   discountPrice  ("Adjusted Price") the same: no discount.
 *   total          ("Subtotal") the same. Swagger describes it as adjusted
 *                  price times quantity; it is sent anyway, agreeing with the
 *                  rest, so the line comes to the revision's total whichever of
 *                  these ACT! computes from the others -- which has not been
 *                  seen on a live record.
 *
 * Not sent: `discount` (swagger: "ignore on updates"; the create sends 0);
 * `productID`, the ACT! catalogue product, because the line is free-form by
 * the design spec's rule that the catalogue lives in PathQuote (whether ACT!
 * accepts a product with none has not been tried); `cost`, which PathQuote
 * has no figure for, so ACT!'s Gross Margin for the deal means nothing; and
 * `type`.
 */
export type SummaryProductPatch = {
  name: string;
  quantity: 1;
  price: number;
  discountPrice: number;
  total: number;
};

/**
 * The body of `POST /api/opportunities/{opportunityId}/products`: the patch's
 * fields, and `discount` 0, which is ignored on an update but not on a create.
 */
export type SummaryProductBody = SummaryProductPatch & { discount: 0 };

/**
 * The deal's one product line, as this revision has it -- what a later
 * revision PATCHes in place (THE DEAL AMOUNT IS ONE PRODUCT LINE).
 *
 * The name is the revision's label -- "Q-AU-2026-014" for the first,
 * "Q-AU-2026-014-R2" after that, as the History's `regarding` has it -- then
 * the amount with its currency code: "Q-AU-2026-014-R2 — AUD 47,500.00". The
 * label rather than the bare number because the line, unlike the
 * opportunity, says which revision's figure it is.
 *
 * Written when productLineWrite says so -- an Open deal, or a Won one whose
 * quote is accepted -- and by win-opportunity, before it patches the status,
 * whatever the status. Otherwise the line is left alone, as
 * revisedOpportunityBody leaves the opportunity.
 */
export function summaryProductPatch(quote: QuoteForAct): SummaryProductPatch {
  const label = revisionLabel(quote.number, quote.revision) ?? quote.number;
  return {
    name: `${label} — ${moneyWithCode(quote.total, quote.currency)}`,
    quantity: 1,
    price: quote.total,
    discountPrice: quote.total,
    total: quote.total,
  };
}

/** The deal's product line as first created: summaryProductPatch, and no discount. */
export function summaryProductBody(quote: QuoteForAct): SummaryProductBody {
  return { ...summaryProductPatch(quote), discount: 0 };
}

/** A body for `PATCH /api/contacts/{id}`: the one field promotion changes. */
export type ContactStatusPatch = { idStatus: ContactStatus };

/** A PathQuote contact ACT! does not have yet, as plain values off its rows. */
export type ContactForAct = {
  /** Contact.firstName. */
  firstName: string;
  /** Contact.lastName. */
  lastName: string | null;
  /** Contact.email. */
  email: string | null;
  /** Contact.phone: E.164, as PathQuote stores it. */
  phone: string | null;
  /** Contact.position. */
  position: string | null;
  /** Company.name of the contact's company (Contact.companyId). */
  companyName: string;
};

/** Who a contact PathQuote creates belongs to in ACT!: the quote's author. */
export type NewContactOwner = Pick<ActParties, "authorActUserId" | "serviceAccountUserId"> & {
  /**
   * User.actAccountMgr: the author's item of the "Rep" picklist, or null. Set
   * only by `npm run act:map-users` (scripts/map-act-users.ts), and only from
   * an exact match against the picklist as ACT! returned it.
   */
  authorActAccountMgr: string | null;
};

/**
 * The body of `POST /api/contacts`. Field names are the API's
 * (act.web.api.models.Contacts.Contact in RAW/ACT/swagger.json), checked
 * against RAW/ACT/meta/fields_contact.json; both are local captures, not
 * committed.
 */
export type NewContactBody = {
  firstName?: string;
  lastName?: string;
  emailAddress?: string;
  businessPhone?: string;
  jobTitle?: string;
  company?: string;
  idStatus: ContactStatus;
  contactType: "Contact";
  isPrivate: false;
  recordManagerID: string;
  customFields?: Record<string, string>;
};

/** Trimmed text, or undefined for nothing -- an absent field rather than an empty one. */
function given(value: string | null): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The contact ACT! is asked to create when a quote's contact exists only in
 * PathQuote (the planner's create-contact step).
 *
 * A PROSPECT, ALWAYS. Nothing else would set `idStatus` -- the field has no
 * default (`defaultValue` null in RAW/ACT/meta/fields_contact.json) -- and a
 * contact created with it blank is lost twice over: the inbound sync skips it as
 * `inactive-status` (ACTIVE_STATUSES is Customer and Prospect only), and
 * contactPromotion leaves a blank status alone, so it never becomes a
 * Customer either. Somebody being quoted is a Prospect, and the signature or
 * acceptance then promotes them like any other.
 *
 * EVERY FIELD IS THE ONE THE INBOUND SYNC READS IT BACK FROM (mapContact in
 * src/lib/act/map.ts), so the next sync sees the same person PathQuote has:
 *
 *   firstName, lastName  map reads both, trimmed.
 *   emailAddress         map reads it and lowercases it.
 *   businessPhone        map reads businessPhone first and mobilePhone only
 *                        when it is empty, so the one number goes here. Sent
 *                        as E.164: with its "+" it resolves without the
 *                        country map would otherwise need (actPhoneToE164).
 *                        Whether ACT! keeps it as sent or reformats it to a
 *                        phone mask has not been seen on a live record.
 *   jobTitle             "Title", map's `position`. Its picklist, "Jobtitles",
 *                        is NOT limited to the list, so any text is accepted.
 *   company              the free-text company map derives the company from.
 *   customFields.rep     "Account Mgr", limited to the "Rep" picklist. Only
 *                        the author's User.actAccountMgr, which can only hold
 *                        an item of that list; left out when it is null
 *                        rather than guessed, since a wrong Account Mgr does
 *                        not fail -- it hands the client to another manager.
 *   contactType, isPrivate
 *                        map skips anything that is not a "Contact", and any
 *                        private one. Sent rather than left to ACT!'s
 *                        defaults, which have not been seen on a live create.
 *   recordManagerID      the author, else the service account, as for every
 *                        other body here (WHO OWNS WHAT IS WRITTEN).
 *
 * A field PathQuote has no value for is left out, not sent empty, so a contact
 * with no email or phone is still a valid body.
 *
 * THE COMPANY DOES NOT SPLIT on the round trip, but not because of a key. The
 * sync finds a contact it already has by Contact.actContactId -- which the
 * drain stores from this create's answer -- and keeps it on the company it is
 * on (src/lib/act/sync.ts); it derives a company only for a contact it has
 * never seen. No country is sent: businessAddress/country is limited to the
 * "Countries" picklist, whose items have not been read, so the rule for
 * Account Mgr applies. Should the sync ever meet this contact without knowing
 * it -- the create went through and its id was not stored, the repeat window
 * in src/lib/act/outbox-plan.ts -- it would derive `<name>|??` from the
 * company text alone (companyKey in src/lib/act/company-key.ts) and, missing,
 * create a second company for it as well as a second contact. (The country is
 * also marked isAllowBlank false. RAW/ACT/act-country-fixes.csv lists 113
 * contacts stored with a blank one, so ACT! does not enforce it on what it
 * holds; whether a create through the API does has not been tried, and the
 * first live create will say.)
 */
export function newContactBody(contact: ContactForAct, owner: NewContactOwner): NewContactBody {
  const firstName = given(contact.firstName);
  const lastName = given(contact.lastName);
  const emailAddress = given(contact.email);
  const businessPhone = given(contact.phone);
  const jobTitle = given(contact.position);
  const company = given(contact.companyName);
  const accountMgr = given(owner.authorActAccountMgr);
  return {
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(emailAddress ? { emailAddress } : {}),
    ...(businessPhone ? { businessPhone } : {}),
    ...(jobTitle ? { jobTitle } : {}),
    ...(company ? { company } : {}),
    idStatus: CONTACT_STATUS.prospect,
    contactType: "Contact",
    isPrivate: false,
    recordManagerID: recordManager(owner),
    ...(accountMgr ? { customFields: { [ACT_FIELD.accountMgr]: accountMgr } } : {}),
  };
}

/**
 * Whether winning the quote promotes its contact.
 *
 * - `promote`: the contact is a Prospect; `patch` makes it a Customer.
 * - `leave`: anything else. `already-customer` needs nothing; `not-prospect`
 *   is a status PathQuote does not own -- a reseller, a supplier, blank --
 *   and `current` is what ACT! said, for the drain to report. Either way the
 *   step is done: there is nothing for a retry to change.
 */
export type ContactPromotion =
  | { kind: "promote"; patch: ContactStatusPatch }
  | { kind: "leave"; reason: "already-customer" | "not-prospect"; current: string | null };

/**
 * A Prospect becomes a Customer when the client signs or the quote is
 * accepted, whichever comes first (the plan's addendum of 2026-10-12).
 *
 * CHANGE ONLY WHAT WE OWN. `currentIdStatus` is the contact's `idStatus` as
 * the drain reads it back from ACT! just before, and only a Prospect is
 * promoted. Overwriting a status somebody set deliberately is the harm this
 * prevents, so a status not spelled Prospect -- another case, another word --
 * is left alone rather than normalised: a missed promotion is visible and
 * harmless, a wrong one is not.
 *
 * "A Prospect" is decided exactly as the inbound sync decides it (mapContact
 * in src/lib/act/map.ts): trimmed, then compared case for case. A contact
 * stored as " Prospect" is imported into PathQuote as a Prospect, and a
 * comparison stricter than the import's would leave that contact quoted as a
 * Prospect and never promoted. The patch still writes the constant exactly,
 * so the stray space goes with the promotion. The same trim decides
 * `already-customer`; `current` is always what ACT! said, untrimmed.
 *
 * FORWARD ONLY. A Customer never goes back to Prospect -- not on
 * voidSignature, not on unfinalise. There is no demote body, and the planner
 * (src/lib/act/outbox-plan.ts) has no step that would send one.
 */
export function contactPromotion(currentIdStatus: string | null): ContactPromotion {
  const status = currentIdStatus?.trim() ?? null;
  if (status === CONTACT_STATUS.prospect) {
    return { kind: "promote", patch: { idStatus: CONTACT_STATUS.customer } };
  }
  if (status === CONTACT_STATUS.customer) {
    return { kind: "leave", reason: "already-customer", current: currentIdStatus };
  }
  return { kind: "leave", reason: "not-prospect", current: currentIdStatus };
}
