import { describe, it, expect } from "vitest";
import { normaliseCompanyName, companyKey } from "../src/lib/act/company-key";

describe("normaliseCompanyName", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normaliseCompanyName("  Acme   Cutting  ")).toBe("acme cutting");
  });

  it("strips legal suffixes", () => {
    expect(normaliseCompanyName("Acme Pty Ltd")).toBe("acme");
    expect(normaliseCompanyName("Acme GmbH")).toBe("acme");
    expect(normaliseCompanyName("Acme Inc.")).toBe("acme");
    expect(normaliseCompanyName("Acme Holdings")).toBe("acme");
  });

  it("collapses the spelling variants that differ only by punctuation", () => {
    expect(normaliseCompanyName("Efka America Inc.")).toBe(
      normaliseCompanyName("EFKA AMERICA, INC"),
    );
  });

  it("keeps ampersands, which distinguish real names", () => {
    expect(normaliseCompanyName("Norco Composites & GRP")).toBe("norco composites & grp");
  });

  it("does not strip a suffix that is the whole name", () => {
    // "Group" alone is a company name, not a suffix to discard.
    expect(normaliseCompanyName("Group")).toBe("group");
  });

  it("returns an empty string for junk", () => {
    expect(normaliseCompanyName("   ")).toBe("");
    expect(normaliseCompanyName("...")).toBe("");
  });
});

describe("companyKey", () => {
  it("joins the normalised name and the country code", () => {
    expect(companyKey("Acme Pty Ltd", "AU")).toBe("acme|AU");
  });

  it("separates the same name in different countries", () => {
    // adient genuinely has offices in five countries; a quote to Mexico is not
    // a quote to Romania.
    expect(companyKey("Adient", "MX")).not.toBe(companyKey("Adient", "RO"));
  });

  it("joins USA and United States once the country is already ISO", () => {
    expect(companyKey("Aaon", "US")).toBe(companyKey("AAON Inc", "US"));
  });

  it("uses a placeholder when the country did not resolve", () => {
    expect(companyKey("Acme", null)).toBe("acme|??");
  });

  it("returns null when there is no usable name", () => {
    expect(companyKey("", "AU")).toBeNull();
    expect(companyKey("   ", "AU")).toBeNull();
  });
});
