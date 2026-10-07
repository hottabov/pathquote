import { describe, it, expect } from "vitest";
import { ActApiError, unwrapRows } from "../src/lib/act/client";

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
