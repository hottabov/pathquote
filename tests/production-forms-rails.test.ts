import { describe, it, expect } from "vitest";
import { railLengthM } from "../src/lib/production-forms/rails";

/**
 * Each FabricPro compatible table carries its own rails, as long as the table
 * itself (8.4 m table -> 8.4 m rail and 8.4 m power rail). Nothing is paired
 * with a FabricPro and nothing is summed across tables.
 */
const table = (lengthM: number, fabricProCompatible = true) => ({
  fabricProCompatible,
  sections: lengthM > 0 ? [{ lengthM, surface: "conveyor" as const }] : [],
});

describe("railLengthM", () => {
  it("is the table's own length when it is FabricPro compatible", () => {
    expect(railLengthM(table(8.4))).toBe(8.4);
  });

  it("is null for a table nobody made FabricPro compatible", () => {
    expect(railLengthM(table(8.4, false))).toBeNull();
  });

  it("is null while the table has no layout yet", () => {
    expect(railLengthM(table(0))).toBeNull();
  });

  it("adds every section of the one table", () => {
    const el = {
      fabricProCompatible: true,
      sections: [
        { lengthM: 2.4, surface: "conveyor" as const },
        { lengthM: 1.2, surface: "static" as const },
      ],
    };
    expect(railLengthM(el)).toBe(3.6);
  });
});
