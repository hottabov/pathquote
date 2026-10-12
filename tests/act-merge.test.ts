import { describe, it, expect } from "vitest";
import { changedInAct, fillOnlyEmpty } from "../src/lib/act/merge";

describe("fillOnlyEmpty", () => {
  it("fills a field that is null", () => {
    expect(fillOnlyEmpty({ email: null }, { email: "a@b.c" }, ["email"])).toEqual({
      email: "a@b.c",
    });
  });

  it("fills a field that is an empty string", () => {
    expect(fillOnlyEmpty({ email: "" }, { email: "a@b.c" }, ["email"])).toEqual({
      email: "a@b.c",
    });
  });

  it("fills a field that is only whitespace", () => {
    expect(fillOnlyEmpty({ city: "   " }, { city: "Melbourne" }, ["city"])).toEqual({
      city: "Melbourne",
    });
  });

  it("never overwrites what someone typed", () => {
    // A salesperson corrected this by hand. ACT! does not get to undo it.
    expect(fillOnlyEmpty({ phone: "+61400000000" }, { phone: "+61411111111" }, ["phone"]))
      .toEqual({});
  });

  it("ignores an incoming value that is itself empty", () => {
    expect(fillOnlyEmpty({ email: null }, { email: null }, ["email"])).toEqual({});
    expect(fillOnlyEmpty({ email: null }, { email: "  " }, ["email"])).toEqual({});
  });

  it("only considers the listed fields", () => {
    expect(fillOnlyEmpty({ a: null, b: null }, { a: "x", b: "y" }, ["a"])).toEqual({ a: "x" });
  });

  it("returns an empty object when there is nothing to do", () => {
    expect(fillOnlyEmpty({ email: "a@b.c" }, { email: "a@b.c" }, ["email"])).toEqual({});
  });
});

describe("changedInAct", () => {
  const stored = new Date("2026-10-12T23:00:00.123Z");

  it("does not count PathQuote's own write coming back, or the boundary record read again", () => {
    // Both arrive with exactly the `edited` PathQuote stored: the drain's
    // create or promotion stored what ACT! answered with, and the `ge` cursor
    // re-reads the newest record of the last run.
    expect(changedInAct(stored, new Date("2026-10-12T23:00:00.123Z"))).toBe(false);
  });

  it("counts a record edited in ACT! since, which always moves `edited`", () => {
    expect(changedInAct(stored, new Date("2026-10-13T01:15:00.000Z"))).toBe(true);
    // A millisecond is enough: nothing is rounded away.
    expect(changedInAct(stored, new Date("2026-10-12T23:00:00.124Z"))).toBe(true);
  });

  it("counts it when there is nothing stored to compare with", () => {
    // A contact the drain created from an id alone, with no record to read
    // `edited` off: when in doubt, say something happened.
    expect(changedInAct(null, new Date("2026-10-12T23:00:00.123Z"))).toBe(true);
  });

  it("counts it when ACT!'s `edited` is not a date", () => {
    expect(changedInAct(stored, new Date("not a date"))).toBe(true);
  });
});
