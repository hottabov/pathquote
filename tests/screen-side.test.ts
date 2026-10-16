import { ProductionForm } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { FORM_SPECS } from "@/lib/production-forms/specs";
import { resolveForm } from "@/lib/production-forms/resolve";
import { formHasScreenSide } from "@/lib/production-forms/screen-side";

// `formHasScreenSide` (zod-free, for the builder's client bundle) stands in
// for `resolveForm(form) !== null && !NO_SCREEN_SIDE.has(form)`. That only
// holds while every ProductionForm value has a spec, so this pins it.

describe("formHasScreenSide", () => {
  it("every ProductionForm has a spec, so 'is a form' means 'has a spec'", () => {
    expect(new Set(FORM_SPECS.map((spec) => spec.form))).toEqual(new Set(Object.values(ProductionForm)));
  });

  it("agrees with resolveForm for every form, null and undefined", () => {
    const NO_SIDE = new Set<ProductionForm>(["HDRF", "LNS", "FP_TROLLEY"]);
    for (const form of [...Object.values(ProductionForm), null, undefined]) {
      const viaSpecs = form != null && resolveForm(form) !== null && !NO_SIDE.has(form);
      expect(formHasScreenSide(form)).toBe(viaSpecs);
    }
  });
});
