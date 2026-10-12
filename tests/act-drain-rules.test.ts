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
  retryAfterMs,
  RETRY_AFTER_CAP_MS,
  revisionForAct,
  serviceAccountUserId,
  stepAction,
  wonCloseDate,
  BLOCKED_BY,
  RECHECKS_PER_PASS,
  actForbidden,
  createUnaccounted,
  deniedReason,
  passWork,
  replanBlocked,
  stopsPass,
  type ActStepKind,
} from "../src/lib/act/drain-rules";
import {
  NAMELESS_CONTACT_REASON,
  NO_CONTACT_REASON,
  duplicateOpportunitiesReason,
  type OutboxStep,
} from "../src/lib/act/outbox-plan";
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

  it("waits at least as long as a Retry-After asked, and never less than the backoff", () => {
    const now = new Date("2026-10-12T03:00:00.000Z");
    // Longer than the first backoff: the floor wins.
    expect(nextAttemptAt(now, 1, 30 * MINUTE).toISOString()).toBe("2026-10-12T03:30:00.000Z");
    // Shorter: the backoff stands.
    expect(nextAttemptAt(now, 3, 60 * 1000).toISOString()).toBe("2026-10-12T03:20:00.000Z");
    expect(nextAttemptAt(now, 1, null).toISOString()).toBe("2026-10-12T03:05:00.000Z");
  });

  it("caps what a Retry-After can impose at a day", () => {
    const now = new Date("2026-10-12T03:00:00.000Z");
    expect(nextAttemptAt(now, 1, 365 * 24 * 60 * MINUTE).getTime() - now.getTime()).toBe(RETRY_AFTER_CAP_MS);
    expect(RETRY_AFTER_CAP_MS).toBe(24 * 60 * MINUTE);
  });
});

describe("retryAfterMs", () => {
  const now = new Date("2026-10-12T03:00:00.000Z");

  it("reads a number of seconds", () => {
    expect(retryAfterMs("120", now)).toBe(120_000);
    expect(retryAfterMs(" 0 ", now)).toBe(0);
  });

  it("reads an HTTP-date relative to now, a past one as no wait", () => {
    expect(retryAfterMs("Mon, 12 Oct 2026 03:10:00 GMT", now)).toBe(10 * MINUTE);
    expect(retryAfterMs("Mon, 12 Oct 2026 02:00:00 GMT", now)).toBe(0);
  });

  it("is null for no header, or one that says nothing readable", () => {
    expect(retryAfterMs(null, now)).toBeNull();
    expect(retryAfterMs("", now)).toBeNull();
    expect(retryAfterMs("soon", now)).toBeNull();
    expect(retryAfterMs("-5", now)).toBeNull();
    expect(retryAfterMs("1.5", now)).toBeNull();
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
      'ACT! refused to make this quote\'s contact a Customer, answering 400 ("Account Mgr is not in the list") — PathQuote will not send it again on its own: check the record in ACT!, and it is tried again when this quote is next finalised, signed or accepted, or when your developer retries it.',
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

describe("deniedReason", () => {
  it("says ACT! denied access to the record, what to do, and that it is held", () => {
    expect(deniedReason("promote-contact", "GET", '{"Message":"Access denied"}')).toBe(
      'ACT! denied PathQuote access to the record it needed to make this quote\'s contact a Customer, answering 403 ("Access denied") — ACT! can keep a record to some of its users, and an ACT! administrator can give PathQuote\'s login access. PathQuote will not try again on its own: it is tried again when this quote is next finalised, signed or accepted, or when your developer retries it.',
    );
  });

  it("does not call a create's target a record: there is none yet", () => {
    expect(deniedReason("create-contact", "POST", "")).toMatch(/^ACT! denied PathQuote access when it tried to create this quote's contact, answering 403 — /);
  });
});

describe("replanBlocked: what the drain's pass over blocked rows does with one", () => {
  const fixed: OutboxStep = { kind: "create-opportunity" };
  const noContact: OutboxStep = { kind: "blocked", reason: NO_CONTACT_REASON };

  it("unblocks a row the planner blocked, once the cause is fixed in PathQuote", () => {
    expect(replanBlocked({ blockedReason: NO_CONTACT_REASON, blockedBy: null }, fixed)).toEqual({ kind: "unblock" });
  });

  it("leaves a row the planner still blocks as it is, or stores its new reason as the planner's", () => {
    expect(replanBlocked({ blockedReason: NO_CONTACT_REASON, blockedBy: null }, noContact)).toEqual({ kind: "keep" });
    const nameless: OutboxStep = { kind: "blocked", reason: NAMELESS_CONTACT_REASON };
    expect(replanBlocked({ blockedReason: NO_CONTACT_REASON, blockedBy: null }, nameless)).toEqual({
      kind: "reblock",
      reason: NAMELESS_CONTACT_REASON,
    });
  });

  it("never unblocks a row ACT! refused, whatever the planner says: only a take-over or a person sends it again", () => {
    const refused = { blockedReason: refusedReason("create-contact", 400, ""), blockedBy: BLOCKED_BY.act };
    expect(replanBlocked(refused, fixed)).toEqual({ kind: "keep" });
    expect(replanBlocked(refused, { kind: "create-contact" })).toEqual({ kind: "keep" });
    expect(replanBlocked(refused, noContact)).toEqual({ kind: "keep" });
  });

  it("never rechecks a row whose revision could not be described: that revision reads the same every time", () => {
    const unreadable = revisionForAct({
      number: "Q-AU-2026-014",
      regionCode: "AU",
      revision: 0,
      total: "100.00",
      snapshot: { currency: "AUD", terms: {} },
      createdAt: new Date("2026-10-12T00:00:00.000Z"),
    });
    if (unreadable.kind !== "unreadable") throw new Error("expected an unreadable revision");
    const held = { blockedReason: unreadable.reason, blockedBy: BLOCKED_BY.revision };
    expect(replanBlocked(held, fixed)).toEqual({ kind: "keep" });
    expect(replanBlocked(held, noContact)).toEqual({ kind: "keep" });
  });

  it("works a row a lookup's duplicates blocked again, keeping its reason until then", () => {
    const duplicates = { blockedReason: duplicateOpportunitiesReason("Q-AU-2026-014 AUD", 2), blockedBy: BLOCKED_BY.drain };
    expect(replanBlocked(duplicates, fixed)).toEqual({ kind: "recheck" });
    // Unless the planner blocks it now, which is then the reason, the planner's.
    expect(replanBlocked(duplicates, noContact)).toEqual({ kind: "reblock", reason: NO_CONTACT_REASON });
  });

  it("leaves a row blocked by someone it does not know for a person", () => {
    expect(replanBlocked({ blockedReason: "x", blockedBy: "someone" }, fixed)).toEqual({ kind: "keep" });
  });
});

describe("passWork: the rows one pass works, in order", () => {
  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it("works every due row first, then the rechecks", () => {
    expect(passWork(["d0", "d1"], ["r0", "r1"])).toEqual([
      { id: "d0", recheck: false },
      { id: "d1", recheck: false },
      { id: "r0", recheck: true },
      { id: "r1", recheck: true },
    ]);
  });

  it("rechecks at most RECHECKS_PER_PASS rows, the first ones given, however many wait", () => {
    expect(RECHECKS_PER_PASS).toBe(10);
    const work = passWork(["due"], ids("r", 60));
    expect(work[0]).toEqual({ id: "due", recheck: false });
    expect(work.filter((w) => w.recheck).map((w) => w.id)).toEqual(ids("r", 10));
    expect(work).toHaveLength(11);
  });

  it("never lets rechecks stand between a full batch of due rows and ACT!", () => {
    const work = passWork(ids("d", 50), ids("r", 60));
    expect(work.slice(0, 50).every((w) => !w.recheck)).toBe(true);
    expect(work).toHaveLength(60);
  });

  it("does not work a row twice", () => {
    expect(passWork(["a"], ["a", "b"])).toEqual([
      { id: "a", recheck: false },
      { id: "b", recheck: true },
    ]);
  });
});

describe("createUnaccounted: a create that may have made a record PathQuote has not stored", () => {
  it("is true for an answer lost or unreadable, and for a 408 to the POST", () => {
    expect(createUnaccounted(new ActUntrackedCreateError("x", "POST /api/contacts", null, "", null, { noAnswer: true }))).toBe(true);
    expect(createUnaccounted(new ActUntrackedCreateError("x", "POST /api/contacts", 502, "", null))).toBe(true);
    expect(createUnaccounted(new ActApiError("POST /api/contacts failed (408)", "POST", 408, "", "failed"))).toBe(true);
  });

  it("is false where the id is known, nothing was made, or it was not a create", () => {
    expect(createUnaccounted(new ActUntrackedCreateError("x", "POST /api/contacts", null, "", "c1"))).toBe(false);
    expect(createUnaccounted(new ActApiError("x", "POST", 429, "", "failed"))).toBe(false);
    expect(createUnaccounted(new ActApiError("x", "POST", 400, "", "refused"))).toBe(false);
    expect(createUnaccounted(new ActApiError("authorize failed (408)", "GET", 408, "", "failed", { authorizing: true }))).toBe(false);
    expect(createUnaccounted(new ActApiError("x", "GET", 408, "", "failed"))).toBe(false);
    expect(createUnaccounted(new ActNotSentError("POST /api/contacts", "ECONNREFUSED"))).toBe(false);
    expect(createUnaccounted(new Error("the store failed"))).toBe(false);
  });
});

describe("drainFailure", () => {
  const api = (status: number, failure: "refused" | "failed") => new ActApiError("x", "POST", status, "", failure);

  it("calls a 4xx a refusal, which blocks the row", () => {
    expect(drainFailure(api(400, "refused"))).toBe("refused");
    expect(drainFailure(api(404, "refused"))).toBe("refused");
    expect(drainFailure(api(422, "refused"))).toBe("refused");
  });

  it("stops the pass for an answer every row would get: a 401, a 403 to the login itself, a redirect", () => {
    expect(drainFailure(api(401, "refused"))).toBe("stop");
    expect(drainFailure(new ActApiError("authorize failed (401)", "GET", 401, "", "refused", { authorizing: true }))).toBe("stop");
    expect(drainFailure(new ActApiError("authorize failed (403)", "GET", 403, "", "refused", { authorizing: true }))).toBe("stop");
    expect(drainFailure(new ActApiError("x", "GET", 301, "", "refused"))).toBe("stop");
  });

  it("calls ACT!'s own 403 on a record denied, which blocks that row and lets the pass go on", () => {
    const json = '{"Message":"Authorization has been denied for this request."}';
    expect(drainFailure(new ActApiError("GET /api/contacts/x failed (403)", "GET", 403, json, "refused"))).toBe("denied");
    expect(drainFailure(new ActApiError("PATCH /api/contacts/x failed (403)", "PATCH", 403, json, "refused"))).toBe("denied");
    expect(drainFailure(new ActApiError("x", "POST", 403, ' "no access" ', "refused"))).toBe("denied");
  });

  it("stops the pass for a 403 that is not ACT!'s JSON: IIS turning the VPS away, not one record", () => {
    const iis =
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"><html><head><title>403 - Forbidden: Access is denied.</title></head><body>…</body></html>';
    const ipBlocked = new ActApiError("GET /api/opportunities/x failed (403)", "GET", 403, iis, "refused");
    expect(actForbidden(iis)).toBe(false);
    expect(drainFailure(ipBlocked)).toBe("stop");
    expect(drainFailure(new ActApiError("x", "POST", 403, "Forbidden", "refused"))).toBe("stop");
    expect(drainFailure(api(403, "refused"))).toBe("stop");
    expect(drainFailure(new ActApiError("x", "PATCH", 403, "  \n", "refused"))).toBe("stop");
    expect(lastErrorText("update-opportunity", ipBlocked)).toMatch(
      /^PathQuote could not update this quote's opportunity: it was answered 403 with something other than ACT!'s own answer, most likely ACT!'s IIS no longer letting the VPS's address in — GET \/api\/opportunities\/x failed \(403\)$/,
    );
  });

  it("reads JSON of any shape as ACT!'s own 403 answer, and nothing else", () => {
    expect(actForbidden('{"Message":"no"}')).toBe(true);
    expect(actForbidden('"no"')).toBe(true);
    expect(actForbidden("[]")).toBe(true);
    expect(actForbidden("")).toBe(false);
    expect(actForbidden("<html></html>")).toBe(false);
    expect(actForbidden("{not json")).toBe(false);
  });

  it("backs off for what may go through next time", () => {
    expect(drainFailure(api(503, "failed"))).toBe("failed");
    expect(drainFailure(new ActApiError("not a list", "GET", 200, "", "failed"))).toBe("failed");
  });

  it("calls ACT! not answering at all unreachable: nothing sent, no answer to a read, no answer to a create", () => {
    expect(drainFailure(new ActNotSentError("POST /api/History", "ECONNREFUSED"))).toBe("unreachable");
    expect(drainFailure(new ActNoAnswerError("GET /api/opportunities/x", 3, "timeout"))).toBe("unreachable");
    const lost = new ActUntrackedCreateError("x", "POST /api/contacts", null, "", null, { noAnswer: true });
    expect(drainFailure(lost)).toBe("unreachable");
    // Still a create that may have made a record: its marker is not cleared.
    expect(createMadeNothing(lost)).toBe(false);
  });

  it("stops the pass after a stop, a try-later or ACT! unreachable, and after nothing else", () => {
    const all = ["refused", "denied", "stop", "try-later", "unreachable", "untracked", "failed", "foreign"] as const;
    expect(all.filter(stopsPass)).toEqual(["stop", "try-later", "unreachable"]);
  });

  it("calls a 429 or a 408 try-later, on a create or a read: back off, and stop the pass", () => {
    expect(drainFailure(new ActApiError("x", "POST", 429, "", "failed"))).toBe("try-later");
    expect(drainFailure(new ActApiError("x", "GET", 429, "", "failed"))).toBe("try-later");
    expect(drainFailure(new ActApiError("x", "PATCH", 408, "", "failed"))).toBe("try-later");
  });

  it("stops the pass for a create answered with a redirect, which stays untracked for its marker", () => {
    const redirected = new ActUntrackedCreateError("POST /api/contacts failed (301, a redirect)", "POST /api/contacts", 301, "", null);
    expect(drainFailure(redirected)).toBe("stop");
    expect(createMadeNothing(redirected)).toBe(false);
    expect(lastErrorText("create-contact", redirected)).toMatch(/checked ACT! for the contact\. POST \/api\/contacts failed \(301, a redirect\)$/);
  });

  it("knows a create that may have made a record though ACT! answered", () => {
    expect(drainFailure(new ActUntrackedCreateError("x", "POST /api/opportunities", null, "", null))).toBe("untracked");
    expect(drainFailure(new ActUntrackedCreateError("x", "POST /api/opportunities", 502, "", null))).toBe("untracked");
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

  it("says ACT! asked for it to be tried later, with the wait it asked for", () => {
    const throttled = new ActApiError("POST /api/contacts failed (429)", "POST", 429, "", "failed", { retryAfter: "120" });
    expect(lastErrorText("create-contact", throttled)).toBe(
      "PathQuote could not create this quote's contact: ACT! answered 429, not now, try later (Retry-After: 120) — POST /api/contacts failed (429)",
    );
    expect(lastErrorText("create-contact", new ActApiError("x", "POST", 408, "", "failed"))).toMatch(/answered 408, not now, try later — x$/);
  });

  it("tells a lost create's answer from a failure, and says the next attempt looks first", () => {
    const text = lastErrorText("create-opportunity", new ActUntrackedCreateError("x", "POST /api/opportunities", null, "", null));
    expect(text).toMatch(/did not learn whether it did — the next attempt looks for it/);
    // A contact is not looked up: a person checks first.
    const contact = new ActUntrackedCreateError("x", "POST /api/contacts", null, "", null, { noAnswer: true });
    expect(lastErrorText("create-contact", contact)).toBe(
      "PathQuote asked ACT! to create this quote's contact and got no answer, so did not learn whether it did — it is not tried again until a person has checked ACT! for the contact.",
    );
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
