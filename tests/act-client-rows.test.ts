import { describe, it, expect } from "vitest";
import {
  ActApiError,
  ActNoAnswerError,
  ActNotSentError,
  ActUntrackedCreateError,
  createMadeNothing,
  filterRefused,
  unwrapRows,
  writeFailureOf,
} from "../src/lib/act/client";

const PATH = "/api/contacts?$top=200";

function thrown(payload: unknown): ActApiError {
  try {
    unwrapRows(payload, PATH);
  } catch (error) {
    if (error instanceof ActApiError) return error;
    throw error;
  }
  throw new Error("expected unwrapRows to throw");
}

describe("unwrapRows", () => {
  it("unwraps the { value: [...] } envelope", () => {
    expect(unwrapRows({ value: [{ id: "a" }], Count: 1 }, PATH)).toEqual([{ id: "a" }]);
  });

  it("passes a bare array straight through", () => {
    expect(unwrapRows([{ id: "a" }, { id: "b" }], PATH)).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("treats an empty list in either envelope as a genuinely empty page", () => {
    expect(unwrapRows([], PATH)).toEqual([]);
    expect(unwrapRows({ value: [], Count: 0 }, PATH)).toEqual([]);
  });

  it("throws, rather than returning nothing, for a shape it does not know", () => {
    expect(() => unwrapRows({ items: [] }, PATH)).toThrow(ActApiError);
    expect(() => unwrapRows({ value: "oops" }, PATH)).toThrow(ActApiError);
    expect(() => unwrapRows("<html>", PATH)).toThrow(ActApiError);
    expect(() => unwrapRows(42, PATH)).toThrow(ActApiError);
    expect(() => unwrapRows(null, PATH)).toThrow(ActApiError);
    expect(() => unwrapRows(undefined, PATH)).toThrow(ActApiError);
  });

  it("says which request and what shape it got", () => {
    const message = thrown({ Message: "An error has occurred.", Code: 500 }).message;
    expect(message).toContain(PATH);
    expect(message).toContain("Message: string");
    expect(message).toContain("Code: number");
  });

  it("says when `value` is there but is not a list", () => {
    expect(thrown({ value: "nope", Count: 0 }).message).toContain("value: string");
    expect(thrown({ value: null }).message).toContain("value: null");
  });

  it("describes non-objects by type", () => {
    expect(thrown(null).message).toContain("null");
    expect(thrown("<html>").message).toContain("string");
    expect(thrown(7).message).toContain("number");
    expect(thrown({}).message).toContain("empty object");
  });

  it("does not put the body, or any value from it, in the message", () => {
    const error = thrown({ Message: "secret-contact-name@example.com", other: "x".repeat(5000) });
    expect(error.message).not.toContain("secret-contact-name");
    expect(error.message).not.toContain("xxxxxxxxxx");
    expect(error.body).toBe("");
    expect(error.message.length).toBeLessThan(400);
  });

  it("caps how many keys it lists", () => {
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
    const message = thrown(wide).message;
    expect(message).toContain("30 more");
    expect(message).not.toContain("k39");
  });
});

describe("what an error means, from the error alone", () => {
  it("classifies a 200 that is not a list: a GET whose answer did not give what was asked, safe to try again", () => {
    const error = thrown({ items: [] });
    expect(error.method).toBe("GET");
    expect(error.status).toBe(200);
    expect(error.failure).toBe("failed");
    expect(writeFailureOf(error)).toBe("failed");
  });

  it("reads `refused` and `failed` off an ActApiError, as it was thrown", () => {
    expect(writeFailureOf(new ActApiError("POST /api/contacts failed (400)", "POST", 400, "", "refused"))).toBe("refused");
    expect(writeFailureOf(new ActApiError("GET /api/contacts/x failed (503)", "GET", 503, "", "failed"))).toBe("failed");
  });

  it("calls an ActUntrackedCreateError untracked, with or without the id it made", () => {
    const lost = new ActUntrackedCreateError("lost", "POST /api/History", null, "", null);
    const known = new ActUntrackedCreateError("read-back failed", "POST /api/History", null, "", "c0000000-0000-0000-0000-000000000001");
    expect(lost.failure).toBe("untracked");
    expect(writeFailureOf(lost)).toBe("untracked");
    expect(writeFailureOf(known)).toBe("untracked");
  });

  it("calls a request that was not sent failed, and a GET that kept getting no answer failed", () => {
    const notSent = new ActNotSentError("POST /api/History", "no connection could be made (ECONNREFUSED)");
    expect(notSent.message).toBe(
      "POST /api/History was not sent, so nothing reached ACT!: no connection could be made (ECONNREFUSED)",
    );
    expect(writeFailureOf(notSent)).toBe("failed");
    expect(writeFailureOf(new ActNoAnswerError("GET /api/opportunities/x", 3, "This operation was aborted"))).toBe("failed");
  });

  it("calls an error the client did not throw foreign, never failed: it says nothing about ACT!", () => {
    // The drain's own transaction failing after a POST went through: the same
    // words as a not-sent error, but not the client's error.
    expect(writeFailureOf(new Error("POST /api/History was not sent, so nothing reached ACT!"))).toBe("foreign");
    expect(writeFailureOf(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe("foreign");
    expect(writeFailureOf("a string")).toBe("foreign");
    expect(writeFailureOf(undefined)).toBe("foreign");
  });
});

describe("createMadeNothing: the errors on which a createInFlight marker may be cleared", () => {
  it("is true for a request never sent", () => {
    expect(createMadeNothing(new ActNotSentError("POST /api/contacts", "no connection could be made (ENOTFOUND)"))).toBe(true);
  });

  it("is true for a create ACT! refused", () => {
    expect(createMadeNothing(new ActApiError("POST /api/contacts failed (400)", "POST", 400, "", "refused"))).toBe(true);
    // An authorisation refused before the POST left.
    expect(createMadeNothing(new ActApiError("authorize failed (401)", "GET", 401, "", "refused"))).toBe(true);
  });

  it("is true for a create ACT! answered 429: rate-limited before it ran", () => {
    expect(createMadeNothing(new ActApiError("POST /api/contacts failed (429)", "POST", 429, "", "failed"))).toBe(true);
    // An authorisation throttled before the POST left.
    expect(createMadeNothing(new ActApiError("authorize failed (429)", "GET", 429, "", "failed", { authorizing: true }))).toBe(true);
  });

  it("is false for a create ACT! answered 408: application code can send it after the insert committed", () => {
    expect(createMadeNothing(new ActApiError("POST /api/contacts failed (408)", "POST", 408, "", "failed"))).toBe(false);
    expect(createMadeNothing(new ActApiError("POST /api/History failed (408)", "POST", 408, "", "failed", { retryAfter: "5" }))).toBe(false);
  });

  it("is true for a 408 to the login: the POST it was getting a token for never left", () => {
    expect(createMadeNothing(new ActApiError("authorize failed (408)", "GET", 408, "", "failed", { authorizing: true }))).toBe(true);
  });

  it("is false for an untracked create, with or without the id it made", () => {
    expect(createMadeNothing(new ActUntrackedCreateError("lost", "POST /api/History", null, "", null))).toBe(false);
    // The id is stored, and that clears the marker -- not this.
    expect(
      createMadeNothing(
        new ActUntrackedCreateError("read-back failed", "POST /api/History", null, "", "c0000000-0000-0000-0000-000000000001"),
      ),
    ).toBe(false);
  });

  it("is false for a failed ActApiError, a GET with no answer, and anything the client did not throw", () => {
    expect(createMadeNothing(new ActApiError("GET /api/opportunities failed (503)", "GET", 503, "", "failed"))).toBe(false);
    expect(createMadeNothing(new ActNoAnswerError("GET /api/opportunities/x", 3, "aborted"))).toBe(false);
    expect(createMadeNothing(new Error("POST /api/History was not sent, so nothing reached ACT!"))).toBe(false);
    expect(createMadeNothing(new TypeError("fetch failed"))).toBe(false);
    expect(createMadeNothing(null)).toBe(false);
  });
});

describe("filterRefused: when a filtered lookup falls back to its unfiltered form", () => {
  const api = (status: number) =>
    new ActApiError(`GET /api/opportunities failed (${status})`, "GET", status, "", status < 500 ? "refused" : "failed");

  it("is true for a 4xx other than 401: ACT! does not take the filter there", () => {
    for (const status of [400, 404, 405, 422, 499]) expect(filterRefused(api(status))).toBe(true);
  });

  it("is false for a 401, a redirect, a 429 or a 408, a 5xx and a 200 that was not a list", () => {
    for (const status of [401, 301, 500, 503]) expect(filterRefused(api(status))).toBe(false);
    // "Not now" is not about the filter: the lookup is tried again later, filter and all.
    for (const status of [408, 429]) expect(filterRefused(new ActApiError("throttled", "GET", status, "", "failed"))).toBe(false);
    expect(filterRefused(new ActApiError("not a list", "GET", 200, "", "failed"))).toBe(false);
  });

  it("is false for anything that is not ACT! answering", () => {
    expect(filterRefused(new ActNotSentError("GET /api/opportunities", "no connection could be made (ECONNREFUSED)"))).toBe(false);
    expect(filterRefused(new ActNoAnswerError("GET /api/opportunities", 3, "aborted"))).toBe(false);
    expect(filterRefused(new Error("400"))).toBe(false);
  });
});
