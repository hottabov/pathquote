import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * `Signature.imageUrl` must always be a freshly written upload, never a
 * pointer at `User.signatureUrl`. Assigning the profile URL directly would
 * make every past signature follow the manager's current one -- a silent
 * rewrite of documents a customer has already signed (see the `imageUrl`
 * doc comment on the `Signature` model in schema.prisma).
 *
 * Source-text check, like tests/scope-coverage.test.ts: the failure mode is a
 * line someone writes later, not the behaviour of the code that exists now.
 */
const ACTIONS = "src/lib/actions/signing.ts";

describe("author signature is copied, not referenced", () => {
  const source = readFileSync(ACTIONS, "utf8");

  it("writes the signature from a saveUpload result", () => {
    // saveUpload returns a bare filename (see its doc comment in
    // src/lib/uploads.ts), not a URL -- the stored column has to be built
    // from it, the same way saveMySignature builds one in
    // src/lib/actions/users.ts.
    expect(source).toMatch(/filename\s*=\s*await saveUpload\(/);
    expect(source).toContain("const imageUrl = `/api/files/${filename}`;");
  });

  it("never assigns a profile signature URL into a Signature row", () => {
    expect(source).not.toMatch(/imageUrl\s*:\s*[\w.]*signatureUrl/);
  });

  it("only reads the saved signature URL to load bytes from disk", () => {
    // Every mention of the saved-signature field in this module should be a
    // read used to resolve a path, never a value written onward into
    // imageUrl.
    for (const line of source.split("\n")) {
      if (!line.includes("signatureUrl")) continue;
      expect(line).not.toMatch(/imageUrl/);
    }
  });
});
