import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The signing query feeds an UNAUTHENTICATED page. Showing a client the
 * manager's commission is an incident, not a bug, and the way it would
 * happen is not malice but reuse -- someone reaching for the builder's own
 * document read because it already returns everything the sheet needs,
 * commission included.
 *
 * Reads source text rather than importing, matching
 * tests/scope-coverage.test.ts: the point is to catch the shape of the file
 * a future author writes, not the behaviour of the one that exists.
 */
const SIGNING_QUERY = "src/lib/queries/signing.ts";

describe("signing query exposure", () => {
  const source = readFileSync(SIGNING_QUERY, "utf8");

  it("exists and selects something", () => {
    expect(source).toContain("getDocumentForSigning");
    expect(source).toContain("select");
  });

  it("names no commission field", () => {
    const inCode = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      // The runtime guard's own allowlist (see the "guards against a
      // commission leak at runtime" test below) has to spell out the three
      // keys it rejects, or it couldn't reject them -- that's not the same
      // thing this assertion exists to catch, which is a `select` (or a
      // spread) that would actually fetch one of them.
      .filter((line) => !line.includes("FORBIDDEN_KEYS"))
      .join("\n");
    expect(inCode).not.toMatch(/\bcommission/i);
  });

  it("does not borrow the builder query, which does select commission", () => {
    expect(source).not.toMatch(/from ["']@\/lib\/queries\/documents["']/);
    expect(source).not.toContain("getDocumentForBuilder");
  });

  it("selects no internal-only document fields", () => {
    const inCode = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .join("\n");
    for (const field of ["ownerId"]) {
      expect(inCode).not.toMatch(new RegExp(`\\b${field}\\s*:\\s*true`));
    }
  });

  // `notes` is NOT an exposure concern, despite living on the same Document
  // row as the commission fields above: it's the identical column already
  // rendered into the PDF the manager sends the client (NotesSection /
  // QuotationSheet, included unconditionally). Withholding it on the signing
  // page would show the client a different document from the one they're
  // being asked to sign, which is its own bug -- so this file selects it,
  // and there is nothing here asserting its absence.

  it("guards against a commission leak at runtime, not just in source text", () => {
    // A source-text scan can't see an `include`-shaped rewrite or a
    // concatenated key -- the forbidden word never appears in either. This
    // asserts the runtime half (assertNoCommissionLeak in signing.ts) exists
    // and names all three commission keys it must catch.
    expect(source).toContain("assertNoCommissionLeak");
    for (const field of ["commissionAmount", "commissionRatePct", "commissionBase"]) {
      expect(source).toContain(field);
    }
  });
});
