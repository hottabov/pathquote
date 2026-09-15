import { describe, it, expect } from "vitest";
import { buildPatches, unmatchedOptions } from "../src/lib/production-forms/resolve";
import { easyLoaderSpecSchema } from "../src/lib/validation/production-spec";
import { formContext, formItem, xlsxForm } from "./helpers/fixtures";

const patchMap = (form: "M_SERIES" | "EASYLOADER", spec: Record<string, unknown>, options = []) =>
  Object.fromEntries(
    buildPatches(
      xlsxForm(form),
      formContext({ item: formItem({ form, spec, options, specs: { tableWidthMm: 2420 } }) })
    ).map((patch) => [patch.cell, patch.value])
  );

describe("VRB is standard fitment, not an option", () => {
  it("prints ticked on every M-Series form, with no VRB line on the quote", () => {
    expect(patchMap("M_SERIES", { ui: "-Y" }).F42).toBe("X");
  });

  it("does not claim to cover a VRB line, so an unexpected one still surfaces", () => {
    const vrb = { id: "o", code: "VRB-M", role: "VRB" as const, qty: 1, attributes: null };
    const ctx = formContext({ item: formItem({ form: "M_SERIES", options: [vrb] }) });

    expect(unmatchedOptions(xlsxForm("M_SERIES"), ctx).map((o) => o.code)).toEqual(["VRB-M"]);
  });
});

describe("EasyLoader synchronisation with the cutter", () => {
  it("defaults to yes when the spec has never been touched", () => {
    expect(easyLoaderSpecSchema.parse({}).syncWithCutter).toBe(true);
    expect(patchMap("EASYLOADER", {}).D56).toBe("X");
  });

  it("prints ticked when it is on", () => {
    expect(patchMap("EASYLOADER", { syncWithCutter: true }).D56).toBe("X");
  });

  it("prints nothing only when a manager unticked it", () => {
    expect(patchMap("EASYLOADER", { syncWithCutter: false }).D56).toBeUndefined();
  });
});
