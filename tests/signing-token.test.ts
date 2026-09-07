import { describe, it, expect } from "vitest";
import {
  generateSigningToken,
  hashSigningToken,
  SIGNING_TOKEN_BYTES,
} from "../src/lib/signing/token";

describe("generateSigningToken", () => {
  it("produces a base64url string with no padding or URL-unsafe characters", () => {
    const token = generateSigningToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("encodes SIGNING_TOKEN_BYTES bytes of entropy", () => {
    // base64url of 32 bytes is 43 characters once padding is dropped.
    expect(SIGNING_TOKEN_BYTES).toBe(32);
    expect(generateSigningToken()).toHaveLength(43);
  });

  it("never repeats across a large sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) seen.add(generateSigningToken());
    expect(seen.size).toBe(1000);
  });
});

describe("hashSigningToken", () => {
  it("returns a 64-character lowercase hex sha256 digest", () => {
    expect(hashSigningToken("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for the same input", () => {
    const token = generateSigningToken();
    expect(hashSigningToken(token)).toBe(hashSigningToken(token));
  });

  it("differs for different inputs", () => {
    expect(hashSigningToken("a")).not.toBe(hashSigningToken("b"));
  });

  it("matches the known sha256 of a fixed string", () => {
    expect(hashSigningToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});
