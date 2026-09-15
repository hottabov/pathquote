import { describe, it, expect } from "vitest";
import { assignRails, railLengthM } from "../src/lib/production-forms/rails";

/**
 * A FabricPro runs over *one* table. It cannot straddle two, so a quote with
 * two tables and two FabricPros is two independent pairs, not one sum split
 * in half -- which is what summing every compatible table used to produce.
 *
 * The pairing is positional and needs no manager input: tables and
 * FabricPros are both read in document order, first with first.
 */
const table = (id: string, lengthM: number, fabricProCompatible = true) => ({
  id,
  code: "EL-2420",
  fabricProCompatible,
  sections: lengthM > 0 ? [{ lengthM, surface: "conveyor" as const }] : [],
});

describe("railLengthM", () => {
  it("is the table's own length when it is FabricPro compatible", () => {
    expect(railLengthM(table("el1", 7.2))).toBe(7.2);
  });

  it("is null for a table that is not FabricPro compatible", () => {
    expect(railLengthM(table("el1", 7.2, false))).toBeNull();
  });

  it("is null for a compatible table nobody has laid out yet", () => {
    expect(railLengthM(table("el1", 0))).toBeNull();
  });

  it("returns a clean single decimal rather than a float artefact", () => {
    // Three 1.2m modules: 3.5999999999999996 without the round.
    const el = { fabricProCompatible: true, sections: [{ lengthM: 1.2, surface: "conveyor" as const }, { lengthM: 1.2, surface: "conveyor" as const }, { lengthM: 1.2, surface: "conveyor" as const }] };
    expect(railLengthM(el)).toBe(3.6);
  });
});

describe("assignRails", () => {
  it("assigns nothing when the quote has no tables at all", () => {
    expect(assignRails([], ["fp1"]).size).toBe(0);
  });

  it("gives the one FabricPro the one compatible table", () => {
    const rails = assignRails([table("el1", 7.2)], ["fp1"]);

    expect(rails.get("fp1")).toEqual({ tableId: "el1", tableCode: "EL-2420", lengthM: 7.2 });
    expect(rails.has("el1")).toBe(false);
  });

  it("pairs two tables with two FabricPros one to one, never the sum", () => {
    const rails = assignRails([table("el1", 7.2), table("el2", 4.8)], ["fp1", "fp2"]);

    expect(rails.get("fp1")?.lengthM).toBe(7.2);
    expect(rails.get("fp2")?.lengthM).toBe(4.8);
  });

  it("skips a table that is not FabricPro compatible when pairing", () => {
    const rails = assignRails([table("el1", 7.2, false), table("el2", 4.8), table("el3", 3.6)], ["fp1", "fp2"]);

    expect(rails.get("fp1")?.tableId).toBe("el2");
    expect(rails.get("fp2")?.tableId).toBe("el3");
    expect(rails.has("el1")).toBe(false);
  });

  it("leaves a compatible table with no FabricPro pointing at itself, so its own form prints the rails", () => {
    const rails = assignRails([table("el1", 7.2), table("el2", 4.8)], ["fp1"]);

    expect(rails.get("fp1")?.tableId).toBe("el1");
    expect(rails.get("el2")).toEqual({ tableId: "el2", tableCode: "EL-2420", lengthM: 4.8 });
  });

  it("assigns every table when the quote carries no FabricPro at all", () => {
    const rails = assignRails([table("el1", 7.2)], []);

    expect(rails.get("el1")?.lengthM).toBe(7.2);
  });

  it("leaves a FabricPro with no compatible table unassigned rather than guessing", () => {
    const rails = assignRails([table("el1", 7.2)], ["fp1", "fp2"]);

    expect(rails.get("fp1")?.tableId).toBe("el1");
    expect(rails.has("fp2")).toBe(false);
  });

  it("never claims a table that is not FabricPro compatible, even with no FabricPro in the quote", () => {
    expect(assignRails([table("el1", 7.2, false)], []).size).toBe(0);
  });

  it("claims a compatible table that has no length yet, so the pairing does not slide onto the next one", () => {
    const rails = assignRails([table("el1", 0), table("el2", 4.8)], ["fp1", "fp2"]);

    expect(rails.get("fp1")).toEqual({ tableId: "el1", tableCode: "EL-2420", lengthM: null });
    expect(rails.get("fp2")?.lengthM).toBe(4.8);
  });
});
