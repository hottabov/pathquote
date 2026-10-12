import { describe, it, expect } from "vitest";
import {
  BACKOFF_CAP_MS,
  BACKOFF_FIRST_MS,
  answerDetail,
  backoffMs,
  drainFailure,
  lastErrorText,
  nextAttemptAt,
  opportunityNow,
  refusedReason,
  revisionForAct,
  serviceAccountUserId,
  stepAction,
  wonCloseDate,
  type ActStepKind,
} from "../src/lib/act/drain-rules";
import {
  ActApiError,
  ActNoAnswerError,
  ActNotSentError,
  ActUntrackedCreateError,
  createMadeNothing,
} from "../src/lib/act/client";
import { stageMove, wonStage } from "../src/lib/act/opportunity-stages";

const MINUTE = 60 * 1000;

describe("backoffMs", () => {
  it("waits five minutes after the first failure, doubling after each one", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(n) / MINUTE)).toEqual([5, 10, 20, 40, 80, 160, 320]);
  });

  it("never waits more than six hours", () => {
    expect(backoffMs(8)).toBe(BACKOFF_CAP_MS);
    expect(backoffMs(9)).toBe(BACKOFF_CAP_MS);
    expect(backoffMs(10_000)).toBe(BACKOFF_CAP_MS);
    expect(BACKOFF_CAP_MS).toBe(6 * 60 * MINUTE);
  });

  it("treats a count below one as the first failure", () => {
    expect(backoffMs(0)).toBe(BACKOFF_FIRST_MS);
    expect(backoffMs(-3)).toBe(BACKOFF_FIRST_MS);
  });

  it("dates the next attempt from the time it is handed, not the clock", () => {
    const now = new Date("2026-10-12T03:00:00.000Z");
    expect(nextAttemptAt(now, 2).toISOString()).toBe("2026-10-12T03:10:00.000Z");
  });
});

describe("wonCloseDate", () => {
  const signed = new Date("2026-10-01T00:00:00.000Z");
  const accepted = new Date("2026-10-02T00:00:00.000Z");
  const resigned = new Date("2026-10-09T00:00:00.000Z");

  it("is the acceptance when the client signed first, the usual order", () => {
    expect(wonCloseDate(accepted, signed)).toBe(accepted);
  });

  it("is the new signature after accept, void and re-sign: the acceptance is the old one", () => {
    expect(wonCloseDate(accepted, resigned)).toBe(resigned);
  });

  it("is the acceptance when no signature time was recorded", () => {
    expect(wonCloseDate(accepted, null)).toBe(accepted);
  });
});

describe("serviceAccountUserId", () => {
  const users = [
    { id: "u-1", username: "John Hollo" },
    { id: "u-2", username: "Marketing" },
    { id: "u-3", username: null },
  ];

  it("finds the uuid of the login ACT_USER names", () => {
    expect(serviceAccountUserId(users, "Marketing")).toBe("u-2");
  });

  it("ignores case and surrounding spaces, as a login does", () => {
    expect(serviceAccountUserId(users, "  marketing ")).toBe("u-2");
  });

  it("finds nobody for a login no user has, or a blank one", () => {
    expect(serviceAccountUserId(users, "Sales")).toBeNull();
    expect(serviceAccountUserId(users, "  ")).toBeNull();
  });

  it("refuses to choose between two users with the same login", () => {
    expect(serviceAccountUserId([...users, { id: "u-4", username: "MARKETING" }], "Marketing")).toBeNull();
  });

  it("finds nobody when the match has no id to write records under", () => {
    expect(serviceAccountUserId([{ id: "", username: "Marketing" }], "Marketing")).toBeNull();
  });
});

describe("opportunityNow", () => {
  const SALES_CYCLE = "2380e83d-cef4-4b6d-ad15-dc9a558431ab";

  it("reads the stage's process and number, and the status", () => {
    expect(opportunityNow({ status: "Open", stage: { number: 4, process: { id: SALES_CYCLE } } })).toEqual({
      processId: SALES_CYCLE,
      number: 4,
      status: "Open",
    });
  });

  it("puts an opportunity with no readable stage in no process, so its stage is never moved", () => {
    for (const stage of [null, undefined, {}, { number: 3 }, { number: 3, process: null }, { number: "3", process: { id: SALES_CYCLE } }]) {
      const now = opportunityNow({ status: "Lost", stage });
      expect(now).toEqual({ processId: "", number: 0, status: "Lost" });
      expect(stageMove(now, wonStage("AU")!)).toBe("different-process");
    }
  });

  it("reads a missing status as one that is not Open", () => {
    expect(opportunityNow({ stage: null }).status).toBe("");
  });
});

describe("answerDetail", () => {
  it("quotes the Message of ACT!'s JSON error body", () => {
    expect(answerDetail('{"Message":"The request is invalid."}')).toBe("The request is invalid.");
    expect(answerDetail('{"message":"Value is not in list"}')).toBe("Value is not in list");
  });

  it("quotes a JSON string, or plain text, as it is", () => {
    expect(answerDetail('"Country is required"')).toBe("Country is required");
    expect(answerDetail("Bad Request")).toBe("Bad Request");
  });

  it("is empty for an empty body", () => {
    expect(answerDetail("")).toBe("");
    expect(answerDetail("   ")).toBe("");
  });

  it("keeps a long answer to one short line", () => {
    const detail = answerDetail(`${"word ".repeat(100)}\n\nmore`);
    expect(detail.length).toBeLessThanOrEqual(200);
    expect(detail).not.toContain("\n");
    expect(detail.endsWith("…")).toBe(true);
  });

  it("falls back to the text of a JSON body with no message in it", () => {
    expect(answerDetail('{"code":42}')).toBe('{"code":42}');
  });
});

describe("refusedReason", () => {
  it("says what was refused, what ACT! said, and what happens next, in a manager's sentence", () => {
    const reason = refusedReason("promote-contact", 400, '{"Message":"Account Mgr is not in the list"}');
    expect(reason).toBe(
      'ACT! refused to make this quote\'s contact a Customer, answering 400 ("Account Mgr is not in the list") — PathQuote will try again on its next pass; if this stays, check the record in ACT!, or ask your developer.',
    );
  });

  it("leaves out an answer ACT! gave no words for", () => {
    expect(refusedReason("create-contact", 400, "")).toContain("answering 400 —");
  });

  it("has a sentence for every step that calls ACT!", () => {
    const kinds: ActStepKind[] = [
      "create-contact",
      "create-opportunity",
      "update-opportunity",
      "write-product-line",
      "write-accepted-line",
      "write-history",
      "win-opportunity",
      "promote-contact",
    ];
    for (const kind of kinds) expect(stepAction(kind)).toMatch(/^[a-z]/);
  });
});

describe("drainFailure", () => {
  const api = (status: number, failure: "refused" | "failed") => new ActApiError("x", "POST", status, "", failure);

  it("calls a 4xx a refusal, which blocks the row", () => {
    expect(drainFailure(api(400, "refused"))).toBe("refused");
    expect(drainFailure(api(404, "refused"))).toBe("refused");
    expect(drainFailure(api(422, "refused"))).toBe("refused");
  });

  it("stops the pass for an answer every row would get: the login, the licence, a redirect", () => {
    expect(drainFailure(api(401, "refused"))).toBe("stop");
    expect(drainFailure(api(403, "refused"))).toBe("stop");
    expect(drainFailure(new ActApiError("x", "GET", 301, "", "refused"))).toBe("stop");
  });

  it("backs off for what may go through next time", () => {
    expect(drainFailure(api(503, "failed"))).toBe("failed");
    expect(drainFailure(new ActNotSentError("POST /api/History", "ECONNREFUSED"))).toBe("failed");
    expect(drainFailure(new ActNoAnswerError("GET /api/opportunities/x", 3, "timeout"))).toBe("failed");
  });

  it("knows a create that may have made a record", () => {
    expect(drainFailure(new ActUntrackedCreateError("x", "POST /api/opportunities", null, "", null))).toBe("untracked");
  });

  it("calls anything else foreign, which never says nothing was sent", () => {
    const error = new Error("the transaction storing the id failed");
    expect(drainFailure(error)).toBe("foreign");
    expect(createMadeNothing(error)).toBe(false);
  });
});

describe("lastErrorText", () => {
  it("says whose fault it was, with the error behind it", () => {
    expect(lastErrorText("write-history", new ActNotSentError("POST /api/History", "ECONNREFUSED"))).toMatch(
      /^PathQuote could not record this revision in the contact's history: ACT! could not be reached — /,
    );
    expect(lastErrorText("update-opportunity", new ActApiError("GET failed (503)", "GET", 503, "", "failed"))).toMatch(
      /ACT! answered 503 — GET failed \(503\)$/,
    );
    expect(lastErrorText("win-opportunity", new Error("boom"))).toBe(
      "PathQuote could not mark this quote's opportunity Won: something in PathQuote failed — boom",
    );
  });

  it("tells a lost create's answer from a failure, and says the next attempt looks first", () => {
    const text = lastErrorText("create-opportunity", new ActUntrackedCreateError("x", "POST /api/opportunities", null, "", null));
    expect(text).toMatch(/did not learn whether it did — the next attempt looks for it/);
  });

  it("keeps it short enough to show on a quote", () => {
    expect(lastErrorText("write-history", new Error("x".repeat(5000))).length).toBeLessThanOrEqual(500);
  });
});

describe("revisionForAct", () => {
  const createdAt = new Date("2026-10-12T04:30:00.000Z");
  const snapshot = { currency: "AUD", totals: { total: "1.00" }, terms: { validityDays: 30 } };
  const input = (overrides: Partial<Parameters<typeof revisionForAct>[0]> = {}) => ({
    number: "Q-AU-2026-014",
    regionCode: "AU",
    revision: 2,
    total: { toString: () => "45000.50" },
    snapshot,
    createdAt,
    ...overrides,
  });

  it("describes the revision from its own row and frozen snapshot", () => {
    expect(revisionForAct(input())).toEqual({
      kind: "quote",
      quote: {
        number: "Q-AU-2026-014",
        revision: 2,
        regionCode: "AU",
        total: 45000.5,
        currency: "AUD",
        validityDays: 30,
        finalizedAt: createdAt,
      },
    });
  });

  it("refuses a revision with no validity rather than default one", () => {
    const result = revisionForAct(input({ snapshot: { ...snapshot, terms: { validityDays: null } } }));
    expect(result.kind).toBe("unreadable");
    if (result.kind === "unreadable") {
      expect(result.reason).toMatch(/no validity on record/);
      expect(result.reason).toContain("— ask your developer.");
    }
  });

  it("refuses a revision with no currency, no number or no readable total", () => {
    expect(revisionForAct(input({ snapshot: { terms: { validityDays: 30 } } })).kind).toBe("unreadable");
    expect(revisionForAct(input({ snapshot: null })).kind).toBe("unreadable");
    expect(revisionForAct(input({ number: null })).kind).toBe("unreadable");
    expect(revisionForAct(input({ total: { toString: () => "n/a" } })).kind).toBe("unreadable");
  });
});
