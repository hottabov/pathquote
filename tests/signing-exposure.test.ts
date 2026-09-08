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
    for (const field of ["notes", "ownerId"]) {
      expect(inCode).not.toMatch(new RegExp(`\\b${field}\\s*:\\s*true`));
    }
  });
});
