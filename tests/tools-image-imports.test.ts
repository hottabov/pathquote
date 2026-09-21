/**
 * The `tools` image ships a pruned dependency tree: `npm ci --omit=dev`, and
 * then `@next/swc-*`, `next`, `sharp` and `@img` are deleted outright (see
 * the `prod-deps` stage in the Dockerfile, and "What each image carries" in
 * docs/runbook.md). Together they are ~180 MB gzipped that the image would
 * otherwise carry to a VPS that pulls at ~500 KB/s on every deploy.
 *
 * That deletion is only safe while no command the image runs reaches those
 * packages, and nothing about `npm run db:seed` says which packages it will
 * need — the breakage would surface on the VPS, mid-deploy, as `Cannot find
 * module 'next'`. So this test walks the import graph of every entry point
 * the image can run (the `tsx` scripts in package.json) and fails if one of
 * them arrives at a deleted package.
 *
 * `next-auth` is banned for a second reason: it is present in the image, but
 * it requires `next` at runtime, so importing it from a script would fail
 * there and nowhere else.
 *
 * If this test fails, the choice is to stop importing the package from that
 * script, or to stop deleting it in the Dockerfile and accept the megabytes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/** Deleted from the tools image, plus what would drag them back in. */
const ABSENT_FROM_TOOLS_IMAGE = ["next", "next-auth", "sharp", "@img"];

/**
 * Every form the repo uses: `import x from "y"`, `export ... from "y"`, the
 * side-effect `import "y"` (this is how `dotenv/config` arrives, and missing
 * it is how an earlier version of this test passed while the package it was
 * supposed to catch sat right there in the file), dynamic `import("y")` and
 * `require("y")`.
 */
const SPECIFIERS = [
  /(?:^|[;{}\n])\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g,
  /(?:^|[;{}\n])\s*import\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']/g,
];

/** Comments can hold example code; scanning them invents imports. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function entryPoints(): string[] {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  return Object.values(pkg.scripts)
    .filter((cmd) => cmd.startsWith("tsx "))
    .map((cmd) => cmd.split(" ")[1]);
}

/** Mirrors tsx's resolution of the two forms the repo uses: relative and `@/`. */
function resolveLocal(spec: string, importer: string): string | null {
  const base = spec.startsWith("@/")
    ? path.join(ROOT, "src", spec.slice(2))
    : path.resolve(path.dirname(importer), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.json`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

function packageOf(spec: string): string {
  return spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
}

/** Every bare package reachable from `entry`, mapped to who imports it. */
function reachablePackages(entry: string): Map<string, string> {
  const importedBy = new Map<string, string>();
  const seen = new Set<string>();

  const walk = (file: string) => {
    if (seen.has(file) || !/\.tsx?$/.test(file)) return;
    seen.add(file);
    const source = stripComments(readFileSync(file, "utf8"));
    const specs = SPECIFIERS.flatMap((re) => [...source.matchAll(re)].map((m) => m[1]));
    for (const spec of specs) {
      if (!spec || spec.startsWith("node:")) continue;
      if (spec.startsWith(".") || spec.startsWith("@/")) {
        const resolved = resolveLocal(spec, file);
        if (resolved) walk(resolved);
        continue;
      }
      const pkg = packageOf(spec);
      if (!importedBy.has(pkg)) importedBy.set(pkg, path.relative(ROOT, file));
    }
  };

  walk(path.join(ROOT, entry));
  return importedBy;
}

describe("tools image: entry points stay inside the pruned dependency tree", () => {
  const entries = entryPoints();

  it("finds the operator scripts to check", () => {
    expect(entries.length).toBeGreaterThan(10);
    expect(entries).toContain("prisma/seed.ts");
  });

  it.each(entries)("%s reaches no package the image deletes", (entry) => {
    const reachable = reachablePackages(entry);
    const offenders = ABSENT_FROM_TOOLS_IMAGE.filter((pkg) => reachable.has(pkg)).map(
      (pkg) => `${pkg} (imported by ${reachable.get(pkg)})`,
    );
    expect(offenders).toEqual([]);
  });
});
