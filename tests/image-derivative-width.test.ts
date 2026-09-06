import { describe, expect, it } from "vitest";
import { DERIVATIVE_WIDTHS, pickDerivativeWidth } from "@/lib/image-derivative-width";

describe("pickDerivativeWidth", () => {
  it("picks the smallest generated width that covers the target", () => {
    // Avatar/CatalogThumb/ItemsList shape: ask for box*2 device pixels.
    expect(pickDerivativeWidth(24 * 2)).toBe(64); // ItemOptionsEditor's icon
    expect(pickDerivativeWidth(40 * 2)).toBe(128); // CatalogThumb's default box
    expect(pickDerivativeWidth(48 * 2)).toBe(128); // ItemsList's item thumb
    expect(pickDerivativeWidth(64 * 2)).toBe(128); // SeriesImageCard's preview
  });

  it("returns an exact match unchanged", () => {
    for (const w of DERIVATIVE_WIDTHS) {
      expect(pickDerivativeWidth(w)).toBe(w);
    }
  });

  it("never returns a width smaller than requested", () => {
    expect(pickDerivativeWidth(1)).toBe(64);
    expect(pickDerivativeWidth(65)).toBe(128);
    expect(pickDerivativeWidth(129)).toBe(256);
    expect(pickDerivativeWidth(257)).toBe(512);
  });

  it("falls back to the largest width when nothing is big enough", () => {
    // A caller asking for a bigger box than this app ever generates a
    // derivative for still gets the best available thumbnail, not an error —
    // the same "bigger than necessary beats missing" tradeoff pdf.ts's
    // DERIVATIVE_WIDTH_BY_CLASS documents for the print pipeline.
    expect(pickDerivativeWidth(4096)).toBe(512);
  });
});
