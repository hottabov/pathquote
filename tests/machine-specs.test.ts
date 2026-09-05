import { describe, it, expect } from "vitest";
import { machineSpecSentence, extraSpecVars } from "../src/lib/machine-specs";

// Pure module — no @/lib/db import, so this never needs DATABASE_URL set,
// same as tests/quotation-data.test.ts. Both functions read `Product.specs`
// (src/lib/validation/product-specs.ts); the product code never enters.

describe("machineSpecSentence", () => {
  it("builds the M-Series sentence with both height and width", () => {
    expect(machineSpecSentence("M-Series", { cutHeightCm: 3, cutWidthCm: 390 })).toBe(
      "M-Series Cutting Machine, 3cm compressed lay height, 390cm cutting width"
    );
  });

  it("builds the X-Calibre sentence with both height and width", () => {
    expect(machineSpecSentence("X-Calibre", { cutHeightCm: 3, cutWidthCm: 180 })).toBe(
      "X-Calibre Cutting Machine, 3cm compressed lay height, 180cm cutting width"
    );
  });

  it("prints the real cut of a 220-family machine (227cm), not the family", () => {
    expect(machineSpecSentence("M-Series", { cutHeightCm: 5, cutWidthCm: 227, widthCode: 220 })).toBe(
      "M-Series Cutting Machine, 5cm compressed lay height, 227cm cutting width"
    );
  });

  it("builds the L-Series sentence with width only", () => {
    expect(machineSpecSentence("L-Series", { cutWidthCm: 320 })).toBe("L-Series Cutting Machine with 320cm cutting width");
  });

  it("ignores the L-Series belt and length variants (width unaffected)", () => {
    expect(machineSpecSentence("L-Series", { cutWidthCm: 320, belt: "felt", extended: true })).toBe(
      "L-Series Cutting Machine with 320cm cutting width"
    );
  });

  it("returns null when there is no width, even with a height", () => {
    expect(machineSpecSentence("M-Series", { cutHeightCm: 3 })).toBeNull();
  });

  it("returns null for a product with no cutting specs (a table, software)", () => {
    expect(machineSpecSentence("Easy-Loader", { tableWidthMm: 2020 })).toBeNull();
    expect(machineSpecSentence("PathWorks", { softwareMode: "standalone" })).toBeNull();
    expect(machineSpecSentence("Punchline", {})).toBeNull();
  });
});

describe("extraSpecVars", () => {
  it("exposes tableWidthMm as a string for an EasyLoader", () => {
    expect(extraSpecVars({ tableWidthMm: 2020 })).toEqual({ tableWidthMm: "2020" });
    expect(extraSpecVars({ tableWidthMm: 2420 })).toEqual({ tableWidthMm: "2420" });
  });

  it("exposes paperWidthMm as a string for a Punchline", () => {
    expect(extraSpecVars({ paperWidthMm: 1880 })).toEqual({ paperWidthMm: "1880" });
    expect(extraSpecVars({ paperWidthMm: 2280 })).toEqual({ paperWidthMm: "2280" });
  });

  it("exposes both when both are present", () => {
    expect(extraSpecVars({ tableWidthMm: 2020, paperWidthMm: 1880 })).toEqual({
      tableWidthMm: "2020",
      paperWidthMm: "1880",
    });
  });

  it("returns an empty object when neither width is recorded", () => {
    expect(extraSpecVars({})).toEqual({});
    expect(extraSpecVars({ cutHeightCm: 3, cutWidthCm: 390 })).toEqual({});
    expect(extraSpecVars({ cutWidthCm: 320 })).toEqual({});
  });
});
