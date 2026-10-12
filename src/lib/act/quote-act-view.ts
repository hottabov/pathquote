// What a quote's own page says about its write into ACT!, decided here rather
// than in the page -- the same line src/lib/act/sync-view.ts draws for the
// Settings section, and for the same readers: the company director and the
// managers. This module decides every sentence, and which of two tones it is
// said in; the page decides how a tone looks and where the card goes.
//
// FIVE STATES, from the quote's most recent ActOutbox row (an unfinished one
// if there is one -- there is never more than one -- else the last to
// finish), or none:
//
//   not queued   a FINAL quote with no row at all -- an administrator only
//   waiting      an unfinished row, due or backing off after a failure
//   held         an unfinished row with a blockedReason
//   in ACT!      a finished row
//   not sent     a finished row an administrator stopped (BLOCKED_BY.admin)
//
// and a sixth that shows nothing: a DRAFT with no unfinished row. A draft is
// still being written, and what ACT! holds of an earlier version of it is not
// news. A draft WITH an unfinished row is shown, because its row is still
// worked -- the drain writes the revision it was queued for, whatever the
// quote has done since -- and because the Settings list sends readers to this
// page for every held row, a voided-and-reopened draft's included.
//
// WHO READS IT. Whoever can open the quote (the page is already scoped:
// getDocumentForBuilder, documentWhereForUser) AND can see the ACT! sync
// section -- canSeeActSync in src/lib/roles.ts, the one rule for who has
// ACT! in front of them: an administrator or developer always, anybody else
// only with User.actSyncVisible ticked. A distributor has no ACT! licence,
// so the card is not theirs to read, as the Settings section is not; their
// quotes are queued and sent all the same, and the Settings list and this
// card show those quotes to an administrator. Of the five states, "not
// queued" is shown to an administrator only: every quote finalised before
// sending began says it until it is next signed, accepted or finalised --
// hundreds of them -- and nothing in it is a manager's to act on, where an
// administrator reads it as information. So a manager with the tick sees
// no card for such a quote. Every sentence in `headline`, `detail` and
// `facts` of the other four states is written to be true for a manager, who
// sees the state but none of the administrator's buttons. `adminNote` and
// the button texts (adminHelpFor) are for an administrator only, and the
// page shows them to nobody else.
//
// NO LINKS INTO ACT!. Nothing in this repository knows an address for an ACT!
// record (docs/act-integration-reference.md has the API's base and nothing a
// browser opens), so the card says what is there in words a person can look
// up in ACT! -- the contact's name, the opportunity's name -- and invents no
// URL.
//
// Pure: no database, no React, and `now` is a parameter, so every state can
// be driven by a test (tests/act-quote-view.test.ts).

import { BLOCKED_BY } from "@/lib/act/drain-rules";
import { heldForContact } from "@/lib/act/outbox-admin";
import { melbourneTime } from "@/lib/act/sync-view";
import { opportunityName } from "@/lib/act/write-payloads";
import { formatDateAU, formatMoney } from "@/lib/format";
import { formatCount } from "@/lib/plural";
import { canSeeActSync, isAdminRole } from "@/lib/roles";

/** Who is reading the card: the session's role and its ACT! sync tick (User.actSyncVisible). */
export type QuoteActViewer = { role: string | null | undefined; actSyncVisible: boolean };

/**
 * Whether `viewer` gets the quote's ACT! card at all: canSeeActSync, the rule
 * the Settings section follows (see WHO READS IT above). The page asks this
 * before it reads anything for the card; describeQuoteAct asks it again, so
 * the rule holds wherever the card is built.
 */
export function showsQuoteActCard(viewer: QuoteActViewer): boolean {
  return canSeeActSync(viewer);
}

/** What the card is built from: the quote, its contact, and its latest row. */
export type QuoteActFacts = {
  /** Document.status: "DRAFT" or "FINAL". */
  status: string;
  /** Document.signingStatus, as its enum name. */
  signingStatus: string;
  /** Document.acceptedAt. */
  acceptedAt: Date | null;
  /** Document.number. */
  number: string | null;
  /** Document.currency, and the region's symbol for it when it has one. */
  currency: string;
  currencySymbol: string | null;
  /** Whether the quote has any QuoteRevision -- a quote finalised before revisions existed may have none. */
  hasRevision: boolean;
  /** Whether sending to ACT! is switched on (src/lib/act/write-switch.ts). */
  sendingOn: boolean;
  /** The quote's contact as it stands, or null when it has none. */
  contact: {
    /** First and last name, as the rest of the app prints them. */
    name: string;
    actContactId: string | null;
    actCreateInFlightAt: Date | null;
  } | null;
  /** Document.actOpportunityId. */
  actOpportunityId: string | null;
  /** Document.actOpportunityWonAt. */
  actOpportunityWonAt: Date | null;
  /** Document.actContactPromotedForId. */
  actContactPromotedForId: string | null;
  /**
   * The revision the deal's product line in ACT! shows
   * (Document.actProductLineRevision), with that revision's label and total;
   * null when nothing has been written to it.
   */
  line: { revision: number; label: string; total: string } | null;
  /** The latest row, as described in the header, or null for none. */
  row: {
    attempts: number;
    lastError: string | null;
    nextAttemptAt: Date;
    completedAt: Date | null;
    blockedReason: string | null;
    blockedBy: string | null;
    productLineSkippedAt: Date | null;
    /** The revision the row writes (ActOutbox.quoteRevisionId). */
    revision: { revision: number; label: string; actHistoryId: string | null };
  } | null;
};

export type QuoteActState = "not-queued" | "waiting" | "held" | "in-act" | "not-sent";

export type QuoteActView = {
  state: QuoteActState;
  /** `warn` for a held quote, which stays held until somebody acts; `ok` for the rest. */
  tone: "ok" | "warn";
  headline: string;
  /** Whole sentences, a paragraph; null when the headline says it all. */
  detail: string | null;
  /** What ACT! holds of the quote, label and value, for a quote in ACT!; empty otherwise. */
  facts: { label: string; value: string }[];
  /** ActOutbox.lastError, verbatim, for a quote that has failed to get through; null otherwise. */
  lastError: string | null;
  /** For an administrator only: what they can do that the buttons do not say. Null when nothing. */
  adminNote: string | null;
};

/** The label the page puts before `lastError`. */
export const LAST_ERROR_LABEL = "Last attempt";

/** The card's title. */
export const ACT_CARD_TITLE = "ACT!";

/** "once", "twice" reads as a count of attempts; "3 times" past that. */
function times(n: number): string {
  if (n === 1) return "once";
  if (n === 2) return "twice";
  return `${formatCount(n)} times`;
}

/**
 * How far off `date` is, roughly, as the end of a sentence: "in about 40
 * minutes". relativeTime in src/lib/format.ts says how long ago; this is its
 * other direction, and rounds the same way.
 */
export function inAbout(date: Date, now: Date): string {
  const minutes = Math.round((date.getTime() - now.getTime()) / 60000);
  if (minutes < 1) return "in a moment";
  if (minutes < 60) return `in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in about ${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `in about ${Math.round(hours / 24)} days`;
}

/** Shown on no quote: a DRAFT with nothing unfinished. */
function hidden(facts: QuoteActFacts): boolean {
  return facts.status !== "FINAL" && (facts.row === null || facts.row.completedAt !== null);
}

/**
 * A FINAL quote with no row. Two ways to get here, told apart by whether the
 * quote has a revision, because what will and will not send it differs:
 *
 *   - NO REVISION: finalised before revisions existed and not reached by
 *     scripts/backfill-quote-revisions.ts. A row has to name a revision, so
 *     the client's signature and the acceptance queue nothing for it -- they
 *     log a warning instead (enqueueActWriteForNewestRevision in
 *     src/lib/act/outbox.ts). Unfinalize and finalize again does work: it
 *     creates revision 0 (planRevision, no prior revision) and queues it in
 *     the same transaction. But unfinalize revokes any signing link that is
 *     out and clears the signatures, and the quote is finalised again with
 *     today's terms and legal documents (unfinalizeDocument clears
 *     documentsSnapshot), so the note says so; and it is refused once the
 *     client has signed (canUnfinalize). The backfill alone is not offered:
 *     it creates the revision and queues nothing, and a backfilled revision
 *     with no validity on record is held by the drain anyway
 *     (revisionForAct's `unreadable`).
 *   - A REVISION BUT NO ROW: finalised before PathQuote began sending quotes
 *     to ACT! (z65_act_outbox queued no row for an existing quote), and
 *     neither signed nor accepted since -- either would have queued one. Those
 *     still can, so the sentence says which is left. The note's advice on
 *     unfinalizing is the same.
 */
function notQueued(facts: QuoteActFacts): QuoteActView {
  const signed = facts.signingStatus === "SIGNED";
  const reopen = signed
    ? null
    : "Unfinalizing it and finalizing it again sends it, but that also withdraws any signing link that is out, clears the signatures on it, and finalises it with today's terms and documents — so if the client already has this quote, ask your developer instead.";

  if (!facts.hasRevision) {
    return {
      state: "not-queued",
      tone: "ok",
      headline: "Not queued for ACT!",
      detail:
        "This quote was finalised before PathQuote kept a copy of each finalised version, so there is no copy of it to send to ACT! — and signing or accepting it will not send it either.",
      facts: [],
      lastError: null,
      adminNote: reopen ?? "Now that the client has signed it, it cannot be unfinalized, so only your developer can queue it for ACT!.",
    };
  }

  const still = !signed
    ? " If the client signs it, it goes then."
    : facts.acceptedAt === null
      ? " If it is accepted, it goes then."
      : "";
  return {
    state: "not-queued",
    tone: "ok",
    headline: "Not queued for ACT!",
    detail: `This quote was finalised before PathQuote began sending quotes to ACT!, and has not been finalised, signed or accepted since — which is what sends a quote.${still}`,
    facts: [],
    lastError: null,
    adminNote: reopen ?? "Now that the client has signed it, it cannot be unfinalized, so if it has to be in ACT!, ask your developer to queue it.",
  };
}

/**
 * An unfinished row that is not held. Whether sending is switched on comes
 * first: while it is off nothing goes, whatever the row says. Then whether it
 * has failed before: a row that has not is sent at the next pass (the fast
 * path after the event usually got there first, so a quote seen waiting has
 * normally just been queued, or found the drain busy); a row that has is held
 * back by the backoff until nextAttemptAt, and goes at the first pass after
 * that -- nothing retries a row on a clock of its own (backoffMs in
 * src/lib/act/drain-rules.ts) -- which is what "at the first send after" says.
 * "Keeps trying until it gets through", not "waiting longer each time": the
 * waits stop growing at BACKOFF_CAP_MS (same file), and a Retry-After from
 * ACT! can set one longer still; what is always true is that no row is ever
 * given up on.
 */
function waiting(facts: QuoteActFacts, row: NonNullable<QuoteActFacts["row"]>, now: Date): QuoteActView {
  const failed = row.attempts > 0;
  let detail: string;
  if (!facts.sendingOn) {
    detail = "Sending to ACT! is switched off, so this quote waits — it goes as soon as it is switched on.";
  } else if (!failed) {
    detail = "It goes on its own — PathQuote sends queued quotes every 15 minutes.";
  } else if (row.nextAttemptAt.getTime() > now.getTime()) {
    detail = `PathQuote has tried ${times(row.attempts)} and not got through to ACT! yet. It tries again on its own at the first send after ${melbourneTime(row.nextAttemptAt)}, ${inAbout(row.nextAttemptAt, now)}, and keeps trying until it gets through.`;
  } else {
    detail = `PathQuote has tried ${times(row.attempts)} and not got through to ACT! yet. It is due to be tried again at the next send — PathQuote sends queued quotes every 15 minutes.`;
  }
  return {
    state: "waiting",
    tone: "ok",
    headline: "Waiting to go to ACT!",
    detail,
    facts: [],
    lastError: failed && row.lastError ? row.lastError : null,
    adminNote: null,
  };
}

/**
 * An unfinished row with a blockedReason: the reason verbatim, which is a
 * sentence written for this reader by the planner or the drain (BLOCKED
 * REASONS ARE READ BY A MANAGER in src/lib/act/outbox-plan.ts). Who held it
 * (blockedBy) is not repeated to the reader: each reason already says what to
 * do, and where it differs is in what an administrator can do, which the
 * buttons' own texts say (adminHelpFor). The one note an administrator gets
 * here is for a contact held after a create: where to look, and from when --
 * given exactly when the two contact actions it leads into are offered
 * (heldForContact in src/lib/act/outbox-admin.ts, the same function).
 */
function held(facts: QuoteActFacts, row: NonNullable<QuoteActFacts["row"]>): QuoteActView {
  const contact = facts.contact;
  const contactHeld = heldForContact(row, contact);
  return {
    state: "held",
    tone: "warn",
    headline: "Held back from ACT!",
    detail: row.blockedReason,
    facts: [],
    lastError: null,
    adminNote:
      contactHeld && contact?.actCreateInFlightAt
        ? `Look in ACT! for ${contact.name}. If PathQuote's request reached ACT!, they were created there at about ${melbourneTime(contact.actCreateInFlightAt)}. Then choose one of the two below.`
        : null,
  };
}

/**
 * A finished row the drain finished: what ACT! now holds of the deal, from
 * what PathQuote stored as each step went through. Each fact is what PathQuote
 * did, which stays true whatever somebody has done in ACT! since -- an
 * opportunity marked Won may have been set back to Lost by hand, and is left
 * that way (THE WIN IS ONCE PER DEAL in src/lib/act/outbox-plan.ts), so the
 * card says PathQuote marked it Won, and when.
 *
 *   Contact      the quote's contact, when it has an ACT! id. The promotion
 *                is stated as the rule it is: a Prospect becomes a Customer,
 *                any other status is left alone (contactPromotion in
 *                src/lib/act/write-payloads.ts), and which it was is not
 *                stored.
 *   Opportunity  by the name PathQuote created it under, or found it by,
 *                which is fixed for the deal (opportunityName); a name
 *                somebody changes by hand in ACT! is not known here. The
 *                date it was marked Won is formatDateAU's, in the server's
 *                zone, as the Signing card beside this prints its dates.
 *   Amount       the revision the product line shows, and its figure. When
 *                this row left the line alone because the deal in ACT! is
 *                closed (productLineSkippedAt), that is said beside it,
 *                since the figure is then an older revision's, or none.
 *   History      the row's revision, when its History is stored.
 */
function inAct(facts: QuoteActFacts, row: NonNullable<QuoteActFacts["row"]>): QuoteActView {
  const out: { label: string; value: string }[] = [];
  const contact = facts.contact;
  if (contact?.actContactId) {
    const promoted = facts.actContactPromotedForId !== null && facts.actContactPromotedForId === contact.actContactId;
    out.push({
      label: "Contact",
      value: promoted ? `${contact.name} — made a Customer when the client signed, if they were a Prospect` : contact.name,
    });
  }
  if (facts.actOpportunityId) {
    const name = facts.number ? `"${opportunityName({ number: facts.number, currency: facts.currency })}"` : "This quote's opportunity";
    out.push({
      label: "Opportunity",
      value: facts.actOpportunityWonAt ? `${name} — marked Won by PathQuote on ${formatDateAU(facts.actOpportunityWonAt)}` : name,
    });
  }
  const leftAlone = row.productLineSkippedAt !== null && (facts.line === null || facts.line.revision < row.revision.revision);
  if (facts.line) {
    const figure = `${formatMoney(facts.line.total, facts.currency, facts.currencySymbol)}, from ${facts.line.label}`;
    out.push({
      label: "Amount",
      value: leftAlone
        ? `${figure} — left as it was for ${row.revision.label}, because the deal in ACT! is closed`
        : figure,
    });
  } else if (leftAlone) {
    out.push({ label: "Amount", value: "Not written — the deal in ACT! is closed, so PathQuote left its amount alone" });
  }
  if (row.revision.actHistoryId) {
    out.push({ label: "History", value: `${row.revision.label} is recorded in the contact's history` });
  }
  return {
    state: "in-act",
    tone: "ok",
    headline: "In ACT!",
    detail: null,
    facts: out,
    lastError: null,
    adminNote: null,
  };
}

/**
 * What queues a quote taken out of the queue again, as a sentence, by where
 * the quote stands: the only way back from "Don't send", which the enqueue
 * gives by inserting a new row (dontSendDecision in
 * src/lib/act/outbox-admin.ts) on the quote's next finalise, signature or
 * acceptance. Which of those can still happen differs: a FINAL quote not yet
 * signed can be signed, or unfinalized and finalised again; a signed one
 * cannot be unfinalized (canUnfinalize in src/lib/signing/state.ts) and can
 * only be accepted; one signed and accepted has nothing left that queues it
 * -- only voiding the client's signature and finalising again would, which is
 * no way to send a quote to ACT!, so the sentence sends the reader to the
 * developer. A draft (shown only while its row is unfinished) is queued by
 * being finalised.
 */
function requeuedBy(facts: Pick<QuoteActFacts, "status" | "signingStatus" | "acceptedAt">): string {
  if (facts.status !== "FINAL") return "If it is finalised, it is queued for ACT! again and sent as usual.";
  if (facts.signingStatus !== "SIGNED") {
    return "If the client signs it, or it is unfinalized and finalised again, it is queued for ACT! again and sent as usual.";
  }
  if (facts.acceptedAt === null) return "If it is accepted, it is queued for ACT! again and sent as usual.";
  return "It is signed and accepted, so nothing left to happen to it queues it again — if it has to go to ACT! after all, ask your developer.";
}

/**
 * A finished row an administrator stopped ("Don't send", dontSendDecision in
 * src/lib/act/outbox-admin.ts). What can still queue it is said (requeuedBy),
 * because it is the only way back and a reader may want it. Whatever the row
 * had sent before it was stopped -- an opportunity, a History -- is still in
 * ACT!, and that is said only when PathQuote has stored that something went.
 */
function notSent(facts: QuoteActFacts, row: NonNullable<QuoteActFacts["row"]>): QuoteActView {
  const sentBefore = facts.actOpportunityId !== null || row.revision.actHistoryId !== null;
  return {
    state: "not-sent",
    tone: "ok",
    headline: "Not sent to ACT! — an administrator chose not to",
    detail: `${sentBefore ? "What had already gone to ACT! for it before then stays there. " : ""}${requeuedBy(facts)}`,
    facts: [],
    lastError: null,
    adminNote: null,
  };
}

/**
 * The card `viewer` reads, or null for none: a viewer without ACT! sync
 * (showsQuoteActCard), a draft with nothing unfinished, or -- for anyone but
 * an administrator -- a quote not queued. See WHO READS IT above.
 */
export function describeQuoteAct(facts: QuoteActFacts, now: Date, viewer: QuoteActViewer): QuoteActView | null {
  if (!showsQuoteActCard(viewer) || hidden(facts)) return null;
  const row = facts.row;
  if (!row) return isAdminRole(viewer.role) ? notQueued(facts) : null;
  if (row.completedAt !== null) {
    return row.blockedBy === BLOCKED_BY.admin ? notSent(facts, row) : inAct(facts, row);
  }
  if (row.blockedReason !== null) return held(facts, row);
  return waiting(facts, row, now);
}

/** A confirmation dialog's words, for the two actions nothing on the page can undo. */
export type ConfirmWords = { title: string; description: string; confirmLabel: string };

/** What the administrator's buttons say: each label, its helper text, and the confirmations. */
export type AdminHelp = {
  tryAgain: { label: string; help: string };
  contactFound: { label: string; help: string; field: string; submit: string };
  contactAbsent: { label: string; help: string; confirm: ConfirmWords };
  dontSend: { label: string; help: string; confirm: ConfirmWords };
};

/**
 * The buttons' words, for an administrator. "Try again now" says something
 * different for each way a row is held, because what it can achieve differs:
 * ACT!'s refusal comes back unless ACT! is put right first; a revision PathQuote
 * cannot read is read the same way again; a lookup's duplicates are looked up
 * again, which the drain does by itself anyway.
 */
export function adminHelpFor(input: {
  blockedBy: string | null;
  contactName: string | null;
  number: string | null;
  /** Where the quote stands, for what can still queue it after "Don't send" (requeuedBy). */
  status: string;
  signingStatus: string;
  acceptedAt: Date | null;
}): AdminHelp {
  const person = input.contactName ?? "this contact";
  const quote = input.number ?? "this quote";
  const requeue = requeuedBy(input);
  const tryAgainHelp =
    input.blockedBy === BLOCKED_BY.revision
      ? "Reads this quote's finalised copy again and sends it, now. That copy does not change, so this only helps once your developer has put right what the reason above describes."
      : input.blockedBy === BLOCKED_BY.drain
        ? "Looks in ACT! again now, rather than at PathQuote's next check. It goes on only once the extra records named above have been removed in ACT!."
        : "Sends ACT! the same thing again, now. ACT! said no last time, and it will say no again unless what it objected to has been put right in ACT! first.";
  return {
    tryAgain: { label: "Try again now", help: tryAgainHelp },
    contactFound: {
      label: "ACT! has this person",
      help: `Choose this once you have found ${person} in ACT!. Enter their ACT! contact id. PathQuote first asks ACT! for that contact, and links nothing unless ACT! has it and its name or its email matches ${person}'s; then it links this contact to that person and carries on with every quote on it. If you do not have the id, your developer can find it in PathQuote's log when ACT! sent one back.`,
      field: "ACT! contact id",
      submit: "Link to this ACT! contact",
    },
    contactAbsent: {
      label: "ACT! has nobody",
      help: `Choose this only once you have looked in ACT! and ${person} is not there. PathQuote then creates them in ACT! at its next send. If ACT! does have them, this puts the same person in ACT! twice.`,
      confirm: {
        title: `Create ${person} in ACT!?`,
        description: `Only if you have looked in ACT! and ${person} is not there. If they are, this puts a second copy of the same person in ACT!, and PathQuote cannot take it out again.`,
        confirmLabel: "Create them in ACT!",
      },
    },
    dontSend: {
      label: "Don't send this quote to ACT!",
      help: `Takes this quote out of the queue for ACT! — a test quote, say. Whatever has already gone to ACT! stays there. ${requeue}`,
      confirm: {
        title: `Don't send ${quote} to ACT!?`,
        description: `PathQuote stops trying to send this quote to ACT!, and nothing on this page undoes that. ${requeue}`,
        confirmLabel: "Don't send",
      },
    },
  };
}

/**
 * What each action says when it has gone through, with sending switched on or
 * off. With it on, the action starts a send for this quote straight away (the
 * fast path, drainAfterResponse in src/lib/act/drain-after.ts), which finds
 * the drain busy now and then and leaves the row to the next 15-minute send --
 * hence "or within 15 minutes". Other quotes on a contact just settled are
 * not sent by that, only made due, so they go at the next 15-minute send.
 * `sendingOn` null is the switch not read (finish in
 * src/lib/actions/act-outbox.ts, after a failure that follows the write):
 * the message then says what was done, and promises no time.
 */
export function adminDoneMessage(
  action: "tryAgain" | "contactFound" | "contactAbsent" | "dontSend",
  sendingOn: boolean | null,
): string {
  const when =
    sendingOn === null
      ? "at the next send"
      : sendingOn
        ? "now, or within 15 minutes if another send is under way"
        : "once sending is switched on";
  switch (action) {
    case "tryAgain":
      return `Released — it goes to ACT! ${when}.`;
    case "contactFound":
      return sendingOn === null
        ? "Linked — this quote, and any other held for this contact, go on to ACT! at the next send."
        : sendingOn
          ? "Linked — this quote goes on to ACT! now, or within 15 minutes if another send is under way, and any other quote held for this contact within 15 minutes."
          : "Linked — this quote, and any other held for this contact, go on to ACT! once sending is switched on.";
    case "contactAbsent":
      return `Released — PathQuote creates them in ACT! ${when}.`;
    case "dontSend":
      return "Taken out of the queue for ACT!.";
  }
}
