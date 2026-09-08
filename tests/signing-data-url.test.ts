import { describe, it, expect } from "vitest";
import { parseSignatureDataUrl, MAX_SIGNATURE_BYTES } from "../src/lib/signing/data-url";

// Mirrors the module-private PNG_PREFIX in src/lib/signing/data-url.ts (not
// exported, so duplicated here rather than reached into).
const PNG_PREFIX = "data:image/png;base64,";

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

  it("rejects a payload whose first four bytes are the PNG magic but whose next four aren't the rest of the signature", () => {
    // sniffImageType (src/lib/uploads.ts) requires the full 8-byte PNG
    // signature (89 50 4E 47 0D 0A 1A 0A); this must now match it rather
    // than stopping at the first four bytes, or saveUpload's stricter check
    // throws on input this function already accepted.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04]);
    const dataUrl = PNG_PREFIX + bytes.toString("base64");
    expect(parseSignatureDataUrl(dataUrl).ok).toBe(false);
  });

  it("accepts a full-size signature whose base64 length sits just under the tightened pre-decode bound", () => {
    // The pre-decode bound is meant to track base64's real 4/3 expansion
    // (plus a few bytes of slack for padding), not the old 2x figure. A
    // genuine MAX_SIGNATURE_BYTES-sized PNG must still get through it.
    const bytes = Buffer.alloc(MAX_SIGNATURE_BYTES);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const dataUrl = PNG_PREFIX + bytes.toString("base64");
    const result = parseSignatureDataUrl(dataUrl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes.length).toBe(MAX_SIGNATURE_BYTES);
  });
});
