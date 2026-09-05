import { describe, it, expect } from "vitest";
import { resolveDocumentTax, type ResolveTaxInput } from "@/lib/documents/tax";
import { computeTotals } from "@/lib/pricing";

/**
 * Coverage for the rule that decides which tax rate a quote is charged at —
 * the FINAL freeze and the DRAFT refresh (see src/lib/documents/tax.ts).
 *
 * The bug these exist to prevent is a specific and expensive one: GST was
 * configured on the region after a draft had already been created, so the
 * draft carried the 0% it was born with, the summary showed no tax line at
 * all, and nothing in the app could ever move it. The mirror-image failure
 * is just as bad — a region's rate changing after a quote was issued and
 * silently rewriting the tax on a document a customer is already holding —
 * so both directions are pinned here rather than only the reported one.
 */

const base: ResolveTaxInput = {
  status: "DRAFT",
  deliveryTerms: "DELIVERED",
  document: { taxName: "GST", taxRate: "10.00" },
  region: { taxName: "GST", taxRate: "10.00" },
};

describe("resolveDocumentTax — a DRAFT follows its region", () => {
  it("adopts a rate configured after the draft was created", () => {
    const tax = resolveDocumentTax({
      ...base,
      document: { taxName: "GST", taxRate: "0.00" },
      region: { taxName: "GST", taxRate: "10.00" },
    });
    expect(tax.taxRate).toBe("10.00");
    expect(tax.engineTaxRate).toBe(10);
    expect(tax.refresh).toEqual({ taxName: "GST", taxRate: "10.00" });
  });

  it("follows a rate downwards too, not only upwards", () => {
    const tax = resolveDocumentTax({
      ...base,
      document: { taxName: "VAT", taxRate: "20.00" },
      region: { taxName: "VAT", taxRate: "17.50" },
    });
    expect(tax.engineTaxRate).toBe(17.5);
    expect(tax.refresh).toEqual({ taxName: "VAT", taxRate: "17.50" });
  });

  it("carries the label along with the rate so the two can never disagree", () => {
    const tax = resolveDocumentTax({
      ...base,
      document: { taxName: "Sales Tax", taxRate: "0.00" },
      region: { taxName: "GST", taxRate: "10.00" },
    });
    expect(tax.taxName).toBe("GST");
    expect(tax.refresh).toEqual({ taxName: "GST", taxRate: "10.00" });
  });

  it("renames without a rate change", () => {
    const tax = resolveDocumentTax({
      ...base,
      document: { taxName: "GST", taxRate: "10.00" },
      region: { taxName: "GST/HST", taxRate: "10.00" },
    });
    expect(tax.refresh).toEqual({ taxName: "GST/HST", taxRate: "10.00" });
  });

  it("asks for no write when the row already agrees", () => {
    expect(resolveDocumentTax(base).refresh).toBeNull();
  });

  it("treats a differently-rendered Decimal as agreement, not as a change", () => {
    const tax = resolveDocumentTax({
      ...base,
      document: { taxName: "GST", taxRate: "10" },
      region: { taxName: "GST", taxRate: "10.00" },
    });
    expect(tax.engineTaxRate).toBe(10);
    expect(tax.refresh).toBeNull();
  });
});

describe("resolveDocumentTax — a FINAL document is frozen", () => {
  it("keeps the rate it was issued with when the region moves", () => {
    const tax = resolveDocumentTax({
      ...base,
      status: "FINAL",
      document: { taxName: "GST", taxRate: "10.00" },
      region: { taxName: "GST", taxRate: "12.50" },
    });
    expect(tax.taxRate).toBe("10.00");
    expect(tax.engineTaxRate).toBe(10);
    expect(tax.refresh).toBeNull();
  });

  it("keeps a 0% issued document at 0% even once the region configures a rate", () => {
    const tax = resolveDocumentTax({
      ...base,
      status: "FINAL",
      document: { taxName: "Sales Tax", taxRate: "0.00" },
      region: { taxName: "GST", taxRate: "10.00" },
    });
    expect(tax.taxName).toBe("Sales Tax");
    expect(tax.engineTaxRate).toBe(0);
    expect(tax.refresh).toBeNull();
  });

  it("never proposes a write for an unrecognised status either", () => {
    const tax = resolveDocumentTax({
      ...base,
      status: "SOMETHING_ADDED_LATER",
      document: { taxName: "GST", taxRate: "10.00" },
      region: { taxName: "GST", taxRate: "12.50" },
    });
    expect(tax.engineTaxRate).toBe(10);
    expect(tax.refresh).toBeNull();
  });
});

describe("resolveDocumentTax — Ex Works", () => {
  it("charges no tax while still carrying the region's nominal rate", () => {
    const tax = resolveDocumentTax({
      ...base,
      deliveryTerms: "EX_WORKS",
      document: { taxName: "GST", taxRate: "10.00" },
      region: { taxName: "GST", taxRate: "10.00" },
    });
    expect(tax.engineTaxRate).toBe(0);
    // The document is not rewritten to 0% — the sheet renders "Ex Works —
    // no GST applicable" from the terms, and needs the real rate to name.
    expect(tax.taxRate).toBe("10.00");
  });

  it("still refreshes a stale draft's stored rate, which the sheet prints", () => {
    const tax = resolveDocumentTax({
      ...base,
      deliveryTerms: "EX_WORKS",
      document: { taxName: "GST", taxRate: "0.00" },
      region: { taxName: "GST", taxRate: "10.00" },
    });
    expect(tax.engineTaxRate).toBe(0);
    expect(tax.refresh).toEqual({ taxName: "GST", taxRate: "10.00" });
  });

  it("zeroes a FINAL Ex Works document's charge from its frozen rate", () => {
    const tax = resolveDocumentTax({
      ...base,
      status: "FINAL",
      deliveryTerms: "EX_WORKS",
      document: { taxName: "GST", taxRate: "10.00" },
      region: { taxName: "GST", taxRate: "12.50" },
    });
    expect(tax.engineTaxRate).toBe(0);
    expect(tax.refresh).toBeNull();
  });
});

describe("the resolved rate reaches the engine as money", () => {
  // The end-to-end shape of the reported bug: a $10,000 quote on a region
  // configured at 10% GST must show $1,000 of tax, not nothing.
  it("produces a GST line on a draft whose region configured GST after creation", () => {
    const tax = resolveDocumentTax({
      status: "DRAFT",
      deliveryTerms: "DELIVERED",
      document: { taxName: "GST", taxRate: "0.00" },
      region: { taxName: "GST", taxRate: "10.00" },
    });
    const totals = computeTotals({
      items: [{ unitPrice: 10000, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: tax.engineTaxRate,
    });
    expect(totals.taxAmount).toBe(1000);
    expect(totals.total).toBe(11000);
  });

  it("leaves that same quote untaxed under Ex Works terms", () => {
    const tax = resolveDocumentTax({
      status: "DRAFT",
      deliveryTerms: "EX_WORKS",
      document: { taxName: "GST", taxRate: "0.00" },
      region: { taxName: "GST", taxRate: "10.00" },
    });
    const totals = computeTotals({
      items: [{ unitPrice: 10000, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: tax.engineTaxRate,
    });
    expect(totals.taxAmount).toBe(0);
    expect(totals.total).toBe(10000);
  });

  it("taxes a fractional rate on the discounted base, not the gross", () => {
    const tax = resolveDocumentTax({
      status: "DRAFT",
      deliveryTerms: "DELIVERED",
      document: { taxName: "VAT", taxRate: "0.00" },
      region: { taxName: "VAT", taxRate: "17.50" },
    });
    const totals = computeTotals({
      items: [{ unitPrice: 1000, lines: [] }],
      extraLines: [],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "10",
      taxRate: tax.engineTaxRate,
    });
    expect(totals.taxableBase).toBe(900);
    expect(totals.taxAmount).toBe(157.5);
    expect(totals.total).toBe(1057.5);
  });
});
