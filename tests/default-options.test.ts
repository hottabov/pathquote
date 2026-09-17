import { describe, it, expect } from "vitest";
import { DEFAULT_OPTION_ROLES, defaultOptionRoles, pickDefaultOptions } from "../src/lib/production-forms/default-options";

describe("defaultOptionRoles", () => {
  it("returns the crate role for a FabricPro", () => {
    expect(defaultOptionRoles("FABRICPRO")).toEqual(["CRATE"]);
  });

  it("returns nothing for a form with no default options", () => {
    expect(defaultOptionRoles("M_SERIES")).toEqual([]);
    expect(defaultOptionRoles("EASYLOADER")).toEqual([]);
  });

  it("returns nothing for an item with no form", () => {
    expect(defaultOptionRoles(null)).toEqual([]);
    expect(defaultOptionRoles(undefined)).toEqual([]);
  });

  it("carries only FabricPro today", () => {
    expect(Object.keys(DEFAULT_OPTION_ROLES)).toEqual(["FABRICPRO"]);
  });
});

describe("pickDefaultOptions", () => {
  const crate = (code: string) => ({ code, role: "CRATE" as const });

  it("takes one option per role, the first in the order given", () => {
    expect(pickDefaultOptions(["CRATE"], [crate("Crate-FP"), crate("Crate-FP-2")])).toEqual([crate("Crate-FP")]);
  });

  it("adds nothing when no candidate carries the role", () => {
    expect(pickDefaultOptions(["CRATE"], [{ code: "HDC-M", role: "HDC" as const }])).toEqual([]);
  });

  it("adds nothing for a form with no default roles", () => {
    expect(pickDefaultOptions(defaultOptionRoles("M_SERIES"), [crate("Crate-M-220")])).toEqual([]);
  });
});
