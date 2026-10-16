// Walks the import graph from every "use client" module under src/ and
// reports the ones that reach a module importing zod (or any package in
// HEAVY). Resolves `@/` and relative imports; ignores `import type`.
// usage: node docs/technical-audit/scripts/client-zod-trace.mjs
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const ROOT = resolve("src");
const HEAVY = ["zod", "@tiptap/react", "google-libphonenumber", "isomorphic-dompurify", "xlsx"];
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(name)) files.push(p);
  }
})(ROOT);

const importRe = /^\s*(?:import|export)\s+(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;
function resolveSpec(from, spec) {
  let base = spec.startsWith("@/") ? join(ROOT, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, base + ".ts", base + ".tsx", join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}
const graph = new Map();
const heavyHits = new Map();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const deps = [];
  for (const m of src.matchAll(importRe)) {
    const spec = m[1] ?? m[2] ?? m[3];
    const heavy = HEAVY.find((h) => spec === h || spec.startsWith(h + "/"));
    if (heavy) heavyHits.set(f, [...(heavyHits.get(f) ?? []), heavy]);
    const r = resolveSpec(f, spec);
    if (r) deps.push(r);
  }
  graph.set(f, { deps, client: /^\s*["']use client["']/m.test(src), server: /^\s*["']use server["']/m.test(src) });
}
const report = new Map();
for (const [f, { client }] of graph) {
  if (!client) continue;
  const seen = new Set();
  const stack = [[f, []]];
  while (stack.length) {
    const [cur, path] = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const hits = heavyHits.get(cur);
    if (hits) for (const h of hits) {
      const key = h;
      const entry = report.get(key) ?? [];
      entry.push({ client: f.replace(ROOT + "/", ""), via: [...path, cur].map((p) => p.replace(ROOT + "/", "")).join(" -> ") });
      report.set(key, entry);
    }
    if (graph.get(cur)?.server) continue;
    for (const d of graph.get(cur)?.deps ?? []) stack.push([d, [...path, cur]]);
  }
}
for (const [pkg, entries] of report) {
  console.log(`\n## ${pkg}: reached from ${entries.length} client module(s)`);
  const byClient = new Map();
  for (const e of entries) if (!byClient.has(e.client)) byClient.set(e.client, e.via);
  for (const [c, via] of byClient) console.log(`- ${c}\n    ${via}`);
}
if (report.size === 0) console.log("No client module reaches a heavy package statically.");
