// The request bodies a finalised quote sends to ACT!: one History record per
// revision, and the Opportunity that stands for the whole deal.
//
// Pure, and deliberately free of Prisma types: every input is a plain value
// the drain reads off the quote and hands in. That is what lets the suite test
// these under `isolate: false` (see vitest.config.ts), and it keeps the one
// part of the write that decides what ACT! is told out of the I/O shell.
//
// THE CURRENCY PROBLEM. An ACT! opportunity has no currency field anywhere --
// `productTotal`, `weightedTotal`, `grossMargin` and the rest are bare numbers
// (act.web.api.models.Opportunities.Opportunity in RAW/ACT/swagger.json, a
// local capture, not committed).
// PathQuote quotes exist in AUD, USD and GBP, and nothing in the schema
// converts between them. So the currency travels as text where people read it:
// in the opportunity's `name` ("Q-AU-2026-014 — AUD 45,000.00"), which every
// ACT! list and lookup shows, and again in the History `details`. The amount
// still goes into `productTotal`, in the quote's own currency, because it is
// the opportunity's amount field and an opportunity without one is a deal with
// no value anywhere ACT! reads it.
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
 * this module sends comes from here, and so does the one it reads back
 * (`open`, in revisedOpportunityBody), so that check changes one place.
 * `Inactive` is absent only because nothing here sends it.
 */
export const OPPORTUNITY_STATUS = {
  open: "Open",
  won: "Won",
  lost: "Lost",
} as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUS)[keyof typeof OPPORTUNITY_STATUS];

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

/** The body of `POST /api/opportunities`. */
export type NewOpportunityBody = {
  name: string;
  stage: StageBody;
  probability: number;
  status: OpportunityStatus;
  openDate: string;
  productTotal: number;
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

/** A body for `PATCH /api/opportunities/{id}`, which takes a partial opportunity. */
export type OpportunityPatch = {
  name?: string;
  productTotal?: number;
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

function recordManager(parties: ActParties): string {
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
    productTotal: quote.total,
    recordManagerID: recordManager(parties),
    contacts: [{ id: parties.contactActId }],
    ...companiesOf(parties),
  };
}

/**
 * What a later revision does to the deal's existing opportunity.
 *
 * - `patch`: the opportunity is Open. `patch` always carries the name and
 *   total, since a revision can change the price, and the stage (with its
 *   probability) only when `stage` -- stageMove's verdict, handed back so the
 *   drain can report a "different-process" opportunity it did not move -- is
 *   `move`. Never backwards, never across processes, and never a status.
 * - `closed`: the opportunity is not Open. Send nothing at all; the revision
 *   is recorded by its History alone. `status` is what ACT! said, for the
 *   drain to report.
 *
 * A union rather than a patch that might be empty, or null: an Open patch is
 * never empty, so "nothing to send" is a different answer, not a smaller one,
 * and it should say why. It also keeps the drain from sending a `{}` "to be
 * safe" -- which, with an update that reads the opportunity and writes it back
 * whole (the plan's Task 5), would still rewrite the closed record and bump
 * its `edited`.
 */
export type RevisionUpdate =
  | { kind: "patch"; patch: OpportunityPatch; stage: StageMove }
  | { kind: "closed"; status: string };

/**
 * A later revision's effect on the deal's existing opportunity.
 *
 * AN OPPORTUNITY THAT IS NOT OPEN IS LEFT ENTIRELY ALONE: no stage, no
 * probability, no name, no total. Won, Lost or Inactive, it is the record of
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
  if (current.status !== OPPORTUNITY_STATUS.open) {
    return { kind: "closed", status: current.status };
  }
  const sent = stagesFor(quote.regionCode).sent;
  const stage = stageMove(current, sent);
  return {
    kind: "patch",
    stage,
    patch: {
      name: opportunityName(quote),
      productTotal: quote.total,
      ...(stage === "move" ? { stage: stageBody(sent), probability: sent.probability } : {}),
    },
  };
}

/** Closing the opportunity as won: the patch, and stageMove's verdict on the won stage for the drain to report. */
export type WonUpdate = { patch: OpportunityPatch; stage: StageMove };

/**
 * Closing the opportunity as won, when the quote is accepted.
 *
 * The status and close date always; the won stage only when `stageMove`
 * allows it, which in practice means unless the opportunity has been moved to
 * another process -- the won stage is the last in each process, so nothing in
 * the same process is past it. `stage` says which, so the drain can report a
 * "different-process" opportunity closed without its stage. `current` is
 * required for the same reason as in `revisedOpportunityBody`: an opportunity
 * being closed already exists.
 */
export function wonOpportunityBody(
  regionCode: string,
  current: StagePosition,
  acceptedAt: Date,
): WonUpdate {
  const won = stagesFor(regionCode).won;
  const stage = stageMove(current, won);
  return {
    stage,
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
