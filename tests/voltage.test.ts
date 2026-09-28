import { describe, it, expect } from "vitest";
import {
  M_SERIES_VOLTAGES,
  X_CALIBRE_VOLTAGES,
  isMSeriesVoltage,
  transformerCodeFor,
} from "../src/lib/production-forms/voltage";
import { mSeriesSpecSchema, xCalibreSpecSchema, missingKeys } from "../src/lib/validation/production-spec";
import { resolveForm } from "../src/lib/production-forms/resolve";

describe("supply voltages", () => {
  it("offers 220/400/480 V on an M-Series and 400/480 V on an X-Calibre, no 415 V", () => {
    expect(M_SERIES_VOLTAGES).toEqual(["220V", "400V", "480V"]);
    expect(X_CALIBRE_VOLTAGES).toEqual(["400V", "480V"]);
    expect(mSeriesSpecSchema.safeParse({ voltage: "415V" }).success).toBe(false);
    expect(xCalibreSpecSchema.safeParse({ voltage: "220V" }).success).toBe(false);
    expect(xCalibreSpecSchema.safeParse({ voltage: "480V" }).success).toBe(true);
  });

  it("brings the matching transformer with 220 V and 480 V, none with 400 V", () => {
    expect(transformerCodeFor("220V")).toBe("TR220");
    expect(transformerCodeFor("480V")).toBe("TR480");
    expect(transformerCodeFor("400V")).toBeNull();
    expect(transformerCodeFor(undefined)).toBeNull();
    expect(isMSeriesVoltage("415V")).toBe(false);
  });

  it("will not let an M-Series or X-Calibre be finalized without one", () => {
    for (const form of ["M_SERIES", "X_CALIBRE"] as const) {
      const spec = resolveForm(form)!;
      expect(spec.requires, form).toContain("voltage");
      expect(missingKeys({}, spec.requires), form).toContain("voltage");
      expect(missingKeys({ voltage: "480V" }, spec.requires), form).not.toContain("voltage");
    }
  });
});
