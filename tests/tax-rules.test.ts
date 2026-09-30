import { describe, it, expect } from "vitest";
import { destinationCountry, suggestTax, type SuggestTaxInput } from "@/lib/documents/tax-rules";

const au: SuggestTaxInput = {
  sellerCountry: "AU",
  destinationCountry: "AU",
  incoterm: "DAP",
  regionTax: { taxName: "GST", taxRate: "10.00" },
  customerTaxId: null,
};

describe("suggestTax — domestic sale", () => {
  it("charges the region rate on a delivered domestic sale", () => {
    const s = suggestTax(au);
    expect(s).toMatchObject({ treatment: "STANDARD", taxName: "GST", taxRate: "10.00", blocker: null, hint: null });
  });

  it("charges GST on a domestic EXW sale too — the goods never leave Australia", () => {
    expect(suggestTax({ ...au, incoterm: "EXW" })).toMatchObject({ treatment: "STANDARD", taxRate: "10.00" });
  });

  it("charges the region rate on domestic DDP (nothing is imported)", () => {
    expect(suggestTax({ ...au, incoterm: "DDP" })).toMatchObject({ treatment: "STANDARD", blocker: null });
  });

  it("hints that a 0% domestic rate may need a Custom tax (US sales tax)", () => {
    const s = suggestTax({
      ...au,
      sellerCountry: "US",
      destinationCountry: "US",
      regionTax: { taxName: "Sales Tax", taxRate: "0.00" },
    });
    expect(s.treatment).toBe("STANDARD");
    expect(s.taxRate).toBe("0.00");
    expect(s.hint).toMatch(/Custom/);
    expect(s.blocker).toBeNull();
  });
});

describe("suggestTax — export", () => {
  it("zero-rates FOB to New Zealand", () => {
    expect(suggestTax({ ...au, destinationCountry: "NZ", incoterm: "FOB" })).toMatchObject({
      treatment: "EXPORT",
      taxName: "GST",
      taxRate: "0.00",
      blocker: null,
    });
  });

  it("zero-rates EXW to a foreign buyer", () => {
    expect(suggestTax({ ...au, destinationCountry: "MX", incoterm: "EXW" }).treatment).toBe("EXPORT");
  });

  it("zero-rates US → Canada", () => {
    const s = suggestTax({
      ...au,
      sellerCountry: "US",
      destinationCountry: "CA",
      regionTax: { taxName: "Sales Tax", taxRate: "0.00" },
    });
    expect(s.treatment).toBe("EXPORT");
  });

  it("treats UK → Germany as an export (GB is not in the EU)", () => {
    const s = suggestTax({
      ...au,
      sellerCountry: "GB",
      destinationCountry: "DE",
      regionTax: { taxName: "VAT", taxRate: "20.00" },
      customerTaxId: "DE123456789",
    });
    expect(s.treatment).toBe("EXPORT");
  });

  it("explains the export in the reason line", () => {
    expect(suggestTax({ ...au, destinationCountry: "NZ" }).reason).toBe("Goods leave Australia → export, no GST");
  });
});

describe("suggestTax — EU to EU", () => {
  const lt: SuggestTaxInput = {
    sellerCountry: "LT",
    destinationCountry: "DE",
    incoterm: "DAP",
    regionTax: { taxName: "VAT", taxRate: "21.00" },
    customerTaxId: "DE123456789",
  };

  it("reverse-charges Lithuania → Germany", () => {
    expect(suggestTax(lt)).toMatchObject({ treatment: "REVERSE_CHARGE", taxName: "VAT", taxRate: "0.00", blocker: null });
  });

  it("blocks reverse charge until the client's VAT ID is set", () => {
    expect(suggestTax({ ...lt, customerTaxId: "  " }).blocker).toBe("Add the client's VAT ID for reverse charge");
  });

  it("treats an EU seller shipping outside the EU as an export", () => {
    expect(suggestTax({ ...lt, destinationCountry: "US" })).toMatchObject({
      treatment: "EXPORT",
      taxName: "VAT",
      taxRate: "0.00",
      blocker: null,
    });
  });

  it("lets DDP win over reverse charge inside the EU", () => {
    const s = suggestTax({ ...lt, incoterm: "DDP" });
    expect(s.treatment).toBe("STANDARD");
    expect(s.blocker).toBe("DDP abroad: set Germany's tax with Custom");
  });
});

describe("suggestTax — cases the app cannot decide", () => {
  it("blocks DDP into another country and keeps the region figures provisionally", () => {
    const s = suggestTax({ ...au, destinationCountry: "CA", incoterm: "DDP" });
    expect(s.treatment).toBe("STANDARD");
    expect(s.taxRate).toBe("10.00");
    expect(s.blocker).toBe("DDP abroad: set Canada's tax with Custom");
  });

  it("blocks when the destination country is unknown", () => {
    const s = suggestTax({ ...au, destinationCountry: null });
    expect(s.treatment).toBe("STANDARD");
    expect(s.blocker).toBe("Set the client's delivery country");
  });
});

describe("destinationCountry", () => {
  it("uses the main country when delivery is the same address", () => {
    expect(destinationCountry({ country: "AU", deliverySameAsMain: true, deliveryCountry: "NZ" })).toBe("AU");
  });

  it("uses the delivery country when it differs", () => {
    expect(destinationCountry({ country: "AU", deliverySameAsMain: false, deliveryCountry: "NZ" })).toBe("NZ");
  });

  it("falls back to the main country when the delivery country is blank", () => {
    expect(destinationCountry({ country: "AU", deliverySameAsMain: false, deliveryCountry: "" })).toBe("AU");
  });

  it("falls back to the main country when the delivery country is whitespace or null", () => {
    expect(destinationCountry({ country: "AU", deliverySameAsMain: false, deliveryCountry: "  " })).toBe("AU");
    expect(destinationCountry({ country: "AU", deliverySameAsMain: false, deliveryCountry: null })).toBe("AU");
  });

  it("is null, not the main country, when the delivery country is set but unrecognised", () => {
    expect(destinationCountry({ country: "AU", deliverySameAsMain: false, deliveryCountry: "Nueva Zelanda" })).toBeNull();
  });

  it("normalises legacy free text", () => {
    expect(destinationCountry({ country: "Australia", deliverySameAsMain: true, deliveryCountry: null })).toBe("AU");
    expect(destinationCountry({ country: "UK", deliverySameAsMain: true, deliveryCountry: null })).toBe("GB");
  });

  it("is null with no company or no country", () => {
    expect(destinationCountry(null)).toBeNull();
    expect(destinationCountry({ country: null, deliverySameAsMain: true, deliveryCountry: null })).toBeNull();
  });
});
