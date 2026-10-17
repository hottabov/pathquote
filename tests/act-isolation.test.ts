import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PathQuote must keep working when ACT! is down, slow or gone: ACT! is a
 * feature, not the product. The rule (owner, 2026-10-16): nothing reads from
 * or writes to ACT! while a user waits. Writes go through the `ActOutbox`
 * queue and the five-minute drain; reads come from snapshots the drain
 * refreshes. This test holds the import graph to that rule.
 *
 * Every page, layout, route handler and server action is walked through its
 * imports. Reaching a module that BUILDS an ACT! client (`actClientFromEnv`,
 * `actReaderFromEnv`, `new ActClient`) is a failure -- importing
 * `src/lib/act/client.ts` for its types or error classes is not, since that
 * sends nothing. Two modules build a client on purpose and are allowed:
 * - `src/lib/act/drain-after.ts` -- runs in `after()`, once the response has gone;
 * - `src/lib/act/outbox-admin-store.ts` -- "ACT! has this person", an
 *   administrator's explicit check with a 40 s ceiling, on a quote's ACT! card.
 */

const ROOT = resolve(__dirname, "../src");
const CLIENT = join(ROOT, "lib/act/client.ts");
const ALLOWED = new Set([join(ROOT, "lib/act/drain-after.ts"), join(ROOT, "lib/act/outbox-admin-store.ts")]);
const BUILDS_CLIENT = /\b(actClientFromEnv|actReaderFromEnv)\s*\(|new ActClient\s*\(/;

/** Whether `file` constructs an ACT! client (the definitions in client.ts
 *  itself do not count; only callers do). */
function buildsClient(file: string): boolean {
  if (file === CLIENT) return false;
  const src = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return BUILDS_CLIENT.test(src);
}

const importRe = /^\s*(?:import|export)\s+(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

function resolveSpec(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(ROOT, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, base + ".ts", base + ".tsx", join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

function depsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(importRe)) {
    const r = resolveSpec(file, m[1] ?? m[2] ?? m[3]);
    if (r) out.push(r);
  }
  return out;
}

function walk(dir: string, keep: (p: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}

/** The first import path from `entry` to a module that builds an ACT! client, or null. */
function pathToClient(entry: string): string[] | null {
  const seen = new Set<string>();
  const stack: string[][] = [[entry]];
  while (stack.length) {
    const path = stack.pop()!;
    const cur = path[path.length - 1];
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (ALLOWED.has(cur)) continue;
    if (buildsClient(cur)) return path;
    for (const d of depsOf(cur)) stack.push([...path, d]);
  }
  return null;
}

describe("ACT! stays off the request path", () => {
  const entries = [
    ...walk(join(ROOT, "app"), (p) => /\/(page|layout|route)\.tsx?$/.test(p)),
    ...walk(join(ROOT, "lib/actions"), (p) => p.endsWith(".ts")),
  ];

  it("has entries to check", () => {
    expect(entries.length).toBeGreaterThan(20);
  });

  it.each(entries.map((e) => [e.replace(ROOT + "/", "")] as const))("%s never reaches a module that builds an ACT! client", (rel) => {
    const path = pathToClient(join(ROOT, rel));
    expect(path?.map((p) => p.replace(ROOT + "/", "")).join(" -> ") ?? null).toBeNull();
  });
});
