import { describe, it, expect } from "vitest";
import { formatMoney, relativeTime } from "../src/lib/format";
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
    // Locale is the FOURTH argument — the third is the region's optional
    // currency-symbol override (see `formatMoney`), so `null` here means
    // "no override" and leaves Intl's own symbol in place.
    expect(formatMoney(1234.5, "USD", null, "en-US")).toBe(expectedMoney(1234.5, "USD", "en-US"));
  });
});


// --- relativeTime (src/lib/format.ts) ----------------------------------------
// Added for Settings -> ACT! sync, which has to answer "is this stale?" about a
// job that runs once a night. Every case passes `now` explicitly: the suite has
// no fake timers (see vitest.config.ts), which is why the parameter exists.

describe("relativeTime", () => {
  const now = new Date("2026-10-10T05:00:00.000Z");
  const ago = (ms: number) => relativeTime(new Date(now.getTime() - ms), now);
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;

  it("says 'just now' for the first few seconds", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(44 * SECOND)).toBe("just now");
  });

  it("flattens a clock that is ahead rather than counting backwards", () => {
    // A server and a database disagreeing by a second must not produce "-1
    // minutes ago" on a page whose whole job is to be trusted.
    expect(relativeTime(new Date(now.getTime() + 90 * SECOND), now)).toBe("just now");
  });

  it("counts minutes, singular at one", () => {
    expect(ago(45 * SECOND)).toBe("1 minute ago");
    expect(ago(2 * MINUTE)).toBe("2 minutes ago");
    expect(ago(59 * MINUTE)).toBe("59 minutes ago");
  });

  it("counts hours, singular at one", () => {
    expect(ago(60 * MINUTE)).toBe("1 hour ago");
    expect(ago(2 * HOUR)).toBe("2 hours ago");
  });

  it("keeps counting hours past a day, up to two", () => {
    // The point of the helper on a nightly job: "27 hours ago" says it missed
    // last night, where "1 day ago" hides exactly that.
    expect(ago(27 * HOUR)).toBe("27 hours ago");
    expect(ago(47 * HOUR)).toBe("47 hours ago");
  });

  it("switches to days once the hour stops mattering", () => {
    expect(ago(48 * HOUR)).toBe("2 days ago");
    expect(ago(9 * 24 * HOUR)).toBe("9 days ago");
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
