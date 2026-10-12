import { describe, it, expect } from "vitest";
import { ActApiError, ActUntrackedCreateError, unwrapRows, writeFailureOf } from "../src/lib/act/client";

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

  it("calls any other error failed: not sent, never connected, or a GET that kept failing", () => {
    expect(writeFailureOf(new Error("POST /api/History was not sent, so nothing reached ACT!: no connection could be made (ECONNREFUSED)"))).toBe("failed");
    expect(writeFailureOf("a string")).toBe("failed");
  });
});
