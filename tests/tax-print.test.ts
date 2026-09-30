import { describe, it, expect } from "vitest";
import { printsTaxRow, reverseChargeNote, taxBannerNote, taxRowLabel, type PrintableTax } from "@/lib/documents/tax-print";

const std: PrintableTax = { incoterm: "DAP", taxTreatment: "STANDARD", taxName: "GST", taxRate: "10.00", customerTaxId: null };

describe("taxBannerNote", () => {
  it.each<[string, PrintableTax, string]>([
    ["standard", std, "(DAP, incl. GST 10%)"],
    ["standard at 0%", { ...std, taxName: "Sales Tax", taxRate: "0.00" }, "(DAP)"],
    ["export", { ...std, incoterm: "FOB", taxTreatment: "EXPORT", taxRate: "0.00" }, "(FOB, export — no GST)"],
    ["reverse charge", { ...std, taxTreatment: "REVERSE_CHARGE", taxName: "VAT", taxRate: "0.00" }, "(DAP, VAT reverse charge)"],
    ["custom", { ...std, incoterm: "DDP", taxTreatment: "CUSTOM", taxName: "Sales Tax (Texas)", taxRate: "8.25" }, "(DDP, incl. Sales Tax (Texas) 8.25%)"],
    ["custom at 0%", { ...std, incoterm: "EXW", taxTreatment: "CUSTOM", taxName: "Tax exempt", taxRate: "0" }, "(EXW, Tax exempt)"],
  ])("%s", (_label, tax, expected) => {
    expect(taxBannerNote(tax)).toBe(expected);
  });
});

describe("printsTaxRow / taxRowLabel", () => {
  it("prints a row only for a charged tax", () => {
    expect(printsTaxRow(std)).toBe(true);
    expect(printsTaxRow({ ...std, taxTreatment: "CUSTOM", taxRate: "8.25" })).toBe(true);
    expect(printsTaxRow({ ...std, taxRate: "0.00" })).toBe(false);
    expect(printsTaxRow({ ...std, taxTreatment: "EXPORT", taxRate: "0.00" })).toBe(false);
    expect(printsTaxRow({ ...std, taxTreatment: "REVERSE_CHARGE", taxRate: "0.00" })).toBe(false);
  });

  it("labels the row without trailing zeros", () => {
    expect(taxRowLabel(std)).toBe("GST 10%");
    expect(taxRowLabel({ ...std, taxName: "Sales Tax (Texas)", taxRate: "8.25" })).toBe("Sales Tax (Texas) 8.25%");
  });
});

describe("reverseChargeNote", () => {
  it("is null for anything but reverse charge", () => {
    expect(reverseChargeNote(std)).toBeNull();
  });

  it("names the customer's VAT ID", () => {
    expect(
      reverseChargeNote({ ...std, taxTreatment: "REVERSE_CHARGE", taxName: "VAT", taxRate: "0.00", customerTaxId: "DE123456789" })
    ).toBe("Reverse charge: VAT to be accounted for by the recipient. Customer VAT ID: DE123456789.");
  });

  it("still prints the legal line when the ID is missing (a frozen legacy quote)", () => {
    expect(reverseChargeNote({ ...std, taxTreatment: "REVERSE_CHARGE", taxName: "VAT", taxRate: "0.00" })).toBe(
      "Reverse charge: VAT to be accounted for by the recipient."
    );
  });
});
