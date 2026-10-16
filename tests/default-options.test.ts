import { describe, it, expect } from "vitest";
import {
  DEFAULT_OPTION_ROLES_BY_FORM,
  defaultOptionRoles,
  pickDefaultOptions,
} from "../src/lib/production-forms/default-options";

describe("defaultOptionRoles", () => {
  it("gives a FabricPro its crate and its installation and training", () => {
    expect(defaultOptionRoles({ form: "FABRICPRO", kind: "SPREADER" })).toEqual([
      "CRATE",
      "INSTALL",
      "TRAINING",
      "EL_INSTALL",
    ]);
  });

  it("gives every other installed product its installation and training", () => {
    expect(defaultOptionRoles({ form: "M_SERIES", kind: "MACHINE" })).toEqual(["INSTALL", "TRAINING", "EL_INSTALL"]);
    expect(defaultOptionRoles({ form: "EASYLOADER", kind: "TABLE" })).toEqual(["INSTALL", "TRAINING", "EL_INSTALL"]);
    expect(defaultOptionRoles({ form: null, kind: "SOFTWARE" })).toEqual(["INSTALL", "TRAINING", "EL_INSTALL"]);
  });

  it("gives a service or a credit nothing", () => {
    expect(defaultOptionRoles({ form: null, kind: "SERVICE" })).toEqual([]);
    expect(defaultOptionRoles({ form: null, kind: "CREDIT" })).toEqual([]);
  });

  it("carries only FabricPro by form", () => {
    expect(Object.keys(DEFAULT_OPTION_ROLES_BY_FORM)).toEqual(["FABRICPRO"]);
  });
});

describe("pickDefaultOptions", () => {
  const option = (
    code: string,
    role: "CRATE" | "INSTALL" | "TRAINING" | "HDC",
    extra: { fitsProduct?: boolean; conflictGroupIds?: string[] } = {}
  ) => ({ code, role, fitsProduct: extra.fitsProduct ?? false, conflictGroupIds: extra.conflictGroupIds ?? [] });

  it("adds the one candidate of each role", () => {
    const crate = option("Crate-FP", "CRATE");
    const install = option("SVC-FP-INSTALL", "INSTALL");
    expect(pickDefaultOptions(["CRATE", "INSTALL", "TRAINING"], [crate, install])).toEqual([crate, install]);
  });

  it("adds nothing when no candidate carries the role", () => {
    expect(pickDefaultOptions(["CRATE"], [option("HDC-M", "HDC")])).toEqual([]);
  });

  it("takes the first of alternatives that share a conflict group", () => {
    const staticInstall = option("SVC-INSTALL", "INSTALL", { conflictGroupIds: ["install-mts"] });
    const mtsInstall = option("SVC-INSTALL-MTS", "INSTALL", { conflictGroupIds: ["install-mts"] });
    expect(pickDefaultOptions(["INSTALL"], [staticInstall, mtsInstall])).toEqual([staticInstall]);
  });

  it("adds none of several unrelated candidates -- the catalogue cannot say which", () => {
    const small = option("SVC-L-INSTALL-S", "INSTALL");
    const large = option("SVC-L-INSTALL-L", "INSTALL");
    expect(pickDefaultOptions(["INSTALL"], [small, large])).toEqual([]);
  });

  it("prefers the candidate fitted to this product by name", () => {
    const small = option("SVC-L-INSTALL-S", "INSTALL");
    const large = option("SVC-L-INSTALL-L", "INSTALL", { fitsProduct: true });
    expect(pickDefaultOptions(["INSTALL"], [small, large])).toEqual([large]);
  });
});
