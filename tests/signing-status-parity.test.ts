import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * `src/lib/signing/state.ts` re-declares SigningStatus as a string union
 * rather than importing it from @prisma/client, so the pure rule module has
 * no generated-code dependency. That is a deliberate duplication, and this
 * is the thing that makes it safe: adding a value to the Prisma enum without
 * adding it to the union fails the build here rather than at the first
 * unhandled state in production.
 *
 * Reads source text rather than importing, matching tests/scope-coverage.test.ts.
 */
function prismaEnumValues(name: string): string[] {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const match = schema.match(new RegExp(`enum ${name} \\{([^}]*)\\}`));
  if (!match) throw new Error(`enum ${name} not found in prisma/schema.prisma`);
  return match[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0);
}

function unionMembers(file: string, typeName: string): string[] {
  const source = readFileSync(file, "utf8");
  const match = source.match(new RegExp(`export type ${typeName} =([^;]*);`));
  if (!match) throw new Error(`type ${typeName} not found in ${file}`);
  return [...match[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
}

describe("SigningStatus parity", () => {
  it("the hand-written union lists exactly the Prisma enum's values", () => {
    expect(unionMembers("src/lib/signing/state.ts", "SigningStatus").sort()).toEqual(
      prismaEnumValues("SigningStatus").sort()
    );
  });

  it("finds a non-empty set of values, so a silent regex miss cannot pass", () => {
    expect(prismaEnumValues("SigningStatus").length).toBe(5);
  });
});
