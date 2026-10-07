import { describe, it, expect } from "vitest";
import { fillOnlyEmpty } from "../src/lib/act/merge";

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
