import { describe, it, expect } from "vitest";
import { coveredRoles, resolveForm, unmatchedOptions } from "../src/lib/production-forms/resolve";
import { FORM_SPECS } from "../src/lib/production-forms/specs";
import { isXlsxForm } from "../src/lib/production-forms/types";
import { lSeriesSpecSchema, xCalibreSpecSchema } from "../src/lib/validation/production-spec";
import { formContext, formItem } from "./helpers/fixtures";

describe("the form registry", () => {
  it("has exactly one spec per ProductionForm value it claims", () => {
    const forms = FORM_SPECS.map((spec) => spec.form);
    expect(new Set(forms).size).toBe(forms.length);
  });

  it("gives every component-rendered form an explicit coverage list", () => {
    for (const spec of FORM_SPECS.filter((s) => !isXlsxForm(s))) {
      // A JSX layout is not enumerable, so coverage cannot be assembled from
      // the ticks. An empty list would silently send every option to the
      // Additional items sheet.
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

  it("sends a DuctMasTer to the Additional items sheet — the form has no box for it", () => {
    // DMT is compatible with the X series in the catalogue but absent from
    // the printed form. Surfacing it is the point: silently dropping a
    // A$18,240 option is the failure this engine exists to prevent.
    const dmt = { id: "o", code: "DMT", role: "DMT" as const, qty: 1, attributes: null };
    const ctx = formContext({ item: formItem({ form: "X_CALIBRE", options: [dmt] }) });

    expect(unmatchedOptions(spec, ctx).map((o) => o.code)).toEqual(["DMT"]);
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

  it("accepts the three shipping options the form prints, and nothing else", () => {
    for (const shipping of ["complete", "crate-disassembled", "crate-whole"]) {
      expect(lSeriesSpecSchema.safeParse({ shipping }).success, shipping).toBe(true);
    }
    expect(lSeriesSpecSchema.safeParse({ shipping: "post" }).success).toBe(false);
  });
});
