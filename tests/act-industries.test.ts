import { describe, it, expect } from "vitest";
import {
  buildIndustryKnownCheck,
  buildIndustryLookup,
  buildIndustryResolver,
  loadActIndustries,
} from "../src/lib/act/industries";

describe("buildIndustryResolver", () => {
  const resolve = buildIndustryResolver();

  it("maps a known raw spelling to its canonical segment", () => {
    expect(resolve("Apparel")).toBe("Apparel");
    expect(resolve("Furniture")).toBe("Furniture & Upholstery");
  });

  it("ignores case and surrounding whitespace", () => {
    expect(resolve("  apparel ")).toBe(resolve("Apparel"));
  });

  it("returns null for values that are not industries", () => {
    expect(resolve("NIL")).toBeNull();
  });

  it("returns null for an unknown spelling rather than inventing one", () => {
    // The importer must never create an industry row: free text is what
    // produced 335 spellings in the first place.
    expect(resolve("Underwater Basket Weaving")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(resolve(null)).toBeNull();
    expect(resolve("")).toBeNull();
    expect(resolve("   ")).toBeNull();
  });

  it("resolves every canonical segment to itself", () => {
    for (const name of loadActIndustries().canonical) {
      expect(resolve(name)).toBe(name);
    }
  });

  // The three spellings the first full dry run found with no entry at all.
  it("resolves the spellings the first dry run found unmapped", () => {
    expect(resolve("Bags")).toBe("Bags, Luggage & Cases");
    expect(resolve("Machinery dealer")).toBe("Equipment & Materials Suppliers");
    expect(resolve("Signage / Laser cutting")).toBe("Signs, Graphics & Display");
  });
});

describe("buildIndustryKnownCheck", () => {
  const isKnown = buildIndustryKnownCheck();
  const resolve = buildIndustryResolver();

  it("knows a spelling that maps to a segment", () => {
    expect(isKnown("Furniture")).toBe(true);
  });

  it("knows a spelling the table maps to null on purpose", () => {
    // Not an industry, and the table says so. That is an opinion, not a gap.
    expect(resolve("NIL")).toBeNull();
    expect(isKnown("NIL")).toBe(true);
    expect(isKnown("Poor info")).toBe(true);
    expect(isKnown("prospect")).toBe(true);
  });

  it("does not know an invented spelling", () => {
    expect(resolve("Underwater Basket Weaving")).toBeNull();
    expect(isKnown("Underwater Basket Weaving")).toBe(false);
  });

  it("ignores case and surrounding whitespace, as the resolver does", () => {
    expect(isKnown("nil")).toBe(true);
    expect(isKnown("  Nil  ")).toBe(true);
    expect(isKnown("  furniture ")).toBe(true);
  });

  it("knows every canonical segment", () => {
    for (const name of loadActIndustries().canonical) {
      expect(isKnown(name)).toBe(true);
    }
  });

  it("has no opinion about empty input", () => {
    expect(isKnown(null)).toBe(false);
    expect(isKnown(undefined)).toBe(false);
    expect(isKnown("")).toBe(false);
    expect(isKnown("   ")).toBe(false);
  });

  it("knows every spelling in the table, so nothing in it is ever reported as unmapped", () => {
    for (const alias of Object.keys(loadActIndustries().aliases)) {
      expect(isKnown(alias)).toBe(true);
    }
  });
});

describe("buildIndustryLookup", () => {
  const data = {
    canonical: ["Marine"],
    aliases: { Boating: "Marine", NIL: null },
  };
  const lookup = buildIndustryLookup(data);

  it("separates a null that was decided from a null that is a gap", () => {
    expect(lookup.resolve("NIL")).toBeNull();
    expect(lookup.isKnown("NIL")).toBe(true);

    expect(lookup.resolve("Yachting")).toBeNull();
    expect(lookup.isKnown("Yachting")).toBe(false);
  });

  it("agrees with the standalone resolver and known check over the same data", () => {
    const resolve = buildIndustryResolver(data);
    const isKnown = buildIndustryKnownCheck(data);
    for (const raw of ["Boating", "boating", "Marine", "NIL", "Yachting", "", null]) {
      expect(lookup.resolve(raw)).toBe(resolve(raw));
      expect(lookup.isKnown(raw)).toBe(isKnown(raw));
    }
  });
});
