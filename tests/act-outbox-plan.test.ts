import { describe, it, expect } from "vitest";
import {
  nextStep,
  type OutboxProgress,
  type OutboxStep,
  type QuoteState,
  type RevisionProgress,
} from "../src/lib/act/outbox-plan";

const ACT_CONTACT = "c0000000-0000-0000-0000-000000000001";
const ACT_OPPORTUNITY = "c0000000-0000-0000-0000-0000000000a0";
const ACT_HISTORY = "c0000000-0000-0000-0000-0000000000b0";

const nothingDone: OutboxProgress = { opportunityActId: null };
const noHistory: RevisionProgress = { actHistoryId: null };
const journaled: RevisionProgress = { actHistoryId: ACT_HISTORY };

const SIGNED_AT = new Date("2026-11-01T02:00:00.000Z");
const ACCEPTED_AT = new Date("2026-11-02T01:00:00.000Z");

const quoteState = (overrides: Partial<QuoteState> = {}): QuoteState => ({
  regionCode: "AU",
  contact: { actContactId: ACT_CONTACT, firstName: "Ross", lastName: "Fielding" },
  actOpportunityId: null,
  signingStatus: "NOT_SENT",
  acceptedAt: null,
  actContactPromotedAt: null,
  actOpportunityWonAt: null,
  ...overrides,
});

/** A deal whose finalise row has finished: contact in ACT!, opportunity made, revision journaled. */
const finishedDeal = (overrides: Partial<QuoteState> = {}) => quoteState({ actOpportunityId: ACT_OPPORTUNITY, ...overrides });

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
      return { ...world, quote: { ...world.quote, contact: { ...world.quote.contact!, actContactId: ACT_CONTACT } } };
    case "create-opportunity":
      return {
        ...world,
        progress: { ...world.progress, opportunityActId: ACT_OPPORTUNITY },
        quote: { ...world.quote, actOpportunityId: ACT_OPPORTUNITY },
      };
    case "update-opportunity":
      return { ...world, progress: { ...world.progress, opportunityActId: world.quote.actOpportunityId } };
    case "write-history":
      // Stored on the revision, not the row.
      return { ...world, revision: { actHistoryId: ACT_HISTORY } };
    case "promote-contact":
      return { ...world, quote: { ...world.quote, actContactPromotedAt: SIGNED_AT } };
    case "win-opportunity":
      return { ...world, quote: { ...world.quote, actOpportunityWonAt: ACCEPTED_AT } };
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

  it("writes this revision's history once the opportunity step is done", () => {
    const opportunityDone = { opportunityActId: ACT_OPPORTUNITY };
    expect(nextStep(opportunityDone, noHistory, quoteState({ actOpportunityId: ACT_OPPORTUNITY }))).toEqual({
      kind: "write-history",
    });
  });

  it("is done when this revision's history has been written", () => {
    const opportunityDone = { opportunityActId: ACT_OPPORTUNITY };
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
    const opportunityDone = { opportunityActId: ACT_OPPORTUNITY };
    const step = nextStep(opportunityDone, noHistory, quoteState({ contact: null, actOpportunityId: ACT_OPPORTUNITY }));
    expect(reasonOf(step)).toMatch(/no contact/);
  });

  it("leaves a journaled revision finished, whatever has happened to the quote since", () => {
    const opportunityDone = { opportunityActId: ACT_OPPORTUNITY };
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
    expect(taken).toEqual(["create-contact", "create-opportunity", "write-history"]);
    expect(nextStep(world.progress, world.revision, world.quote)).toEqual({ kind: "done" });
  });

  it("resumes a re-finalised revision at its history, after updating the opportunity once", () => {
    // Second revision of a deal: the opportunity already exists on the
    // Document. The row updates it, records that it did, then writes history.
    // The same plan whether that opportunity is open or closed -- the planner
    // is never told its status, so a closed deal cannot lead it to create a
    // second one. For a closed deal the drain sends nothing in the update
    // step (revisedOpportunityBody) and still stores opportunityActId.
    const quote = quoteState({ actOpportunityId: ACT_OPPORTUNITY });
    expect(nextStep(nothingDone, noHistory, quote)).toEqual({ kind: "update-opportunity" });
    const updated = { opportunityActId: ACT_OPPORTUNITY };
    expect(nextStep(updated, noHistory, quote)).toEqual({ kind: "write-history" });
    expect(nextStep(updated, journaled, quote)).toEqual({ kind: "done" });
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
    const quote = finishedDeal({ signingStatus: "SIGNED", acceptedAt: ACCEPTED_AT, actContactPromotedAt: SIGNED_AT });
    expect(nextStep(nothingDone, journaled, quote)).toEqual({ kind: "win-opportunity" });
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
      actContactPromotedAt: SIGNED_AT,
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
    expect(taken).toEqual(["create-contact", "create-opportunity", "write-history", "promote-contact", "win-opportunity"]);
  });

  it("reverses nothing when the signature is voided after the promotion", () => {
    // voidSignature puts signingStatus back to NOT_SENT. The contact stays a
    // Customer in ACT!: there is no step that would demote it.
    const quote = finishedDeal({ signingStatus: "NOT_SENT", actContactPromotedAt: SIGNED_AT });
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
    const quote = quoteState({ acceptedAt: ACCEPTED_AT, actContactPromotedAt: SIGNED_AT });
    expect(nextStep(nothingDone, journaled, quote)).toEqual({ kind: "create-opportunity" });
  });
});
