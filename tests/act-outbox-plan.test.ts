import { describe, it, expect } from "vitest";
import {
  nextStep,
  type OutboxProgress,
  type OutboxStep,
  type QuoteState,
  type RevisionProgress,
} from "../src/lib/act/outbox-plan";
import {
  productLineWrite,
  summaryProductPatch,
  wonOpportunityBody,
  type QuoteForAct,
} from "../src/lib/act/write-payloads";

const ACT_CONTACT = "c0000000-0000-0000-0000-000000000001";
const ACT_OTHER_CONTACT = "c0000000-0000-0000-0000-000000000002";
/** The id ACT! gives a contact the drain creates: a new record, so a new id. */
const ACT_CREATED_CONTACT = "c0000000-0000-0000-0000-000000000003";
const ACT_OPPORTUNITY = "c0000000-0000-0000-0000-0000000000a0";
const ACT_HISTORY = "c0000000-0000-0000-0000-0000000000b0";
const ACT_PRODUCT_LINE = "c0000000-0000-0000-0000-0000000000d0";

const nothingDone: OutboxProgress = { opportunityActId: null, productLineSkippedAt: null };
/** This row's opportunity step done, and nothing after it. */
const opportunityStepDone: OutboxProgress = { ...nothingDone, opportunityActId: ACT_OPPORTUNITY };
/** The first revision, 0, not yet journaled. */
const noHistory: RevisionProgress = { revision: 0, actHistoryId: null };
const journaled: RevisionProgress = { revision: 0, actHistoryId: ACT_HISTORY };

const ACCEPTED_AT = new Date("2026-11-02T01:00:00.000Z");

const quoteState = (overrides: Partial<QuoteState> = {}): QuoteState => ({
  regionCode: "AU",
  contact: { actContactId: ACT_CONTACT, firstName: "Ross", lastName: "Fielding" },
  actOpportunityId: null,
  actProductLineId: null,
  actProductLineRevision: null,
  signingStatus: "NOT_SENT",
  acceptedAt: null,
  actContactPromotedForId: null,
  actOpportunityWonAt: null,
  ...overrides,
});

/** A deal whose finalise row has finished: contact in ACT!, opportunity and its line made for revision 0, revision journaled. */
const finishedDeal = (overrides: Partial<QuoteState> = {}) =>
  quoteState({ actOpportunityId: ACT_OPPORTUNITY, actProductLineId: ACT_PRODUCT_LINE, actProductLineRevision: 0, ...overrides });

const pathQuoteOnlyContact = { actContactId: null, firstName: "Ross", lastName: "Fielding" };

function reasonOf(step: OutboxStep): string {
  if (step.kind !== "blocked") throw new Error(`expected blocked, got ${step.kind}`);
  return step.reason;
}

type World = { progress: OutboxProgress; revision: RevisionProgress; quote: QuoteState };

/** Store a step's result where the drain will: on the Contact, the Document, the row or the revision. */
function apply(world: World, step: OutboxStep): World {
  switch (step.kind) {
    case "create-contact":
      return { ...world, quote: { ...world.quote, contact: { ...world.quote.contact!, actContactId: ACT_CREATED_CONTACT } } };
    case "create-opportunity":
      return {
        ...world,
        progress: { ...world.progress, opportunityActId: ACT_OPPORTUNITY },
        quote: { ...world.quote, actOpportunityId: ACT_OPPORTUNITY },
      };
    case "update-opportunity":
      return { ...world, progress: { ...world.progress, opportunityActId: world.quote.actOpportunityId } };
    case "write-product-line":
      // On the Document, in one UPDATE: the line's id when it was created,
      // and in any case the revision it now shows.
      return {
        ...world,
        quote: {
          ...world.quote,
          actProductLineId: step.line === "create" ? ACT_PRODUCT_LINE : world.quote.actProductLineId,
          actProductLineRevision: world.revision.revision,
        },
      };
    case "write-history":
      // Stored on the revision, not the row.
      return { ...world, revision: { ...world.revision, actHistoryId: ACT_HISTORY } };
    case "promote-contact":
      // The ACT! id of the contact it promoted, not a time.
      return { ...world, quote: { ...world.quote, actContactPromotedForId: world.quote.contact!.actContactId } };
    case "win-opportunity":
      // The line first, when the step says so, then the win.
      return {
        ...world,
        quote: {
          ...world.quote,
          ...(step.line
            ? {
                actProductLineId: step.line === "create" ? ACT_PRODUCT_LINE : world.quote.actProductLineId,
                actProductLineRevision: world.revision.revision,
              }
            : {}),
          actOpportunityWonAt: ACCEPTED_AT,
        },
      };
    default:
      throw new Error(`nothing to apply for ${step.kind}`);
  }
}

/** Run a row to completion the way the drain will, re-planning after every stored result. */
function drive(start: World): { taken: string[]; world: World } {
  let world = start;
  const taken: string[] = [];
  for (let i = 0; i < 10; i++) {
    const step = nextStep(world.progress, world.revision, world.quote);
    // Planning twice from the same stored state gives the same answer: a
    // re-run before the step's result is stored repeats only that step.
    expect(nextStep(world.progress, world.revision, world.quote)).toEqual(step);
    if (step.kind === "done") return { taken, world };
    taken.push(step.kind);
    world = apply(world, step);
  }
  throw new Error(`no done after ${taken.join(", ")}`);
}

describe("nextStep", () => {
  it("creates the opportunity when the contact is already in ACT!", () => {
    expect(nextStep(nothingDone, noHistory, quoteState())).toEqual({ kind: "create-opportunity" });
  });

  it("creates the contact first when it exists only in PathQuote", () => {
    expect(nextStep(nothingDone, noHistory, quoteState({ contact: pathQuoteOnlyContact }))).toEqual({
      kind: "create-contact",
    });
  });

  it("creates the opportunity once the contact has been created", () => {
    // The contact step's result is the contact's own actContactId, stored on
    // the Contact row -- which is exactly what a contact that was always in
    // ACT! looks like.
    const contactCreated = { ...pathQuoteOnlyContact, actContactId: ACT_CONTACT };
    expect(nextStep(nothingDone, noHistory, quoteState({ contact: contactCreated }))).toEqual({
      kind: "create-opportunity",
    });
  });

  it("updates the deal's opportunity from an earlier revision instead of creating a second", () => {
    // One opportunity per deal. A re-finalise after a revision must not make
    // another one.
    expect(nextStep(nothingDone, noHistory, quoteState({ actOpportunityId: ACT_OPPORTUNITY }))).toEqual({
      kind: "update-opportunity",
    });
  });

  it("creates the deal's product line once the opportunity step is done", () => {
    const opportunityDone = opportunityStepDone;
    expect(nextStep(opportunityDone, noHistory, quoteState({ actOpportunityId: ACT_OPPORTUNITY }))).toEqual({
      kind: "write-product-line",
      line: "create",
    });
  });

  it("writes this revision's history once the product line shows it", () => {
    const opportunityDone = opportunityStepDone;
    const quote = quoteState({ actOpportunityId: ACT_OPPORTUNITY, actProductLineId: ACT_PRODUCT_LINE, actProductLineRevision: 0 });
    expect(nextStep(opportunityDone, noHistory, quote)).toEqual({ kind: "write-history" });
  });

  it("is done when this revision's history has been written", () => {
    const opportunityDone = opportunityStepDone;
    expect(nextStep(opportunityDone, journaled, quoteState({ actOpportunityId: ACT_OPPORTUNITY }))).toEqual({
      kind: "done",
    });
  });

  it("does not journal a revision twice when a new row is queued for it", () => {
    // A row finished; the manager unfinalised and re-finalised with no
    // changes, so planRevision kept the revision number and a NEW row was
    // queued for the same revision. That row has stored nothing of its own,
    // but the revision already has its History -- so it is done, not about to
    // write a second History for the same revision.
    expect(nextStep(nothingDone, journaled, quoteState({ actOpportunityId: ACT_OPPORTUNITY }))).toEqual({
      kind: "done",
    });
  });

  it("is blocked when the quote has no contact", () => {
    // Finalize does not require a contact, and a company with no contacts
    // leaves the builder nothing to pick, so a FINAL quote can legally carry
    // a company and nobody.
    const reason = reasonOf(nextStep(nothingDone, noHistory, quoteState({ contact: null })));
    expect(reason).toMatch(/no contact/);
    // "Choose or add": at a company with no contacts there is nobody to
    // choose, and "New contact" in the builder is the way out.
    expect(reason).toContain("choose or add a contact");
    // A voided quote is a draft already, with nothing to unfinalize; the
    // sentence must not tell its manager to do something they cannot.
    expect(reason).toContain("if it is final, unfinalize it");
    expect(reason).toContain("—");
    expect(reason).not.toMatch(/^[A-Z_]+$/);
  });

  it("is blocked when the region has no ACT! process, and names the region", () => {
    const reason = reasonOf(nextStep(nothingDone, noHistory, quoteState({ regionCode: "NZ" })));
    expect(reason).toContain("NZ");
    expect(reason).toMatch(/developer/);
  });

  it("is blocked when a contact that has to be created in ACT! has no name", () => {
    const nameless = { actContactId: null, firstName: "  ", lastName: null };
    expect(reasonOf(nextStep(nothingDone, noHistory, quoteState({ contact: nameless })))).toMatch(/no name/);
  });

  it("does not mind a nameless contact that ACT! already knows", () => {
    // The name is only needed to create one.
    const namelessButLinked = { actContactId: ACT_CONTACT, firstName: "", lastName: null };
    expect(nextStep(nothingDone, noHistory, quoteState({ contact: namelessButLinked }))).toEqual({
      kind: "create-opportunity",
    });
  });

  it("checks the region before a fresh row creates anything, so it leaves nothing behind in ACT!", () => {
    const step = nextStep(nothingDone, noHistory, quoteState({ regionCode: "NZ", contact: pathQuoteOnlyContact }));
    expect(step.kind).toBe("blocked");
  });

  it("blocks a row partway when the quote loses its contact, and does not call it done", () => {
    // The checks run before every step, not only the first: unfinalised after
    // its opportunity was made, then moved to a company with no contacts. The
    // opportunity stays in ACT!; the row waits for a contact.
    const opportunityDone = opportunityStepDone;
    const step = nextStep(opportunityDone, noHistory, quoteState({ contact: null, actOpportunityId: ACT_OPPORTUNITY }));
    expect(reasonOf(step)).toMatch(/no contact/);
  });

  it("leaves a journaled revision finished, whatever has happened to the quote since", () => {
    const opportunityDone = opportunityStepDone;
    expect(nextStep(opportunityDone, journaled, quoteState({ contact: null, regionCode: "NZ" }))).toEqual({
      kind: "done",
    });
  });

  it("resumes a partly-done row at the step after the last stored result, never repeating one", () => {
    // Drive a row through every step, storing each result the way the drain
    // will, and stop ("crash") after each one. Re-planning from what was
    // stored must always pick up at the next step: the planner only ever
    // looks at stored ids, so a step that stored its id is never run twice.
    const { taken, world } = drive({
      progress: nothingDone,
      revision: noHistory,
      quote: quoteState({ contact: pathQuoteOnlyContact }),
    });
    expect(taken).toEqual(["create-contact", "create-opportunity", "write-product-line", "write-history"]);
    expect(nextStep(world.progress, world.revision, world.quote)).toEqual({ kind: "done" });
    expect(world.quote.actProductLineId).toBe(ACT_PRODUCT_LINE);
    expect(world.quote.actProductLineRevision).toBe(0);
  });

  it("resumes a re-finalised revision at its history, after updating the opportunity and its line once", () => {
    // Second revision of a deal: the opportunity and its product line already
    // exist on the Document. The row updates the opportunity, records that it
    // did, updates the line, records which revision it shows, then writes
    // history. The same plan whether that opportunity is open or closed -- the
    // planner is never told its status, so a closed deal cannot lead it to
    // create a second one. For a closed deal the drain sends nothing in either
    // update step (revisedOpportunityBody, productLineWrite) and stores
    // opportunityActId and the row's productLineSkippedAt -- not
    // actProductLineRevision, since the line was not written.
    const quote = finishedDeal();
    const revision1: RevisionProgress = { revision: 1, actHistoryId: null };
    expect(nextStep(nothingDone, revision1, quote)).toEqual({ kind: "update-opportunity" });
    const updated = opportunityStepDone;
    // The line shows revision 0: patched in place, never a second line.
    expect(nextStep(updated, revision1, quote)).toEqual({ kind: "write-product-line", line: "update" });
    const lineUpdated = { ...quote, actProductLineRevision: 1 };
    expect(nextStep(updated, revision1, lineUpdated)).toEqual({ kind: "write-history" });
    expect(nextStep(updated, { ...revision1, actHistoryId: ACT_HISTORY }, lineUpdated)).toEqual({ kind: "done" });
  });
});

describe("nextStep: the deal's one product line", () => {
  const revision = (n: number): RevisionProgress => ({ revision: n, actHistoryId: null });

  it("runs a later revision's row through the opportunity, the line, then the History, updating the line it already has", () => {
    const { taken, world } = drive({ progress: nothingDone, revision: revision(3), quote: finishedDeal() });
    expect(taken).toEqual(["update-opportunity", "write-product-line", "write-history"]);
    expect(world.quote.actProductLineId).toBe(ACT_PRODUCT_LINE);
    expect(world.quote.actProductLineRevision).toBe(3);
  });

  it("does not patch the line again for a revision it already shows", () => {
    // A row taken over before its History, for the same revision (an
    // unchanged re-finalise): the line was written; the History was not.
    const quote = finishedDeal({ actProductLineRevision: 2 });
    expect(nextStep(opportunityStepDone, revision(2), quote)).toEqual({ kind: "write-history" });
  });

  it("never writes an older revision's figure over a newer one", () => {
    const quote = finishedDeal({ actProductLineRevision: 4 });
    expect(nextStep(opportunityStepDone, revision(3), quote)).toEqual({ kind: "write-history" });
  });

  it("moves on when this row skipped the line of a closed deal, without recording a revision the line does not show", () => {
    // Closed: nothing sent, so nothing about the line is stored -- only the
    // row's skip. The planner is never told the status; it sees the step done.
    const closed = quoteState({ actOpportunityId: ACT_OPPORTUNITY });
    const skipped: OutboxProgress = { ...opportunityStepDone, productLineSkippedAt: ACCEPTED_AT };
    expect(nextStep(skipped, revision(1), closed)).toEqual({ kind: "write-history" });
    expect(closed.actProductLineRevision).toBeNull();
  });

  it("asks again on the next row, and creates the line then if the deal was reopened", () => {
    // The skip is the row's: a row for revision 2 (or this one taken over for
    // it) starts without it, and the line still shows nothing.
    const closed = quoteState({ actOpportunityId: ACT_OPPORTUNITY });
    expect(nextStep(opportunityStepDone, revision(2), closed)).toEqual({
      kind: "write-product-line",
      line: "create",
    });
  });

  it("updates rather than creates whenever a line id is stored, even with no revision beside it", () => {
    // Not reachable when the drain stores both in one UPDATE; if the database
    // says otherwise, a patch is the harmless repeat and a create is a second line.
    const quote = finishedDeal({ actProductLineRevision: null });
    expect(nextStep(opportunityStepDone, revision(0), quote)).toEqual({
      kind: "write-product-line",
      line: "update",
    });
  });

  it("is not reached once the revision is journaled, whatever the line shows", () => {
    // The line step comes before write-history; a journaled revision had it.
    const quote = finishedDeal({ actProductLineRevision: null, actProductLineId: null });
    expect(nextStep(nothingDone, { revision: 0, actHistoryId: ACT_HISTORY }, quote)).toEqual({ kind: "done" });
  });
});

describe("nextStep: a won quote promotes its contact and wins its opportunity", () => {
  // Rows queued by a signature or an acceptance usually arrive after the
  // finalise row has finished: the revision is journaled, and this row has
  // stored nothing of its own.
  it("promotes the contact once the client has signed", () => {
    expect(nextStep(nothingDone, journaled, finishedDeal({ signingStatus: "SIGNED" }))).toEqual({
      kind: "promote-contact",
    });
  });

  it("wins the opportunity once the quote is accepted", () => {
    // Accepting needs the client's signature first, so the contact is
    // normally promoted already by then.
    const quote = finishedDeal({ signingStatus: "SIGNED", acceptedAt: ACCEPTED_AT, actContactPromotedForId: ACT_CONTACT });
    expect(nextStep(nothingDone, journaled, quote)).toEqual({ kind: "win-opportunity", line: null });
  });

  it("does both, promotion first, when the quote is accepted before either has run", () => {
    const { taken } = drive({
      progress: nothingDone,
      revision: journaled,
      quote: finishedDeal({ signingStatus: "SIGNED", acceptedAt: ACCEPTED_AT }),
    });
    expect(taken).toEqual(["promote-contact", "win-opportunity"]);
  });

  it("skips a promotion and a win that have already run", () => {
    const quote = finishedDeal({
      signingStatus: "SIGNED",
      acceptedAt: ACCEPTED_AT,
      actContactPromotedForId: ACT_CONTACT,
      actOpportunityWonAt: ACCEPTED_AT,
    });
    expect(nextStep(nothingDone, journaled, quote)).toEqual({ kind: "done" });
  });

  it("does not call a finished finalise's revision done while a signature still has to promote the contact", () => {
    // The revision's History was written by the finalise row; a new row,
    // queued by the signature, must not stop there.
    const quote = finishedDeal({ signingStatus: "SIGNED" });
    expect(nextStep(nothingDone, journaled, quote)).not.toEqual({ kind: "done" });
    const { taken } = drive({ progress: nothingDone, revision: journaled, quote });
    expect(taken).toEqual(["promote-contact"]);
  });

  it("does the earlier steps first when the signature comes before the deal reached ACT!", () => {
    // ACT! was down from finalise to signature, so the row taken over by the
    // signature has made nothing yet. The contact, the opportunity and the
    // History still come first, in their usual order.
    const { taken } = drive({
      progress: nothingDone,
      revision: noHistory,
      quote: quoteState({ contact: pathQuoteOnlyContact, signingStatus: "SIGNED", acceptedAt: ACCEPTED_AT }),
    });
    expect(taken).toEqual([
      "create-contact",
      "create-opportunity",
      "write-product-line",
      "write-history",
      "promote-contact",
      "win-opportunity",
    ]);
  });

  it("reverses nothing when the signature is voided after the promotion", () => {
    // voidSignature puts signingStatus back to NOT_SENT. The contact stays a
    // Customer in ACT!: there is no step that would demote it.
    const quote = finishedDeal({ signingStatus: "NOT_SENT", actContactPromotedForId: ACT_CONTACT });
    expect(nextStep(nothingDone, journaled, quote)).toEqual({ kind: "done" });
  });

  it("promotes nobody when the signature was voided before the promotion ran", () => {
    // The planner reads the quote as it stands: a signature annulled before
    // the drain got to it is no longer evidence of a customer.
    expect(nextStep(nothingDone, journaled, finishedDeal({ signingStatus: "NOT_SENT" }))).toEqual({ kind: "done" });
  });

  it("is blocked, not done, when a promotion is due and the quote has lost its contact", () => {
    // The blocking checks run before every step, these included.
    const step = nextStep(nothingDone, journaled, finishedDeal({ contact: null, acceptedAt: ACCEPTED_AT }));
    expect(reasonOf(step)).toMatch(/no contact/);
  });

  it("creates the opportunity before winning it if the deal somehow has none", () => {
    // Not reachable through the drain: the row that journaled the revision
    // did its opportunity step first, and nothing clears
    // Document.actOpportunityId. Should the database say otherwise, the
    // win still waits for an opportunity to exist.
    const quote = quoteState({ acceptedAt: ACCEPTED_AT, actContactPromotedForId: ACT_CONTACT });
    expect(nextStep(nothingDone, journaled, quote)).toEqual({ kind: "create-opportunity" });
  });

  it("promotes on an acceptance alone, with no signature standing", () => {
    // acceptQuote needs the client's signature, but voidSignature does not
    // clear acceptedAt: an accepted quote whose signature was voided is
    // NOT_SENT and still accepted, and the acceptance is evidence enough.
    const quote = finishedDeal({ signingStatus: "NOT_SENT", acceptedAt: ACCEPTED_AT, actOpportunityWonAt: ACCEPTED_AT });
    expect(nextStep(nothingDone, journaled, quote)).toEqual({ kind: "promote-contact" });
  });

  it("is blocked, not done, when a deal event is due in a region with no ACT! process", () => {
    // A row queued by a signature runs the same checks as a finalise row.
    const step = nextStep(nothingDone, journaled, finishedDeal({ regionCode: "NZ", signingStatus: "SIGNED" }));
    expect(reasonOf(step)).toContain("NZ");
    expect(reasonOf(step)).toMatch(/developer/);
  });

  it("promotes a corrected contact: promotion is recorded per contact, not per deal", () => {
    // Contact A signed and was promoted. The signature was voided (a wrong
    // signatory), the quote went back to DRAFT, its contact was changed to B,
    // and it was finalised and signed again. B is the customer now, and has
    // not been promoted.
    const quote = finishedDeal({
      contact: { actContactId: ACT_OTHER_CONTACT, firstName: "Dana", lastName: "Okafor" },
      signingStatus: "SIGNED",
      actContactPromotedForId: ACT_CONTACT,
    });
    expect(nextStep(nothingDone, journaled, quote)).toEqual({ kind: "promote-contact" });
    const { taken, world } = drive({ progress: nothingDone, revision: journaled, quote });
    expect(taken).toEqual(["promote-contact"]);
    expect(world.quote.actContactPromotedForId).toBe(ACT_OTHER_CONTACT);
  });

  it("creates a corrected contact ACT! does not have, then promotes it", () => {
    // B exists only in PathQuote: whatever is stored, it cannot be the contact
    // already promoted.
    const { taken, world } = drive({
      progress: nothingDone,
      revision: journaled,
      quote: finishedDeal({ contact: pathQuoteOnlyContact, signingStatus: "SIGNED", actContactPromotedForId: ACT_CONTACT }),
    });
    expect(taken).toEqual(["create-contact", "promote-contact"]);
    expect(world.quote.actContactPromotedForId).toBe(ACT_CREATED_CONTACT);
  });

  it("does not promote the same contact twice when the quote is signed again", () => {
    const quote = finishedDeal({ signingStatus: "SIGNED", actContactPromotedForId: ACT_CONTACT });
    expect(nextStep(nothingDone, journaled, quote)).toEqual({ kind: "done" });
  });

  it("never wins the opportunity again once the win is recorded, so a Lost set by hand afterwards stands", () => {
    // Vadym, 2026-10-12: "If after that someone changes it to Lost by hand in
    // ACT!, it stays that way." The planner is never told the opportunity's
    // status -- it could be Lost in ACT! by now -- and with the win recorded
    // it never plans win-opportunity again: not for this row, and not for a
    // row queued by a later revision or a second acceptance. (A revision's
    // update-opportunity leaves a closed deal alone; revisedOpportunityBody.)
    const quote = finishedDeal({
      signingStatus: "SIGNED",
      acceptedAt: ACCEPTED_AT,
      actContactPromotedForId: ACT_CONTACT,
      actOpportunityWonAt: ACCEPTED_AT,
    });
    expect(nextStep(nothingDone, journaled, quote)).toEqual({ kind: "done" });
    const { taken } = drive({ progress: nothingDone, revision: noHistory, quote });
    expect(taken).not.toContain("win-opportunity");
    expect(taken).toEqual(["update-opportunity", "write-history"]);
  });
});

// The drain and ACT! played out together: the planner picks each step, the
// pure decisions in write-payloads say what it sends, and a plain object
// stands in for the deal in ACT!. No I/O, no mocks -- the same functions the
// drain will call, against a record that changes the way ACT!'s would.
describe("a won deal shows the accepted figure (the drain and ACT! together)", () => {
  const SALES_CYCLE = "2380e83d-cef4-4b6d-ad15-dc9a558431ab";
  const SKIPPED_AT = new Date("2026-10-20T00:00:00.000Z");

  /** The deal as ACT! holds it. */
  type Deal = { status: string; stageNumber: number; line: { revision: number; total: number } | null };
  type Sim = { world: World; deal: Deal | null; totals: Record<number, number>; journaled: Record<number, string> };

  const quoteFor = (revision: number, totals: Record<number, number>): QuoteForAct => ({
    number: "Q-AU-2026-014",
    revision,
    regionCode: "AU",
    total: totals[revision],
    currency: "AUD",
    validityDays: 30,
    finalizedAt: new Date("2026-10-12T04:30:00.000Z"),
  });

  /** A fresh row for `revision`, as an enqueue inserts it; the revision's History as stored. */
  function enqueue(sim: Sim, revision: number, quote: Partial<QuoteState> = {}): Sim {
    return {
      ...sim,
      world: {
        progress: nothingDone,
        revision: { revision, actHistoryId: sim.journaled[revision] ?? null },
        quote: { ...sim.world.quote, ...quote },
      },
    };
  }

  /** Write the line for the row's revision, and store what was written. */
  function writeLine(sim: Sim, line: "create" | "update"): Sim {
    const q = quoteFor(sim.world.revision.revision, sim.totals);
    return {
      ...sim,
      deal: { ...sim.deal!, line: { revision: q.revision, total: summaryProductPatch(q).total } },
      world: {
        ...sim.world,
        quote: {
          ...sim.world.quote,
          actProductLineId: line === "create" ? ACT_PRODUCT_LINE : sim.world.quote.actProductLineId,
          actProductLineRevision: q.revision,
        },
      },
    };
  }

  /** One step: what the drain would send, applied to the deal, and its result stored. */
  function step(sim: Sim, planned: OutboxStep): Sim {
    const { world, deal } = sim;
    const now = { processId: SALES_CYCLE, number: deal?.stageNumber ?? 0, status: deal?.status ?? "" };
    switch (planned.kind) {
      case "create-opportunity":
        return { ...sim, deal: { status: "Open", stageNumber: 4, line: null }, world: apply(world, planned) };
      case "write-product-line": {
        const decision = productLineWrite(deal!.status, world.quote.acceptedAt !== null);
        if (decision.kind === "write") return writeLine(sim, planned.line);
        return { ...sim, world: { ...world, progress: { ...world.progress, productLineSkippedAt: SKIPPED_AT } } };
      }
      case "write-history":
        return {
          ...sim,
          journaled: { ...sim.journaled, [world.revision.revision]: ACT_HISTORY },
          world: apply(world, planned),
        };
      case "win-opportunity": {
        const lined = planned.line ? writeLine(sim, planned.line) : sim;
        const won = wonOpportunityBody("AU", now, ACCEPTED_AT);
        return {
          ...lined,
          deal: won.kind === "patch" ? { ...lined.deal!, status: "Won" } : lined.deal,
          world: { ...lined.world, quote: { ...lined.world.quote, actOpportunityWonAt: ACCEPTED_AT } },
        };
      }
      default:
        return { ...sim, world: apply(world, planned) };
    }
  }

  function drain(start: Sim): { sim: Sim; taken: OutboxStep[] } {
    let sim = start;
    const taken: OutboxStep[] = [];
    for (let i = 0; i < 12; i++) {
      const planned = nextStep(sim.world.progress, sim.world.revision, sim.world.quote);
      if (planned.kind === "done") return { sim, taken };
      if (planned.kind === "blocked") throw new Error(planned.reason);
      taken.push(planned);
      sim = step(sim, planned);
    }
    throw new Error("no done");
  }

  /** Revision 0 at 100,000 finalised and drained: an open deal whose line shows it. */
  function finalisedAt100k(): Sim {
    const start: Sim = {
      world: { progress: nothingDone, revision: noHistory, quote: quoteState() },
      deal: null,
      totals: { 0: 100000, 1: 80000 },
      journaled: {},
    };
    const { sim } = drain(start);
    expect(sim.deal).toEqual({ status: "Open", stageNumber: 4, line: { revision: 0, total: 100000 } });
    return sim;
  }

  const byHand = (sim: Sim, status: string): Sim => ({ ...sim, deal: { ...sim.deal!, status } });

  it("a deal closed by hand keeps its line, and the acceptance then wins it at the accepted figure", () => {
    // R0 at 100k; the deal marked Lost by hand; R1 finalised at 80k.
    let sim = drain(enqueue(byHand(finalisedAt100k(), "Lost"), 1)).sim;
    expect(sim.deal).toEqual({ status: "Lost", stageNumber: 4, line: { revision: 0, total: 100000 } });
    // Nothing was written, so nothing says the line shows R1.
    expect(sim.world.quote.actProductLineRevision).toBe(0);
    expect(sim.world.progress.productLineSkippedAt).toEqual(SKIPPED_AT);

    // R1 signed and accepted: a new row for R1, journaled already.
    const accepted = drain(enqueue(sim, 1, { signingStatus: "SIGNED", acceptedAt: ACCEPTED_AT }));
    expect(accepted.taken).toEqual([
      { kind: "promote-contact" },
      { kind: "win-opportunity", line: "update" },
    ]);
    sim = accepted.sim;
    expect(sim.deal).toEqual({ status: "Won", stageNumber: 4, line: { revision: 1, total: 80000 } });
    expect(sim.world.quote.actProductLineRevision).toBe(1);
  });

  it("a deal closed before it ever had a line is won with one, not at nothing", () => {
    // Revision 0: the opportunity is made, then closed by hand before the line step.
    const start: Sim = {
      world: { progress: nothingDone, revision: noHistory, quote: quoteState() },
      deal: null,
      totals: { 0: 100000 },
      journaled: {},
    };
    let sim = step(start, nextStep(start.world.progress, start.world.revision, start.world.quote));
    expect(sim.deal?.status).toBe("Open");
    sim = drain(byHand(sim, "Lost")).sim;
    expect(sim.deal?.line).toBeNull();
    expect(sim.world.quote.actProductLineId).toBeNull();
    expect(sim.world.quote.actProductLineRevision).toBeNull();

    const accepted = drain(enqueue(sim, 0, { signingStatus: "SIGNED", acceptedAt: ACCEPTED_AT }));
    expect(accepted.taken).toContainEqual({ kind: "win-opportunity", line: "create" });
    expect(accepted.sim.deal).toEqual({ status: "Won", stageNumber: 4, line: { revision: 0, total: 100000 } });
    expect(accepted.sim.world.quote.actProductLineId).toBe(ACT_PRODUCT_LINE);
  });

  it("a won quote voided and re-finalised at a new figure moves the won deal's line with it", () => {
    // R0 accepted and won at 100k.
    let sim = drain(enqueue(finalisedAt100k(), 0, { signingStatus: "SIGNED", acceptedAt: ACCEPTED_AT })).sim;
    expect(sim.deal).toMatchObject({ status: "Won", line: { revision: 0, total: 100000 } });
    expect(sim.world.quote.actOpportunityWonAt).toEqual(ACCEPTED_AT);

    // voidSignature: NOT_SENT, acceptedAt kept. R1 re-finalised at 80k. The
    // win is never planned again, so the line has to follow at the line step.
    const refinalised = drain(enqueue(sim, 1, { signingStatus: "NOT_SENT" }));
    expect(refinalised.taken.map((t) => t.kind)).toEqual(["update-opportunity", "write-product-line", "write-history"]);
    sim = refinalised.sim;
    expect(sim.deal).toMatchObject({ status: "Won", line: { revision: 1, total: 80000 } });

    // Signed again; acceptQuote returns early for a quote already accepted.
    const signed = drain(enqueue(sim, 1, { signingStatus: "SIGNED" }));
    expect(signed.taken).toEqual([]);
    expect(signed.sim.deal).toMatchObject({ status: "Won", line: { revision: 1, total: 80000 } });
  });

  it("a deal set to Lost by hand after its win keeps its status and its line through a re-finalise", () => {
    let sim = drain(enqueue(finalisedAt100k(), 0, { signingStatus: "SIGNED", acceptedAt: ACCEPTED_AT })).sim;
    sim = drain(enqueue(byHand(sim, "Lost"), 1, { signingStatus: "NOT_SENT" })).sim;
    expect(sim.deal).toEqual({ status: "Lost", stageNumber: 4, line: { revision: 0, total: 100000 } });
    expect(sim.world.quote.actProductLineRevision).toBe(0);
  });

  it("resumes a win that wrote the line and died before the status at the status, without the line again", () => {
    const sim = drain(enqueue(byHand(finalisedAt100k(), "Lost"), 1)).sim;
    const accepted = enqueue(sim, 1, { signingStatus: "SIGNED", acceptedAt: ACCEPTED_AT, actContactPromotedForId: ACT_CONTACT });
    expect(nextStep(accepted.world.progress, accepted.world.revision, accepted.world.quote)).toEqual({
      kind: "win-opportunity",
      line: "update",
    });
    // The line written and stored; the opportunity's PATCH never made.
    const lined = writeLine(accepted, "update");
    expect(lined.deal).toMatchObject({ status: "Lost", line: { revision: 1, total: 80000 } });
    expect(nextStep(lined.world.progress, lined.world.revision, lined.world.quote)).toEqual({
      kind: "win-opportunity",
      line: null,
    });
    expect(drain(lined).sim.deal).toEqual({ status: "Won", stageNumber: 4, line: { revision: 1, total: 80000 } });
  });

  it("wins an open deal whose line is current without touching the line", () => {
    const { taken, sim } = drain(enqueue(finalisedAt100k(), 0, { signingStatus: "SIGNED", acceptedAt: ACCEPTED_AT }));
    expect(taken).toContainEqual({ kind: "win-opportunity", line: null });
    expect(sim.deal).toMatchObject({ status: "Won", line: { revision: 0, total: 100000 } });
  });
});
