import { describe, it, expect } from "vitest";
import { mapContact } from "../src/lib/act/map";
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

  it("skips Personal contacts even if the status filter let them through", () => {
    // These are the director's own and he shares them with nobody. The API
    // query already excludes them; this is the second barrier, on purpose.
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

  it("skips a contact with no name at all", () => {
    expect(
      mapContact(contact({ firstName: null, lastName: null }), resolveIndustry),
    ).toEqual({ kind: "skipped", reason: "no-name" });
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
