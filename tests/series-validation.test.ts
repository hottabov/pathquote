import { describe, it, expect } from "vitest";
import { seriesQuoteDescriptionSchema } from "../src/lib/validation/series";

describe("seriesQuoteDescriptionSchema", () => {
  it("accepts empty, meaning the category prints nothing", () => {
    expect(seriesQuoteDescriptionSchema.parse("")).toBeNull();
    expect(seriesQuoteDescriptionSchema.parse("   ")).toBeNull();
  });

  it("accepts ordinary copy", () => {
    expect(seriesQuoteDescriptionSchema.parse("<p>Copy.</p>")).toBe("<p>Copy.</p>");
  });

  it("rejects a body over 20000 characters", () => {
    expect(() => seriesQuoteDescriptionSchema.parse("x".repeat(20001))).toThrow();
  });
});
