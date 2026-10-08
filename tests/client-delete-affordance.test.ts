import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The client page hides its delete controls from a manager who can open a
 * company (through a country grant) but not delete it. Whether to hide them is
 * answered by asking the database the very filter the delete actions enforce,
 * never by re-deriving the rule from the role or from `ownerId`: a second
 * expression of the rule is how a button and an action drift apart, and a
 * button that is wrong in either direction is worse than none.
 *
 * Nothing here can run the query (this suite has no database), so these read
 * the sources and pin the coupling instead, as session-plumbing.test.ts does
 * for the grant's trip through the page memo.
 */
function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

/** Source with block and line comments removed, so a check for what the code
 * does is not tripped by a comment that names the thing it avoids. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The text of one exported function, from its signature to the next export. */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("CompanyDetail.canDelete is the delete actions' own filter", () => {
  const queries = readFileSync("src/lib/queries/clients.ts", "utf8");
  const actions = readFileSync("src/lib/actions/clients.ts", "utf8");

  it("is looked up with companyOwnedWhereForUser, spread the way the actions spread it", () => {
    expect(queries).toMatch(
      /db\.company\.findFirst\(\{\s*where:\s*\{\s*id:\s*companyId,\s*\.\.\.companyOwnedWhereForUser\(user\)\s*\},\s*select:\s*\{\s*id:\s*true\s*\},?\s*\}\)/
    );
    expect(queries).toMatch(/canDelete:\s*deletable\s*!==\s*null/);
  });

  it("calls the delete filter exactly once, and never decides from the role or owner", () => {
    expect(count(code(queries), /companyOwnedWhereForUser\(/g)).toBe(1);
    expect(code(queries)).not.toMatch(/isAdminRole|isRegionalManagerRole|\.ownerId\b/);
  });

  it("uses the same helper as the two actions it describes", () => {
    expect(bodyOf(actions, "deleteCompany")).toMatch(/\.\.\.companyOwnedWhereForUser\(session\.user\)/);
    expect(bodyOf(actions, "deleteContact")).toMatch(/company:\s*companyOwnedWhereForUser\(session\.user\)/);
  });
});

describe("the client page renders delete controls from company.canDelete only", () => {
  const page = readFileSync("src/app/(app)/clients/[companyId]/page.tsx", "utf8");

  it("renders the Danger zone, and so the company delete button, only when it is true", () => {
    expect(page).toMatch(/company\.canDelete\s*\?\s*\(\s*<SectionCard[\s\S]*?<DeleteCompanyButton[\s\S]*?\)\s*:\s*null/);
  });

  it("hands it to the contacts section", () => {
    expect(page).toMatch(/<ContactsSection[\s\S]*?canDelete=\{company\.canDelete\}/);
  });

  it("does not re-derive it", () => {
    expect(code(page)).not.toMatch(/companyOwnedWhereForUser|\.ownerId\b/);
  });
});
