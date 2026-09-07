import { describe, it, expect } from "vitest";
import { parseSignatureDataUrl, MAX_SIGNATURE_BYTES } from "../src/lib/signing/data-url";

// A 1x1 transparent PNG.
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("parseSignatureDataUrl", () => {
  it("decodes a PNG data URL to bytes", () => {
    const result = parseSignatureDataUrl(PNG_1PX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // PNG magic number.
    expect([...result.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("rejects a non-PNG media type", () => {
    expect(parseSignatureDataUrl("data:image/svg+xml;base64,PHN2Zy8+").ok).toBe(false);
  });

  it("rejects a plain URL", () => {
    expect(parseSignatureDataUrl("https://example.com/sig.png").ok).toBe(false);
    expect(parseSignatureDataUrl("/api/files/abc.png").ok).toBe(false);
  });

  it("rejects a non-base64 data URL", () => {
    expect(parseSignatureDataUrl("data:image/png,%89PNG").ok).toBe(false);
  });

  it("rejects malformed base64", () => {
    expect(parseSignatureDataUrl("data:image/png;base64,!!!!").ok).toBe(false);
  });

  it("rejects an oversized payload before decoding it", () => {
    const huge = "data:image/png;base64," + "A".repeat(MAX_SIGNATURE_BYTES * 2);
    expect(parseSignatureDataUrl(huge).ok).toBe(false);
  });

  it("rejects an empty payload", () => {
    expect(parseSignatureDataUrl("data:image/png;base64,").ok).toBe(false);
  });
});
