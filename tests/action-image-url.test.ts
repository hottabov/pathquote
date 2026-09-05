import { describe, it, expect } from "vitest";
import { parseImageUrl } from "../src/lib/actions/_shared";
import { IMAGE_URL_PATTERN } from "../src/lib/uploads";

// Pure module — `_shared.ts` imports no `@/lib/db`, so this needs no
// DATABASE_URL, same discipline as tests/spec-images.test.ts. It is also the
// only automated cover the image-write actions have: everything around
// `parseImageUrl` in those actions is Prisma, which this suite deliberately
// does not mock.

const VALID = "/api/files/a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789.jpg";

describe("parseImageUrl", () => {
  it("accepts null as the explicit 'clear the image' value", () => {
    expect(parseImageUrl(null)).toEqual({ ok: true, value: null });
  });

  it("accepts the exact /api/files/<uuid>.<ext> shape saveUpload produces", () => {
    expect(parseImageUrl(VALID)).toEqual({ ok: true, value: VALID });
  });

  it("accepts every extension the upload pattern allows", () => {
    for (const ext of ["jpg", "png", "webp", "svg"]) {
      const url = `/api/files/a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789.${ext}`;
      expect(parseImageUrl(url)).toEqual({ ok: true, value: url });
    }
  });

  it("returns the URL unchanged rather than normalising it", () => {
    const result = parseImageUrl(VALID);
    expect(result.ok && result.value).toBe(VALID);
  });

  // The point of the validator: an accepted value is written to a column
  // that is later rendered in the app and printed into PDFs, so anything
  // pointing off /api/files — another host, another app route, or the
  // filesystem underneath it — must not get through.
  it("rejects an external host", () => {
    expect(parseImageUrl("https://evil.example.com/x.jpg")).toEqual({ ok: false });
    expect(parseImageUrl("//evil.example.com/x.jpg")).toEqual({ ok: false });
  });

  it("rejects a path outside /api/files", () => {
    expect(parseImageUrl("/api/uploads/a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789.jpg")).toEqual({
      ok: false,
    });
    expect(parseImageUrl("/documents/a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789.jpg")).toEqual({
      ok: false,
    });
  });

  it("rejects traversal dressed up as a file name", () => {
    expect(parseImageUrl("/api/files/../../etc/passwd.jpg")).toEqual({ ok: false });
    expect(parseImageUrl("/api/files/a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789.jpg/../x")).toEqual({
      ok: false,
    });
  });

  it("rejects a well-formed name under a disallowed extension", () => {
    expect(parseImageUrl("/api/files/a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789.gif")).toEqual({
      ok: false,
    });
    expect(parseImageUrl("/api/files/a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789.svg.exe")).toEqual({
      ok: false,
    });
  });

  it("rejects a name that is not the uuid shape saveUpload writes", () => {
    expect(parseImageUrl("/api/files/photo.jpg")).toEqual({ ok: false });
    expect(parseImageUrl("/api/files/.jpg")).toEqual({ ok: false });
    expect(parseImageUrl("/api/files/A1B2C3D4-E5F6-4789-A0B1-C2D3E4F56789.jpg")).toEqual({
      ok: false,
    });
  });

  it("rejects the empty string rather than treating it as 'clear it' — only null means that", () => {
    expect(parseImageUrl("")).toEqual({ ok: false });
  });

  it("rejects a valid URL with anything appended or prepended", () => {
    expect(parseImageUrl(` ${VALID}`)).toEqual({ ok: false });
    expect(parseImageUrl(`${VALID}?x=1`)).toEqual({ ok: false });
    expect(parseImageUrl(`${VALID}\n/api/files/x.jpg`)).toEqual({ ok: false });
  });

  it("agrees with IMAGE_URL_PATTERN for every non-null input, which is what keeps it in step with saveUpload", () => {
    const inputs = [VALID, "", "/api/files/photo.jpg", "https://x.example/y.png", `${VALID}?x=1`];
    for (const input of inputs) {
      expect(parseImageUrl(input).ok).toBe(IMAGE_URL_PATTERN.test(input));
    }
  });
});
