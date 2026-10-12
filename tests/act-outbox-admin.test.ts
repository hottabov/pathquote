import { describe, it, expect } from "vitest";
import {
  ACT_LOOKUP_FAILED_ERROR,
  ACT_UNREACHABLE_ERROR,
  BAD_ACT_ID_ERROR,
  CONTACT_NOT_HELD_ERROR,
  NO_ROW_ERROR,
  ROW_CHANGED_ERROR,
  actContactCheck,
  actLookupFailure,
  adminActionsFor,
  contactAbsentDecision,
  contactFoundDecision,
  dontSendDecision,
  duplicateContactError,
  heldForContact,
  heldForContactRelease,
  parseActContactId,
  tryAgainDecision,
  type AdminContact,
  type AdminRow,
} from "../src/lib/act/outbox-admin";
import { BLOCKED_BY, refusedReason } from "../src/lib/act/drain-rules";
import {
  NO_CONTACT_REASON,
  UNTRACKED_CONTACT_REASON,
  unmappedRegionReason,
} from "../src/lib/act/outbox-plan";
import { ActApiError, ActNoAnswerError, ActNotSentError } from "../src/lib/act/client";

const NOW = new Date("2026-10-13T03:00:00.000Z");
const ACT_ID = "2f6c1a9e-4b7d-4c2e-9a51-0d3e8f7b6a10";

function row(overrides: Partial<AdminRow> = {}): AdminRow {
  return { id: "row1", generation: 4, completedAt: null, blockedReason: null, blockedBy: null, ...overrides };
}

/** A contact whose create went unaccounted for: marked, no ACT! id. */
function heldContact(overrides: Partial<AdminContact> = {}): AdminContact {
  return { id: "contact1", actContactId: null, actCreateInFlightAt: new Date("2026-10-12T23:05:00.000Z"), ...overrides };
}

const refused = refusedReason("create-opportunity", 400, '{"Message":"Bad stage"}');
const heldRow = row({ blockedReason: UNTRACKED_CONTACT_REASON, blockedBy: BLOCKED_BY.contact });
/** The contact's hold, its sentence reworded since: the blocker is what says what it is. */
const REWORDED = "PathQuote lost track of whether ACT! made this contact — an administrator settles it on this quote's page.";

describe("adminActionsFor: what the page offers", () => {
  it("nothing for a quote with no row, or a finished one", () => {
    const none = { tryAgain: false, contactFound: false, contactAbsent: false, dontSend: false };
    expect(adminActionsFor(null, null)).toEqual(none);
    expect(adminActionsFor(row({ completedAt: NOW }), null)).toEqual(none);
    expect(adminActionsFor(row({ completedAt: NOW, blockedBy: BLOCKED_BY.admin }), null)).toEqual(none);
  });

  it("only Don't send for a row that is waiting", () => {
    expect(adminActionsFor(row(), heldContact())).toEqual({
      tryAgain: false,
      contactFound: false,
      contactAbsent: false,
      dontSend: true,
    });
  });

  it("Try again now for a row held by ACT!, its revision or a lookup's duplicates -- not by the planner or its contact", () => {
    for (const blockedBy of [BLOCKED_BY.act, BLOCKED_BY.revision, BLOCKED_BY.drain]) {
      expect(adminActionsFor(row({ blockedReason: refused, blockedBy }), null).tryAgain).toBe(true);
    }
    expect(adminActionsFor(row({ blockedReason: NO_CONTACT_REASON, blockedBy: null }), null).tryAgain).toBe(false);
    // Held for its contact: the contact actions settle it, and the drain lets it go.
    expect(adminActionsFor(heldRow, heldContact()).tryAgain).toBe(false);
    expect(tryAgainDecision(heldRow, NOW)).toEqual({ ok: false, error: ROW_CHANGED_ERROR });
    // A value nothing here knows is left for a person who does.
    expect(adminActionsFor(row({ blockedReason: refused, blockedBy: "mystery" }), null).tryAgain).toBe(false);
  });

  it("the two contact actions only while the quote is held and its contact still held", () => {
    expect(adminActionsFor(heldRow, heldContact())).toEqual({
      tryAgain: false,
      contactFound: true,
      contactAbsent: true,
      dontSend: true,
    });
    // An ACT! id already: settled.
    expect(adminActionsFor(heldRow, heldContact({ actContactId: ACT_ID })).contactFound).toBe(false);
    // The marker gone: released.
    expect(adminActionsFor(heldRow, heldContact({ actCreateInFlightAt: null })).contactFound).toBe(false);
    // The marker set but the row not blocked: a create may be in flight this very second.
    expect(adminActionsFor(row(), heldContact()).contactAbsent).toBe(false);
    // Held by ACT!, not by the planner: the contact is not what holds it.
    expect(adminActionsFor(row({ blockedReason: refused, blockedBy: BLOCKED_BY.act }), heldContact()).contactAbsent).toBe(false);
  });

  it("only for a quote held for exactly that: not one the planner holds for its region first", () => {
    expect(heldForContact(heldRow, heldContact())).toBe(true);
    expect(heldForContact(row({ blockedReason: unmappedRegionReason("ZZ") }), heldContact())).toBe(false);
  });

  it("knows the hold by its blocker, never by its sentence", () => {
    // Reworded: still held for its contact, and offered both actions.
    const reworded = row({ blockedReason: REWORDED, blockedBy: BLOCKED_BY.contact });
    expect(heldForContact(reworded, heldContact())).toBe(true);
    expect(adminActionsFor(reworded, heldContact())).toMatchObject({ contactFound: true, contactAbsent: true });
    expect(contactAbsentDecision(reworded, heldContact()).ok).toBe(true);
    expect(contactFoundDecision({ row: reworded, contact: heldContact(), actContactId: ACT_ID, duplicate: null }).ok).toBe(true);
    // The sentence word for word, but not blocked as the contact's: not that hold.
    expect(heldForContact(row({ blockedReason: UNTRACKED_CONTACT_REASON, blockedBy: null }), heldContact())).toBe(false);
    expect(heldForContact(row({ blockedReason: UNTRACKED_CONTACT_REASON, blockedBy: BLOCKED_BY.drain }), heldContact())).toBe(false);
  });
});

describe("tryAgainDecision", () => {
  it("clears the hold, resets attempts and lastError, makes it due -- guarded, and moves the generation on", () => {
    expect(tryAgainDecision(row({ blockedReason: refused, blockedBy: BLOCKED_BY.act }), NOW)).toEqual({
      ok: true,
      write: {
        where: { id: "row1", generation: 4, completedAt: null },
        data: { blockedReason: null, blockedBy: null, attempts: 0, lastError: null, nextAttemptAt: NOW, generation: 5 },
      },
    });
  });

  it("leaves what the row got done, and a create in flight, as they are", () => {
    const decision = tryAgainDecision(row({ blockedReason: refused, blockedBy: BLOCKED_BY.drain }), NOW);
    if (!decision.ok) throw new Error("expected the decision to allow it");
    for (const kept of ["opportunityActId", "productLineSkippedAt", "createInFlight", "completedAt", "quoteRevisionId"]) {
      expect(decision.write.data).not.toHaveProperty(kept);
    }
  });

  it("refuses a row that is not held that way any more, or no row", () => {
    expect(tryAgainDecision(null, NOW)).toEqual({ ok: false, error: NO_ROW_ERROR });
    expect(tryAgainDecision(row(), NOW)).toEqual({ ok: false, error: ROW_CHANGED_ERROR });
    expect(tryAgainDecision(row({ blockedReason: NO_CONTACT_REASON }), NOW)).toEqual({ ok: false, error: ROW_CHANGED_ERROR });
    expect(
      tryAgainDecision(row({ blockedReason: refused, blockedBy: BLOCKED_BY.act, completedAt: NOW }), NOW),
    ).toEqual({ ok: false, error: ROW_CHANGED_ERROR });
  });
});

describe("dontSendDecision", () => {
  it("finishes any unfinished row as not sent -- guarded, generation moved on", () => {
    for (const unfinished of [row(), heldRow, row({ blockedReason: refused, blockedBy: BLOCKED_BY.act })]) {
      expect(dontSendDecision(unfinished, NOW)).toEqual({
        ok: true,
        write: {
          where: { id: "row1", generation: 4, completedAt: null },
          data: { completedAt: NOW, blockedBy: BLOCKED_BY.admin, blockedReason: null, generation: 5 },
        },
      });
    }
  });

  it("refuses a finished row and no row", () => {
    expect(dontSendDecision(row({ completedAt: NOW }), NOW)).toEqual({ ok: false, error: ROW_CHANGED_ERROR });
    expect(dontSendDecision(null, NOW)).toEqual({ ok: false, error: NO_ROW_ERROR });
  });
});

describe("parseActContactId", () => {
  it("takes a uuid, trimmed and lowercased", () => {
    expect(parseActContactId(` ${ACT_ID.toUpperCase()}\n`)).toBe(ACT_ID);
  });

  it("refuses anything else", () => {
    for (const text of ["", "Nora Quinn", ACT_ID.slice(1), `${ACT_ID}0`, ACT_ID.replace(/-/g, ""), "g".repeat(8) + ACT_ID.slice(8)]) {
      expect(parseActContactId(text)).toBeNull();
    }
  });
});

describe("contactFoundDecision", () => {
  it("writes the id, SYNCED and the marker cleared, guarded on the very marker read still being there", () => {
    expect(
      contactFoundDecision({ row: heldRow, contact: heldContact(), actContactId: ` ${ACT_ID.toUpperCase()}`, duplicate: null }),
    ).toEqual({
      ok: true,
      write: {
        where: { id: "contact1", actCreateInFlightAt: new Date("2026-10-12T23:05:00.000Z"), actContactId: null },
        data: { actContactId: ACT_ID, actSyncState: "SYNCED", actCreateInFlightAt: null },
      },
    });
  });

  it("refuses an id that is not a uuid before anything else", () => {
    expect(contactFoundDecision({ row: null, contact: null, actContactId: "nope", duplicate: null })).toEqual({
      ok: false,
      error: BAD_ACT_ID_ERROR,
    });
    expect(BAD_ACT_ID_ERROR).toBe(
      "That is not an ACT! contact id. It is 36 characters: letters a to f and digits in five groups joined by dashes, like 2f6c1a9e-4b7d-4c2e-9a51-0d3e8f7b6a10.",
    );
  });

  it("refuses a contact that is no longer held", () => {
    for (const contact of [heldContact({ actContactId: ACT_ID }), heldContact({ actCreateInFlightAt: null }), null]) {
      expect(contactFoundDecision({ row: heldRow, contact, actContactId: ACT_ID, duplicate: null })).toEqual({
        ok: false,
        error: CONTACT_NOT_HELD_ERROR,
      });
    }
  });

  it("refuses when another contact carries the id, naming it, and does not merge", () => {
    const decision = contactFoundDecision({
      row: heldRow,
      contact: heldContact(),
      actContactId: ACT_ID,
      duplicate: { name: "Nora Quinn", companyName: "Fielding Signs" },
    });
    expect(decision).toEqual({
      ok: false,
      error:
        "Nora Quinn at Fielding Signs is already in PathQuote with ACT! id 2f6c1a9e-4b7d-4c2e-9a51-0d3e8f7b6a10 — most likely the same person, brought across from ACT! by a sync. PathQuote cannot give one ACT! id to two contacts, so the two have to be merged first: ask your developer to merge them, then this quote carries on.",
    });
    expect(duplicateContactError(ACT_ID, { name: "Nora Quinn", companyName: "Fielding Signs" })).toBe(
      (decision as { error: string }).error,
    );
  });
});

describe("contactAbsentDecision", () => {
  it("clears the marker, guarded on the contact still having no ACT! id and on the marker read", () => {
    expect(contactAbsentDecision(heldRow, heldContact())).toEqual({
      ok: true,
      write: {
        where: { id: "contact1", actContactId: null, actCreateInFlightAt: new Date("2026-10-12T23:05:00.000Z") },
        data: { actCreateInFlightAt: null },
      },
    });
  });

  it("refuses when the contact is not held, or the quote is not held for it", () => {
    expect(contactAbsentDecision(heldRow, heldContact({ actContactId: ACT_ID }))).toEqual({ ok: false, error: CONTACT_NOT_HELD_ERROR });
    expect(contactAbsentDecision(row(), heldContact())).toEqual({ ok: false, error: CONTACT_NOT_HELD_ERROR });
    expect(contactAbsentDecision(null, heldContact())).toEqual({ ok: false, error: NO_ROW_ERROR });
  });
});

describe("heldForContactRelease", () => {
  it("makes due every row held for the contact, each guarded with its own generation", () => {
    const rows = [
      row({ id: "a", generation: 0, blockedReason: UNTRACKED_CONTACT_REASON, blockedBy: BLOCKED_BY.contact }),
      row({ id: "b", generation: 7, blockedReason: UNTRACKED_CONTACT_REASON, blockedBy: BLOCKED_BY.contact }),
    ];
    expect(heldForContactRelease(rows, NOW)).toEqual([
      {
        where: { id: "a", generation: 0, completedAt: null },
        data: { blockedReason: null, blockedBy: null, nextAttemptAt: NOW, generation: 1 },
      },
      {
        where: { id: "b", generation: 7, completedAt: null },
        data: { blockedReason: null, blockedBy: null, nextAttemptAt: NOW, generation: 8 },
      },
    ]);
  });

  it("releases a row whose sentence has been reworded too: the blocker says it is held for the contact", () => {
    const rows = [row({ id: "reworded", generation: 2, blockedReason: REWORDED, blockedBy: BLOCKED_BY.contact })];
    expect(heldForContactRelease(rows, NOW).map((write) => write.where.id)).toEqual(["reworded"]);
  });

  it("leaves rows held for anything else, rows ACT! refused, waiting rows and finished ones", () => {
    const rows = [
      row({ id: "region", blockedReason: unmappedRegionReason("ZZ") }),
      row({ id: "act", blockedReason: UNTRACKED_CONTACT_REASON, blockedBy: BLOCKED_BY.act }),
      // The sentence alone, stored as the planner's: not held for the contact.
      row({ id: "sentence", blockedReason: UNTRACKED_CONTACT_REASON, blockedBy: null }),
      row({ id: "waiting" }),
      row({ id: "done", completedAt: NOW, blockedReason: UNTRACKED_CONTACT_REASON, blockedBy: BLOCKED_BY.contact }),
    ];
    expect(heldForContactRelease(rows, NOW)).toEqual([]);
  });
});

describe("actLookupFailure: what an error asking ACT! for the contact means", () => {
  it("a 404 is ACT! having no such contact", () => {
    expect(actLookupFailure(new ActApiError("GET failed (404)", "GET", 404, "", "refused"))).toEqual({ kind: "missing" });
  });

  it("no answer, nothing sent, a 5xx, a 408 or a 429 is worth trying again", () => {
    for (const error of [
      new ActNoAnswerError("GET /api/contacts/x", 3, "timed out"),
      new ActNotSentError("GET /api/contacts/x", "connection refused"),
      new ActApiError("GET failed (503)", "GET", 503, "", "failed"),
      new ActApiError("GET failed (429)", "GET", 429, "", "failed"),
      new ActApiError("GET failed (408)", "GET", 408, "", "failed"),
    ]) {
      expect(actLookupFailure(error)).toEqual({ kind: "unreachable" });
    }
  });

  it("anything else -- a 401, a 403, PathQuote's own setup -- is not mended by waiting", () => {
    for (const error of [
      new ActApiError("authorize failed (401)", "GET", 401, "", "refused", { authorizing: true }),
      new ActApiError("GET failed (403)", "GET", 403, "{}", "refused"),
      new Error("missing environment: ACT_PASS"),
    ]) {
      expect(actLookupFailure(error)).toEqual({ kind: "failed" });
    }
  });
});

describe("actContactCheck: the typed id against what ACT! holds", () => {
  const held = { firstName: "Nora", lastName: "Quinn", email: "nora@fielding.example" };
  const found = (over: Partial<{ firstName: string | null; lastName: string | null; email: string | null }> = {}) => ({
    kind: "found" as const,
    firstName: "Nora",
    lastName: "Quinn",
    email: "nora@fielding.example",
    ...over,
  });

  it("refuses an id ACT! has no contact for, naming the id", () => {
    expect(actContactCheck({ actContactId: ACT_ID, lookup: { kind: "missing" }, held })).toBe(
      "ACT! has no contact with the id 2f6c1a9e-4b7d-4c2e-9a51-0d3e8f7b6a10, so nothing was linked. Copy the id from the person's record in ACT! again, and check it is a contact's id rather than a company's or an opportunity's.",
    );
  });

  it("refuses when ACT! cannot be asked -- an unconfirmed id is never written", () => {
    expect(actContactCheck({ actContactId: ACT_ID, lookup: { kind: "unreachable" }, held })).toBe(ACT_UNREACHABLE_ERROR);
    expect(ACT_UNREACHABLE_ERROR).toBe(
      "PathQuote could not reach ACT! to check that id, so nothing was linked. Try again in a few minutes.",
    );
    expect(actContactCheck({ actContactId: ACT_ID, lookup: { kind: "failed" }, held })).toBe(ACT_LOOKUP_FAILED_ERROR);
    expect(ACT_LOOKUP_FAILED_ERROR).toBe(
      "PathQuote could not read that contact from ACT! to check it, so nothing was linked. Ask your developer — PathQuote's log says what ACT! answered.",
    );
  });

  it("links when both match, or either one alone -- case and spacing aside", () => {
    expect(actContactCheck({ actContactId: ACT_ID, lookup: found(), held })).toBeNull();
    // The email changed in ACT! since: the name still says it is them.
    expect(actContactCheck({ actContactId: ACT_ID, lookup: found({ email: "nq@new.example" }), held })).toBeNull();
    // ACT! has no email for them.
    expect(actContactCheck({ actContactId: ACT_ID, lookup: found({ email: null }), held })).toBeNull();
    // Spelt differently in ACT!: the email says it is them.
    expect(actContactCheck({ actContactId: ACT_ID, lookup: found({ firstName: "Norah" }), held })).toBeNull();
    expect(
      actContactCheck({ actContactId: ACT_ID, lookup: found({ firstName: " nora ", lastName: "QUINN", email: null }), held }),
    ).toBeNull();
    expect(
      actContactCheck({ actContactId: ACT_ID, lookup: found({ firstName: "X", email: " NORA@Fielding.example " }), held }),
    ).toBeNull();
  });

  it("refuses when neither the name nor the email matches, showing both", () => {
    expect(
      actContactCheck({
        actContactId: ACT_ID,
        lookup: found({ firstName: "Peter", lastName: "Hale", email: "peter@hale.example" }),
        held,
      }),
    ).toBe(
      "The ACT! contact with that id is Peter Hale (peter@hale.example), but this quote's contact is Nora Quinn (nora@fielding.example) — neither the name nor the email matches, so nothing was linked. Check the id was copied from the right person in ACT!. If it is the same person, correct the name or the email on one side so that one of them matches, then try again.",
    );
  });

  it("two missing emails are not a match, and say so", () => {
    expect(
      actContactCheck({
        actContactId: ACT_ID,
        lookup: found({ firstName: "Peter", lastName: null, email: null }),
        held: { firstName: "Nora", lastName: null, email: null },
      }),
    ).toBe(
      "The ACT! contact with that id is Peter (no email), but this quote's contact is Nora (no email) — neither the name nor the email matches, so nothing was linked. Check the id was copied from the right person in ACT!. If it is the same person, correct the name or the email on one side so that one of them matches, then try again.",
    );
  });
});
