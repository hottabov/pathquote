import { describe, it, expect } from "vitest";
import { companyKey } from "../src/lib/act/company-key";
import { formatGenericChannel, mapContact } from "../src/lib/act/map";
import type { ActContact } from "../src/lib/act/types";

const resolveIndustry = (raw: string | null | undefined) =>
  raw === "Furniture" ? "Furniture & Upholstery" : null;

function contact(overrides: Partial<ActContact> = {}): ActContact {
  return {
    id: "72acf7a4-5af5-422d-8905-f0fe96361cb6",
    companyID: "",
    idStatus: "Prospect",
    contactType: "Contact",
    isPrivate: false,
    firstName: "Hans",
    lastName: "Helmer",
    jobTitle: "Plant Manager",
    emailAddress: "hans@efka.example",
    businessPhone: "404 457 7006",
    mobilePhone: null,
    company: "Efka America Inc.",
    website: "https://efka.example",
    businessAddress: {
      line1: "3715 Northcrest Rd.",
      line2: "Suite 10",
      line3: null,
      city: "Atlanta",
      state: "GA",
      postalCode: "30340",
      country: "United States",
    },
    recordManagerID: "015cbe53-2040-4179-8734-295732f774e5",
    recordManager: "David Cook",
    customFields: { rep: "David Cook", user6: "Furniture" },
    created: "2010-11-18T18:51:06+11:00",
    edited: "2023-08-26T03:24:14+10:00",
    ...overrides,
  };
}

describe("mapContact", () => {
  it("maps a complete contact", () => {
    const result = mapContact(contact(), resolveIndustry);
    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") return;

    expect(result.contact).toMatchObject({
      actContactId: "72acf7a4-5af5-422d-8905-f0fe96361cb6",
      firstName: "Hans",
      lastName: "Helmer",
      email: "hans@efka.example",
      phone: "+14044577006",
      position: "Plant Manager",
      actAccountMgr: "David Cook",
    });
    expect(result.contact.actEditedAt.toISOString()).toBe("2023-08-25T17:24:14.000Z");

    expect(result.company).toMatchObject({
      actCompanyKey: "efka america|US",
      actCompanyId: null,
      name: "Efka America Inc.",
      street: "3715 Northcrest Rd., Suite 10",
      city: "Atlanta",
      country: "US",
      industry: "Furniture & Upholstery",
      actStatus: "Prospect",
      actRecordManagerId: "015cbe53-2040-4179-8734-295732f774e5",
    });
  });

  it("lowercases the email", () => {
    const result = mapContact(contact({ emailAddress: "Hans@EFKA.Example" }), resolveIndustry);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.contact.email).toBe("hans@efka.example");
  });

  it("carries the ACT! company id when the contact is linked to one", () => {
    const result = mapContact(
      contact({ companyID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
      resolveIndustry,
    );
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.company.actCompanyId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("leaves industry null when the raw value is not in the alias table", () => {
    const result = mapContact(contact({ customFields: { user6: "Wat" } }), resolveIndustry);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.company.industry).toBeNull();
  });

  it("skips Personal contacts as their own explicit case", () => {
    // These are the director's own and he shares them with nobody. The API
    // query applies no status filter, so the mapper is the only barrier.
    expect(mapContact(contact({ idStatus: "Personal" }), resolveIndustry)).toEqual({
      kind: "skipped",
      reason: "personal",
    });
  });

  it("skips private records", () => {
    expect(mapContact(contact({ isPrivate: true }), resolveIndustry)).toEqual({
      kind: "skipped",
      reason: "private",
    });
  });

  it("skips anything that is not a Contact", () => {
    expect(mapContact(contact({ contactType: "User" }), resolveIndustry)).toEqual({
      kind: "skipped",
      reason: "not-a-contact",
    });
  });

  it("skips inactive statuses", () => {
    expect(mapContact(contact({ idStatus: "Dead Prospect" }), resolveIndustry)).toEqual({
      kind: "skipped",
      reason: "inactive-status",
    });
    expect(mapContact(contact({ idStatus: null }), resolveIndustry)).toEqual({
      kind: "skipped",
      reason: "inactive-status",
    });
  });

  describe("a contact with no name", () => {
    const nameless = (overrides: Partial<ActContact> = {}) =>
      contact({
        firstName: null,
        lastName: null,
        company: "NOITEX S.R.L.",
        emailAddress: "Info@Noitex.IT",
        businessPhone: "045 6340034",
        businessAddress: {
          line1: "Via Roma 1",
          line2: null,
          line3: null,
          city: "Verona",
          state: null,
          postalCode: "37100",
          country: "Italy",
        },
        ...overrides,
      });

    it("yields the company and the generic channel, and no person", () => {
      const result = mapContact(nameless(), resolveIndustry);
      expect(result.kind).toBe("company-only");
      if (result.kind !== "company-only") return;

      expect(result).not.toHaveProperty("contact");
      expect(result.channel).toEqual({ email: "info@noitex.it", phone: "+390456340034" });
      expect(result.company).toMatchObject({
        actCompanyKey: companyKey("NOITEX S.R.L.", "IT"),
        name: "NOITEX S.R.L.",
        city: "Verona",
        country: "IT",
        industry: "Furniture & Upholstery",
        actStatus: "Prospect",
      });
    });

    it("builds the same company a named contact would have", () => {
      const named = mapContact(contact({ company: "NOITEX S.R.L." }), resolveIndustry);
      const bare = mapContact(
        contact({ company: "NOITEX S.R.L.", firstName: null, lastName: null }),
        resolveIndustry,
      );
      if (named.kind !== "mapped" || bare.kind !== "company-only") throw new Error("unexpected kind");
      expect(bare.company).toEqual(named.company);
    });

    it("carries a missing email or phone as null", () => {
      const result = mapContact(
        nameless({ emailAddress: null, businessPhone: null, mobilePhone: null }),
        resolveIndustry,
      );
      if (result.kind !== "company-only") throw new Error("expected company-only");
      expect(result.channel).toEqual({ email: null, phone: null });
    });

    it("falls back to the mobile when there is no business phone", () => {
      const result = mapContact(
        nameless({ businessPhone: null, mobilePhone: "345 123 4567" }),
        resolveIndustry,
      );
      if (result.kind !== "company-only") throw new Error("expected company-only");
      expect(result.channel.phone).toBe("+393451234567");
    });

    it("treats whitespace-only names as no name", () => {
      const result = mapContact(nameless({ firstName: "  ", lastName: "\r" }), resolveIndustry);
      expect(result.kind).toBe("company-only");
    });

    it("is skipped when the company name is blank too", () => {
      expect(mapContact(nameless({ company: null }), resolveIndustry)).toEqual({
        kind: "skipped",
        reason: "no-name",
      });
      expect(mapContact(nameless({ company: "   " }), resolveIndustry)).toEqual({
        kind: "skipped",
        reason: "no-name",
      });
    });

    it("still obeys the filters that come before the name check", () => {
      expect(mapContact(nameless({ idStatus: "Personal" }), resolveIndustry)).toEqual({
        kind: "skipped",
        reason: "personal",
      });
      expect(mapContact(nameless({ isPrivate: true }), resolveIndustry)).toEqual({
        kind: "skipped",
        reason: "private",
      });
      expect(mapContact(nameless({ idStatus: "Dead Prospect" }), resolveIndustry)).toEqual({
        kind: "skipped",
        reason: "inactive-status",
      });
    });
  });

  it("keeps a contact whose phone could not be resolved", () => {
    // 7.8% of active contacts are in this state, almost always because the
    // country on the record is wrong. They are still real clients.
    const result = mapContact(contact({ businessPhone: "\r", mobilePhone: null }), resolveIndustry);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.contact.phone).toBeNull();
  });

  it("falls back to the surname when there is no first name", () => {
    const result = mapContact(contact({ firstName: null }), resolveIndustry);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.contact.firstName).toBe("Helmer");
    expect(result.contact.lastName).toBeNull();
  });

  it("gives a contact with no company name no company key", () => {
    const result = mapContact(contact({ company: null }), resolveIndustry);
    if (result.kind !== "mapped") throw new Error("expected mapped");
    expect(result.company.actCompanyKey).toBeNull();
  });
});

describe("formatGenericChannel", () => {
  it("lists the email and the phone", () => {
    expect(formatGenericChannel({ email: "info@noitex.it", phone: "+390456340034" })).toBe(
      "ACT! general contact: info@noitex.it, +390456340034",
    );
  });

  it("lists only the email when there is no phone", () => {
    expect(formatGenericChannel({ email: "info@noitex.it", phone: null })).toBe(
      "ACT! general contact: info@noitex.it",
    );
  });

  it("lists only the phone when there is no email", () => {
    expect(formatGenericChannel({ email: null, phone: "+390456340034" })).toBe(
      "ACT! general contact: +390456340034",
    );
  });

  it("is null when there is nothing to record", () => {
    expect(formatGenericChannel({ email: null, phone: null })).toBeNull();
  });
});
