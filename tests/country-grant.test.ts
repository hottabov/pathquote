import { describe, it, expect } from "vitest";
import { NO_COUNTRIES, grantFromSelection, parseCountryGrant } from "../src/lib/country-grant";

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

describe("grantFromSelection", () => {
  function selected(allCountries: boolean, codes: string[]): string[] {
    const result = grantFromSelection(allCountries, codes);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    return result.countries;
  }

  function selectionError(allCountries: boolean, codes: string[]): string {
    const result = grantFromSelection(allCountries, codes);
    if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.countries)}`);
    return result.error;
  }

  it('stores "*" for every country and ignores the list', () => {
    expect(selected(true, [])).toEqual(["*"]);
    expect(selected(true, ["US", "CA"])).toEqual(["*"]);
    // Leftover state under the switch is not validated: it is not a request.
    expect(selected(true, ["ZZ"])).toEqual(["*"]);
  });

  it("applies the script's rules to a list: upper-case, de-duplicate, sort", () => {
    expect(selected(false, ["us", "CA", "US"])).toEqual(["CA", "US"]);
    expect(selected(false, ["UK"])).toEqual(["GB"]);
  });

  it("agrees with parseCountryGrant for the same codes", () => {
    expect(selected(false, ["MX", "us", "CA"])).toEqual(ok("MX,us,CA"));
  });

  it("stores an empty list as no grant, never as every country", () => {
    expect(selected(false, [])).toEqual([]);
  });

  it("refuses an unknown code and names every one", () => {
    const message = selectionError(false, ["QQ", "US", "ZZ"]);
    expect(message).toContain('"QQ"');
    expect(message).toContain('"ZZ"');
  });

  it('refuses "*" in the list when the switch is off', () => {
    expect(selectionError(false, ["US", "*"])).toContain('"*"');
  });

  it("refuses an empty entry", () => {
    expect(selectionError(false, ["US", ""])).toContain('""');
  });
});
