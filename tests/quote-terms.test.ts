// Pure — no DB, no next/*, same discipline as quote-variables.test.ts.
import { describe, it, expect } from "vitest";
import { resolveQuoteTerms } from "../src/lib/quote-terms";

const region = { deliveryWeeks: 14, installationDays: 2, trainingDays: 3, warrantyMonths: 12 };

describe("resolveQuoteTerms", () => {
  it("takes the region's figures when the quote overrides nothing", () => {
    expect(resolveQuoteTerms({}, region)).toEqual(region);
  });

  it("prefers a figure the quote sets", () => {
    expect(resolveQuoteTerms({ deliveryWeeks: 10 }, region).deliveryWeeks).toBe(10);
  });

  it("treats zero as a real override, not as absent", () => {
    // "Installation: 0 days" is a legitimate thing to promise for a
    // self-install; `??` gets this right where `||` would not.
    expect(resolveQuoteTerms({ installationDays: 0 }, region).installationDays).toBe(0);
  });

  it("overrides each figure independently", () => {
    const resolved = resolveQuoteTerms({ warrantyMonths: 24 }, region);
    expect(resolved.warrantyMonths).toBe(24);
    expect(resolved.deliveryWeeks).toBe(14);
  });
});
