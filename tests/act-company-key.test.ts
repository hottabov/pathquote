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

  it("strips a legal suffix that punctuation turned into single letters", () => {
    // "S.R.L." survives the punctuation strip as "s r l", which matches no
    // suffix. Without rejoining it, NOITEX S.R.L. and NOITEX SRL are two
    // companies -- and both spellings are in the real data.
    expect(normaliseCompanyName("NOITEX S.R.L.")).toBe(normaliseCompanyName("NOITEX SRL"));
    expect(normaliseCompanyName("Acme G.m.b.H.")).toBe(normaliseCompanyName("Acme GmbH"));
    expect(normaliseCompanyName("Acme S.p.A.")).toBe(normaliseCompanyName("Acme SpA"));
    expect(normaliseCompanyName("Acme B.V.")).toBe(normaliseCompanyName("Acme BV"));
    expect(normaliseCompanyName("Acme L.L.C.")).toBe(normaliseCompanyName("Acme LLC"));
  });

  it("only rejoins a trailing run, so leading initials survive", () => {
    // The run has to be what ends the name. Initials at the front are part of
    // it, not a legal form.
    expect(normaliseCompanyName("A B C Trading")).toBe("a b c trading");
  });

  it("leaves a rejoined run alone when it is not a legal form", () => {
    // "K G" joins to "kg", which is in no suffix list, so it stays as the name.
    expect(normaliseCompanyName("Smith K.G.")).toBe("smith kg");
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
