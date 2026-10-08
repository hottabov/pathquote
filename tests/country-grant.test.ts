import { describe, it, expect } from "vitest";
import { NO_COUNTRIES, parseCountryGrant } from "../src/lib/country-grant";

function ok(input: string): string[] {
  const result = parseCountryGrant(input);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.countries;
}

function error(input: string): string {
  const result = parseCountryGrant(input);
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.countries)}`);
  return result.error;
}

describe("parseCountryGrant", () => {
  it("accepts a list of ISO codes", () => {
    expect(ok("US,CA")).toEqual(["CA", "US"]);
  });

  it("upper-cases, trims, de-duplicates and sorts", () => {
    expect(ok(" us , ca,US ")).toEqual(["CA", "US"]);
  });

  it("accepts a single code", () => {
    expect(ok("MX")).toEqual(["MX"]);
  });

  it("maps a known alias to its ISO code", () => {
    expect(ok("UK")).toEqual(["GB"]);
  });

  it('accepts "*" as every country', () => {
    expect(ok("*")).toEqual(["*"]);
  });

  it('refuses "*" beside other entries', () => {
    expect(error("US,*")).toContain("only entry");
  });

  it("clears the grant with the explicit word, in any case", () => {
    expect(NO_COUNTRIES).toBe("none");
    expect(ok("none")).toEqual([]);
    expect(ok("NONE")).toEqual([]);
  });

  it("refuses an unknown code and names it", () => {
    expect(error("US,ZZ")).toContain('"ZZ"');
  });

  it("names every unknown code, not just the first", () => {
    const message = error("QQ,US,ZZ");
    expect(message).toContain('"QQ"');
    expect(message).toContain('"ZZ"');
  });

  it("refuses an empty argument rather than reading it as a grant of anything", () => {
    expect(error("")).toContain("no countries");
    expect(error("   ")).toContain("no countries");
  });

  it("refuses an empty entry", () => {
    expect(error("US,,CA")).toContain("empty entry");
    expect(error("US,")).toContain("empty entry");
  });
});
