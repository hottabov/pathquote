import { describe, it, expect } from "vitest";
import { buildIndustryResolver, loadActIndustries } from "../src/lib/act/industries";

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
});
