/**
 * The `build` stage of the Dockerfile does not copy the whole repository. It
 * copies four root config files, prisma/seed-lib.ts, public/ and src/ -- and
 * nothing else (see the comment block above those COPY lines). So a file under
 * src/ that reaches outside src/ with a relative import compiles fine on a
 * developer's machine, where the whole repo is on disk, and then fails inside
 * the image with `Module not found` -- in CI, after the merge, on a path
 * nobody was thinking about.
 *
 * That happened: src/lib/act/industries.ts imported
 * ../../../scripts/data/act-industries.json. It had been reached only from
 * scripts/ until a Settings page pulled src/lib/act/sync.ts into the app's
 * import graph, and the first image build after that broke. The JSON now lives
 * beside its importer in src/lib/act/, which is why that invariant can be
 * stated as a rule here rather than as an exception list.
 *
 * The rule is the generalisation of that bug: the next module someone pulls in
 * from scripts/ or prisma/ fails exactly the same way. If a genuine exception
 * ever turns up, an explicit allowlist in this file is better than loosening
 * the check -- there is nothing to allow today.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Derived from this file's own location, deliberately: `process.cwd()` is
// whatever directory the runner happened to start in. The repo already avoids
// it for this reason where it would bite -- see the note on `loadActIndustries`
// in src/lib/act/industries.ts -- and tests/tools-image-imports.test.ts walks
// from `__dirname` for the same reason.
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");

/**
 * The forms a specifier can take here. `import x from "y"` and `export ...
 * from "y"` share one pattern (`[^;]*?` spans the newlines of a multi-line
 * clause list); then the side-effect `import "y"`, and dynamic `import("y")`.
 *
 * What this cannot see: a specifier that is not a literal string. A template
 * literal or a variable has no path to resolve until the code runs, so it is
 * out of reach of any static check, and nothing in src/ uses one.
 */
const SPECIFIERS = [
  /(?:^|[;{}\n])\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g,
  /(?:^|[;{}\n])\s*import\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']/g,
];

/**
 * Comments hold example code -- this file's own header names the import that
 * started all this -- and scanning them invents violations. Blanked rather
 * than deleted so the offsets of everything after a comment still give the
 * right line number.
 */
function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + " ".repeat(m.length - lead.length));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

type Escape = { file: string; line: number; spec: string; target: string };

/**
 * Relative specifiers only. A bare specifier (`react`, `node:path`) resolves
 * in node_modules, which the image has; `@/...` is tsconfig.json's path
 * mapping to ./src/*, so it cannot leave src/ by construction.
 */
function escapingImports(file: string): Escape[] {
  const source = blankComments(readFileSync(file, "utf8"));
  const found: Escape[] = [];

  for (const re of SPECIFIERS) {
    for (const match of source.matchAll(re)) {
      const spec = match[1];
      if (!spec.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), spec);
      const fromSrc = path.relative(SRC, target);
      if (!fromSrc.startsWith("..") && !path.isAbsolute(fromSrc)) continue;
      found.push({
        file: path.relative(ROOT, file),
        line: source.slice(0, match.index).split("\n").length,
        spec,
        target: path.relative(ROOT, target),
      });
    }
  }

  return found;
}

const REMEDY = [
  "A file under src/ imports something outside src/.",
  "",
  "The Dockerfile's `build` stage copies only src, public, prisma/seed-lib.ts",
  "and four root config files (package.json, next.config.ts, tsconfig.json,",
  "postcss.config.mjs). Anything else in the repo is simply not in the image,",
  "so this import breaks the image build with `Module not found` even though",
  "`npm run build` passes locally, where the whole repo is on disk.",
  "",
  "Move what src/ needs into src/, beside the file that imports it. Adding a",
  "COPY line to the `build` stage instead puts the burden back on keeping that",
  "list in step with the tree, which is its own documented failure mode.",
].join("\n");

describe("build image: src/ imports nothing from outside src/", () => {
  const files = sourceFiles(SRC);

  it("finds the source files to check", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("has no relative import leaving src/", () => {
    const offenders = files
      .flatMap(escapingImports)
      .map((e) => `${e.file}:${e.line} imports "${e.spec}" -> ${e.target}`);
    // The offenders lead the message: the first thing worth knowing is which
    // file and line, and vitest's diff of an array of strings is harder to
    // read in a CI log than the list spelled out.
    expect(offenders, `${offenders.join("\n")}\n\n${REMEDY}`).toEqual([]);
  });
});
