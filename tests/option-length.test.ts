import { describe, it, expect } from "vitest";
import { formatMetres } from "@/lib/option-length";

// The per-unit length itself is `Option.unitLengthM` (a column, read by the
// options editor straight off `CompatibleOption.unitLengthM`); this module
// only formats the running total.

describe("formatMetres", () => {
  it("drops trailing zeros so a whole number of metres reads as one", () => {
    expect(formatMetres(1.2 * 5)).toBe("6 m");
  });

  it("keeps a fractional total", () => {
    expect(formatMetres(1.2 * 4)).toBe("4.8 m");
  });

  it("absorbs binary floating-point drift", () => {
    // 1.2 * 3 is 3.5999999999999996 in IEEE 754.
    expect(formatMetres(1.2 * 3)).toBe("3.6 m");
  });

  it("formats a single MTS travel metre", () => {
    expect(formatMetres(1 * 1)).toBe("1 m");
  });
});
