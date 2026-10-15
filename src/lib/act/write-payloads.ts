// The request bodies a finalised quote sends to ACT!: the contact, when ACT!
// does not have it yet; one History record per revision; the Opportunity that
// stands for the whole deal, and the one product line that carries its amount;
// the contact's promotion from Prospect to Customer, once the client's
// signature stands; and the opportunity's win, once the quote is accepted
// with the client's signature standing. Where a body depends on what ACT!
// holds now (a later revision's opportunity update, its product line, the
// win, the promotion), the function here takes that state as read back by the
// drain and decides, including deciding to send nothing.
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
// revision's amount excluding tax, named with the revision and that amount in
// its currency, marked as before tax. A later revision PATCHes that same line
// in place (summaryProductPatch); it is never deleted and re-created.
//
// THE AMOUNT IS BEFORE TAX. Vadym's decision, 2026-10-13: GST on an AU quote,
// VAT on a UK one and nothing on an export make tax-inclusive amounts
// incomparable across regions, and before tax is the usual pipeline base.
// What that figure is, and why it is not the snapshot's `subtotal`, is
// revisionAmount in src/lib/act/drain-rules.ts. The History says it too, with
// the tax-inclusive total beside it for reference (historyBody).
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
// in the opportunity's `name` ("Q-AU-2026-014 AUD"), which every ACT! list and
// lookup shows, in the product line's `name` with the amount ("Q-AU-2026-014
// — AUD 45,000.00 ex GST"), and again in the History `details`. The amount still
// reaches `productTotal`, through the product line and in the quote's own
// currency, because it is the opportunity's amount field and an opportunity
// without one is a deal with no value anywhere ACT! reads it.
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
// WHERE THAT ID COMES FROM. The service account is the user `ACT_USER` logs
// in as, but `ACT_USER` is a login name, not a user uuid (actClientFromEnv in
// src/lib/act/client.ts passes it as `username`), and no setting holds the
// uuid. So the drain looks it up once a pass from `GET /api/users` (which
// returns every user, unpaged), as the one user whose `username` matches
// `ACT_USER` (serviceAccountUserId in src/lib/act/drain-rules.ts), and stops
// its pass when there is none. It is a parameter here rather than a constant
// so that changing the account stays a configuration change.

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
 * opportunity (Open, Won, Lost, or inactive)"). Those names are what is SENT,
 * and ACT! takes them: the first live create sent "Open". What comes BACK is
 * a number (readOpportunityStatus below), so every status read goes through
 * readOpportunityStatus before it is compared with these. Every status
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
 * ACT! READS STATUS BACK AS A NUMBER. The live API answered a GET of an
 * opportunity it had just created with `"status": 0` (production, 2026-10-13)
 * -- not the string swagger declares, while the create's `"status": "Open"`
 * was taken. So the server serialises the .NET enum by value and parses it
 * by name. Swagger lists the names in declaration order, which is the order
 * of the values: 0 Open, 1 Won, 2 Lost, 3 Inactive.
 *
 * Before this, every read status was a number, so nothing was ever Open: the
 * first deal's product line was skipped as if the deal were closed, and it
 * showed 0.
 */
const STATUS_BY_VALUE = ["Open", "Won", "Lost", "Inactive"] as const;

/**
 * Opportunity.status as read from ACT!, as its name: a string as it came, a
 * number by STATUS_BY_VALUE, and "" for anything else. A number outside the
 * list keeps its digits ("7"), which is no status's name -- not Open, so a
 * deal in a status never seen is left alone, as for any status never seen.
 */
export function readOpportunityStatus(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isInteger(raw)) return STATUS_BY_VALUE[raw] ?? String(raw);
  return "";
}

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
 * they were but makes the draft editable again -- its totals, its validity,
 * every price -- and a row can be drained after that has happened. Read off
 * the Document, the History would say "Revision n" beside the draft's current
 * amount: a figure no customer was ever sent. The revision row and its
 * snapshot are what was sent, and nothing edits them.
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
   * The revision's amount EXCLUDING TAX, in `currency`: QuoteRevision.total
   * less the snapshot's `totals.taxAmount` (revisionAmount in
   * src/lib/act/drain-rules.ts, which says why it is not the snapshot's
   * `subtotal`). The deal's amount in ACT!: the product line's price and its
   * name, and the History's first line. Not Document.subtotal or anything else
   * on the Document.
   */
  amountExTax: number;
  /**
   * QuoteRevision.total (Decimal(12,2), the same figure as the snapshot's
   * `totals.total`): the amount WITH tax, in `currency`. For reference only,
   * in the History beside amountExTax; never a price. Not Document.total.
   */
  total: number;
  /**
   * The snapshot's `taxName` -- GST, VAT, Sales Tax, or a Custom quote's own
   * -- which names the tax amountExTax is before. Null when the snapshot has
   * none; the bodies then say "tax".
   */
  taxName: string | null;
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
   * name; see WHERE THAT ID COMES FROM above.
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
  /**
   * REQUIRED BY ACT!, though swagger does not say so: a create without it is
   * refused 400, `"opportunity.EstimatedCloseDate": ["The EstimatedCloseDate
   * field is required."]` (production, 2026-10-13). See estimatedCloseDate.
   */
  estimatedCloseDate: string;
  /** See STAGE START DATE on revisedOpportunityBody. */
  stageStartDate: string;
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
 * has none, and no name: the name is set on create only (opportunityName).
 */
export type OpportunityPatch = {
  stage?: StageBody;
  probability?: number;
  /** Sent with `stage`, and only then: see STAGE START DATE on revisedOpportunityBody. */
  stageStartDate?: string;
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
 * ACT!'s limit on an opportunity's name: `TBL_OPPORTUNITY` `name`, "Opportunity
 * Name", Character 32, in RAW/ACT/meta/fields_all.json (a local capture, not
 * committed).
 */
export const OPPORTUNITY_NAME_MAX = 32;

/**
 * The opportunity's name: the quote number and its currency code,
 * "Q-AU-2026-1000 AUD".
 *
 * NO AMOUNT, because of OPPORTUNITY_NAME_MAX. Quote numbers are
 * `Q-{region}-{year}-{counter}`, the counter padded to three digits and never
 * truncated (formatDocNumber in src/lib/numbering.ts), and with an amount in
 * it -- "Q-AU-2026-1000 — AUD 1,250,000.00" is 33 -- a big quote in a busy
 * year would not fit. Without one, a five-digit counter in any region of the
 * seed is 19 characters (tests/act-write-payloads.test.ts holds it under 32).
 * The amount is the product line's, and its name carries it.
 *
 * The bare number, not the revision label: the opportunity is the whole deal.
 * SET ON CREATE ONLY: nothing in a revision changes the number or the
 * currency (Document.currency is set by createDraft and never changed), so
 * there is nothing to rename -- and a name a person edits in ACT! stays as
 * they left it. That also makes the name fixed for the life of the deal,
 * which is what lets the drain find an opportunity it created but did not
 * store by this name (opportunityLookup).
 */
export function opportunityName(quote: Pick<QuoteForAct, "number" | "currency">): string {
  return `${quote.number} ${quote.currency}`;
}

/** The region's process: its own, or the default (src/lib/act/opportunity-stages.ts). */
function stagesFor(regionCode: string) {
  return processForRegion(regionCode);
}

/**
 * A revision's History `regarding`: "Quote Q-AU-2026-014-R2 finalised in
 * PathQuote". PathQuote's own sentence, and one per revision -- the label
 * carries the quote number and the revision -- which is what lets the drain
 * find a History it created but did not store
 * (historyLookup). historyBody and historyLookup both take it from here, so
 * the two cannot drift apart.
 */
export function historyRegarding(quote: Pick<QuoteForAct, "number" | "revision">): string {
  const label = revisionLabel(quote.number, quote.revision) ?? quote.number;
  return `Quote ${label} finalised in PathQuote`;
}

/** "ex GST": what the deal's amount is before, as the line and the History say it. */
function exTaxWords(quote: Pick<QuoteForAct, "taxName">): string {
  return `ex ${quote.taxName ?? "tax"}`;
}

/**
 * The History record for one finalised revision.
 *
 * `details`, one fact a line: the amount excluding tax, as the product line
 * carries it ("Amount: AUD 45,000.00 ex GST"); the tax-inclusive total for
 * reference ("Total incl. GST: AUD 49,500.00"), or, on a quote that charges
 * no tax, that total and that none was charged ("Total: USD 30,000.00, no
 * Sales Tax charged") -- "incl." would claim a tax the quote does not carry;
 * the validity; the revision.
 *
 * `opportunityActId` links it to the deal's opportunity when there is one;
 * ACT! does not require the link.
 */
export function historyBody(
  quote: QuoteForAct,
  parties: ActParties,
  opportunityActId: string | null,
): HistoryBody {
  const at = quote.finalizedAt.toISOString();
  return {
    historyTypeID: HISTORY_TYPE_QUOTE,
    regarding: historyRegarding(quote),
    details: [
      `Amount: ${moneyWithCode(quote.amountExTax, quote.currency)} ${exTaxWords(quote)}`,
      quote.total === quote.amountExTax
        ? `Total: ${moneyWithCode(quote.total, quote.currency)}, no ${quote.taxName ?? "tax"} charged`
        : `Total incl. ${quote.taxName ?? "tax"}: ${moneyWithCode(quote.total, quote.currency)}`,
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The opportunity's estimated close date: the day the quote stops being
 * valid, its finalizedAt plus validityDays. The quote's own deadline is the
 * one date PathQuote knows that a deal is expected to close by; a person who
 * knows better changes it in ACT!. Set on create only, like the name: a later
 * PATCH lays its changes over the record as read (mergeForWrite), so a date
 * edited in ACT! stays as it was left. Derived from frozen inputs, so a
 * repeated create sends the same body.
 */
export function estimatedCloseDate(quote: Pick<QuoteForAct, "finalizedAt" | "validityDays">): string {
  return new Date(quote.finalizedAt.getTime() + quote.validityDays * DAY_MS).toISOString();
}

/**
 * The opportunity a quote's first finalise opens, at its region's sent stage.
 * Opened, and in that stage, from the revision's finalise: `openDate` and
 * `stageStartDate` are both its finalizedAt; expected to close when the quote
 * expires (estimatedCloseDate).
 */
export function newOpportunityBody(quote: QuoteForAct, parties: ActParties): NewOpportunityBody {
  const sent = stagesFor(quote.regionCode).sent;
  const finalised = quote.finalizedAt.toISOString();
  return {
    name: opportunityName(quote),
    stage: stageBody(sent),
    probability: sent.probability,
    status: OPPORTUNITY_STATUS.open,
    openDate: finalised,
    estimatedCloseDate: estimatedCloseDate(quote),
    stageStartDate: finalised,
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
 * alone by both -- the line of a won deal whose quote is accepted and signed
 * apart.
 */
export function opportunityIsOpen(status: string | null): boolean {
  return status === OPPORTUNITY_STATUS.open;
}

/**
 * Whether write-product-line writes the deal's line for the row's revision,
 * decided on the opportunity as the drain reads it just before, and on the
 * quote as it stands: `accepted` is Document.acceptedAt set, `signed` is
 * Document.signingStatus SIGNED.
 *
 * - `write`: the deal is Open, so the revision's figure is the deal's; or it
 *   is Won, the quote is accepted AND the client's signature stands. A won
 *   deal shows the latest SIGNED figure. Vadym's rule is "PathQuote
 *   confirms", and the confirmation is the client's signature; acceptedAt
 *   alone is not it, because voidSignature leaves acceptedAt set. After a
 *   void, a quote re-finalised at a new figure is still "accepted", at a
 *   figure nobody has signed, and its finalise row skips the line here. When
 *   the client signs that revision, the signature's row finds the line
 *   behind and asks again, and this says `write`
 *   (src/lib/act/outbox-plan.ts, A WON DEAL SHOWS THE LATEST SIGNED FIGURE).
 * - `skip`: anything else -- Lost, Inactive, Won without both an acceptance
 *   and a signature standing in PathQuote (a deal Won by hand in ACT! among
 *   them), a status never seen. The line is part of the record of how the
 *   deal ended, and is left alone, as revisedOpportunityBody leaves the
 *   opportunity. `status` is what ACT! said, for the drain to report.
 *
 * On `skip` the drain sends nothing and stores ActOutbox.productLineSkippedAt
 * -- never Document.actProductLineRevision, which says what the line shows.
 * A skipped line on a deal the quote's acceptance then wins is written by
 * write-accepted-line, which does not ask this: it comes before the win and
 * writes the line whatever the status.
 */
export type ProductLineWrite = { kind: "write" } | { kind: "skip"; status: string | null };

export function productLineWrite(
  status: string | null,
  quote: { accepted: boolean; signed: boolean },
): ProductLineWrite {
  if (opportunityIsOpen(status)) return { kind: "write" };
  if (status === OPPORTUNITY_STATUS.won && quote.accepted && quote.signed) return { kind: "write" };
  return { kind: "skip", status };
}

/**
 * What a later revision does to the deal's existing opportunity.
 *
 * - `patch`: the opportunity is Open. `patch` carries the stage, with its
 *   probability and stageStartDate, when `stage` -- stageMove's verdict,
 *   handed back so the drain can report a "different-process" opportunity it
 *   did not move -- is `move`, and is EMPTY otherwise: the name is set on
 *   create only (opportunityName), and the amount is the product line's
 *   (summaryProductPatch). Never backwards, never across processes, never a
 *   status.
 * - `closed`: the opportunity is not Open. Send nothing at all; the revision
 *   is recorded by its History alone. `status` is what ACT! said, for the
 *   drain to report.
 *
 * An empty patch sends nothing either: the client sends no PATCH for a patch
 * with nothing in it, or nothing the record does not already say (patchToSend
 * in src/lib/act/record-write.ts), because writing a record back unchanged
 * still bumps its `edited`. The union is kept anyway, because "the deal is
 * closed" is a different answer from "the deal is open and needs nothing",
 * and the drain reports the first.
 */
export type RevisionUpdate =
  | { kind: "patch"; patch: OpportunityPatch; stage: StageMove }
  | { kind: "closed"; status: string };

/**
 * A later revision's effect on the deal's existing opportunity.
 *
 * AN OPPORTUNITY THAT IS NOT OPEN IS LEFT ENTIRELY ALONE: no stage, no
 * probability -- and no product line either, which is what keeps its amount,
 * save the one exception productLineWrite makes: a Won deal whose quote is
 * accepted and signed in PathQuote gets the signed figure. Won, Lost or
 * Inactive, it is the record of
 * how the deal ended and at what figure, and silently rewriting a closed
 * record in somebody else's CRM is the worse harm. The
 * History is the journal: it still records that a new revision went out and
 * what it came to, before tax and with it. Reached when an admin's
 * voidSignature is followed by a re-finalise, or when somebody closed the
 * deal by hand in ACT!. If the deal
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
 *
 * STAGE START DATE. Swagger's Opportunity has `stageStartDate`, "the date the
 * opportunity stage started", and does not mark it read-only. It is sent when,
 * and only when, the patch moves the stage, set to the time of the event that
 * moved it: this revision's finalizedAt here, the deal's close date in
 * wonOpportunityBody -- the later of the acceptance and the client's
 * signature (wonCloseDate in src/lib/act/drain-rules.ts) -- the first
 * revision's finalizedAt beside `openDate` on create. Every one of those is a
 * frozen input, so a repeated step sends the same body. When the stage stays, or sits in another process, the date is
 * left as read: the stage it describes has not changed.
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
    patch:
      stage === "move"
        ? {
            stage: stageBody(sent),
            probability: sent.probability,
            stageStartDate: quote.finalizedAt.toISOString(),
          }
        : {},
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
 * `closedAt` is the deal's close date: the drain passes the later of the
 * acceptance and the client's signature (wonCloseDate in
 * src/lib/act/drain-rules.ts), since the win needs both standing. The
 * status and `actualCloseDate` of `closedAt` always; the won stage, with its
 * probability and a stageStartDate of `closedAt` (STAGE START DATE on
 * revisedOpportunityBody), only when `stageMove` allows it. `current` is
 * required for the same reason as in
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
 * the win at that figure. So whenever the line does not show the accepted
 * revision, the planner puts a step of its own, write-accepted-line, before
 * win-opportunity, and the win is not planned until that step is done
 * (src/lib/act/outbox-plan.ts, THE LINE IS WRITTEN BEFORE THE WIN). An
 * `already-won` deal still gets that line: the step comes before this is
 * asked anything.
 */
export function wonOpportunityBody(
  regionCode: string,
  current: OpportunityNow,
  closedAt: Date,
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
      actualCloseDate: closedAt.toISOString(),
      ...(stage === "move"
        ? { stage: stageBody(won), probability: won.probability, stageStartDate: closedAt.toISOString() }
        : {}),
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
 *   name           ("Name", Character 256) the revision label, the amount
 *                  with its currency code, and that it is before tax. The
 *                  product has no currency field, nor any field for tax, so
 *                  this is where the line says what its number means.
 *   itemNumber     ("Item #", Character 64) the quote number, which is how the
 *                  drain finds the deal's line again before every create
 *                  (productLineLookup). Sent on every write, so a line whose
 *                  item number was edited by hand gets it back.
 *   quantity       ("Quantity") always 1: one line for the whole deal.
 *   price          ("Price") the revision's amount excluding tax
 *                  (QuoteForAct.amountExTax).
 *   discountPrice  ("Adjusted Price") the same: no discount.
 *   total          ("Subtotal") the same. Swagger describes it as adjusted
 *                  price times quantity; it is sent anyway, agreeing with the
 *                  rest, so the line comes to the revision's amount whichever
 *                  of these ACT! computes from the others -- which has not
 *                  been seen on a live record.
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
  itemNumber: string;
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
 * the amount excluding tax with its currency code, and the tax it is before:
 * "Q-AU-2026-014-R2 — AUD 47,500.00 ex GST". The label rather than the bare
 * number because the line, unlike the opportunity, says which revision's
 * figure it is. "ex GST" because ACT! shows the line's price as a bare
 * number, and anyone reading it beside the quote PDF's tax-inclusive total
 * needs telling which one it is.
 *
 * Written by write-product-line when productLineWrite says so -- an Open
 * deal, or a Won one whose quote is accepted and signed -- and by
 * write-accepted-line, the step before the win, whatever the status.
 * Otherwise the line is left alone, as revisedOpportunityBody leaves the
 * opportunity.
 */
export function summaryProductPatch(quote: QuoteForAct): SummaryProductPatch {
  const label = revisionLabel(quote.number, quote.revision) ?? quote.number;
  return {
    name: `${label} — ${moneyWithCode(quote.amountExTax, quote.currency)} ${exTaxWords(quote)}`,
    itemNumber: quote.number,
    quantity: 1,
    price: quote.amountExTax,
    discountPrice: quote.amountExTax,
    total: quote.amountExTax,
  };
}

/** The deal's product line as first created: summaryProductPatch, and no discount. */
export function summaryProductBody(quote: QuoteForAct): SummaryProductBody {
  return { ...summaryProductPatch(quote), discount: 0 };
}

/**
 * What the drain does before creating a record PathQuote may already have
 * made: what its lookup found.
 *
 * - `create`: nothing matches, so nothing was made. Create it.
 * - `adopt`: exactly one record matches. It is the one an earlier attempt
 *   created and never stored -- the answer lost, or the process gone between
 *   ACT!'s answer and the database write. The drain stores `id` ALONE --
 *   Document.actOpportunityId, or Document.actProductLineId -- and asks the
 *   planner again, which then plans the update (update-opportunity, or the
 *   line's `update`): the record was made from an earlier attempt's body,
 *   perhaps for an older revision, and is brought up to date by the same
 *   decision on a fresh read as any other. Nothing it was made with is
 *   assumed.
 * - `block`: more than one matches. PathQuote never deletes in ACT!, and has
 *   no way to tell which is its own, so a person has to; `count` is how many,
 *   for the blocked reason (src/lib/act/outbox-plan.ts).
 */
export type CreateLookup =
  | { kind: "create" }
  | { kind: "adopt"; id: string }
  | { kind: "block"; count: number };

function lookup(matches: readonly { id?: unknown }[]): CreateLookup {
  if (matches.length === 0) return { kind: "create" };
  const [only] = matches;
  if (matches.length === 1 && typeof only.id === "string" && only.id !== "") {
    return { kind: "adopt", id: only.id };
  }
  // One match with no id to adopt it by cannot be created around either.
  return { kind: "block", count: matches.length };
}

/**
 * The deal's line among the opportunity's products, by `itemNumber` -- the
 * quote number, exactly (summaryProductPatch) -- read with
 * `GET /api/opportunities/{opportunityId}/products` (ActClient.listProductLines).
 *
 * LOOKED UP BEFORE EVERY CREATE, not only after a create that failed without
 * an answer: a drain that dies between ACT!'s answer and the database write
 * raises no error at all, and the next attempt would create the line again.
 * A second line is the worst failure available here -- it silently doubles the
 * deal's amount, and nothing in ACT! looks wrong. Exact, case for case: the
 * item number is PathQuote's own key, written by PathQuote. A line somebody
 * added by hand with another item number, or none, is not ours and is left
 * alone.
 */
export function productLineLookup(
  lines: readonly { id?: unknown; itemNumber?: unknown }[],
  quote: Pick<QuoteForAct, "number">,
): CreateLookup {
  return lookup(lines.filter((line) => line.itemNumber === quote.number));
}

/**
 * The deal's opportunity, by `name` -- opportunityName, exactly -- among the
 * opportunities ActClient.opportunitiesNamed returns: every opportunity in
 * ACT! with that name (`GET /api/opportunities?$filter=name eq '...'`), or,
 * when ACT! answers that filter with a 4xx, the contact's own
 * (`GET /api/contacts/{contactId}/associated-opportunities`). Looked up before
 * every create, for the line's reason; possible because the name is fixed on
 * create and never changed by PathQuote. The comparison here is exact
 * whatever the server matched, so a filter ACT! applies without regard to
 * case, or does not apply at all, still leaves only this deal's name.
 *
 * ACROSS EVERY OPPORTUNITY, not the contact's, because the name is the quote
 * number and its currency, and the quote number is unique. So a create lost
 * on one contact is still found after the quote's contact was changed
 * (unfinalise, choose another, finalise) before the next attempt -- a case
 * a lookup among the new contact's opportunities misses, and answers with a
 * second opportunity for the deal. Only the fallback has that blind spot
 * again.
 *
 * What it cannot see: an opportunity created for this quote and then renamed
 * by hand in ACT!. That needs the earlier create to have been lost as well,
 * and ends as a second opportunity for the deal, not a doubled amount: the
 * line is created on whichever opportunity the Document stores.
 */
export function opportunityLookup(
  opportunities: readonly { id?: unknown; name?: unknown }[],
  quote: Pick<QuoteForAct, "number" | "currency">,
): CreateLookup {
  const name = opportunityName(quote);
  return lookup(opportunities.filter((opportunity) => opportunity.name === name));
}

/**
 * What the drain does before creating a revision's History: what its lookup
 * found.
 *
 * - `create`: none of the contact's Histories is this revision's. Create it.
 * - `adopt`: one is, or more than one. The drain stores `id` as
 *   QuoteRevision.actHistoryId, clearing createInFlight in the same
 *   transaction, and moves on. Nothing is updated: a History is never
 *   rewritten, and the one found was made for this very revision -- its
 *   `regarding` says so. `matches` is how many were found; more than one is a
 *   duplicate journal entry already in ACT!, which the drain notes in its run
 *   report and leaves where it is (PathQuote never deletes in ACT!).
 */
export type HistoryLookup = { kind: "create" } | { kind: "adopt"; id: string; matches: number };

/**
 * This revision's History among the contact's, read with
 * `GET /api/contacts/{contactId}/history` (ActClient.contactHistories), whose
 * 200 is swagger's array of act.web.api.models.Histories.History --
 * `historyTypeID` and `regarding` among its fields. A History is this
 * revision's when its `historyTypeID` is HISTORY_TYPE_QUOTE and its
 * `regarding` is historyRegarding(quote), both exactly: PathQuote writes that
 * sentence, one per revision, and a History somebody typed by hand that
 * happens to read the same is the same journal entry anyway.
 *
 * LOOKED UP BEFORE EVERY CREATE, for the line's reason: a drain that dies
 * between ACT!'s answer and the database write raises no error, and the next
 * attempt would journal the revision again.
 *
 * MORE THAN ONE DOES NOT BLOCK, unlike the opportunity and the line. A
 * duplicate History says twice that a revision went out, but carries no
 * figure the deal is summed from, as a second line or opportunity does; a
 * blocked row would hold back the line steps, the win and the promotion that
 * can follow it, which carry the deal's amount and status. So the oldest is
 * adopted -- by `created`,
 * then by id, so the same answer always gives the same choice, with a match
 * whose `created` ACT! did not give after those that have one -- and the rest
 * are noted. A match with no id is one the drain could not store, and is
 * passed over; were every match without one, the History is created again,
 * which is the duplicate this lookup already accepts.
 *
 * What it cannot see: a History made for this revision under another contact
 * -- the quote's contact changed between the lost create and the next
 * attempt. That ends as the revision journaled on both contacts.
 */
export function historyLookup(
  histories: readonly { id?: unknown; historyTypeID?: unknown; regarding?: unknown; created?: unknown }[],
  quote: Pick<QuoteForAct, "number" | "revision">,
): HistoryLookup {
  const regarding = historyRegarding(quote);
  const matches = histories.filter(
    (history) => history.historyTypeID === HISTORY_TYPE_QUOTE && history.regarding === regarding,
  );
  const adoptable = matches
    .filter((history): history is typeof history & { id: string } => typeof history.id === "string" && history.id !== "")
    .map((history) => ({ id: history.id, created: createdAt(history.created) }))
    .sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (adoptable.length === 0) return { kind: "create" };
  return { kind: "adopt", id: adoptable[0].id, matches: matches.length };
}

/** A record's `created` as a time to sort by; a missing or unreadable one sorts last. */
function createdAt(created: unknown): number {
  const time = typeof created === "string" ? Date.parse(created) : Number.NaN;
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
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
  /**
   * The company's country (Company.country) as an item of ACT!'s Countries
   * picklist -- actCountryValue in src/lib/act/country-picklist.ts, from the
   * list as the drain read it -- or null when it has none or no item matches.
   * Already the picklist's spelling: this module does not look it up.
   */
  country: string | null;
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
  /** Only ever `country`: see THE ADDRESS on newContactBody. */
  businessAddress?: { country: string };
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
 * Customer either. Somebody being quoted is a Prospect, and the client's
 * signature then promotes them like any other.
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
 *   businessAddress      its `country` only, map's company country; see THE
 *                        ADDRESS below.
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
 * THE ADDRESS. businessAddress/country is limited to the "Countries"
 * picklist (COUNTRIES_PICKLIST_ID in src/lib/act/client.ts) and marked
 * isAllowBlank false. The drain reads that list and hands in the item that
 * spells the company's country (`country`), so the rule for Account Mgr
 * applies here too: sent when PathQuote has a value ACT! lists, left out
 * rather than guessed when it has not. Whether ACT! enforces isAllowBlank on
 * a create through the API is UNVERIFIED: RAW/ACT/act-country-fixes.csv lists
 * 113 contacts stored with a blank country, so it does not enforce it on what
 * it holds, and the first live create without one will say. Should it refuse,
 * the refusal blocks the row with ACT!'s own answer for a person to read.
 *
 * The address object carries the country and nothing else. A nested object
 * is sent whole or not at all (mergeForWrite in src/lib/act/record-write.ts
 * says why for a PATCH, where a partial one blanks the record's siblings); on
 * a create there is no record to blank, so this object IS the whole address
 * the contact starts with. No street, city or state is sent: PathQuote holds
 * them for the company, not the person, and ACT!'s state may be a limited
 * list as well, whose items have not been read either.
 *
 * THE COMPANY DOES NOT SPLIT on the round trip, but not because of a key. The
 * sync finds a contact it already has by Contact.actContactId -- which the
 * drain stores from this create's answer -- and keeps it on the company it is
 * on (src/lib/act/sync.ts); it derives a company only for a contact it has
 * never seen. Should the sync ever meet this contact without knowing it --
 * the create went through and its id was not stored, the repeat window in
 * src/lib/act/outbox-plan.ts -- it would derive `<name>|<country>` from the
 * company text and the country sent (companyKey in
 * src/lib/act/company-key.ts), `<name>|??` when none was, and, missing, create
 * a second company for it as well as a second contact.
 */
export function newContactBody(contact: ContactForAct, owner: NewContactOwner): NewContactBody {
  const firstName = given(contact.firstName);
  const lastName = given(contact.lastName);
  const emailAddress = given(contact.email);
  const businessPhone = given(contact.phone);
  const jobTitle = given(contact.position);
  const company = given(contact.companyName);
  const accountMgr = given(owner.authorActAccountMgr);
  // Not trimmed: it is the picklist's own spelling, and a list limited to its
  // items compares what it is sent exactly. Only a blank one is left out.
  const country = contact.country !== null && contact.country.trim() !== "" ? contact.country : undefined;
  return {
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(emailAddress ? { emailAddress } : {}),
    ...(businessPhone ? { businessPhone } : {}),
    ...(jobTitle ? { jobTitle } : {}),
    ...(company ? { company } : {}),
    ...(country ? { businessAddress: { country } } : {}),
    idStatus: CONTACT_STATUS.prospect,
    contactType: "Contact",
    isPrivate: false,
    recordManagerID: recordManager(owner),
    ...(accountMgr ? { customFields: { [ACT_FIELD.accountMgr]: accountMgr } } : {}),
  };
}

/**
 * Whether the client's signature promotes the quote's contact.
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
 * A Prospect becomes a Customer once the client's signature stands (the
 * plan's addendum of 2026-10-12). The acceptance is not a trigger of its own:
 * promotionDue in src/lib/act/outbox-plan.ts says why.
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
