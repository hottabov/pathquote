import { describe, it, expect } from "vitest";
import {
  toCents,
  fromCents,
  computeTotals,
  discountCents,
  capPct,
  concessionCapMessage,
  markupCapMessage,
  validateCommissionTiers,
  DEFAULT_COMMISSION_TIERS,
  type CommissionTier,
} from "../src/lib/pricing";

describe("toCents", () => {
  it("converts a whole-dollar amount", () => {
    expect(toCents(100)).toBe(10000);
    expect(toCents(0)).toBe(0);
  });

  it("converts a two-decimal amount exactly", () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0.1)).toBe(10);
  });

  it("rounds half up despite a naive-multiplication float trap (1.005)", () => {
    // 1.005 * 100 evaluates to 100.49999999999999 in naive IEEE-754
    // arithmetic (Math.round(1.005 * 100) === 100), which would silently
    // lose the intended half-up cent instead of the mathematically correct
    // result of 101.
    expect(Math.round(1.005 * 100)).toBe(100); // demonstrates the float trap exists
    expect(toCents(1.005)).toBe(101);
  });

  it("rounds half up on a value whose *100 happens to land exactly on .5 (33.335)", () => {
    expect(toCents(33.335)).toBe(3334);
  });

  it("rounds a third-decimal-place half exactly up", () => {
    expect(toCents(10.005)).toBe(1001);
    expect(toCents(10.004)).toBe(1000);
    expect(toCents(10.006)).toBe(1001);
  });

  it("accepts numeric strings", () => {
    expect(toCents("19.99")).toBe(1999);
    expect(toCents("10.005")).toBe(1001);
  });

  it("throws on NaN", () => {
    expect(() => toCents(NaN)).toThrow(/finite/);
  });

  it("throws on Infinity", () => {
    expect(() => toCents(Infinity)).toThrow(/finite/);
    expect(() => toCents(-Infinity)).toThrow(/finite/);
  });

  it("throws on a non-numeric string", () => {
    expect(() => toCents("abc")).toThrow(/finite/);
  });

  it("throws on an empty string", () => {
    expect(() => toCents("")).toThrow(/finite/);
  });
});

describe("fromCents", () => {
  it("converts cents back to currency units", () => {
    expect(fromCents(10000)).toBe(100);
    expect(fromCents(3334)).toBe(33.34);
    expect(fromCents(0)).toBe(0);
  });

  it("round-trips with toCents for exact cent amounts", () => {
    expect(fromCents(toCents(19.99))).toBe(19.99);
  });

  it("throws on a non-finite input", () => {
    expect(() => fromCents(NaN)).toThrow(/finite/);
  });
});

describe("computeTotals", () => {
  it("computes a single item with no discounts and no tax", () => {
    const result = computeTotals({
      items: [{ unitPrice: 100, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result).toEqual({
      itemTotals: [100],
      itemDiscounts: [0],
      grossSubtotal: 100,
      subtotal: 100,
      discountAmount: 0,
      totalDiscountAmount: 0,
      taxableBase: 100,
      taxAmount: 0,
      total: 100,
      violations: [],
      negativeSubtotal: false,
      documentConcession: {
        concession: "0.00",
        listValue: "100.00",
        effectivePct: 0,
        allowedPct: 100,
        exceedsCap: false,
        allowedMarkupPct: null,
        exceedsMarkupCap: false,
        parts: { documentDiscount: "0.00", itemDiscounts: "0.00", priceAdjustments: "0.00", tradeIns: "0.00" },
      },
      commission: null,
    });
  });

  it("sums an item's base price with its options lines", () => {
    const result = computeTotals({
      items: [{ unitPrice: 100, lines: [{ qty: 2, unitPrice: 25 }] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    // 100 + (2 * 25) = 150
    expect(result.itemTotals).toEqual([150]);
    expect(result.subtotal).toBe(150);
    expect(result.total).toBe(150);
  });

  it("applies a 10% item discount", () => {
    const result = computeTotals({
      items: [{ unitPrice: 100, discountMode: "PERCENT", discountValue: "10", lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.itemTotals).toEqual([90]);
    expect(result.itemDiscounts).toEqual([10]);
    expect(result.grossSubtotal).toBe(100);
    expect(result.subtotal).toBe(90);
    expect(result.totalDiscountAmount).toBe(10);
    expect(result.total).toBe(90);
    expect(result.violations).toEqual([]);
  });

  it("reports a cap violation but still computes with the requested pct", () => {
    // L-Series: max discount 10%, manager requests 15% anyway.
    const result = computeTotals({
      items: [{ unitPrice: 100, discountMode: "PERCENT", discountValue: "15", maxDiscountPct: 10, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    // Math uses the requested 15%, NOT the 10% cap: 100 * 0.85 = 85.
    expect(result.itemTotals).toEqual([85]);
    expect(result.subtotal).toBe(85);
    expect(result.violations).toEqual([{ itemIndex: 0, allowedPct: 10 }]);
  });

  it("does not report a violation when the discount is within the cap", () => {
    const result = computeTotals({
      items: [{ unitPrice: 100, discountMode: "PERCENT", discountValue: "10", maxDiscountPct: 10, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.violations).toEqual([]);
  });

  it("does not report a violation when maxDiscountPct is null (uncapped)", () => {
    const result = computeTotals({
      items: [{ unitPrice: 100, discountMode: "PERCENT", discountValue: "50", maxDiscountPct: null, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.violations).toEqual([]);
    expect(result.itemTotals).toEqual([50]);
  });

  it("indexes violations by the item's position for multiple items", () => {
    const result = computeTotals({
      items: [
        { unitPrice: 100, discountMode: "PERCENT", discountValue: "5", maxDiscountPct: 10, lines: [] },
        { unitPrice: 100, discountMode: "PERCENT", discountValue: "20", maxDiscountPct: 10, lines: [] },
      ],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.violations).toEqual([{ itemIndex: 1, allowedPct: 10 }]);
  });

  it("applies a document-level discount to the subtotal", () => {
    const result = computeTotals({
      items: [
        { unitPrice: 100, lines: [] },
        { unitPrice: 200, lines: [] },
      ],
      extraLines: [],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "10",
      taxRate: 0,
    });
    expect(result.itemTotals).toEqual([100, 200]);
    expect(result.subtotal).toBe(300);
    expect(result.discountAmount).toBe(30);
    expect(result.taxableBase).toBe(270);
    expect(result.total).toBe(270);
  });

  it("combines an item discount and a document discount", () => {
    const result = computeTotals({
      items: [{ unitPrice: 100, discountMode: "PERCENT", discountValue: "10", lines: [] }],
      extraLines: [],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "10",
      taxRate: 0,
    });
    // item: 100 * 0.9 = 90 (subtotal); document: 90 * 0.9 = 81.
    expect(result.itemTotals).toEqual([90]);
    expect(result.grossSubtotal).toBe(100);
    expect(result.subtotal).toBe(90);
    expect(result.discountAmount).toBe(9);
    expect(result.totalDiscountAmount).toBe(19);
    expect(result.taxableBase).toBe(81);
    expect(result.total).toBe(81);
  });

  it("applies a 10% AU-style tax on top of the taxable base", () => {
    const result = computeTotals({
      items: [{ unitPrice: 100, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 10,
    });
    expect(result.taxableBase).toBe(100);
    expect(result.taxAmount).toBe(10);
    expect(result.total).toBe(110);
  });

  it("charges no tax when taxRate is 0", () => {
    const result = computeTotals({
      items: [{ unitPrice: 100, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.taxAmount).toBe(0);
    expect(result.total).toBe(result.taxableBase);
  });

  it("rounds half up at each money step for a fractional-cent unit price", () => {
    // unitPrice 33.335 -> 3334c; 3 lines of 33.335 -> 3 * 3334c = 10002c;
    // base = 3334 + 10002 = 13336c = 133.36.
    const result = computeTotals({
      items: [{ unitPrice: 33.335, lines: [{ qty: 3, unitPrice: 33.335 }] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.itemTotals).toEqual([133.36]);
    expect(result.subtotal).toBe(133.36);
    expect(result.total).toBe(133.36);
  });

  it("avoids the classic 0.1 + 0.2 float trap across items and extra lines", () => {
    // Naive floating point: 0.1 + 0.2 === 0.30000000000000004.
    expect(0.1 + 0.2).not.toBe(0.3);
    const result = computeTotals({
      items: [{ unitPrice: 0.2, lines: [] }],
      extraLines: [{ qty: 1, unitPrice: 0.1 }],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.subtotal).toBe(0.3);
    expect(result.total).toBe(0.3);
  });

  it("avoids float drift when summing repeated fractional lines (3 * 0.1)", () => {
    // Naive floating point: 0.1 + 0.1 + 0.1 === 0.30000000000000004.
    expect(0.1 + 0.1 + 0.1).not.toBe(0.3);
    const result = computeTotals({
      items: [
        {
          unitPrice: 0,
          lines: [
            { qty: 1, unitPrice: 0.1 },
            { qty: 1, unitPrice: 0.1 },
            { qty: 1, unitPrice: 0.1 },
          ],
        },
      ],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.itemTotals).toEqual([0.3]);
    expect(result.subtotal).toBe(0.3);
  });

  it("handles a zero-line item (no options)", () => {
    const result = computeTotals({
      items: [{ unitPrice: 50, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.itemTotals).toEqual([50]);
    expect(result.subtotal).toBe(50);
  });

  it("multiplies option lines by quantity greater than 1", () => {
    const result = computeTotals({
      items: [{ unitPrice: 0, lines: [{ qty: 4, unitPrice: 12.5 }] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.itemTotals).toEqual([50]);
  });

  it("computes extra lines only, with no items", () => {
    const result = computeTotals({
      items: [],
      extraLines: [{ qty: 3, unitPrice: 15.5 }],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.itemTotals).toEqual([]);
    expect(result.subtotal).toBe(46.5);
    expect(result.total).toBe(46.5);
    expect(result.violations).toEqual([]);
  });

  it("returns all zeros for a fully empty input", () => {
    const result = computeTotals({
      items: [],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result).toEqual({
      itemTotals: [],
      itemDiscounts: [],
      grossSubtotal: 0,
      subtotal: 0,
      discountAmount: 0,
      totalDiscountAmount: 0,
      taxableBase: 0,
      taxAmount: 0,
      total: 0,
      violations: [],
      negativeSubtotal: false,
      documentConcession: {
        concession: "0.00",
        listValue: "0.00",
        effectivePct: 0,
        allowedPct: 100,
        exceedsCap: false,
        allowedMarkupPct: null,
        exceedsMarkupCap: false,
        parts: { documentDiscount: "0.00", itemDiscounts: "0.00", priceAdjustments: "0.00", tradeIns: "0.00" },
      },
      commission: null,
    });
  });

  it("treats a missing documentDiscountValue the same as null", () => {
    const withUndefined = computeTotals({
      items: [{ unitPrice: 100, lines: [] }],
      extraLines: [],
      documentDiscountValue: undefined,
      taxRate: 0,
    });
    const withNull = computeTotals({
      items: [{ unitPrice: 100, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(withUndefined).toEqual(withNull);
  });

  it("lets a negative extra line reduce the subtotal", () => {
    const result = computeTotals({
      items: [{ unitPrice: 100000, lines: [] }],
      extraLines: [{ qty: 1, unitPrice: -15000 }],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.subtotal).toBe(85000);
    expect(result.total).toBe(85000);
    expect(result.negativeSubtotal).toBe(false);
  });

  it("sets negativeSubtotal when the subtotal goes below zero", () => {
    const result = computeTotals({
      items: [{ unitPrice: 1000, lines: [] }],
      extraLines: [{ qty: 1, unitPrice: -5000 }],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.subtotal).toBe(-4000);
    expect(result.negativeSubtotal).toBe(true);
  });

  it("does not flag negativeSubtotal when a trade-in exactly zeroes the subtotal", () => {
    // Boundary: subtotalCents === 0 must not trip the `< 0` check — giving
    // an item away even-up on a trade-in is a valid (if unusual) quote, not
    // an error to reject.
    const result = computeTotals({
      items: [{ unitPrice: 1000, lines: [] }],
      extraLines: [{ qty: 1, unitPrice: -1000 }],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.subtotal).toBe(0);
    expect(result.negativeSubtotal).toBe(false);
  });

  it("does not flag negativeSubtotal for an ordinary positive quote", () => {
    const result = computeTotals({
      items: [{ unitPrice: 100, lines: [] }],
      extraLines: [{ qty: 1, unitPrice: 10 }],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.negativeSubtotal).toBe(false);
  });
});

describe("documentConcession", () => {
  it("treats a null listPrice as no concession", () => {
    const result = computeTotals({
      items: [{ unitPrice: 100, listPrice: null, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.documentConcession).toEqual({
      concession: "0.00",
      listValue: "100.00",
      effectivePct: 0,
      allowedPct: 100,
      exceedsCap: false,
      allowedMarkupPct: null,
      exceedsMarkupCap: false,
      parts: { documentDiscount: "0.00", itemDiscounts: "0.00", priceAdjustments: "0.00", tradeIns: "0.00" },
    });
  });

  it("a price cut below list is a positive concession, reducing the subtotal by exactly the cut", () => {
    // A $1,000 machine sold for $0 — John's demo-room giveaway.
    const result = computeTotals({
      items: [{ unitPrice: 0, listPrice: 1000, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.itemTotals).toEqual([0]);
    expect(result.subtotal).toBe(0);
    // Subtotal is reduced by exactly the item's list price (1000 - 0).
    expect(result.documentConcession).toEqual({
      concession: "1000.00",
      listValue: "1000.00",
      effectivePct: 100,
      allowedPct: 100,
      exceedsCap: false,
      allowedMarkupPct: null,
      exceedsMarkupCap: false,
      parts: { documentDiscount: "0.00", itemDiscounts: "0.00", priceAdjustments: "1000.00", tradeIns: "0.00" },
    });
  });

  it("a price raised above list is a negative concession", () => {
    const result = computeTotals({
      items: [{ unitPrice: 12000, listPrice: 10000, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.documentConcession.concession).toBe("-2000.00");
    expect(result.documentConcession.effectivePct).toBe(-20);
    expect(result.documentConcession.exceedsCap).toBe(false);
  });

  it("raising one item's price and lowering another's by the same amount nets to a zero concession with no cap violation", () => {
    // John: "you can increase the price of the machine by $10,000 and then
    // give away $10,000 worth of options — we do that all the time."
    const result = computeTotals({
      items: [
        { unitPrice: 60000, listPrice: 50000, lines: [] }, // +$10,000 raise
        { unitPrice: 0, listPrice: 10000, lines: [] }, // $10,000 given away
      ],
      extraLines: [],
      documentDiscountValue: null,
      regionMaxDiscountPct: 10,
      taxRate: 0,
    });
    expect(result.documentConcession.concession).toBe("0.00");
    expect(result.documentConcession.effectivePct).toBe(0);
    expect(result.documentConcession.exceedsCap).toBe(false);
  });

  it("sets exceedsCap once a price cut pushes the concession over the region cap", () => {
    // $10,000 list, cut to $8,900 (11% concession) against a 10% cap.
    const result = computeTotals({
      items: [{ unitPrice: 8900, listPrice: 10000, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      regionMaxDiscountPct: 10,
      taxRate: 0,
    });
    expect(result.documentConcession.effectivePct).toBeCloseTo(11, 5);
    expect(result.documentConcession.exceedsCap).toBe(true);
  });

  it("stays within the cap just under the boundary (9.99% against a 10% cap)", () => {
    const result = computeTotals({
      items: [{ unitPrice: 9001, listPrice: 10000, lines: [] }], // 9.99% concession
      extraLines: [],
      documentDiscountValue: null,
      regionMaxDiscountPct: 10,
      taxRate: 0,
    });
    expect(result.documentConcession.effectivePct).toBeCloseTo(9.99, 5);
    expect(result.documentConcession.exceedsCap).toBe(false);
  });

  it("does not flag exceedsCap exactly at the boundary (10% against a 10% cap)", () => {
    const result = computeTotals({
      items: [{ unitPrice: 9000, listPrice: 10000, lines: [] }], // exactly 10%
      extraLines: [],
      documentDiscountValue: null,
      regionMaxDiscountPct: 10,
      taxRate: 0,
    });
    expect(result.documentConcession.effectivePct).toBe(10);
    expect(result.documentConcession.exceedsCap).toBe(false);
  });

  it("flags exceedsCap just over the boundary (10.01% against a 10% cap)", () => {
    const result = computeTotals({
      items: [{ unitPrice: 8999, listPrice: 10000, lines: [] }], // 10.01%
      extraLines: [],
      documentDiscountValue: null,
      regionMaxDiscountPct: 10,
      taxRate: 0,
    });
    expect(result.documentConcession.effectivePct).toBeCloseTo(10.01, 5);
    expect(result.documentConcession.exceedsCap).toBe(true);
  });

  it("counts a negative extra line (a trade-in) toward the concession", () => {
    const result = computeTotals({
      items: [{ unitPrice: 10000, listPrice: 10000, lines: [] }],
      extraLines: [{ qty: 1, unitPrice: -2000 }],
      documentDiscountValue: null,
      taxRate: 0,
    });
    // listValue is unaffected by the trade-in (a negative extra line
    // contributes nothing to listValue, only to the concession numerator).
    expect(result.documentConcession).toEqual({
      concession: "2000.00",
      listValue: "10000.00",
      effectivePct: 20,
      allowedPct: 100,
      exceedsCap: false,
      allowedMarkupPct: null,
      exceedsMarkupCap: false,
      parts: { documentDiscount: "0.00", itemDiscounts: "0.00", priceAdjustments: "0.00", tradeIns: "2000.00" },
    });
  });

  it("counts a positive extra line toward listValue but not the concession", () => {
    const result = computeTotals({
      items: [{ unitPrice: 10000, listPrice: 10000, lines: [] }],
      extraLines: [{ qty: 1, unitPrice: 500 }],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.documentConcession.concession).toBe("0.00");
    expect(result.documentConcession.listValue).toBe("10500.00");
  });

  it("counts an item discount and a manual price cut on the same item once each, not double-counted", () => {
    // List $10,000, manually cut to $9,000 (a $1,000 concession), then a
    // further 10% item discount on top of that already-cut $9,000 base
    // ($900) — the two must add, not compound through listPrice twice.
    const result = computeTotals({
      items: [
        {
          unitPrice: 9000,
          listPrice: 10000,
          discountMode: "PERCENT",
          discountValue: "10",
          lines: [],
        },
      ],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.itemDiscounts).toEqual([900]);
    // 1000 (price cut) + 900 (discount on the cut price) = 1900.
    expect(result.documentConcession.concession).toBe("1900.00");
    expect(result.documentConcession.listValue).toBe("10000.00");
  });

  it("counts an option line's manual price cut alongside the item's own", () => {
    const result = computeTotals({
      items: [
        {
          unitPrice: 9000,
          listPrice: 10000,
          lines: [{ qty: 2, unitPrice: 400, listPrice: 500 }],
        },
      ],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    // item: 10000 - 9000 = 1000; line: (500 - 400) * 2 = 200.
    expect(result.documentConcession.concession).toBe("1200.00");
    expect(result.documentConcession.listValue).toBe("11000.00"); // 10000 + 500*2
  });

  it("counts the document-level discount amount toward the concession", () => {
    const result = computeTotals({
      items: [{ unitPrice: 10000, listPrice: 10000, lines: [] }],
      extraLines: [],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "5",
      taxRate: 0,
    });
    expect(result.documentConcession.concession).toBe("500.00");
    expect(result.documentConcession.listValue).toBe("10000.00");
  });

  it("percentage-only behaviour (no listPrice/regionMaxDiscountPct given) is unchanged to the cent", () => {
    // Same fixture as the "combines an item discount and a document
    // discount" test above, with no listPrice anywhere — every money total
    // must match exactly what it was before this feature existed.
    const result = computeTotals({
      items: [{ unitPrice: 100, discountMode: "PERCENT", discountValue: "10", lines: [] }],
      extraLines: [],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "10",
      taxRate: 0,
    });
    expect(result.itemTotals).toEqual([90]);
    expect(result.grossSubtotal).toBe(100);
    expect(result.subtotal).toBe(90);
    expect(result.discountAmount).toBe(9);
    expect(result.totalDiscountAmount).toBe(19);
    expect(result.taxableBase).toBe(81);
    expect(result.total).toBe(81);
    // With no listPrice anywhere, listPrice defaults to unitPrice for both
    // the item discount's base and the document discount's base, so the
    // concession is exactly the item discount (10) plus the document
    // discount (9) — no price-cut component.
    expect(result.documentConcession.concession).toBe("19.00");
    expect(result.documentConcession.listValue).toBe("100.00");
  });
});

describe("concessionCapMessage", () => {
  // Every fixture below uses non-whole-dollar figures throughout — formatMoney's
  // own "whole amounts render without decimals" rule (src/lib/format.ts) would
  // otherwise make these `toBe` assertions depend on that unrelated formatting
  // choice (e.g. a $20,000.00 part would actually render as "$20,000").

  it("names the concession amount, its percentage, the cap, and the region for a discount-only concession", () => {
    const message = concessionCapMessage(
      {
        concession: "34000.55",
        listValue: "195402.30",
        effectivePct: 17.402982,
        allowedPct: 10,
        exceedsCap: true,
        allowedMarkupPct: null,
        exceedsMarkupCap: false,
        parts: { documentDiscount: "34000.55", itemDiscounts: "0.00", priceAdjustments: "0.00", tradeIns: "0.00" },
      },
      "Australia",
      "AUD"
    );
    expect(message).toBe(
      "Concessions total $34,000.55 (17.4% of list price) — $34,000.55 discount — above the 10% limit for Australia."
    );
  });

  it("reproduces the discount-plus-trade-in report that prompted this change, naming both parts", () => {
    // The scenario that triggered this whole change: a $30,448.something
    // concession next to a Summary panel reading "Discount −$10,448.20" —
    // the owner reasonably concluded the bigger number was wrong. It
    // wasn't: the gap was a trade-in (a negative extra line), which counts
    // against the cap by design (see computeTotals's doc comment) but was
    // invisible in the old single-total message.
    const message = concessionCapMessage(
      {
        concession: "30448.25",
        listValue: "300870.99",
        effectivePct: 10.12,
        allowedPct: 10,
        exceedsCap: true,
        allowedMarkupPct: null,
        exceedsMarkupCap: false,
        parts: {
          documentDiscount: "10448.20",
          itemDiscounts: "0.00",
          priceAdjustments: "0.00",
          tradeIns: "20000.05",
        },
      },
      "Australia",
      "AUD"
    );
    expect(message).toBe(
      "Concessions total $30,448.25 (10.12% of list price) — $10,448.20 discount plus a $20,000.05 trade-in — above the 10% limit for Australia."
    );
  });

  it("names only the non-zero parts, omitting the zero ones (a trade-in with no discount at all)", () => {
    const message = concessionCapMessage(
      {
        concession: "5000.50",
        listValue: "50005.00",
        effectivePct: 10,
        allowedPct: 10,
        exceedsCap: false,
        allowedMarkupPct: null,
        exceedsMarkupCap: false,
        parts: { documentDiscount: "0.00", itemDiscounts: "0.00", priceAdjustments: "0.00", tradeIns: "5000.50" },
      },
      "Australia",
      "AUD"
    );
    expect(message).toBe(
      "Concessions total $5,000.50 (10% of list price) — a $5,000.50 trade-in — above the 10% limit for Australia."
    );
  });

  it("words a net price increase as reducing concessions, never as a discount", () => {
    // priceAdjustments negative (a manual price raised above list) must
    // read as a reduction alongside the real discount, never get folded
    // into the "discount" figure itself — a reader must never be told a
    // price increase gave money away.
    const message = concessionCapMessage(
      {
        concession: "8000.05",
        listValue: "100000.00",
        effectivePct: 8,
        allowedPct: 10,
        exceedsCap: false,
        allowedMarkupPct: null,
        exceedsMarkupCap: false,
        parts: {
          documentDiscount: "10000.40",
          itemDiscounts: "0.00",
          priceAdjustments: "-2000.35",
          tradeIns: "0.00",
        },
      },
      "Australia",
      "AUD"
    );
    expect(message).toBe(
      "Concessions total $8,000.05 (8% of list price) — $10,000.40 discount, less $2,000.35 from a price increase above list — above the 10% limit for Australia."
    );
    expect(message).not.toContain("$2,000.35 discount");
  });

  it("still reads cleanly when a price increase is the only concession source", () => {
    const message = concessionCapMessage(
      {
        concession: "-1500.25",
        listValue: "100000.00",
        effectivePct: -1.5,
        allowedPct: 10,
        exceedsCap: false,
        allowedMarkupPct: null,
        exceedsMarkupCap: false,
        parts: {
          documentDiscount: "0.00",
          itemDiscounts: "0.00",
          priceAdjustments: "-1500.25",
          tradeIns: "0.00",
        },
      },
      "Australia",
      "AUD"
    );
    expect(message).toBe(
      "Concessions total -$1,500.25 (-1.5% of list price) — reduced by $1,500.25 from a price increase above list — above the 10% limit for Australia."
    );
  });
});

describe("DocumentConcession.parts", () => {
  it("sums to the concession total, to the cent, for a document combining a document discount, an item discount, a price cut, and a trade-in", () => {
    // item: list $10,000, manually cut to $9,000 (a $1,000 price-cut
    // concession), then a 10% item discount on that $9,000 base ($900);
    // extra line: a $3,000 trade-in; document discount: 5% of the
    // resulting subtotal.
    const result = computeTotals({
      items: [
        {
          unitPrice: 9000,
          listPrice: 10000,
          discountMode: "PERCENT",
          discountValue: "10",
          lines: [],
        },
      ],
      extraLines: [{ qty: 1, unitPrice: -3000 }],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "5",
      regionMaxDiscountPct: 10,
      taxRate: 0,
    });

    // subtotal = 9000 - 900 (item discount) - 3000 (trade-in) = 5100;
    // document discount = 5% of 5100 = 255.
    expect(result.documentConcession.parts).toEqual({
      documentDiscount: "255.00",
      itemDiscounts: "900.00",
      priceAdjustments: "1000.00",
      tradeIns: "3000.00",
    });

    const partsSum =
      Number(result.documentConcession.parts.documentDiscount) +
      Number(result.documentConcession.parts.itemDiscounts) +
      Number(result.documentConcession.parts.priceAdjustments) +
      Number(result.documentConcession.parts.tradeIns);
    expect(partsSum.toFixed(2)).toBe(result.documentConcession.concession);
    expect(result.documentConcession.concession).toBe("5155.00");
  });
});

// A trade-in as a real catalogue product (TRADE-IN, Product.isCredit) —
// John: "you're selling a trade in. It's a negative value." The salesperson
// types a positive unitPrice; `isCredit: true` is the only thing that turns
// it into a subtraction — see `EngineItem.isCredit`'s doc comment.
describe("EngineItem.isCredit (credit items -- the TRADE-IN product)", () => {
  it("a credit item subtracts from the subtotal; the same figures with isCredit: false add", () => {
    const credit = computeTotals({
      items: [
        { unitPrice: 5000, listPrice: 5000, lines: [], isCredit: true },
        { unitPrice: 20000, listPrice: 20000, lines: [] }, // an ordinary machine
      ],
      extraLines: [],
      taxRate: 0,
    });
    expect(credit.itemTotals).toEqual([-5000, 20000]);
    expect(credit.subtotal).toBe(15000);

    const noCredit = computeTotals({
      items: [
        { unitPrice: 5000, listPrice: 5000, lines: [], isCredit: false },
        { unitPrice: 20000, listPrice: 20000, lines: [] },
      ],
      extraLines: [],
      taxRate: 0,
    });
    expect(noCredit.itemTotals).toEqual([5000, 20000]);
    expect(noCredit.subtotal).toBe(25000);
  });

  it("omitting isCredit behaves exactly like isCredit: false (defaults to an ordinary item)", () => {
    const result = computeTotals({
      items: [{ unitPrice: 5000, listPrice: 5000, lines: [] }],
      extraLines: [],
      taxRate: 0,
    });
    expect(result.itemTotals).toEqual([5000]);
  });

  it("a credit item counts once in DocumentConcession.parts.tradeIns, not twice, and not also as a price adjustment", () => {
    const result = computeTotals({
      items: [
        { unitPrice: 20000, listPrice: 20000, lines: [], isCredit: true },
        { unitPrice: 100000, listPrice: 100000, lines: [] },
      ],
      extraLines: [],
      regionMaxDiscountPct: 100,
      taxRate: 0,
    });
    expect(result.documentConcession.parts).toEqual({
      documentDiscount: "0.00",
      itemDiscounts: "0.00",
      priceAdjustments: "0.00",
      tradeIns: "20000.00",
    });
    // The credit item's own listPrice never inflates listValue either — same
    // treatment a negative extra line trade-in already gets (see "counts a
    // negative extra line (a trade-in) toward the concession" above).
    expect(result.documentConcession.listValue).toBe("100000.00");
    expect(result.documentConcession.concession).toBe("20000.00");
  });

  it("a credit item pushing concessions past the cap trips exceedsCap exactly as a discount would", () => {
    // $20,000 credit against $100,000 of list value = 20% concession, over a
    // 10% region cap -- same shape as a discount-driven breach.
    const result = computeTotals({
      items: [
        { unitPrice: 20000, listPrice: 20000, lines: [], isCredit: true },
        { unitPrice: 100000, listPrice: 100000, lines: [] },
      ],
      extraLines: [],
      regionMaxDiscountPct: 10,
      taxRate: 0,
    });
    expect(result.documentConcession.effectivePct).toBeCloseTo(20, 5);
    expect(result.documentConcession.exceedsCap).toBe(true);
  });

  it("a credit item with options negates the whole item's contribution consistently (should not carry options in practice, but the sign still applies to the whole item)", () => {
    const result = computeTotals({
      items: [{ unitPrice: 20000, listPrice: 20000, lines: [{ qty: 1, unitPrice: 500, listPrice: 500 }], isCredit: true }],
      extraLines: [],
      taxRate: 0,
    });
    expect(result.itemTotals).toEqual([-20500]);
  });

  it("an ordinary product is unaffected by every isCredit-related change (same result with isCredit omitted vs. false, no tradeIns, no sign flip)", () => {
    const withoutFlag = computeTotals({
      items: [{ unitPrice: 9000, listPrice: 10000, discountMode: "PERCENT", discountValue: "10", lines: [] }],
      extraLines: [{ qty: 1, unitPrice: -3000 }],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "5",
      regionMaxDiscountPct: 10,
      taxRate: 0,
    });
    const withFlagFalse = computeTotals({
      items: [
        {
          unitPrice: 9000,
          listPrice: 10000,
          discountMode: "PERCENT",
          discountValue: "10",
          lines: [],
          isCredit: false,
        },
      ],
      extraLines: [{ qty: 1, unitPrice: -3000 }],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "5",
      regionMaxDiscountPct: 10,
      taxRate: 0,
    });
    expect(withFlagFalse).toEqual(withoutFlag);
  });
});

// The owner: "the discount works, but backwards" -- a document-level
// percentage discount used to be resolved against `subtotal`, which is
// already NET of every credit item (a trade-in subtracts from it). That
// meant part of the discount was silently coming out of the trade-in credit
// itself rather than entirely out of what the customer owes -- see
// `documentDiscountBaseCents`'s doc comment in src/lib/pricing.ts for the
// exact mechanism and the worked numbers below.
describe("a document discount must not erode a trade-in", () => {
  it("a 10% document discount on a $50,000 sale with a $20,000 trade-in leaves the trade-in's own $20,000 untouched", () => {
    const result = computeTotals({
      items: [
        { unitPrice: 50000, listPrice: 50000, lines: [] },
        { unitPrice: 20000, listPrice: 20000, lines: [], isCredit: true },
      ],
      extraLines: [],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "10",
      taxRate: 0,
    });
    // Pre-fix: subtotal (50,000 - 20,000 = 30,000) * 10% = 3,000 off ->
    // taxableBase 27,000 (the trade-in effectively shrank to $18,000 worth
    // of credit). Fixed: the discount is resolved against the $50,000 sale
    // alone (documentDiscountBaseCents = subtotal(30,000) +
    // creditItemsAbsCents(20,000) = 50,000), 10% of that is $5,000, and the
    // full $20,000 trade-in still comes off on top -> 50,000 - 5,000 -
    // 20,000 = 25,000.
    expect(result.documentConcession.parts.documentDiscount).toBe("5000.00");
    expect(result.taxableBase).toBe(25000);
    expect(result.total).toBe(25000);
    // The trade-in item's own itemTotal (what actually credits the
    // customer) is untouched -- still exactly -20,000, never -18,000.
    expect(result.itemTotals).toEqual([50000, -20000]);
  });

  it("an ordinary line still takes its full share of the document discount with a trade-in present", () => {
    const result = computeTotals({
      items: [
        { unitPrice: 40000, listPrice: 40000, lines: [] },
        { unitPrice: 10000, listPrice: 10000, lines: [] },
        { unitPrice: 20000, listPrice: 20000, lines: [], isCredit: true },
      ],
      extraLines: [],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "5",
      taxRate: 0,
    });
    // Base is the two ordinary items only: 40,000 + 10,000 = 50,000; 5% of
    // that is 2,500.
    expect(result.documentConcession.parts.documentDiscount).toBe("2500.00");
    expect(result.taxableBase).toBe(27500); // 50,000 - 2,500 - 20,000
  });

  it("with no credit item present, the fix changes nothing (same result as before)", () => {
    const result = computeTotals({
      items: [{ unitPrice: 1000, listPrice: 1000, lines: [] }],
      extraLines: [],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "10",
      taxRate: 0,
    });
    expect(result.documentConcession.parts.documentDiscount).toBe("100.00");
    expect(result.taxableBase).toBe(900);
  });

  it("a no-commission item and a credit item together: both carve-outs apply independently", () => {
    const result = computeTotals({
      items: [
        { unitPrice: 40000, listPrice: 40000, lines: [] },
        { unitPrice: 6000, listPrice: 6000, lines: [], isNoCommission: true },
        { unitPrice: 20000, listPrice: 20000, lines: [], isCredit: true },
      ],
      extraLines: [],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "10",
      taxRate: 0,
    });
    // Base is the commissionable, non-credit part only: 40,000 (the
    // no-commission item and the credit item are both excluded). 10% of
    // 40,000 = 4,000.
    expect(result.documentConcession.parts.documentDiscount).toBe("4000.00");
    // 40,000 + 6,000 - 4,000 - 20,000 = 22,000.
    expect(result.taxableBase).toBe(22000);
  });

  it("the concession cap now measures the true discount, not the trade-in-shrunk one", () => {
    // Same $50,000/$20,000/10% document as the first test above -- pre-fix
    // this would have reported only a $3,000 discount concession; the true
    // figure is $5,000.
    const result = computeTotals({
      items: [
        { unitPrice: 50000, listPrice: 50000, lines: [] },
        { unitPrice: 20000, listPrice: 20000, lines: [], isCredit: true },
      ],
      extraLines: [],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "10",
      regionMaxDiscountPct: 100,
      taxRate: 0,
    });
    expect(result.documentConcession.parts.documentDiscount).toBe("5000.00");
    // tradeIns (20,000) + documentDiscount (5,000) = 25,000 concession,
    // against a $50,000 list value (the credit item never adds to
    // listValue) -- 50%.
    expect(result.documentConcession.concession).toBe("25000.00");
    expect(result.documentConcession.listValue).toBe("50000.00");
    expect(result.documentConcession.effectivePct).toBeCloseTo(50, 5);
  });
});

describe("markup ceiling (Region.maxMarkupPct)", () => {
  // Mirrors the discount-cap boundary tests above ("stays within the cap
  // just under the boundary" / "does not flag exceedsCap exactly at the
  // boundary" / "flags exceedsCap just over the boundary"), for the
  // opposite-signed case: a negative concession (a price raised above list)
  // is a markup — see `exceedsMarkupCap`'s own doc comment on
  // `DocumentConcession`.

  it("does not flag exceedsMarkupCap exactly at the boundary (10% markup against a 10% ceiling)", () => {
    // $10,000 list, sold at $11,000 -- exactly 10% above list.
    const result = computeTotals({
      items: [{ unitPrice: 11000, listPrice: 10000, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      regionMaxMarkupPct: 10,
      taxRate: 0,
    });
    expect(result.documentConcession.effectivePct).toBe(-10);
    expect(result.documentConcession.exceedsMarkupCap).toBe(false);
  });

  it("flags exceedsMarkupCap a cent past the boundary (10.01% markup against a 10% ceiling)", () => {
    const result = computeTotals({
      items: [{ unitPrice: 11001, listPrice: 10000, lines: [] }], // 10.01% above list
      extraLines: [],
      documentDiscountValue: null,
      regionMaxMarkupPct: 10,
      taxRate: 0,
    });
    expect(result.documentConcession.effectivePct).toBeCloseTo(-10.01, 5);
    expect(result.documentConcession.exceedsMarkupCap).toBe(true);
  });

  it("never flags exceedsMarkupCap when regionMaxMarkupPct is unset (no ceiling), no matter how large the markup", () => {
    const result = computeTotals({
      items: [{ unitPrice: 1000000, listPrice: 10000, lines: [] }], // 9,900% above list
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.documentConcession.allowedMarkupPct).toBeNull();
    expect(result.documentConcession.exceedsMarkupCap).toBe(false);
  });

  it("leaves a document priced below list unaffected by the markup ceiling", () => {
    // Sold *under* list -- a discount, not a markup -- so the ceiling (which
    // only ever bounds a negative concession) can never fire here regardless
    // of how tight it is.
    const result = computeTotals({
      items: [{ unitPrice: 8900, listPrice: 10000, lines: [] }], // 11% below list
      extraLines: [],
      documentDiscountValue: null,
      regionMaxMarkupPct: 1,
      taxRate: 0,
    });
    expect(result.documentConcession.effectivePct).toBeCloseTo(11, 5);
    expect(result.documentConcession.exceedsMarkupCap).toBe(false);
  });

  it("never fires the discount cap and the markup ceiling at once for the same document (opposite signs)", () => {
    // Same region (both caps set to 10%), two documents: one discounted well
    // past the discount cap, one marked up well past the markup ceiling.
    // Each can only ever trip its own guardrail -- a single concession
    // figure can't be simultaneously a large positive discount and a large
    // negative markup.
    const heavilyDiscounted = computeTotals({
      items: [{ unitPrice: 5000, listPrice: 10000, lines: [] }], // 50% below list
      extraLines: [],
      documentDiscountValue: null,
      regionMaxDiscountPct: 10,
      regionMaxMarkupPct: 10,
      taxRate: 0,
    });
    expect(heavilyDiscounted.documentConcession.exceedsCap).toBe(true);
    expect(heavilyDiscounted.documentConcession.exceedsMarkupCap).toBe(false);

    const heavilyMarkedUp = computeTotals({
      items: [{ unitPrice: 15000, listPrice: 10000, lines: [] }], // 50% above list
      extraLines: [],
      documentDiscountValue: null,
      regionMaxDiscountPct: 10,
      regionMaxMarkupPct: 10,
      taxRate: 0,
    });
    expect(heavilyMarkedUp.documentConcession.exceedsCap).toBe(false);
    expect(heavilyMarkedUp.documentConcession.exceedsMarkupCap).toBe(true);

    // Neither result ever has both flags true at once.
    expect(heavilyDiscounted.documentConcession.exceedsCap && heavilyDiscounted.documentConcession.exceedsMarkupCap).toBe(
      false
    );
    expect(heavilyMarkedUp.documentConcession.exceedsCap && heavilyMarkedUp.documentConcession.exceedsMarkupCap).toBe(
      false
    );
  });
});

describe("markupCapMessage", () => {
  // Non-whole-dollar figures throughout, same reasoning as
  // concessionCapMessage's own tests above — formatMoney's "whole amounts
  // render without decimals" rule would otherwise make a `toBe` assertion
  // depend on that unrelated formatting choice.
  it("states the amount over list, its percentage, the ceiling, and the region", () => {
    const message = markupCapMessage(
      {
        concession: "-1000.50",
        listValue: "10000.00",
        effectivePct: -10,
        allowedPct: 100,
        exceedsCap: false,
        allowedMarkupPct: 10,
        exceedsMarkupCap: true,
        parts: { documentDiscount: "0.00", itemDiscounts: "0.00", priceAdjustments: "-1000.50", tradeIns: "0.00" },
      },
      "Australia",
      "AUD"
    );
    expect(message).toBe(
      "This quote is priced $1,000.50 above list (10% markup) — above the 10% markup ceiling for Australia."
    );
  });
});

describe("capPct", () => {
  it("returns the typed value directly for PERCENT, ignoring the resolved cents discount", () => {
    // A $1.03 base with a 51% discount resolves to a 53c discount (51.46% of
    // base) — capPct must still report 51, not 51.46, for PERCENT.
    const base = toCents(1.03);
    const discount = discountCents(base, "PERCENT", "51");
    expect(discount).toBe(53);
    expect(capPct("PERCENT", "51", base, discount)).toBe(51);
  });

  it("returns the resolved effective percentage for AMOUNT", () => {
    const base = toCents(100000);
    const discount = discountCents(base, "AMOUNT", "20000");
    expect(capPct("AMOUNT", "20000", base, discount)).toBe(20);
  });

  it("returns 0 for a null value regardless of mode", () => {
    expect(capPct("PERCENT", null, 10000, 0)).toBe(0);
    expect(capPct("AMOUNT", null, 10000, 0)).toBe(0);
  });
});

describe("commission calculation (PricingTotals.commission)", () => {
  it("reproduces the owner's corrected worked example to the cent", () => {
    // Item 1  10,000
    // Item 2  15,000
    // Item 3  20,000
    // Item 4   3,000
    //         ------
    //         48,000   commissionable list
    // Item 5   6,000   (no commission, untouched by the discount -- Commit 1)
    //         ------
    //         54,000   list, all items
    //
    // A 10% document discount now reaches only the 48,000 commissionable
    // total (Commit 1 -- the no-commission item takes no percentage
    // discount at all):
    //   discount        = 48,000 x 10% = 4,800
    //   customer pays    = (48,000 - 4,800) + 6,000 = 43,200 + 6,000 = 49,200
    //   commission base  = 48,000 - 4,800 = 43,200 (list price of the
    //                      no-commission item is subtracted separately below
    //                      -- it was never part of the 48,000 commissionable
    //                      total to begin with)
    //   documentConcession.effectivePct = concession / listValue
    //                    = 4,800 / 54,000 = 8.888...% -- NOT the flat 10%
    //                      discount value, because the concession no longer
    //                      includes any share of the no-commission item (it
    //                      was never discounted). 8.89% still falls in the
    //                      same "5.01-10% -> 4.5%" tier as a flat 10% would
    //                      have, so the rate is unaffected here, but the two
    //                      numbers are NOT the same thing in general.
    //   rate             = 4.5% (tier for 8.888...%, same tier a flat 10%
    //                      would also have landed in)
    //   commission       = 43,200 x 4.5% = 1,944
    //
    // This differs from the original brief's worked figure ($1,917), which
    // was computed by applying the 10% discount to the FULL 54,000
    // (including the no-commission item) before subtracting that item's
    // charged price. The owner's later, corrected instruction is that a
    // no-commission line takes no discount in the first place, which is
    // what this test (and the engine) now implement.
    const result = computeTotals({
      items: [
        { unitPrice: 10000, lines: [] },
        { unitPrice: 15000, lines: [] },
        { unitPrice: 20000, lines: [] },
        { unitPrice: 3000, lines: [] },
        { unitPrice: 6000, lines: [], isNoCommission: true },
      ],
      extraLines: [],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "10",
      taxRate: 0,
      commissionTiers: DEFAULT_COMMISSION_TIERS,
    });
    expect(result.subtotal).toBe(54000);
    // The customer pays 49,200 (43,200 discounted commissionable + 6,000
    // untouched no-commission item), not 48,600 -- the no-commission item's
    // full charged price passes through the document discount untouched.
    expect(result.taxableBase).toBe(49200);
    expect(result.documentConcession.parts.documentDiscount).toBe("4800.00");
    expect(result.documentConcession.effectivePct).toBeCloseTo(8.888888888888889, 9);
    expect(result.commission).toEqual({ base: "43200.00", ratePct: 4.5, amount: "1944.00" });
  });

  // Every tier boundary, both sides -- a tier table is nothing but
  // boundaries. Each case sells a single $10,000-list item at a price that
  // produces an exact concession percentage (no document/item discount
  // involved), so `documentConcession.effectivePct` lands exactly on the
  // boundary being tested.
  function ratePctForConcessionPct(pct: number): number | undefined {
    const concessionDollars = (pct / 100) * 10000;
    const result = computeTotals({
      items: [{ unitPrice: 10000 - concessionDollars, listPrice: 10000, lines: [] }],
      extraLines: [],
      taxRate: 0,
      commissionTiers: DEFAULT_COMMISSION_TIERS,
    });
    return result.commission?.ratePct;
  }

  it.each([
    [0, 5],
    [0.01, 4.75],
    [5, 4.75],
    [5.01, 4.5],
    [10, 4.5],
    [10.01, 4.25],
    [15, 4.25],
    [15.01, 4],
  ])("a %s%% discount earns %s%% commission", (pct, expectedRatePct) => {
    expect(ratePctForConcessionPct(pct)).toBe(expectedRatePct);
  });

  it("selling above list clamps to the 0% tier, never a negative rate", () => {
    // Priced $1,000 above a $10,000 list -- a -10% concession.
    const result = computeTotals({
      items: [{ unitPrice: 11000, listPrice: 10000, lines: [] }],
      extraLines: [],
      taxRate: 0,
      commissionTiers: DEFAULT_COMMISSION_TIERS,
    });
    expect(result.documentConcession.effectivePct).toBe(-10);
    expect(result.commission?.ratePct).toBe(5);
  });

  it("excludes a no-commission item from the commission base but not from the subtotal", () => {
    const result = computeTotals({
      items: [
        { unitPrice: 1000, lines: [] },
        { unitPrice: 400, lines: [], isNoCommission: true },
      ],
      extraLines: [],
      taxRate: 0,
      commissionTiers: DEFAULT_COMMISSION_TIERS,
    });
    expect(result.subtotal).toBe(1400);
    expect(result.commission).toEqual({ base: "1000.00", ratePct: 5, amount: "50.00" });
  });

  it("excludes a no-commission option line from the commission base but not from the subtotal", () => {
    const result = computeTotals({
      items: [{ unitPrice: 1000, lines: [{ qty: 1, unitPrice: 400, isNoCommission: true }] }],
      extraLines: [],
      taxRate: 0,
      commissionTiers: DEFAULT_COMMISSION_TIERS,
    });
    expect(result.subtotal).toBe(1400);
    expect(result.commission).toEqual({ base: "1000.00", ratePct: 5, amount: "50.00" });
  });

  it("excludes a no-commission item AND a no-commission line together", () => {
    const result = computeTotals({
      items: [
        { unitPrice: 1000, lines: [{ qty: 1, unitPrice: 400, isNoCommission: true }], isNoCommission: true },
        { unitPrice: 2000, lines: [] },
      ],
      extraLines: [],
      taxRate: 0,
      commissionTiers: DEFAULT_COMMISSION_TIERS,
    });
    expect(result.subtotal).toBe(3400);
    expect(result.commission).toEqual({ base: "2000.00", ratePct: 5, amount: "100.00" });
  });

  it("a quote entirely of no-commission items yields zero commission, not a negative number", () => {
    const result = computeTotals({
      items: [{ unitPrice: 1000, lines: [], isNoCommission: true }],
      extraLines: [],
      taxRate: 0,
      commissionTiers: DEFAULT_COMMISSION_TIERS,
    });
    expect(result.commission).toEqual({ base: "0.00", ratePct: 5, amount: "0.00" });
  });

  it("a document discount can no longer push a wholly no-commission quote's taxableBase down at all (Commit 1)", () => {
    // Before Commit 1, a 50% document discount reached every item
    // regardless of isNoCommission, so a single no-commission item's
    // taxableBase would have been cut in half (1,000 -> 500) and the
    // commission-base clamp below would have been trivially satisfied by
    // that halved figure. Now the no-commission item is entirely excluded
    // from the document discount's base (documentDiscountBaseCents =
    // subtotal(1000) - noCommissionCharged(1000) = 0), so the discount has
    // nothing left to apply to and taxableBase stays the full 1,000 -- the
    // clamp below is genuinely exercised by list price, not by a discount.
    const result = computeTotals({
      items: [{ unitPrice: 1000, lines: [], isNoCommission: true }],
      extraLines: [],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "50",
      taxRate: 0,
      commissionTiers: DEFAULT_COMMISSION_TIERS,
    });
    expect(result.taxableBase).toBe(1000);
    expect(result.commission?.base).toBe("0.00");
    expect(result.commission?.amount).toBe("0.00");
  });

  it("a no-commission item takes no document-level discount -- the commissionable item carries the whole discount instead", () => {
    // Before Commit 1, a document-level 10% discount applied to the WHOLE
    // 1,500 subtotal (150 off, taxableBase 1,350). Now the no-commission
    // item (500) is carved out of the discount's base entirely --
    // documentDiscountBaseCents = 1,500 - 500 = 1,000, so the discount is
    // 10% of 1,000 = 100, not 150, and the no-commission item's own charged
    // price (500) passes through completely untouched either way.
    const result = computeTotals({
      items: [
        { unitPrice: 1000, lines: [] },
        { unitPrice: 500, lines: [], isNoCommission: true },
      ],
      extraLines: [],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "10",
      taxRate: 0,
      commissionTiers: DEFAULT_COMMISSION_TIERS,
    });
    expect(result.documentConcession.parts.documentDiscount).toBe("100.00");
    // 1,500 - 100 = 1,400 (not the pre-Commit-1 1,350).
    expect(result.taxableBase).toBe(1400);
    // Commission base: taxableBase(1,400) - no-commission item's LIST
    // price (500, defaults to its unitPrice) = 900.
    expect(result.commission?.base).toBe("900.00");
  });

  it("clamps the commission base at zero rather than negative when a no-commission item's list price exceeds the remaining taxable base", () => {
    // Commit 2: the commission base subtracts a no-commission item's FULL
    // LIST price, not its charged price -- see computeTotals's commission
    // section. A cheap commissionable item (1,000) alongside a no-commission
    // item priced at 100 but listed at 5,000 would drive the base negative
    // (1,100 - 5,000) if it weren't clamped.
    const result = computeTotals({
      items: [
        { unitPrice: 1000, lines: [] },
        { unitPrice: 100, listPrice: 5000, lines: [], isNoCommission: true },
      ],
      extraLines: [],
      taxRate: 0,
      commissionTiers: DEFAULT_COMMISSION_TIERS,
    });
    // taxableBase = 1,000 + 100 = 1,100 (the customer is still charged the
    // no-commission item's actual, hand-set 100 -- Commit 1).
    expect(result.taxableBase).toBe(1100);
    expect(result.commission?.base).toBe("0.00");
    expect(result.commission?.amount).toBe("0.00");
  });

  it("a no-commission line hand-set to zero: the customer pays zero for it, and the commission base still drops by its full list price", () => {
    // Giving a no-commission item away for free doesn't cost the business
    // nothing -- the commission base still drops by what it was worth
    // (list), even though the customer's own charge for it is 0.
    const result = computeTotals({
      items: [
        { unitPrice: 2000, lines: [] },
        { unitPrice: 0, listPrice: 800, lines: [], isNoCommission: true },
      ],
      extraLines: [],
      taxRate: 0,
      commissionTiers: DEFAULT_COMMISSION_TIERS,
    });
    // The customer pays 2,000 total -- the given-away item contributes $0,
    // not a negative amount and not its list price.
    expect(result.itemTotals[1]).toBe(0);
    expect(result.taxableBase).toBe(2000);
    // Commission base: taxableBase(2,000) - the given-away item's LIST
    // price (800, NOT the 0 it was actually charged) = 1,200.
    expect(result.commission?.base).toBe("1200.00");
  });

  it("the concession cap still catches a giveaway on a no-commission line (a hand-set price cut, not a discount)", () => {
    const result = computeTotals({
      items: [
        { unitPrice: 10000, listPrice: 10000, lines: [] },
        { unitPrice: 0, listPrice: 2000, lines: [], isNoCommission: true }, // given away
      ],
      extraLines: [],
      regionMaxDiscountPct: 10,
      taxRate: 0,
      commissionTiers: DEFAULT_COMMISSION_TIERS,
    });
    // concession = (2000 - 0) price cut = 2000; listValue = 10000 + 2000 =
    // 12000; effectivePct = 2000/12000*100 = 16.67%, above the 10% cap.
    expect(result.documentConcession.concession).toBe("2000.00");
    expect(result.documentConcession.listValue).toBe("12000.00");
    expect(result.documentConcession.effectivePct).toBeCloseTo(16.666666666666668, 9);
    expect(result.documentConcession.exceedsCap).toBe(true);
  });

  it("an item-level percentage discount on a wholly no-commission item is inert -- it does not apply at all", () => {
    // Decision (see Commit 1's brief): item-level and document-level
    // discounts are treated consistently -- neither reaches a no-commission
    // line. A 50% item-level discount set on a no-commission item resolves
    // to 0, not 500.
    const result = computeTotals({
      items: [
        {
          unitPrice: 1000,
          listPrice: 1000,
          discountMode: "PERCENT",
          discountValue: "50",
          lines: [],
          isNoCommission: true,
        },
      ],
      extraLines: [],
      taxRate: 0,
    });
    expect(result.itemDiscounts).toEqual([0]);
    expect(result.itemTotals).toEqual([1000]);
    expect(result.violations).toEqual([]);
  });

  it("an item-level discount still applies to an ordinary line living on an otherwise no-commission item (the two flags are independent)", () => {
    // The item itself is flagged no-commission, but carries one ordinary
    // (non-no-commission) option line -- that line still receives its share
    // of the item's own discount, matching how the document-level rule only
    // ever carves out the specifically-flagged lines, never a whole item's
    // ordinary content by association.
    const result = computeTotals({
      items: [
        {
          unitPrice: 1000, // excluded (item itself is flagged)
          discountMode: "PERCENT",
          discountValue: "10",
          isNoCommission: true,
          lines: [{ qty: 1, unitPrice: 500 }], // an ordinary line -- included
        },
      ],
      extraLines: [],
      taxRate: 0,
    });
    // discountBaseCents = 0 (item) + 500 (ordinary line) = 500; 10% of 500 = 50.
    expect(result.itemDiscounts).toEqual([50]);
    // base = 1000 + 500 = 1500; itemTotal = 1500 - 50 = 1450.
    expect(result.itemTotals).toEqual([1450]);
  });

  it("is null when no tier table is configured (commissionTiers omitted)", () => {
    const result = computeTotals({
      items: [{ unitPrice: 1000, lines: [] }],
      extraLines: [],
      taxRate: 0,
    });
    expect(result.commission).toBeNull();
  });

  it("is null when the tier table is explicitly empty (cleared by an admin)", () => {
    const result = computeTotals({
      items: [{ unitPrice: 1000, lines: [] }],
      extraLines: [],
      taxRate: 0,
      commissionTiers: [],
    });
    expect(result.commission).toBeNull();
  });

  it("leaves every existing total unchanged when every flag is false/absent and no discount is given", () => {
    const withoutFlags = computeTotals({
      items: [{ unitPrice: 1000, lines: [{ qty: 1, unitPrice: 200 }] }],
      extraLines: [{ qty: 1, unitPrice: 50 }],
      taxRate: 10,
    });
    const withFalseFlags = computeTotals({
      items: [{ unitPrice: 1000, lines: [{ qty: 1, unitPrice: 200, isNoCommission: false }], isNoCommission: false }],
      extraLines: [{ qty: 1, unitPrice: 50 }],
      taxRate: 10,
    });
    expect(withFalseFlags).toEqual(withoutFlags);
    expect(withoutFlags.commission).toBeNull();
  });
});

describe("validateCommissionTiers", () => {
  it("accepts the default table", () => {
    expect(validateCommissionTiers(DEFAULT_COMMISSION_TIERS)).toBeNull();
  });

  it("accepts an empty table (the 'admin cleared it' state)", () => {
    expect(validateCommissionTiers([])).toBeNull();
  });

  it("rejects a table that doesn't start at 0%", () => {
    const tiers: CommissionTier[] = [{ minPct: 1, maxPct: null, ratePct: 5 }];
    expect(validateCommissionTiers(tiers)).toMatch(/start at 0/);
  });

  it("rejects a table with a gap between two tiers", () => {
    const tiers: CommissionTier[] = [
      { minPct: 0, maxPct: 5, ratePct: 5 },
      { minPct: 6, maxPct: null, ratePct: 4 }, // 5.01-5.99% covered by nothing
    ];
    expect(validateCommissionTiers(tiers)).toMatch(/gap/);
  });

  it("rejects a table with a gap above the last tier (not left open-ended)", () => {
    const tiers: CommissionTier[] = [{ minPct: 0, maxPct: 10, ratePct: 5 }];
    expect(validateCommissionTiers(tiers)).toMatch(/gap/);
  });

  it("rejects a table with overlapping tiers", () => {
    const tiers: CommissionTier[] = [
      { minPct: 0, maxPct: 5, ratePct: 5 },
      { minPct: 3, maxPct: null, ratePct: 4 }, // 3-5% claimed by both tiers
    ];
    expect(validateCommissionTiers(tiers)).toMatch(/overlap/);
  });

  it("rejects a table where an earlier tier (not the last) is left open-ended", () => {
    const tiers: CommissionTier[] = [
      { minPct: 0, maxPct: null, ratePct: 5 },
      { minPct: 0.01, maxPct: null, ratePct: 4 },
    ];
    expect(validateCommissionTiers(tiers)).toMatch(/last tier/);
  });
});


// --- was tests/discounts.test.ts: discounts — a discount is a mode ("PERCENT" | "AMOUNT") plus a value ------------------

describe("a trade-in combined with a document-level cash discount", () => {
  // The two ways a quote's total can be pulled down meet here: a negative
  // extra line (Task 5, how a trade-in is entered) and an AMOUNT document
  // discount (Task 6). Both reduce the same subtotal, so this locks in that
  // they compose without producing a negative taxable base.
  it("nets the trade-in off the subtotal before the cash discount applies", () => {
    const result = computeTotals({
      items: [{ unitPrice: 195000, discountMode: "PERCENT", discountValue: null, lines: [] }],
      extraLines: [{ qty: 1, unitPrice: -15000 }],
      documentDiscountMode: "AMOUNT",
      documentDiscountValue: "5000",
      taxRate: 0,
    });
    expect(result.subtotal).toBe(180000);
    expect(result.negativeSubtotal).toBe(false);
    expect(result.discountAmount).toBe(5000);
    expect(result.total).toBe(175000);
  });

  it("clamps a cash discount that would swallow a subtotal already cut by a trade-in", () => {
    const result = computeTotals({
      items: [{ unitPrice: 20000, discountMode: "PERCENT", discountValue: null, lines: [] }],
      extraLines: [{ qty: 1, unitPrice: -15000 }],
      documentDiscountMode: "AMOUNT",
      documentDiscountValue: "999999",
      taxRate: 0,
    });
    expect(result.subtotal).toBe(5000);
    expect(result.discountAmount).toBe(5000);
    expect(result.total).toBe(0);
  });
});

describe("item-level discount mode", () => {
  it("an AMOUNT discount below the base reduces the item total by exactly that amount", () => {
    const result = computeTotals({
      items: [{ unitPrice: 100000, discountMode: "AMOUNT", discountValue: "20000", lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.itemTotals).toEqual([80000]);
    expect(result.subtotal).toBe(80000);
  });

  it("an AMOUNT discount larger than the base is clamped to the base, never a negative item total", () => {
    const result = computeTotals({
      items: [{ unitPrice: 100000, discountMode: "AMOUNT", discountValue: "150000", lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.itemTotals).toEqual([0]);
    expect(result.subtotal).toBe(0);
  });

  it("reports a violation when an AMOUNT discount's effective percentage exceeds the item's cap", () => {
    // $20,000 off a $100,000 base is 20% — above the 10% region cap.
    const result = computeTotals({
      items: [
        { unitPrice: 100000, discountMode: "AMOUNT", discountValue: "20000", maxDiscountPct: 10, lines: [] },
      ],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.violations).toEqual([{ itemIndex: 0, allowedPct: 10 }]);
    // The math still uses the requested discount, not the cap.
    expect(result.itemTotals).toEqual([80000]);
  });

  it("a PERCENT discount still yields the same result as before Task 6, to the cent", () => {
    const result = computeTotals({
      items: [{ unitPrice: 100000, discountMode: "PERCENT", discountValue: "5", lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.itemTotals).toEqual([95000]);
    expect(result.subtotal).toBe(95000);
  });
});

describe("document-level discount mode", () => {
  it("an AMOUNT discount below the subtotal reduces it by exactly that amount", () => {
    const result = computeTotals({
      items: [{ unitPrice: 100000, lines: [] }],
      extraLines: [],
      documentDiscountMode: "AMOUNT",
      documentDiscountValue: "20000",
      taxRate: 0,
    });
    expect(result.subtotal).toBe(100000);
    expect(result.discountAmount).toBe(20000);
    expect(result.taxableBase).toBe(80000);
    expect(result.total).toBe(80000);
  });

  it("an AMOUNT discount larger than the subtotal is clamped, taxableBase never negative", () => {
    const result = computeTotals({
      items: [{ unitPrice: 100000, lines: [] }],
      extraLines: [],
      documentDiscountMode: "AMOUNT",
      documentDiscountValue: "150000",
      taxRate: 0,
    });
    expect(result.subtotal).toBe(100000);
    expect(result.discountAmount).toBe(100000);
    expect(result.taxableBase).toBe(0);
    expect(result.total).toBe(0);
  });

  it("an AMOUNT discount's effective percentage of the subtotal is computable the same way an item's is", () => {
    // Mirrors the item-level cap check above: the region cap is enforced
    // against the *document* subtotal by the caller (setDocumentDiscount in
    // src/lib/actions/documents.ts), using the same discountCents/
    // effectivePct pair computeTotals uses internally — the engine itself
    // has no document-level maxDiscountPct input (only items carry
    // maxDiscountPct — see EngineItem), so this asserts the resolved
    // discount amount and its effective percentage against the subtotal
    // directly, exactly the figures the action's cap check consumes: $20,000
    // off a $100,000 subtotal is 20%, above a 10% cap.
    const result = computeTotals({
      items: [{ unitPrice: 100000, lines: [] }],
      extraLines: [],
      documentDiscountMode: "AMOUNT",
      documentDiscountValue: "20000",
      taxRate: 0,
    });
    expect(result.discountAmount).toBe(20000);
    const effectivePct = (result.discountAmount / result.subtotal) * 100;
    expect(effectivePct).toBe(20);
    expect(effectivePct).toBeGreaterThan(10);
  });

  it("a PERCENT document discount still yields the same result as before Task 6, to the cent", () => {
    const result = computeTotals({
      items: [{ unitPrice: 100000, lines: [] }],
      extraLines: [],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "5",
      taxRate: 0,
    });
    expect(result.subtotal).toBe(100000);
    expect(result.discountAmount).toBe(5000);
    expect(result.taxableBase).toBe(95000);
    expect(result.total).toBe(95000);
  });
});

describe("PERCENT cap comparison is not distorted by cents rounding (regression)", () => {
  // discountCents for PERCENT computes the *kept* amount (base * (1 -
  // pct/100), rounded half up) and subtracts it from base to get the
  // discount — not `base * pct/100` rounded directly. That asymmetry means
  // converting the resolved discount back to a percentage via `effectivePct`
  // can land on either side of the typed value on a base that doesn't
  // divide evenly. `capPct` (src/lib/pricing.ts) avoids this entirely for
  // PERCENT by comparing the typed value to the cap directly.

  it("does not flag a violation on the originally suspected case ($333.35 base, 10% discount, 10% cap)", () => {
    // 10% of 33335c is 3333.5c. One might expect this to round up to 3334c
    // (making the effective percentage 10.0015%, just over a 10% cap) — but
    // discountCents actually rounds the *kept* 90% up (30001.5 -> 30002)
    // and subtracts, giving a 3333c discount: 9.9985% of base, under the
    // cap even via the old (buggy) effectivePct comparison. This case does
    // NOT reproduce the regression; it's kept here as a documented negative.
    const result = computeTotals({
      items: [{ unitPrice: 333.35, discountMode: "PERCENT", discountValue: "10", maxDiscountPct: 10, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.violations).toEqual([]);
  });

  it("does not flag a violation for a discount typed at exactly the cap, on a base where rounding pushes the naive effective percentage over it", () => {
    // $1.03 base, 51% discount: 51% of 103c is 52.53c, which rounds up to
    // 53c — 51.46% of base. Routing this through effectivePct (as the code
    // did before this fix) would report a violation for a discount typed at
    // exactly the 51% cap; comparing the typed value directly does not.
    const result = computeTotals({
      items: [{ unitPrice: 1.03, discountMode: "PERCENT", discountValue: "51", maxDiscountPct: 51, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.violations).toEqual([]);
    expect(result.itemTotals).toEqual([0.5]);
  });

  it("still flags a PERCENT discount that is genuinely above the cap on that same base", () => {
    const result = computeTotals({
      items: [{ unitPrice: 1.03, discountMode: "PERCENT", discountValue: "52", maxDiscountPct: 51, lines: [] }],
      extraLines: [],
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(result.violations).toEqual([{ itemIndex: 0, allowedPct: 51 }]);
  });
});

describe("no discount set (mode present, value null)", () => {
  it("treats a null discountValue as zero discount regardless of mode", () => {
    const percentMode = computeTotals({
      items: [{ unitPrice: 100000, discountMode: "PERCENT", discountValue: null, lines: [] }],
      extraLines: [],
      documentDiscountMode: "AMOUNT",
      documentDiscountValue: null,
      taxRate: 0,
    });
    const amountMode = computeTotals({
      items: [{ unitPrice: 100000, discountMode: "AMOUNT", discountValue: null, lines: [] }],
      extraLines: [],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: null,
      taxRate: 0,
    });
    expect(percentMode.itemTotals).toEqual([100000]);
    expect(amountMode.itemTotals).toEqual([100000]);
    expect(percentMode.discountAmount).toBe(0);
    expect(amountMode.discountAmount).toBe(0);
  });
});
