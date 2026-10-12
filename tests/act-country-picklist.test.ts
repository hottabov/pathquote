import { describe, it, expect } from "vitest";
import { actCountryValue, countryPicklistCoverage } from "../src/lib/act/country-picklist";
import { COUNTRIES, normalizeCountryInput } from "../src/lib/countries";

// The Countries picklist's items have never been read from this repo, so
// these lists are made up to exercise the rules -- not ACT!'s list.
const items = (...values: (string | null)[]) => values.map((value, i) => ({ id: `item-${i}`, value, description: null }));

describe("actCountryValue", () => {
  it("returns the picklist's own spelling of an ISO country", () => {
    const list = items("Australia", "New Zealand", "United Kingdom");
    expect(actCountryValue("AU", list)).toBe("Australia");
    expect(actCountryValue("GB", list)).toBe("United Kingdom");
  });

  it("matches the colloquial names countries.ts already reads ACT!'s free text with", () => {
    const list = items("China", "Turkey", "Korea", "USA", "Taiwan");
    expect(actCountryValue("CN", list)).toBe("China");
    expect(actCountryValue("TR", list)).toBe("Turkey");
    expect(actCountryValue("KR", list)).toBe("Korea");
    expect(actCountryValue("US", list)).toBe("USA");
    expect(actCountryValue("TW", list)).toBe("Taiwan");
  });

  it("returns only values the inbound sync reads back as the same country", () => {
    const list = items("Australia", "China", "USA", "United Kingdom", "Holland", "Viet Nam");
    for (const { code } of COUNTRIES) {
      const value = actCountryValue(code, list);
      if (value !== null) expect(normalizeCountryInput(value)).toBe(code);
    }
  });

  it("leaves out a country no item spells, rather than guess one", () => {
    expect(actCountryValue("FJ", items("Australia", "New Zealand"))).toBeNull();
  });

  it("never picks an item that does not resolve to a country", () => {
    // "United" could be either of the two commonest countries in the data.
    expect(actCountryValue("US", items("United", "North America", "U S of A"))).toBeNull();
  });

  it("leaves out a blank or unreadable company country", () => {
    const list = items("Australia");
    expect(actCountryValue(null, list)).toBeNull();
    expect(actCountryValue("", list)).toBeNull();
    expect(actCountryValue("Atlantis", list)).toBeNull();
  });

  it("reads a legacy free-text Company.country the way the rest of PathQuote does", () => {
    expect(actCountryValue("Australia", items("Australia"))).toBe("Australia");
    expect(actCountryValue("U.S.A.", items("United States"))).toBe("United States");
  });

  it("prefers the item spelled as the official English name when several spell one country", () => {
    expect(actCountryValue("GB", items("UK", "England", "United Kingdom"))).toBe("United Kingdom");
  });

  it("otherwise takes the first in the list's own order, so the same list always gives the same answer", () => {
    // Neither is "United States of America", the official name.
    expect(actCountryValue("US", items("United States", "USA"))).toBe("United States");
    expect(actCountryValue("US", items("USA", "United States"))).toBe("USA");
  });

  it("sends an item exactly as listed, surrounding spaces and all", () => {
    expect(actCountryValue("AU", items(" Australia "))).toBe(" Australia ");
  });

  it("passes over items with no value", () => {
    expect(actCountryValue("AU", items(null, "", "Australia"))).toBe("Australia");
  });
});

describe("countryPicklistCoverage", () => {
  it("counts the ISO codes a list covers and names the ones it does not", () => {
    expect(countryPicklistCoverage(["AU", "NZ", "US", "FJ"], items("Australia", "New Zealand", "USA"))).toEqual({
      mapped: 3,
      missing: ["FJ"],
    });
  });

  it("covers nothing with an empty list", () => {
    expect(countryPicklistCoverage(["AU", "GB"], [])).toEqual({ mapped: 0, missing: ["AU", "GB"] });
  });
});
