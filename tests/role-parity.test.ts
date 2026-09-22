import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROLE_VALUES } from "../src/lib/roles";
import { userRoleSchema } from "../src/lib/validation/users";

/**
 * Three lists claim to hold the same set of roles: Prisma's `enum Role`
 * (prisma/schema.prisma, the source of truth a migration is generated
 * from), `ROLE_VALUES` (src/lib/roles.ts, hand-maintained so this stays
 * importable without `@prisma/client`), and `userRoleSchema`'s accepted
 * values (src/lib/validation/users.ts, a separate hand-maintained zod
 * enum). Nothing enforces that the three agree, so this reads the schema
 * text off disk — the same technique tests/scope-coverage.test.ts uses, and
 * for the same reason: a regex is enough because `enum Role { ... }` has
 * exactly one spelling in this file, and reading the schema directly means
 * this test cannot go stale the way importing the generated Prisma client
 * would (this environment's generated client predates the
 * REGIONAL_MANAGER migration).
 *
 * What this catches: a role added to the schema and forgotten in either
 * hand-maintained list, or added to a hand-maintained list and never given
 * a migration. What it does NOT catch: whether the *database's* enum type
 * actually has been migrated to match the schema (that is
 * `prisma migrate deploy`'s job, not a unit test's), or whether the
 * generated `@prisma/client` types agree with the schema (they can be
 * stale in this environment independently of all three lists above).
 *
 * Compared as sets, not as ordered arrays: `enum Role` in the schema lists
 * `REGIONAL_MANAGER` between `MANAGER` and `DEVELOPER` for readability,
 * while Postgres appends new values (`ALTER TYPE ... ADD VALUE`) in the
 * order they were added, so the database's own order is
 * ADMIN, MANAGER, DEVELOPER, REGIONAL_MANAGER — see the schema comment
 * directly above `enum Role`. `ROLE_VALUES` follows the schema's
 * (readability) order. Neither order is meaningful to compare, and a future
 * reorder of either list for readability should not fail this test.
 */

/** Pulls the bare identifiers out of `enum Role { ... }` in schema.prisma.
 * Anchored on the literal sequence "enum", whitespace, "Role" so it cannot
 * match `enum SignerRole {` or `enum OptionRole {` — both exist elsewhere in
 * this file, and neither has "Role" immediately after "enum ". Strips full
 * comment lines (`//...`) and trailing inline comments
 * (`IDENTIFIER // note`), and drops blank lines, even though the `Role`
 * block itself currently has neither. */
function readRoleEnumValues(): string[] {
  const schemaPath = path.join(__dirname, "..", "prisma", "schema.prisma");
  const source = readFileSync(schemaPath, "utf8");
  const match = source.match(/enum\s+Role\s*\{([\s\S]*?)\n\}/);
  if (!match) {
    throw new Error("Could not find `enum Role { ... }` in prisma/schema.prisma");
  }
  return match[1]
    .split("\n")
    .map((line) => line.split("//")[0].trim())
    .filter((line) => line.length > 0);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

describe("Role enum parity", () => {
  it("finds SignerRole and OptionRole too, so the anchor is proven specific", () => {
    // Sanity check on the fixture, not the mechanism under test: if either
    // of these ever stopped existing, the "does not match" claim above
    // would be untested rather than true.
    const schemaPath = path.join(__dirname, "..", "prisma", "schema.prisma");
    const source = readFileSync(schemaPath, "utf8");
    expect(source).toContain("enum SignerRole {");
    expect(source).toContain("enum OptionRole {");
  });

  it("does not pick up SignerRole or OptionRole as Role's values", () => {
    const values = readRoleEnumValues();
    expect(values).not.toContain("AUTHOR"); // SignerRole
    expect(values).not.toContain("CLIENT"); // SignerRole
    expect(values).not.toContain("ABR"); // OptionRole
  });

  it("agrees with ROLE_VALUES (src/lib/roles.ts), as a set", () => {
    expect(sortedUnique(readRoleEnumValues())).toEqual(sortedUnique(ROLE_VALUES));
  });

  it("agrees with userRoleSchema's accepted values (src/lib/validation/users.ts), as a set", () => {
    expect(sortedUnique(readRoleEnumValues())).toEqual(sortedUnique(userRoleSchema.options));
  });
});
