import { describe, it, expect } from "vitest";
import type { OptionRole } from "@prisma/client";
import { coveredRoles, resolveForm, unmatchedOptions } from "../src/lib/production-forms/resolve";
import { FORM_SPECS } from "../src/lib/production-forms/specs";
import { isXlsxForm } from "../src/lib/production-forms/types";
import { PATHWORKS_ROLES } from "../src/lib/production-forms/pathworks";
import { lSeriesSpecSchema, xCalibreSpecSchema } from "../src/lib/validation/production-spec";
import { formContext, formItem } from "./helpers/fixtures";

/** A synthetic option line for each role, one per role, so a form's coverage
 * can be checked against the whole set at once. */
const optionsFor = (roles: readonly OptionRole[]) =>
  roles.map((role, i) => ({ id: `opt-${i}`, code: `opt-${role}`, role, qty: 1, attributes: null }));

/**
 * Every option role the catalogue sells against a series (2026-09-16 dump),
 * checked here rather than only against `coveredRoles` -- a spec that
 * declares coverage for a role the catalogue never actually sells against
 * that series would pass a `coveredRoles`-only check while a role the
 * catalogue does sell, and the spec forgot, would not be caught by it
 * either. Fully optioning one item with all of them and expecting nothing
 * left over is what would actually happen on a real quote.
 */
const M_COMPATIBLE_ROLES = [
  "ABR", "AFP", "APM", "BCR", "CRATE", "DMT", "DR2", "DRG_1", "DRG_2", "DRG_3",
  "HDC", "HFV", "IJP", "IKA", "MRK", "OFD", "OFJ", "OFP", "PM", "PRM",
  "TRANSFORMER", "MTS", "MTS_TRAVEL", ...PATHWORKS_ROLES,
] as const satisfies readonly OptionRole[];

const X_COMPATIBLE_ROLES = [
  "BCR", "CRATE", "DMT", "HDC", "MTS", "MTS_TRAVEL", "OFD", "OFJ", "OFP", "PRM",
  "TRANSFORMER", ...PATHWORKS_ROLES,
] as const satisfies readonly OptionRole[];

const L_COMPATIBLE_ROLES = [
  "ABR", "APM", "BCR", "CRATE", "L_TOOL", "L_EXTENDED", "HDC", "HFV", "JTP",
  "MRK", "OFD", "OFP", "PM", "PRM", ...PATHWORKS_ROLES,
] as const satisfies readonly OptionRole[];

describe("the form registry", () => {
  it("has exactly one spec per ProductionForm value it claims", () => {
    const forms = FORM_SPECS.map((spec) => spec.form);
    expect(new Set(forms).size).toBe(forms.length);
  });

  it("gives every component-rendered form an explicit coverage list", () => {
    // Forms that print no option box by design: the EasyFeeder asks for the
    // model only (Vadym, 2026-09-17), so any option on it belongs on the
    // Additional items sheet. Anything else here is a mistake.
    const NO_OPTIONS = new Set(["easyfeeder"]);
    for (const spec of FORM_SPECS.filter((s) => !isXlsxForm(s))) {
      // A JSX layout is not enumerable, so coverage cannot be assembled from
      // the ticks. An empty list would silently send every option to the
      // Additional items sheet.
      if (NO_OPTIONS.has(spec.id)) {
        expect(coveredRoles(spec).size, spec.id).toBe(0);
        continue;
      }
      expect(coveredRoles(spec).size, spec.id).toBeGreaterThan(0);
    }
  });

  it("resolves the two cutter forms that have no workbook", () => {
    for (const form of ["X_CALIBRE", "L_SERIES"] as const) {
      const spec = resolveForm(form);
      expect(spec?.renderer, form).toBe("html");
    }
  });
});

describe("X-Calibre", () => {
  const spec = resolveForm("X_CALIBRE")!;

  it("asks for drills and nothing else", () => {
    expect(spec.requires).toEqual(["drills"]);
  });

  it("does not ask for a knife size — the form prints one", () => {
    expect(Object.keys(xCalibreSpecSchema.parse({}))).not.toContain("knifeSize");
  });

  it("covers the options its boxes print", () => {
    const covered = coveredRoles(spec);
    for (const role of ["HDC", "BCR", "OFJ", "OFD", "OFP", "DR2", "PRM", "CRATE", "MTS"] as const) {
      expect(covered.has(role), role).toBe(true);
    }
  });

  it("ticks a DuctMasTer rather than sending it to the Additional items sheet", () => {
    // X-Calibre gained a DMT box (2026-09-16), so it no longer needs the
    // Additional items sheet to surface a DMT line.
    const dmt = { id: "o", code: "DMT", role: "DMT" as const, qty: 1, attributes: null };
    const ctx = formContext({ item: formItem({ form: "X_CALIBRE", options: [dmt] }) });

    expect(unmatchedOptions(spec, ctx).map((o) => o.code)).toEqual([]);
  });

  it("leaves nothing unmatched when every X-compatible role is on the item", () => {
    const ctx = formContext({
      item: formItem({ form: "X_CALIBRE", options: optionsFor(X_COMPATIBLE_ROLES) }),
    });
    expect(unmatchedOptions(spec, ctx)).toEqual([]);
  });
});

describe("L-Series", () => {
  const spec = resolveForm("L_SERIES")!;

  it("covers its tools row, which is option lines with quantities", () => {
    expect(coveredRoles(spec).has("L_TOOL")).toBe(true);
  });

  it("does not ask for anything the product code already says", () => {
    const keys = Object.keys(lSeriesSpecSchema.parse({ ui: "-Y" }));
    for (const derived of ["cuttingLength", "cuttingSurface", "model", "belt", "extended"]) {
      expect(keys, derived).not.toContain(derived);
    }
  });

  it("insists on a figure when the voltage is written in by hand", () => {
    expect(lSeriesSpecSchema.safeParse({ voltage: "other" }).success).toBe(false);
    expect(lSeriesSpecSchema.safeParse({ voltage: "other", voltageOtherVac: "380" }).success).toBe(true);
    expect(lSeriesSpecSchema.safeParse({ voltage: "220/230" }).success).toBe(true);
  });

  it("strips a stored shipping answer -- the field is gone from the schema", () => {
    // Packing and delivery moved to logistics' own document (2026-09-16); a
    // value saved before that change is dropped on the next parse rather
    // than rejected, so an old quote does not fail to load.
    const parsed = lSeriesSpecSchema.parse({ shipping: "crate-whole" });
    expect(parsed).not.toHaveProperty("shipping");
  });

  it("leaves nothing unmatched when every L-compatible role is on the item", () => {
    const ctx = formContext({
      item: formItem({ form: "L_SERIES", options: optionsFor(L_COMPATIBLE_ROLES) }),
    });
    expect(unmatchedOptions(spec, ctx)).toEqual([]);
  });
});

describe("M-Series", () => {
  const spec = resolveForm("M_SERIES")!;

  it("leaves nothing unmatched when every M-compatible role is on the item", () => {
    const ctx = formContext({
      item: formItem({ form: "M_SERIES", options: optionsFor(M_COMPATIBLE_ROLES) }),
    });
    expect(unmatchedOptions(spec, ctx)).toEqual([]);
  });
});
