import { describe, it, expect } from "vitest";
import { COUNTRIES, countryName, isValidCountryCode, normalizeCountryInput, displayCountry } from "../src/lib/countries";

describe("COUNTRIES", () => {
  it("is sorted by name", () => {
    const names = COUNTRIES.map((c) => c.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it("contains a substantial number of ISO countries with 2-letter codes", () => {
    expect(COUNTRIES.length).toBeGreaterThan(200);
    for (const c of COUNTRIES) {
      expect(c.code).toMatch(/^[A-Z]{2}$/);
      expect(c.name.length).toBeGreaterThan(0);
    }
  });

  it("includes Australia, the US, and the UK", () => {
    const codes = COUNTRIES.map((c) => c.code);
    expect(codes).toContain("AU");
    expect(codes).toContain("US");
    expect(codes).toContain("GB");
  });
});

describe("isValidCountryCode", () => {
  it("accepts real ISO alpha-2 codes", () => {
    expect(isValidCountryCode("AU")).toBe(true);
    expect(isValidCountryCode("US")).toBe(true);
  });

  it("rejects unknown codes", () => {
    expect(isValidCountryCode("ZZ")).toBe(false);
    expect(isValidCountryCode("")).toBe(false);
    expect(isValidCountryCode("au")).toBe(false); // case-sensitive
  });
});

describe("countryName", () => {
  it("returns the English name for a valid code", () => {
    expect(countryName("AU")).toBe("Australia");
  });

  it("returns undefined for an unknown code", () => {
    expect(countryName("ZZ")).toBeUndefined();
  });
});

describe("normalizeCountryInput", () => {
  it("passes an already-valid code straight through", () => {
    expect(normalizeCountryInput("AU")).toBe("AU");
    expect(normalizeCountryInput("au")).toBe("AU");
  });

  it("maps an exact official name (case-insensitive)", () => {
    expect(normalizeCountryInput("Australia")).toBe("AU");
    expect(normalizeCountryInput("australia")).toBe("AU");
  });

  it("maps common aliases", () => {
    expect(normalizeCountryInput("USA")).toBe("US");
    expect(normalizeCountryInput("United States")).toBe("US");
    expect(normalizeCountryInput("UK")).toBe("GB");
  });

  it("trims whitespace", () => {
    expect(normalizeCountryInput("  Australia  ")).toBe("AU");
  });

  it("returns null for unmappable input", () => {
    expect(normalizeCountryInput("Narnia")).toBeNull();
    expect(normalizeCountryInput("")).toBeNull();
    expect(normalizeCountryInput(null)).toBeNull();
    expect(normalizeCountryInput(undefined)).toBeNull();
  });
});

describe("displayCountry", () => {
  it("resolves an ISO code to its English name", () => {
    expect(displayCountry("AU")).toBe("Australia");
  });

  it("resolves a normalizable legacy free-text value", () => {
    expect(displayCountry("USA")).toBe("United States of America");
    expect(displayCountry("UK")).toBe("United Kingdom");
  });

  it("falls back to the raw value when it can't be mapped", () => {
    expect(displayCountry("Narnia")).toBe("Narnia");
  });

  it("returns null for empty/null/undefined input", () => {
    expect(displayCountry(null)).toBeNull();
    expect(displayCountry(undefined)).toBeNull();
    expect(displayCountry("")).toBeNull();
  });
});

/**
 * The spellings the ACT! import actually met. 35 distinct values failed to
 * resolve across 271 contacts, because the generated table holds the official
 * ISO names ("People's Republic of China", "Türkiye", "Taiwan, Province of
 * China") while twenty years of free text holds the short ones.
 *
 * This matters beyond display: `Company.country` decides which manager sees a
 * client (`companyWhereForUser`), so a country that does not resolve is a
 * client no country grant can reveal.
 */
describe("normalizeCountryInput against the real ACT! spellings", () => {
  it("resolves colloquial names the official ISO list spells out in full", () => {
    expect(normalizeCountryInput("China")).toBe("CN");
    expect(normalizeCountryInput("Turkey")).toBe("TR");
    expect(normalizeCountryInput("Taiwan")).toBe("TW");
    expect(normalizeCountryInput("Iran")).toBe("IR");
    expect(normalizeCountryInput("Moldova")).toBe("MD");
    expect(normalizeCountryInput("Macedonia")).toBe("MK");
    expect(normalizeCountryInput("Serbia (Republic of)")).toBe("RS");
    expect(normalizeCountryInput("Slovak Republic")).toBe("SK");
  });

  it("resolves alternative and longer names for the same country", () => {
    expect(normalizeCountryInput("Fiji Islands")).toBe("FJ");
    expect(normalizeCountryInput("The Netherlands")).toBe("NL");
    expect(normalizeCountryInput("Holland")).toBe("NL");
    expect(normalizeCountryInput("Kingdom of Saudi Arabia")).toBe("SA");
    expect(normalizeCountryInput("US Virgin Islands")).toBe("VI");
  });

  it("resolves the Australian shorthand, written both ways", () => {
    expect(normalizeCountryInput("Aust")).toBe("AU");
    expect(normalizeCountryInput("Aust.")).toBe("AU");
  });

  it("maps a bare Korea to the South", () => {
    // Formally ambiguous, and not ambiguous in this data: South Korea is a
    // market for industrial cutting machines and North Korea is sanctioned.
    expect(normalizeCountryInput("Korea")).toBe("KR");
  });

  it("refuses a typo rather than translating it", () => {
    // These are wrong in ACT!, which owns contact data. Mapping them here would
    // carry the mistake forever and hide it from whoever can correct it.
    expect(normalizeCountryInput("UDSA")).toBeNull();
    expect(normalizeCountryInput("YUSA")).toBeNull();
    expect(normalizeCountryInput("Lativa")).toBeNull();
    expect(normalizeCountryInput("Sru Lanka")).toBeNull();
    expect(normalizeCountryInput("Marocco")).toBeNull();
    expect(normalizeCountryInput("Unitted Kingdom")).toBeNull();
    expect(normalizeCountryInput("Trinidad and Tabago")).toBeNull();
  });

  it("refuses a region, a city or a truncation", () => {
    // Guessing a country from a city is how a client lands in the wrong
    // manager's list, and "United" could be either of the two commonest values
    // in this very data.
    expect(normalizeCountryInput("North America")).toBeNull();
    expect(normalizeCountryInput("West Indies")).toBeNull();
    expect(normalizeCountryInput("Africa")).toBeNull();
    expect(normalizeCountryInput("Launceston")).toBeNull();
    expect(normalizeCountryInput("Istanbul")).toBeNull();
    expect(normalizeCountryInput("Québec")).toBeNull();
    expect(normalizeCountryInput("United")).toBeNull();
    expect(normalizeCountryInput("P.R.")).toBeNull();
  });
});
