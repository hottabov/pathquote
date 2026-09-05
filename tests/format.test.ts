import { describe, it, expect } from "vitest";
import { formatMoney } from "../src/lib/format";
import { formatDocNumber } from "../src/lib/numbering";

// Expected values are derived from Intl.NumberFormat directly (an oracle
// independent of formatMoney's implementation) rather than hardcoded
// strings, since the exact currency glyph Intl renders (e.g. "$" vs "US$"
// vs "USD") depends on the host's bundled CLDR data and shouldn't make
// this test brittle across environments.
function expectedMoney(amount: number, currency: string, locale = "en-AU") {
  const isWhole = Number.isInteger(amount);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: isWhole ? 0 : 2,
  }).format(amount);
}

describe("formatMoney", () => {
  it("formats a whole-number AUD amount with no decimals", () => {
    expect(formatMoney(175000, "AUD")).toBe(expectedMoney(175000, "AUD"));
    expect(formatMoney(175000, "AUD")).not.toContain(".");
  });

  it("formats a whole-number USD amount with no decimals", () => {
    expect(formatMoney(1500, "USD")).toBe(expectedMoney(1500, "USD"));
    expect(formatMoney(1500, "USD")).not.toContain(".");
  });

  it("formats a whole-number GBP amount with no decimals", () => {
    expect(formatMoney(2500, "GBP")).toBe(expectedMoney(2500, "GBP"));
    expect(formatMoney(2500, "GBP")).not.toContain(".");
  });

  it("keeps 2 decimal places when the amount has a fractional part", () => {
    expect(formatMoney(1234.5, "AUD")).toBe(expectedMoney(1234.5, "AUD"));
    expect(formatMoney(1234.5, "AUD")).toContain(".50");
  });

  it("keeps 2 decimal places for a non-trivial fraction", () => {
    expect(formatMoney(99.99, "USD")).toBe(expectedMoney(99.99, "USD"));
    expect(formatMoney(99.99, "USD")).toContain(".99");
  });

  it("accepts a string amount", () => {
    expect(formatMoney("175000", "AUD")).toBe(formatMoney(175000, "AUD"));
  });

  it("accepts a string amount with decimals", () => {
    expect(formatMoney("1234.50", "AUD")).toBe(formatMoney(1234.5, "AUD"));
  });

  it("accepts a Prisma Decimal-like object via toString()", () => {
    const decimalLike = { toString: () => "175000" };
    expect(formatMoney(decimalLike, "AUD")).toBe(formatMoney(175000, "AUD"));
  });

  it("accepts a Decimal-like object with a fractional value", () => {
    const decimalLike = { toString: () => "99.90" };
    expect(formatMoney(decimalLike, "USD")).toBe(formatMoney(99.9, "USD"));
  });

  it("treats zero as a whole number", () => {
    expect(formatMoney(0, "AUD")).toBe(expectedMoney(0, "AUD"));
    expect(formatMoney(0, "AUD")).not.toContain(".");
  });

  it("respects an explicit locale override", () => {
    expect(formatMoney(1234.5, "USD", "en-US")).toBe(expectedMoney(1234.5, "USD", "en-US"));
  });
});


// --- was tests/numbering.test.ts: formatDocNumber (src/lib/numbering.ts) ------------------

describe("formatDocNumber", () => {
  it("formats a quote number", () => {
    expect(formatDocNumber("AU", 2026, 1)).toBe("Q-AU-2026-001");
  });

  it("pads to three digits and grows past 999", () => {
    expect(formatDocNumber("AU", 2026, 42)).toBe("Q-AU-2026-042");
    expect(formatDocNumber("AU", 2026, 1234)).toBe("Q-AU-2026-1234");
  });
});
