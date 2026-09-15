import { describe, it, expect } from "vitest";
import {
  MTS_INCLUDED_M,
  mtsTravelMetres,
  normaliseMtsSelections,
  readMtsMetres,
} from "../src/lib/production-forms/mts";

describe("mtsTravelMetres", () => {
  it("charges nothing up to the distance the MTS price covers", () => {
    expect(MTS_INCLUDED_M).toBe(9);
    for (const metres of [0, 1, 8, 9]) expect(mtsTravelMetres(metres)).toBe(0);
  });

  it("charges per metre past it", () => {
    expect(mtsTravelMetres(10)).toBe(1);
    expect(mtsTravelMetres(14)).toBe(5);
  });

  it("rounds a part metre up — MTS-M is sold whole", () => {
    expect(mtsTravelMetres(12.5)).toBe(4);
    expect(mtsTravelMetres(9.1)).toBe(1);
  });

  it("charges nothing for a length nobody typed", () => {
    for (const value of [undefined, null, "", "abc", NaN]) expect(mtsTravelMetres(value)).toBe(0);
  });

  it("reads a length typed as a string, as the attribute inputs send it", () => {
    expect(mtsTravelMetres("14")).toBe(5);
  });
});

describe("readMtsMetres", () => {
  it("reads the metres off an MTS line's attributes", () => {
    expect(readMtsMetres({ metres: 14 })).toBe(14);
    expect(readMtsMetres({ metres: "14" })).toBe(14);
  });

  it("is undefined for anything that is not a length", () => {
    for (const value of [null, undefined, {}, [], "x", { metres: "abc" }]) {
      expect(readMtsMetres(value)).toBeUndefined();
    }
  });
});

describe("normaliseMtsSelections", () => {
  const ROLES: Record<string, string> = { mts: "MTS", travel: "MTS_TRAVEL", crate: "CRATE" };
  const roleOf = (id: string) => ROLES[id] ?? null;
  const sel = (optionId: string, qty = 1, attributes?: Record<string, unknown>) => ({
    optionId,
    qty,
    attributes,
  });

  it("never lets the manager's own MTS-M through", () => {
    const { selections } = normaliseMtsSelections([sel("mts", 1, { metres: 4 }), sel("travel", 7)], roleOf);

    expect(selections.map((s) => s.optionId)).toEqual(["mts"]);
  });

  it("asks for the metres past the included distance", () => {
    expect(normaliseMtsSelections([sel("mts", 1, { metres: 12 })], roleOf).travelMetres).toBe(3);
  });

  it("asks for nothing when the run fits the MTS price", () => {
    expect(normaliseMtsSelections([sel("mts", 1, { metres: 7 })], roleOf).travelMetres).toBe(0);
  });

  it("asks for nothing when the MTS itself was not selected", () => {
    const { selections, travelMetres } = normaliseMtsSelections([sel("travel", 5), sel("crate")], roleOf);

    expect(selections.map((s) => s.optionId)).toEqual(["crate"]);
    expect(travelMetres).toBe(0);
  });

  it("forces one MTS however many arrive", () => {
    const { selections } = normaliseMtsSelections([sel("mts", 3, { metres: 12 })], roleOf);

    expect(selections[0].qty).toBe(1);
    expect(selections[0].attributes).toEqual({ metres: 12 });
  });

  it("leaves every other option exactly as it came", () => {
    const crate = sel("crate", 2, { note: "x" });
    const { selections } = normaliseMtsSelections([crate], roleOf);

    expect(selections).toEqual([crate]);
  });
});
