import { describe, it, expect } from "vitest";
import {
  adminDoneMessage,
  adminHelpFor,
  describeQuoteAct,
  inAbout,
  type QuoteActFacts,
} from "../src/lib/act/quote-act-view";
import { BLOCKED_BY, refusedReason } from "../src/lib/act/drain-rules";
import { NO_CONTACT_REASON, UNTRACKED_CONTACT_REASON } from "../src/lib/act/outbox-plan";

// A fixed clock, so every relative phrase is a function of the arguments: the
// suite has no fake timers (vitest.config.ts, `isolate: false`).
const NOW = new Date("2026-10-13T03:00:00.000Z"); // 2:00 pm Melbourne, 13 Oct

type Row = NonNullable<QuoteActFacts["row"]>;

function row(overrides: Partial<Row> = {}): Row {
  return {
    attempts: 0,
    lastError: null,
    nextAttemptAt: NOW,
    completedAt: null,
    blockedReason: null,
    blockedBy: null,
    productLineSkippedAt: null,
    revision: { revision: 1, label: "Q-AU-2026-014-R1", actHistoryId: null },
    ...overrides,
  };
}

/** A FINAL quote, sending on, its contact in ACT!, no row yet. */
function facts(overrides: Partial<QuoteActFacts> = {}): QuoteActFacts {
  return {
    status: "FINAL",
    signingStatus: "NOT_SENT",
    acceptedAt: null,
    number: "Q-AU-2026-014",
    currency: "AUD",
    currencySymbol: null,
    hasRevision: true,
    sendingOn: true,
    contact: { name: "Nora Quinn", actContactId: "c0ffee00-0000-4000-8000-000000000001", actCreateInFlightAt: null },
    actOpportunityId: null,
    actOpportunityWonAt: null,
    actContactPromotedForId: null,
    line: null,
    row: null,
    ...overrides,
  };
}

describe("describeQuoteAct: which quotes show a card", () => {
  it("shows nothing for a draft with nothing queued, or whose last write finished", () => {
    expect(describeQuoteAct(facts({ status: "DRAFT" }), NOW)).toBeNull();
    expect(describeQuoteAct(facts({ status: "DRAFT", row: row({ completedAt: NOW }) }), NOW)).toBeNull();
  });

  it("shows a draft whose write is still queued -- the drain still works it, and Settings links to it", () => {
    const view = describeQuoteAct(facts({ status: "DRAFT", row: row({ blockedReason: NO_CONTACT_REASON }) }), NOW);
    expect(view?.state).toBe("held");
    expect(view?.detail).toBe(NO_CONTACT_REASON);
  });
});

describe("describeQuoteAct: not queued", () => {
  it("a quote finalised before revisions existed: nothing to send, and signing will not send it", () => {
    const view = describeQuoteAct(facts({ hasRevision: false }), NOW);
    expect(view).toEqual({
      state: "not-queued",
      tone: "ok",
      headline: "Not queued for ACT!",
      detail:
        "This quote was finalised before PathQuote kept a copy of each finalised version, so there is no copy of it to send to ACT! — and signing or accepting it will not send it either.",
      facts: [],
      lastError: null,
      adminNote:
        "Unfinalizing it and finalizing it again sends it, but that also withdraws any signing link that is out, clears the signatures on it, and finalises it with today's terms and documents — so if the client already has this quote, ask your developer instead.",
    });
  });

  it("the same quote once signed: it cannot be unfinalized, so only the developer can queue it", () => {
    const view = describeQuoteAct(facts({ hasRevision: false, signingStatus: "SIGNED" }), NOW);
    expect(view?.adminNote).toBe(
      "Now that the client has signed it, it cannot be unfinalized, so only your developer can queue it for ACT!.",
    );
  });

  it("a quote finalised before sending began: says which event can still send it", () => {
    expect(describeQuoteAct(facts(), NOW)?.detail).toBe(
      "This quote was finalised before PathQuote began sending quotes to ACT!, and has not been finalised, signed or accepted since — which is what sends a quote. If the client signs it, it goes then.",
    );
    expect(describeQuoteAct(facts({ signingStatus: "SIGNED" }), NOW)?.detail).toBe(
      "This quote was finalised before PathQuote began sending quotes to ACT!, and has not been finalised, signed or accepted since — which is what sends a quote. If it is accepted, it goes then.",
    );
    const done = describeQuoteAct(facts({ signingStatus: "SIGNED", acceptedAt: NOW }), NOW);
    expect(done?.detail).toBe(
      "This quote was finalised before PathQuote began sending quotes to ACT!, and has not been finalised, signed or accepted since — which is what sends a quote.",
    );
    expect(done?.adminNote).toBe(
      "Now that the client has signed it, it cannot be unfinalized, so if it has to be in ACT!, ask your developer to queue it.",
    );
  });
});

describe("describeQuoteAct: waiting", () => {
  it("queued, never failed: goes on its own", () => {
    expect(describeQuoteAct(facts({ row: row() }), NOW)).toEqual({
      state: "waiting",
      tone: "ok",
      headline: "Waiting to go to ACT!",
      detail: "It goes on its own — PathQuote sends queued quotes every 15 minutes.",
      facts: [],
      lastError: null,
      adminNote: null,
    });
  });

  it("says when sending is switched off, before anything else, and still shows the last failure", () => {
    const view = describeQuoteAct(
      facts({ sendingOn: false, row: row({ attempts: 2, lastError: "PathQuote could not reach ACT!" }) }),
      NOW,
    );
    expect(view?.detail).toBe("Sending to ACT! is switched off, so this quote waits — it goes as soon as it is switched on.");
    expect(view?.lastError).toBe("PathQuote could not reach ACT!");
  });

  it("backing off: how often it has tried, when it next tries, and lastError as written", () => {
    const lastError = "PathQuote could not create this quote's opportunity: ACT! answered 503 — Service Unavailable";
    const view = describeQuoteAct(
      facts({ row: row({ attempts: 3, lastError, nextAttemptAt: new Date("2026-10-13T03:40:00.000Z") }) }),
      NOW,
    );
    expect(view?.detail).toBe(
      "PathQuote has tried 3 times and not got through to ACT! yet. It tries again on its own at the first send after 13 Oct 2026, 2:40 pm Melbourne time, in about 40 minutes, and keeps trying, waiting longer each time.",
    );
    expect(view?.lastError).toBe(lastError);
    expect(view?.tone).toBe("ok");
  });

  it("failed once and due again now", () => {
    expect(describeQuoteAct(facts({ row: row({ attempts: 1, lastError: "x", nextAttemptAt: NOW }) }), NOW)?.detail).toBe(
      "PathQuote has tried once and not got through to ACT! yet. It is due to be tried again at the next send — PathQuote sends queued quotes every 15 minutes.",
    );
  });

  it("puts no stale error beside a row that has not failed", () => {
    expect(describeQuoteAct(facts({ row: row({ attempts: 0, lastError: "old" }) }), NOW)?.lastError).toBeNull();
  });
});

describe("describeQuoteAct: held", () => {
  it("shows the reason verbatim, amber, whoever held it", () => {
    const reason = refusedReason("promote-contact", 400, '{"Message":"Account Mgr is not in the list"}');
    for (const blockedBy of [BLOCKED_BY.act, BLOCKED_BY.revision, BLOCKED_BY.drain, null]) {
      expect(describeQuoteAct(facts({ row: row({ blockedReason: reason, blockedBy }) }), NOW)).toEqual({
        state: "held",
        tone: "warn",
        headline: "Held back from ACT!",
        detail: reason,
        facts: [],
        lastError: null,
        adminNote: null,
      });
    }
  });

  it("tells an administrator where to look for a contact whose create went unaccounted for", () => {
    const view = describeQuoteAct(
      facts({
        contact: { name: "Nora Quinn", actContactId: null, actCreateInFlightAt: new Date("2026-10-12T23:05:00.000Z") },
        row: row({ blockedReason: UNTRACKED_CONTACT_REASON }),
      }),
      NOW,
    );
    expect(view?.detail).toBe(UNTRACKED_CONTACT_REASON);
    expect(view?.adminNote).toBe(
      "Look in ACT! for Nora Quinn. If PathQuote's request reached ACT!, they were created there at about 13 Oct 2026, 10:05 am Melbourne time. Then choose one of the two below.",
    );
  });

  it("gives no such note when the quote is held for something else, though its contact is held", () => {
    const view = describeQuoteAct(
      facts({
        contact: { name: "Nora Quinn", actContactId: null, actCreateInFlightAt: new Date("2026-10-12T23:05:00.000Z") },
        row: row({ blockedReason: NO_CONTACT_REASON }),
      }),
      NOW,
    );
    expect(view?.adminNote).toBeNull();
  });
});

describe("describeQuoteAct: in ACT!", () => {
  it("says what is there: contact, opportunity, amount by revision, History", () => {
    const view = describeQuoteAct(
      facts({
        actOpportunityId: "opp",
        line: { revision: 1, label: "Q-AU-2026-014-R1", total: "125000.50" },
        row: row({ completedAt: NOW, revision: { revision: 1, label: "Q-AU-2026-014-R1", actHistoryId: "h" } }),
      }),
      NOW,
    );
    expect(view).toEqual({
      state: "in-act",
      tone: "ok",
      headline: "In ACT!",
      detail: null,
      facts: [
        { label: "Contact", value: "Nora Quinn" },
        { label: "Opportunity", value: '"Q-AU-2026-014 AUD"' },
        { label: "Amount", value: "$125,000.50, from Q-AU-2026-014-R1" },
        { label: "History", value: "Q-AU-2026-014-R1 is recorded in the contact's history" },
      ],
      lastError: null,
      adminNote: null,
    });
  });

  it("a won deal and a promoted contact, said as what PathQuote did", () => {
    const actContactId = "c0ffee00-0000-4000-8000-000000000001";
    const view = describeQuoteAct(
      facts({
        currencySymbol: "A$",
        actOpportunityId: "opp",
        // Midday UTC: formatDateAU reads the host's zone, as the Signing card's dates do.
        actOpportunityWonAt: new Date("2026-10-12T12:00:00.000Z"),
        actContactPromotedForId: actContactId,
        line: { revision: 2, label: "Q-AU-2026-014-R2", total: "9000" },
        row: row({ completedAt: NOW, revision: { revision: 2, label: "Q-AU-2026-014-R2", actHistoryId: "h" } }),
      }),
      NOW,
    );
    expect(view?.facts).toEqual([
      { label: "Contact", value: "Nora Quinn — made a Customer when the client signed, if they were a Prospect" },
      { label: "Opportunity", value: '"Q-AU-2026-014 AUD" — marked Won by PathQuote on 12/10/2026' },
      { label: "Amount", value: "A$9,000, from Q-AU-2026-014-R2" },
      { label: "History", value: "Q-AU-2026-014-R2 is recorded in the contact's history" },
    ]);
  });

  it("an amount left alone because the deal in ACT! is closed says so, with an older figure or none", () => {
    const skipped = row({
      completedAt: NOW,
      productLineSkippedAt: NOW,
      revision: { revision: 2, label: "Q-AU-2026-014-R2", actHistoryId: "h" },
    });
    expect(
      describeQuoteAct(facts({ actOpportunityId: "opp", line: { revision: 1, label: "Q-AU-2026-014-R1", total: "100" }, row: skipped }), NOW)
        ?.facts.find((fact) => fact.label === "Amount"),
    ).toEqual({
      label: "Amount",
      value: "$100, from Q-AU-2026-014-R1 — left as it was for Q-AU-2026-014-R2, because the deal in ACT! is closed",
    });
    expect(describeQuoteAct(facts({ actOpportunityId: "opp", row: skipped }), NOW)?.facts.find((fact) => fact.label === "Amount")).toEqual({
      label: "Amount",
      value: "Not written — the deal in ACT! is closed, so PathQuote left its amount alone",
    });
  });

  it("names nothing it has no record of: a contact without an ACT! id, an unjournaled revision", () => {
    const view = describeQuoteAct(
      facts({ contact: { name: "Nora Quinn", actContactId: null, actCreateInFlightAt: null }, row: row({ completedAt: NOW }) }),
      NOW,
    );
    expect(view?.facts).toEqual([]);
  });
});

describe("describeQuoteAct: not sent", () => {
  it("reads as not sent, not as in ACT!, and says how it comes back", () => {
    expect(describeQuoteAct(facts({ row: row({ completedAt: NOW, blockedBy: BLOCKED_BY.admin }) }), NOW)).toEqual({
      state: "not-sent",
      tone: "ok",
      headline: "Not sent to ACT! — an administrator chose not to",
      detail: "If this quote is finalised, signed or accepted again, it is queued for ACT! and sent as usual.",
      facts: [],
      lastError: null,
      adminNote: null,
    });
  });

  it("says what had gone before stays there, when something had", () => {
    expect(
      describeQuoteAct(facts({ actOpportunityId: "opp", row: row({ completedAt: NOW, blockedBy: BLOCKED_BY.admin }) }), NOW)?.detail,
    ).toBe(
      "What had already gone to ACT! for it before then stays there. If this quote is finalised, signed or accepted again, it is queued for ACT! and sent as usual.",
    );
  });
});

describe("inAbout", () => {
  it("rounds the way relativeTime does, in the other direction", () => {
    expect(inAbout(new Date(NOW.getTime() + 20_000), NOW)).toBe("in a moment");
    expect(inAbout(new Date(NOW.getTime() + 60_000), NOW)).toBe("in about 1 minute");
    expect(inAbout(new Date(NOW.getTime() + 5 * 3600_000), NOW)).toBe("in about 5 hours");
    expect(inAbout(new Date(NOW.getTime() + 3 * 86400_000), NOW)).toBe("in about 3 days");
  });
});

describe("adminHelpFor", () => {
  it("Try again now says, for a refusal, that it sends the same thing and ACT! must be put right first", () => {
    expect(adminHelpFor({ blockedBy: BLOCKED_BY.act, contactName: null, number: null }).tryAgain).toEqual({
      label: "Try again now",
      help: "Sends ACT! the same thing again, now. ACT! said no last time, and it will say no again unless what it objected to has been put right in ACT! first.",
    });
    expect(adminHelpFor({ blockedBy: BLOCKED_BY.revision, contactName: null, number: null }).tryAgain.help).toBe(
      "Reads this quote's finalised copy again and sends it, now. That copy does not change, so this only helps once your developer has put right what the reason above describes.",
    );
    expect(adminHelpFor({ blockedBy: BLOCKED_BY.drain, contactName: null, number: null }).tryAgain.help).toBe(
      "Looks in ACT! again now, rather than at PathQuote's next check. It goes on only once the extra records named above have been removed in ACT!.",
    );
  });

  it("the contact actions name the person, and ACT! has nobody warns of a second copy", () => {
    const help = adminHelpFor({ blockedBy: null, contactName: "Nora Quinn", number: "Q-AU-2026-014" });
    expect(help.contactFound).toEqual({
      label: "ACT! has this person",
      help: "Choose this once you have found Nora Quinn in ACT!. Enter their ACT! contact id, and PathQuote links this contact to that person and carries on with every quote on it. If you do not have the id, your developer can find it in PathQuote's log when ACT! sent one back.",
      field: "ACT! contact id",
      submit: "Link to this ACT! contact",
    });
    expect(help.contactAbsent).toEqual({
      label: "ACT! has nobody",
      help: "Choose this only once you have looked in ACT! and Nora Quinn is not there. PathQuote then creates them in ACT! at its next send. If ACT! does have them, this puts the same person in ACT! twice.",
      confirm: {
        title: "Create Nora Quinn in ACT!?",
        description:
          "Only if you have looked in ACT! and Nora Quinn is not there. If they are, this puts a second copy of the same person in ACT!, and PathQuote cannot take it out again.",
        confirmLabel: "Create them in ACT!",
      },
    });
  });

  it("Don't send says what a later event does, and asks first", () => {
    expect(adminHelpFor({ blockedBy: null, contactName: null, number: "Q-AU-2026-014" }).dontSend).toEqual({
      label: "Don't send this quote to ACT!",
      help: "Takes this quote out of the queue for ACT! — a test quote, say. Whatever has already gone to ACT! stays there. If the quote is finalised, signed or accepted again later, it is queued again and goes to ACT! as usual.",
      confirm: {
        title: "Don't send Q-AU-2026-014 to ACT!?",
        description:
          "PathQuote stops trying to send this quote to ACT!. Nothing on this page undoes that — only finalising, signing or accepting the quote again queues it again.",
        confirmLabel: "Don't send",
      },
    });
  });
});

describe("adminDoneMessage", () => {
  it("says when it goes, with sending on and off", () => {
    expect(adminDoneMessage("tryAgain", true)).toBe(
      "Released — it goes to ACT! now, or within 15 minutes if another send is under way.",
    );
    expect(adminDoneMessage("tryAgain", false)).toBe("Released — it goes to ACT! once sending is switched on.");
    expect(adminDoneMessage("contactFound", true)).toBe(
      "Linked — this quote goes on to ACT! now, or within 15 minutes if another send is under way, and any other quote held for this contact within 15 minutes.",
    );
    expect(adminDoneMessage("contactFound", false)).toBe(
      "Linked — this quote, and any other held for this contact, go on to ACT! once sending is switched on.",
    );
    expect(adminDoneMessage("contactAbsent", true)).toBe(
      "Released — PathQuote creates them in ACT! now, or within 15 minutes if another send is under way.",
    );
    expect(adminDoneMessage("dontSend", true)).toBe("Taken out of the queue for ACT!.");
  });
});
