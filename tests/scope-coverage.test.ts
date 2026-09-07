import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * A module that queries an ownership- or region-scoped model must import
 * the scoping helpers. This does not prove the helpers are used correctly —
 * only that the author saw them. That is the point: the failure mode this
 * catches is a new query written without the rule in mind at all, which no
 * amount of review catches reliably once the file count grows.
 *
 * Reads files off disk rather than parsing an AST. A regex is enough here
 * because the thing being detected (`db.company.`, `db.document.`,
 * `db.price.`) has exactly one spelling in this codebase, and a false
 * positive costs an allowlist entry with a comment — cheap, and the comment
 * is itself the review artefact worth having.
 */
const ROOTS = ["src/lib/queries", "src/lib/actions"];
const SCOPED_MODEL = /\bdb\.(company|document|price)\b/;
const SCOPE_IMPORT = /from ["']@\/lib\/scope["']/;

/**
 * Files that touch a scoped model and legitimately do not scope it. Each
 * entry needs a reason. Adding one is a deliberate act, which is the whole
 * mechanism — an unexplained entry should not survive review.
 */
const ALLOWLIST = new Map<string, string>([
  [
    "src/lib/actions/catalog/prices.ts",
    "Price mutations are the admin price editor. Every action here is behind requireAdmin(), and an admin is unscoped by definition.",
  ],
  [
    "src/lib/queries/industries.ts",
    "countCompaniesUsingIndustry counts across every owner on purpose — it warns an admin how wide a shared-row rename reaches. Its caller shows the number to admins only; see the client card.",
  ],
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("scope coverage", () => {
  const files = ROOTS.flatMap((root) => walk(root));

  it("finds the modules to check at all", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("requires a scope import in every module that queries a scoped model", () => {
    const offenders = files.filter((file) => {
      const relative = file.split(path.sep).join("/");
      if (ALLOWLIST.has(relative)) return false;
      const source = readFileSync(file, "utf8");
      return SCOPED_MODEL.test(source) && !SCOPE_IMPORT.test(source);
    });

    expect(offenders).toEqual([]);
  });

  it("keeps the allowlist honest — every entry still touches a scoped model", () => {
    const stale = [...ALLOWLIST.keys()].filter((relative) => {
      const source = readFileSync(relative, "utf8");
      return !SCOPED_MODEL.test(source);
    });

    expect(stale).toEqual([]);
  });
});
