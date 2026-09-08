import { describe, it, expect } from "vitest";
import { sha256Hex, signedPdfFilename } from "../src/lib/signing/archive";

describe("sha256Hex", () => {
  it("matches the known digest of 'abc'", () => {
    expect(sha256Hex(Buffer.from("abc", "utf8"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("is stable and differs between inputs", () => {
    const a = Buffer.from([1, 2, 3]);
    expect(sha256Hex(a)).toBe(sha256Hex(Buffer.from([1, 2, 3])));
    expect(sha256Hex(a)).not.toBe(sha256Hex(Buffer.from([1, 2, 4])));
  });
});

describe("signedPdfFilename", () => {
  it("is a uuid with a .pdf extension", () => {
    expect(signedPdfFilename()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/
    );
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 500 }, () => signedPdfFilename()));
    expect(seen.size).toBe(500);
  });
});
