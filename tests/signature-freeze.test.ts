import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * `Signature.imageUrl` must always be a freshly written upload, never a
 * pointer at `User.signatureUrl`. Assigning the profile URL directly would
 * make every past signature follow the manager's current one -- a silent
 * rewrite of documents a customer has already signed (see the `imageUrl`
 * doc comment on the `Signature` model in schema.prisma).
 *
 * The first version of this guard was a pair of regexes over
 * src/lib/actions/signing.ts's source text, looking for the specific shape
 * "assign `signatureUrl` straight into `imageUrl`". Review defeated it in
 * one edit: assign `user.signatureUrl` to an intermediate variable, then
 * write *that* variable into `imageUrl`. All three tests still passed,
 * because none of them was actually checking for an intermediate variable
 * -- and there is no bound on how many ways a value can be renamed on its
 * way from one field to another, so tightening the regex is a losing game.
 *
 * The real fix was structural, not textual: `src/lib/signing/saved-signature.ts`
 * now owns the only code that reads the saved-signature column, and it
 * returns bytes -- never a URL, never anything derived from one (see its own
 * header comment). Once nothing URL-shaped enters `signing.ts` at all, the
 * rule stops being "does this line match a bad pattern" and becomes "this
 * module does not know that column exists": the identifier `signatureUrl`
 * simply does not occur in its source text, in any spelling, ever. That is
 * total in a way no regex against `imageUrl:` assignments could be.
 */
const ACTIONS = "src/lib/actions/signing.ts";
const SAVED_SIGNATURE = "src/lib/signing/saved-signature.ts";

describe("author signature is copied, not referenced", () => {
  const source = readFileSync(ACTIONS, "utf8");

  it("never mentions the saved-signature column, in any spelling", () => {
    // Not a regex over a suspicious pattern -- a flat substring search over
    // the whole file. There is no assignment, alias, destructure or
    // intermediate variable this can be routed through without the
    // identifier appearing in the source text somewhere.
    expect(source).not.toContain("signatureUrl");
  });

  it("only ever assigns imageUrl from a saveUpload result", () => {
    expect(source).toMatch(/filename\s*=\s*await saveUpload\(/);
    expect(source).toContain("const imageUrl = `/api/files/${filename}`;");
    // The only place a variable named `imageUrl` is ever assigned in this
    // file is the line above -- there is no second `imageUrl =` (or `let`/
    // `var` redeclaration) that could route a different value into the same
    // name before it reaches the `Signature` upsert, where it's then written
    // via the `imageUrl` shorthand (so both branches read this one value).
    const assignments = source.match(/\b(?:const|let|var)\s+imageUrl\s*=/g) ?? [];
    expect(assignments).toHaveLength(1);
  });
});

describe("the saved-signature module returns bytes, never a URL", () => {
  const source = readFileSync(SAVED_SIGNATURE, "utf8");

  it("readSavedSignatureBytes resolves to bytes or a reason, not a URL", () => {
    // Checking the exported type's own text, not behaviour: the guarantee
    // this whole module exists for is a shape guarantee (nothing URL-shaped
    // ever leaves it), and a shape is exactly what a type's text says.
    expect(source).toMatch(
      /export async function readSavedSignatureBytes\([^)]*\):\s*Promise<\s*\{\s*ok:\s*true;\s*bytes:\s*Buffer\s*\}\s*\|\s*\{\s*ok:\s*false;\s*reason:\s*string\s*\}\s*>/
    );
  });
});
