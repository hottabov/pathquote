import { describe, it, expect } from "vitest";
import { resolveDocumentTax, type ResolveTaxInput } from "@/lib/documents/tax";
import type { TaxSuggestion } from "@/lib/documents/tax-rules";
import { computeTotals } from "@/lib/pricing";

/**
 * The rule that decides which tax a quote carries: a FINAL document is
 * frozen, a Custom tax is never overwritten, and an Auto draft follows the
 * suggestion (src/lib/documents/tax-rules.ts). Both directions of the old
 * freeze/refresh bug stay pinned: a draft must pick up a region rate
 * configured after it was created, and an issued quote must never be
 * rewritten by a later region edit.
 */

const gst: TaxSuggestion = {
  treatment: "STANDARD",
  taxName: "GST",
  taxRate: "10.00",
  reason: "Sale within Australia → GST 10%",
  hint: null,
  blocker: null,
};

const exportSuggestion: TaxSuggestion = {
  treatment: "EXPORT",
  taxName: "GST",
  taxRate: "0.00",
  reason: "Goods leave Australia → export, no GST",
  hint: null,
  blocker: null,
};

const base: ResolveTaxInput = {
  status: "DRAFT",
  document: { taxTreatment: "STANDARD", taxName: "GST", taxRate: "10.00", taxOverridden: false, taxNote: null },
  suggestion: gst,
};

describe("resolveDocumentTax — an Auto draft follows the suggestion", () => {
  it("adopts a rate configured after the draft was created", () => {
    const tax = resolveDocumentTax({ ...base, document: { ...base.document, taxRate: "0.00" } });
    expect(tax.taxRate).toBe("10.00");
    expect(tax.refresh).toEqual({ taxTreatment: "STANDARD", taxName: "GST", taxRate: "10.00" });
  });

  it("switches treatment when the destination becomes foreign", () => {
    const tax = resolveDocumentTax({ ...base, suggestion: exportSuggestion });
    expect(tax.taxTreatment).toBe("EXPORT");
    expect(tax.taxRate).toBe("0.00");
    expect(tax.refresh).toEqual({ taxTreatment: "EXPORT", taxName: "GST", taxRate: "0.00" });
  });

  it("asks for no write when the row already agrees", () => {
    expect(resolveDocumentTax(base).refresh).toBeNull();
  });

  it("treats a differently-rendered Decimal as agreement", () => {
    const tax = resolveDocumentTax({ ...base, document: { ...base.document, taxRate: "10" } });
    expect(tax.refresh).toBeNull();
  });

  it("passes the suggestion's blocker through", () => {
    const tax = resolveDocumentTax({ ...base, suggestion: { ...gst, blocker: "DDP abroad: set Canada's tax with Custom" } });
    expect(tax.blocker).toBe("DDP abroad: set Canada's tax with Custom");
  });
});

describe("resolveDocumentTax — a Custom draft is the salesperson's", () => {
  const custom: ResolveTaxInput = {
    ...base,
    document: {
      taxTreatment: "CUSTOM",
      taxName: "Sales Tax (Texas)",
      taxRate: "8.25",
      taxOverridden: true,
      taxNote: "Delivered to Austin, TX",
    },
    suggestion: exportSuggestion,
  };

  it("keeps the custom figures whatever the suggestion says", () => {
    const tax = resolveDocumentTax(custom);
    expect(tax).toMatchObject({ taxTreatment: "CUSTOM", taxName: "Sales Tax (Texas)", taxRate: "8.25", refresh: null, blocker: null });
  });

  it("ignores the suggestion's blocker — Custom is how a blocker is resolved", () => {
    const tax = resolveDocumentTax({ ...custom, suggestion: { ...gst, blocker: "DDP abroad: set Canada's tax with Custom" } });
    expect(tax.blocker).toBeNull();
  });

  it("blocks a custom tax with no reason", () => {
    expect(resolveDocumentTax({ ...custom, document: { ...custom.document, taxNote: "  " } }).blocker).toBe(
      "Give a reason for the custom tax"
    );
    expect(resolveDocumentTax({ ...custom, document: { ...custom.document, taxNote: null } }).blocker).toBe(
      "Give a reason for the custom tax"
    );
  });
});

describe("resolveDocumentTax — a FINAL document is frozen", () => {
  it("keeps the rate it was issued with", () => {
    const tax = resolveDocumentTax({ ...base, status: "FINAL", suggestion: { ...gst, taxRate: "12.50" } });
    expect(tax.taxRate).toBe("10.00");
    expect(tax.refresh).toBeNull();
  });

  it("keeps an issued export quote at 0% even when the suggestion now says STANDARD", () => {
    const tax = resolveDocumentTax({
      ...base,
      status: "FINAL",
      document: { ...base.document, taxTreatment: "EXPORT", taxRate: "0.00" },
    });
    expect(tax.taxTreatment).toBe("EXPORT");
    expect(tax.taxRate).toBe("0.00");
  });

  it("never blocks — the document is already issued", () => {
    const tax = resolveDocumentTax({ ...base, status: "FINAL", suggestion: { ...gst, blocker: "x" } });
    expect(tax.blocker).toBeNull();
  });

  it("never proposes a write for an unrecognised status either", () => {
    const tax = resolveDocumentTax({ ...base, status: "SOMETHING_ADDED_LATER", suggestion: { ...gst, taxRate: "12.50" } });
    expect(tax.refresh).toBeNull();
  });
});

describe("the resolved rate reaches the engine as money", () => {
  const priceOf = (taxRate: string) =>
    computeTotals({ items: [{ unitPrice: 10000, lines: [] }], extraLines: [], documentDiscountValue: null, taxRate: Number(taxRate) });

  it("charges GST on a domestic quote", () => {
    const totals = priceOf(resolveDocumentTax(base).taxRate);
    expect(totals.taxAmount).toBe(1000);
    expect(totals.total).toBe(11000);
  });

  it("charges nothing on an export", () => {
    const totals = priceOf(resolveDocumentTax({ ...base, suggestion: exportSuggestion }).taxRate);
    expect(totals.taxAmount).toBe(0);
    expect(totals.total).toBe(10000);
  });

  it("charges a custom fractional rate", () => {
    const tax = resolveDocumentTax({
      ...base,
      document: { taxTreatment: "CUSTOM", taxName: "Sales Tax", taxRate: "8.25", taxOverridden: true, taxNote: "TX" },
    });
    expect(priceOf(tax.taxRate).taxAmount).toBe(825);
  });
});
