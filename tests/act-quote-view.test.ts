import { describe, it, expect } from "vitest";
import {
  adminDoneMessage,
  adminHelpFor,
  describeQuoteAct,
  inAbout,
  showsQuoteActCard,
  type QuoteActFacts,
  type QuoteActViewer,
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

const ADMIN: QuoteActViewer = { role: "ADMIN", actSyncVisible: false };
const DEVELOPER: QuoteActViewer = { role: "DEVELOPER", actSyncVisible: false };
/** A manager an administrator has given the ACT! sync section to. */
const MANAGER: QuoteActViewer = { role: "MANAGER", actSyncVisible: true };
/** A distributor: no ACT! licence, so no tick. */
const DISTRIBUTOR: QuoteActViewer = { role: "MANAGER", actSyncVisible: false };

/** The card as an administrator reads it -- every state, the notes included. */
function asAdmin(f: QuoteActFacts, now: Date) {
  return describeQuoteAct(f, now, ADMIN);
}

/** A revision's frozen snapshot, as far as the card reads it: the tax it charged. */
function frozen(taxAmount: string, taxName = "GST") {
  return { taxName, totals: { taxAmount } };
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
    expect(asAdmin(facts({ status: "DRAFT" }), NOW)).toBeNull();
    expect(asAdmin(facts({ status: "DRAFT", row: row({ completedAt: NOW }) }), NOW)).toBeNull();
  });

  it("shows a draft whose write is still queued -- the drain still works it, and Settings links to it", () => {
    const view = asAdmin(facts({ status: "DRAFT", row: row({ blockedReason: NO_CONTACT_REASON }) }), NOW);
    expect(view?.state).toBe("held");
    expect(view?.detail).toBe(NO_CONTACT_REASON);
  });
});

describe("describeQuoteAct: not queued", () => {
  it("a quote finalised before revisions existed: nothing to send, and signing will not send it", () => {
    const view = asAdmin(facts({ hasRevision: false }), NOW);
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
    const view = asAdmin(facts({ hasRevision: false, signingStatus: "SIGNED" }), NOW);
    expect(view?.adminNote).toBe(
      "Now that the client has signed it, it cannot be unfinalized, so only your developer can queue it for ACT!.",
    );
  });

  it("a quote finalised before sending began: says which event can still send it", () => {
    expect(asAdmin(facts(), NOW)?.detail).toBe(
      "This quote was finalised before PathQuote began sending quotes to ACT!, and has not been finalised, signed or accepted since — which is what sends a quote. If the client signs it, it goes then.",
    );
    expect(asAdmin(facts({ signingStatus: "SIGNED" }), NOW)?.detail).toBe(
      "This quote was finalised before PathQuote began sending quotes to ACT!, and has not been finalised, signed or accepted since — which is what sends a quote. If it is accepted, it goes then.",
    );
    const done = asAdmin(facts({ signingStatus: "SIGNED", acceptedAt: NOW }), NOW);
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
    expect(asAdmin(facts({ row: row() }), NOW)).toEqual({
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
    const view = asAdmin(
      facts({ sendingOn: false, row: row({ attempts: 2, lastError: "PathQuote could not reach ACT!" }) }),
      NOW,
    );
    expect(view?.detail).toBe("Sending to ACT! is switched off, so this quote waits — it goes as soon as it is switched on.");
    expect(view?.lastError).toBe("PathQuote could not reach ACT!");
  });

  it("backing off: how often it has tried, when it next tries, and lastError as written", () => {
    const lastError = "PathQuote could not create this quote's opportunity: ACT! answered 503 — Service Unavailable";
    const view = asAdmin(
      facts({ row: row({ attempts: 3, lastError, nextAttemptAt: new Date("2026-10-13T03:40:00.000Z") }) }),
      NOW,
    );
    expect(view?.detail).toBe(
      "PathQuote has tried 3 times and not got through to ACT! yet. It tries again on its own at the first send after 13 Oct 2026, 2:40 pm Melbourne time, in about 40 minutes, and keeps trying until it gets through.",
    );
    expect(view?.lastError).toBe(lastError);
    expect(view?.tone).toBe("ok");
  });

  it("failed once and due again now", () => {
    expect(asAdmin(facts({ row: row({ attempts: 1, lastError: "x", nextAttemptAt: NOW }) }), NOW)?.detail).toBe(
      "PathQuote has tried once and not got through to ACT! yet. It is due to be tried again at the next send — PathQuote sends queued quotes every 15 minutes.",
    );
  });

  it("puts no stale error beside a row that has not failed", () => {
    expect(asAdmin(facts({ row: row({ attempts: 0, lastError: "old" }) }), NOW)?.lastError).toBeNull();
  });
});

describe("describeQuoteAct: held", () => {
  it("shows the reason verbatim, amber, whoever held it", () => {
    const reason = refusedReason("promote-contact", 400, '{"Message":"Account Mgr is not in the list"}');
    for (const blockedBy of [BLOCKED_BY.act, BLOCKED_BY.revision, BLOCKED_BY.drain, null]) {
      expect(asAdmin(facts({ row: row({ blockedReason: reason, blockedBy }) }), NOW)).toEqual({
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
    const view = asAdmin(
      facts({
        contact: { name: "Nora Quinn", actContactId: null, actCreateInFlightAt: new Date("2026-10-12T23:05:00.000Z") },
        row: row({ blockedReason: UNTRACKED_CONTACT_REASON, blockedBy: BLOCKED_BY.contact }),
      }),
      NOW,
    );
    expect(view?.detail).toBe(UNTRACKED_CONTACT_REASON);
    expect(view?.adminNote).toBe(
      "Look in ACT! for Nora Quinn. If PathQuote's request reached ACT!, they were created there at about 13 Oct 2026, 10:05 am Melbourne time. Then choose one of the two below.",
    );
  });

  it("gives the note by the row's blocker, whatever its sentence says, as the actions are offered by it", () => {
    const contact = { name: "Nora Quinn", actContactId: null, actCreateInFlightAt: new Date("2026-10-12T23:05:00.000Z") };
    const reworded = "PathQuote lost track of whether ACT! made this contact — an administrator settles it on this quote's page.";
    const view = asAdmin(facts({ contact, row: row({ blockedReason: reworded, blockedBy: BLOCKED_BY.contact }) }), NOW);
    expect(view?.detail).toBe(reworded);
    expect(view?.adminNote).toMatch(/^Look in ACT! for Nora Quinn\./);
    // The sentence word for word, but not blocked as the contact's: no note.
    expect(asAdmin(facts({ contact, row: row({ blockedReason: UNTRACKED_CONTACT_REASON }) }), NOW)?.adminNote).toBeNull();
  });

  it("gives no such note when the quote is held for something else, though its contact is held", () => {
    const view = asAdmin(
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
    const view = asAdmin(
      facts({
        actOpportunityId: "opp",
        line: { revision: 1, label: "Q-AU-2026-014-R1", total: "137500.55", snapshot: frozen("12500.05") },
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
        { label: "Amount", value: "$125,000.50 ex GST, from Q-AU-2026-014-R1" },
        { label: "History", value: "Q-AU-2026-014-R1 is recorded in the contact's history" },
      ],
      lastError: null,
      adminNote: null,
    });
  });

  it("a won deal and a promoted contact, said as what PathQuote did", () => {
    const actContactId = "c0ffee00-0000-4000-8000-000000000001";
    const view = asAdmin(
      facts({
        currencySymbol: "A$",
        actOpportunityId: "opp",
        // Midday UTC: formatDateAU reads the host's zone, as the Signing card's dates do.
        actOpportunityWonAt: new Date("2026-10-12T12:00:00.000Z"),
        actContactPromotedForId: actContactId,
        line: { revision: 2, label: "Q-AU-2026-014-R2", total: "9900", snapshot: frozen("900") },
        row: row({ completedAt: NOW, revision: { revision: 2, label: "Q-AU-2026-014-R2", actHistoryId: "h" } }),
      }),
      NOW,
    );
    expect(view?.facts).toEqual([
      { label: "Contact", value: "Nora Quinn — made a Customer when the client signed, if they were a Prospect" },
      { label: "Opportunity", value: '"Q-AU-2026-014 AUD" — marked Won by PathQuote on 12/10/2026' },
      { label: "Amount", value: "A$9,000 ex GST, from Q-AU-2026-014-R2" },
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
      asAdmin(
        facts({ actOpportunityId: "opp", line: { revision: 1, label: "Q-AU-2026-014-R1", total: "110", snapshot: frozen("10") }, row: skipped }),
        NOW,
      )
        ?.facts.find((fact) => fact.label === "Amount"),
    ).toEqual({
      label: "Amount",
      value: "$100 ex GST, from Q-AU-2026-014-R1 — left as it was for Q-AU-2026-014-R2, because the deal in ACT! is closed",
    });
    expect(asAdmin(facts({ actOpportunityId: "opp", row: skipped }), NOW)?.facts.find((fact) => fact.label === "Amount")).toEqual({
      label: "Amount",
      value: "Not written — the deal in ACT! is closed, so PathQuote left its amount alone",
    });
  });

  it("shows the line's amount before tax, as ACT! has it: the total itself where no tax was charged", () => {
    const amount = (line: QuoteActFacts["line"], currency = "AUD") =>
      asAdmin(
        facts({
          currency,
          actOpportunityId: "opp",
          line,
          row: row({ completedAt: NOW, revision: { revision: 1, label: line!.label, actHistoryId: "h" } }),
        }),
        NOW,
      )?.facts.find((fact) => fact.label === "Amount")?.value;
    expect(amount({ revision: 1, label: "Q-AU-2026-014-R1", total: "49500", snapshot: frozen("4500") })).toBe(
      "$45,000 ex GST, from Q-AU-2026-014-R1",
    );
    expect(amount({ revision: 1, label: "Q-US-2026-003-R1", total: "30000", snapshot: frozen("0", "Sales Tax") }, "USD")).toBe(
      // Intl puts a no-break space after the code.
      "USD\u00a030,000 ex Sales Tax, from Q-US-2026-003-R1",
    );
    // Never the tax-inclusive total in its place: a revision the drain could
    // not have written a line from is named without a figure.
    expect(amount({ revision: 1, label: "Q-AU-2026-014-R1", total: "49500", snapshot: {} })).toBe(
      "Q-AU-2026-014-R1's amount before tax",
    );
  });

  it("names nothing it has no record of: a contact without an ACT! id, an unjournaled revision", () => {
    const view = asAdmin(
      facts({ contact: { name: "Nora Quinn", actContactId: null, actCreateInFlightAt: null }, row: row({ completedAt: NOW }) }),
      NOW,
    );
    expect(view?.facts).toEqual([]);
  });
});

describe("describeQuoteAct: not sent", () => {
  it("reads as not sent, not as in ACT!, and says how it comes back", () => {
    expect(asAdmin(facts({ row: row({ completedAt: NOW, blockedBy: BLOCKED_BY.admin }) }), NOW)).toEqual({
      state: "not-sent",
      tone: "ok",
      headline: "Not sent to ACT! — an administrator chose not to",
      detail: "If the client signs it, or it is unfinalized and finalised again, it is queued for ACT! again and sent as usual.",
      facts: [],
      lastError: null,
      adminNote: null,
    });
  });

  it("says what had gone before stays there, when something had", () => {
    expect(
      asAdmin(facts({ actOpportunityId: "opp", row: row({ completedAt: NOW, blockedBy: BLOCKED_BY.admin }) }), NOW)?.detail,
    ).toBe(
      "What had already gone to ACT! for it before then stays there. If the client signs it, or it is unfinalized and finalised again, it is queued for ACT! again and sent as usual.",
    );
  });

  it("says only what can still queue it: a signed quote by its acceptance, a signed and accepted one by nothing", () => {
    const stopped = row({ completedAt: NOW, blockedBy: BLOCKED_BY.admin });
    expect(asAdmin(facts({ signingStatus: "SIGNED", row: stopped }), NOW)?.detail).toBe(
      "If it is accepted, it is queued for ACT! again and sent as usual.",
    );
    expect(asAdmin(facts({ signingStatus: "SIGNED", acceptedAt: NOW, row: stopped }), NOW)?.detail).toBe(
      "It is signed and accepted, so nothing left to happen to it queues it again — if it has to go to ACT! after all, ask your developer.",
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

/** Where the quote stands, for adminHelpFor: FINAL, sent for signing, not signed. */
const QUOTE = { status: "FINAL", signingStatus: "SENT", acceptedAt: null };

describe("adminHelpFor", () => {
  it("Try again now says, for a refusal, that it sends the same thing and ACT! must be put right first", () => {
    expect(adminHelpFor({ ...QUOTE, blockedBy: BLOCKED_BY.act, contactName: null, number: null }).tryAgain).toEqual({
      label: "Try again now",
      help: "Sends ACT! the same thing again, now. ACT! said no last time, and it will say no again unless what it objected to has been put right in ACT! first.",
    });
    expect(adminHelpFor({ ...QUOTE, blockedBy: BLOCKED_BY.revision, contactName: null, number: null }).tryAgain.help).toBe(
      "Reads this quote's finalised copy again and sends it, now. That copy does not change, so this only helps once your developer has put right what the reason above describes.",
    );
    expect(adminHelpFor({ ...QUOTE, blockedBy: BLOCKED_BY.drain, contactName: null, number: null }).tryAgain.help).toBe(
      "Looks in ACT! again now, rather than at PathQuote's next check. It goes on only once the extra records named above have been removed in ACT!.",
    );
  });

  it("the contact actions name the person, and ACT! has nobody warns of a second copy", () => {
    const help = adminHelpFor({ ...QUOTE, blockedBy: null, contactName: "Nora Quinn", number: "Q-AU-2026-014" });
    expect(help.contactFound).toEqual({
      label: "ACT! has this person",
      help: "Choose this once you have found Nora Quinn in ACT!. Enter their ACT! contact id. PathQuote first asks ACT! for that contact, and links nothing unless ACT! has it and its name or its email matches Nora Quinn's; then it links this contact to that person and carries on with every quote on it. If you do not have the id, your developer can find it in PathQuote's log when ACT! sent one back.",
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

  it("Don't send says what can still queue the quote again, and asks first", () => {
    expect(adminHelpFor({ ...QUOTE, blockedBy: null, contactName: null, number: "Q-AU-2026-014" }).dontSend).toEqual({
      label: "Don't send this quote to ACT!",
      help: "Takes this quote out of the queue for ACT! — a test quote, say. Whatever has already gone to ACT! stays there. If the client signs it, or it is unfinalized and finalised again, it is queued for ACT! again and sent as usual.",
      confirm: {
        title: "Don't send Q-AU-2026-014 to ACT!?",
        description:
          "PathQuote stops trying to send this quote to ACT!, and nothing on this page undoes that. If the client signs it, or it is unfinalized and finalised again, it is queued for ACT! again and sent as usual.",
        confirmLabel: "Don't send",
      },
    });
  });

  it("Don't send on a quote signed and accepted says nothing will queue it again", () => {
    const help = adminHelpFor({ status: "FINAL", signingStatus: "SIGNED", acceptedAt: NOW, blockedBy: null, contactName: null, number: null });
    expect(help.dontSend.confirm.description).toBe(
      "PathQuote stops trying to send this quote to ACT!, and nothing on this page undoes that. It is signed and accepted, so nothing left to happen to it queues it again — if it has to go to ACT! after all, ask your developer.",
    );
    expect(adminHelpFor({ status: "DRAFT", signingStatus: "NOT_SENT", acceptedAt: null, blockedBy: null, contactName: null, number: null }).dontSend.help).toBe(
      "Takes this quote out of the queue for ACT! — a test quote, say. Whatever has already gone to ACT! stays there. If it is finalised, it is queued for ACT! again and sent as usual.",
    );
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

  it("promises no time when the switch could not be read after the write", () => {
    expect(adminDoneMessage("tryAgain", null)).toBe("Released — it goes to ACT! at the next send.");
    expect(adminDoneMessage("contactFound", null)).toBe(
      "Linked — this quote, and any other held for this contact, go on to ACT! at the next send.",
    );
    expect(adminDoneMessage("contactAbsent", null)).toBe("Released — PathQuote creates them in ACT! at the next send.");
  });
});

describe("who gets the card (decision: the card is for people with ACT! access)", () => {
  it("showsQuoteActCard is canSeeActSync: admins and developers always, anybody else only with the tick", () => {
    expect(showsQuoteActCard(ADMIN)).toBe(true);
    expect(showsQuoteActCard(DEVELOPER)).toBe(true);
    expect(showsQuoteActCard(MANAGER)).toBe(true);
    expect(showsQuoteActCard(DISTRIBUTOR)).toBe(false);
    expect(showsQuoteActCard({ role: "REGIONAL_MANAGER", actSyncVisible: false })).toBe(false);
  });

  it("a distributor reads no card in any state -- their quote is queued and sent all the same", () => {
    const states: QuoteActFacts[] = [
      facts(),
      facts({ row: row() }),
      facts({ row: row({ blockedReason: NO_CONTACT_REASON }) }),
      facts({ row: row({ completedAt: NOW }) }),
      facts({ row: row({ completedAt: NOW, blockedBy: BLOCKED_BY.admin }) }),
    ];
    for (const f of states) {
      expect(describeQuoteAct(f, NOW, DISTRIBUTOR)).toBeNull();
      expect(describeQuoteAct(f, NOW, ADMIN)).not.toBeNull();
    }
  });
});

describe("who reads \"Not queued\" (decision: administrators only)", () => {
  it("an administrator or developer reads it; a manager with the tick reads no card for such a quote", () => {
    expect(describeQuoteAct(facts(), NOW, ADMIN)?.state).toBe("not-queued");
    expect(describeQuoteAct(facts({ hasRevision: false }), NOW, DEVELOPER)?.state).toBe("not-queued");
    expect(describeQuoteAct(facts(), NOW, MANAGER)).toBeNull();
    expect(describeQuoteAct(facts({ hasRevision: false, signingStatus: "SIGNED" }), NOW, MANAGER)).toBeNull();
  });

  it("the same manager reads every other state", () => {
    expect(describeQuoteAct(facts({ row: row() }), NOW, MANAGER)?.state).toBe("waiting");
    expect(
      describeQuoteAct(facts({ row: row({ blockedReason: UNTRACKED_CONTACT_REASON, blockedBy: BLOCKED_BY.contact }) }), NOW, MANAGER)?.state,
    ).toBe("held");
    expect(describeQuoteAct(facts({ row: row({ completedAt: NOW }) }), NOW, MANAGER)?.state).toBe("in-act");
    expect(describeQuoteAct(facts({ row: row({ completedAt: NOW, blockedBy: BLOCKED_BY.admin }) }), NOW, MANAGER)?.state).toBe(
      "not-sent",
    );
  });
});
