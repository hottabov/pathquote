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

const quoteState = (overrides: Partial<QuoteState> = {}): QuoteState => ({
  regionCode: "AU",
  contact: { actContactId: ACT_CONTACT, firstName: "Ross", lastName: "Fielding" },
  actOpportunityId: null,
  ...overrides,
});

const pathQuoteOnlyContact = { actContactId: null, firstName: "Ross", lastName: "Fielding" };

function reasonOf(step: OutboxStep): string {
  if (step.kind !== "blocked") throw new Error(`expected blocked, got ${step.kind}`);
  return step.reason;
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
    type World = { progress: OutboxProgress; revision: RevisionProgress; quote: QuoteState };
    const apply = (world: World, step: OutboxStep): World => {
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
        default:
          throw new Error(`nothing to apply for ${step.kind}`);
      }
    };

    let world: World = {
      progress: nothingDone,
      revision: noHistory,
      quote: quoteState({ contact: pathQuoteOnlyContact }),
    };
    const taken: string[] = [];
    for (let i = 0; i < 10; i++) {
      const step = nextStep(world.progress, world.revision, world.quote);
      // Planning twice from the same stored state gives the same answer: a
      // re-run before the step's result is stored repeats only that step.
      expect(nextStep(world.progress, world.revision, world.quote)).toEqual(step);
      if (step.kind === "done") break;
      taken.push(step.kind);
      world = apply(world, step);
    }
    expect(taken).toEqual(["create-contact", "create-opportunity", "write-history"]);
    expect(nextStep(world.progress, world.revision, world.quote)).toEqual({ kind: "done" });
  });

  it("resumes a re-finalised revision at its history, after updating the opportunity once", () => {
    // Second revision of a deal: the opportunity already exists on the
    // Document. The row updates it, records that it did, then writes history.
    const quote = quoteState({ actOpportunityId: ACT_OPPORTUNITY });
    expect(nextStep(nothingDone, noHistory, quote)).toEqual({ kind: "update-opportunity" });
    const updated = { opportunityActId: ACT_OPPORTUNITY };
    expect(nextStep(updated, noHistory, quote)).toEqual({ kind: "write-history" });
    expect(nextStep(updated, journaled, quote)).toEqual({ kind: "done" });
  });
});
