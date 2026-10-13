import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { canSeeCommission } from "../src/lib/roles";

// canSeeCommission (src/lib/roles.ts) -- whether the quote builder shows a
// viewer "Your commission". Admins and developers by role; everyone else only
// with `User.commissionVisible` ticked (distributors are left unticked).
describe("canSeeCommission", () => {
  it("always shows it to an ADMIN or DEVELOPER, whatever their own flag says", () => {
    for (const role of ["ADMIN", "DEVELOPER"]) {
      expect(canSeeCommission({ role, commissionVisible: true })).toBe(true);
      expect(canSeeCommission({ role, commissionVisible: false })).toBe(true);
    }
  });

  it("shows it to a MANAGER or REGIONAL_MANAGER only with the tick", () => {
    for (const role of ["MANAGER", "REGIONAL_MANAGER"]) {
      expect(canSeeCommission({ role, commissionVisible: true })).toBe(true);
      expect(canSeeCommission({ role, commissionVisible: false })).toBe(false);
    }
  });

  it("fails closed for a missing role", () => {
    expect(canSeeCommission({ role: undefined, commissionVisible: false })).toBe(false);
    expect(canSeeCommission({ role: null, commissionVisible: false })).toBe(false);
  });
});

// The rule has to be applied where the figure is produced, not only where the
// footer draws it: the builder page hands the whole DocumentForBuilder to
// client components, so a commission left on it reaches the browser. This
// reads the source because getDocumentForBuilder needs a database and this
// suite has none.
describe("getDocumentForBuilder drops commission for a viewer who may not see it", () => {
  const source = readFileSync("src/lib/queries/documents-builder.ts", "utf8");
  const fn = source.slice(
    source.indexOf("export async function getDocumentForBuilder("),
    source.indexOf("const getDocumentForBuilderInScope")
  );

  it("asks canSeeCommission and nulls the commission when it refuses", () => {
    expect(fn).toMatch(/!canSeeCommission\(user\)/);
    expect(fn).toMatch(/commission:\s*null/);
  });

  it("copies rather than mutates the memoized document", () => {
    expect(fn).toMatch(/\{\s*\.\.\.document,\s*commission:\s*null\s*\}/);
    expect(fn).not.toMatch(/document\.commission\s*=/);
  });
});
