import { describe, it, expect } from "vitest";
import { consumableChoice, consumableIncludedLabel } from "../src/lib/consumables";

const blade = (id: string, qty = 2) => ({ id, code: id.toUpperCase(), name: `Blade ${id}`, qty });

/**
 * A tool that takes a consumable goes on the quote with exactly one of them
 * (John: "you must select either this or this").
 */
describe("consumableChoice", () => {
  it("needs nothing for a tool with no consumables, and ignores a stale pick", () => {
    expect(consumableChoice([], undefined)).toEqual({ ok: true, link: null });
    expect(consumableChoice([], "blade-30")).toEqual({ ok: true, link: null });
  });

  it("gives a tool with a single consumable that one without asking", () => {
    expect(consumableChoice([blade("pack")], undefined)).toEqual({ ok: true, link: blade("pack") });
    expect(consumableChoice([blade("pack")], "pack")).toEqual({ ok: true, link: blade("pack") });
  });

  it("refuses a tool with several consumables and none picked", () => {
    expect(consumableChoice([blade("a"), blade("b")], undefined)).toEqual({ ok: false, reason: "required" });
  });

  it("takes the one picked, and refuses one the tool does not list", () => {
    expect(consumableChoice([blade("a"), blade("b")], "b")).toEqual({ ok: true, link: blade("b") });
    expect(consumableChoice([blade("a"), blade("b")], "c")).toEqual({ ok: false, reason: "unknown" });
    expect(consumableChoice([blade("a")], "c")).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("consumableIncludedLabel", () => {
  it("says how many come with the tool", () => {
    expect(consumableIncludedLabel(2, "30° Carbide Blade 380017")).toBe("Includes 2 × 30° Carbide Blade 380017");
  });
});
