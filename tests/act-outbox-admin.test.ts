import { describe, it, expect } from "vitest";
import {
  BAD_ACT_ID_ERROR,
  CONTACT_NOT_HELD_ERROR,
  NO_ROW_ERROR,
  ROW_CHANGED_ERROR,
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
import { NO_CONTACT_REASON, UNTRACKED_CONTACT_REASON, unmappedRegionReason } from "../src/lib/act/outbox-plan";

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
const heldRow = row({ blockedReason: UNTRACKED_CONTACT_REASON });

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

  it("Try again now for a row held by ACT!, its revision or a lookup's duplicates -- not by the planner", () => {
    for (const blockedBy of [BLOCKED_BY.act, BLOCKED_BY.revision, BLOCKED_BY.drain]) {
      expect(adminActionsFor(row({ blockedReason: refused, blockedBy }), null).tryAgain).toBe(true);
    }
    expect(adminActionsFor(row({ blockedReason: NO_CONTACT_REASON, blockedBy: null }), null).tryAgain).toBe(false);
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
    // An older wording waits for the drain's next pass to rewrite it.
    expect(heldForContact(row({ blockedReason: "an older wording" }), heldContact())).toBe(false);
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
  it("writes the id, SYNCED and the marker cleared, guarded on the hold still being there", () => {
    expect(
      contactFoundDecision({ row: heldRow, contact: heldContact(), actContactId: ` ${ACT_ID.toUpperCase()}`, duplicate: null }),
    ).toEqual({
      ok: true,
      write: {
        where: { id: "contact1", actCreateInFlightAt: { not: null }, actContactId: null },
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
  it("clears the marker, guarded on the contact still having no ACT! id", () => {
    expect(contactAbsentDecision(heldRow, heldContact())).toEqual({
      ok: true,
      write: { where: { id: "contact1", actContactId: null }, data: { actCreateInFlightAt: null } },
    });
  });

  it("refuses when the contact is not held, or the quote is not held for it", () => {
    expect(contactAbsentDecision(heldRow, heldContact({ actContactId: ACT_ID }))).toEqual({ ok: false, error: CONTACT_NOT_HELD_ERROR });
    expect(contactAbsentDecision(row(), heldContact())).toEqual({ ok: false, error: CONTACT_NOT_HELD_ERROR });
    expect(contactAbsentDecision(null, heldContact())).toEqual({ ok: false, error: NO_ROW_ERROR });
  });
});

describe("heldForContactRelease", () => {
  it("makes due every row held for the contact by the planner, each guarded with its own generation", () => {
    const rows = [
      row({ id: "a", generation: 0, blockedReason: UNTRACKED_CONTACT_REASON }),
      row({ id: "b", generation: 7, blockedReason: UNTRACKED_CONTACT_REASON }),
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

  it("leaves rows held for anything else, rows ACT! refused, waiting rows and finished ones", () => {
    const rows = [
      row({ id: "region", blockedReason: unmappedRegionReason("ZZ") }),
      row({ id: "act", blockedReason: UNTRACKED_CONTACT_REASON, blockedBy: BLOCKED_BY.act }),
      row({ id: "waiting" }),
      row({ id: "done", completedAt: NOW, blockedReason: UNTRACKED_CONTACT_REASON }),
    ];
    expect(heldForContactRelease(rows, NOW)).toEqual([]);
  });
});
