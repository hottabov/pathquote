import { describe, it, expect } from "vitest";
import { buildCandidates } from "../scripts/seed-industry-aliases";
import { loadActIndustries } from "../scripts/import-act-industries";
import { normalizeIndustryName } from "../src/lib/validation/industries";

/**
 * The rules that decide which of ACT's 335 raw spellings become aliases. They
 * run once, over a file of hand-made judgement calls, straight into a table the
 * picker reads — so the cheap thing to get wrong (a duplicate, a spelling that
 * is also an industry name) is worth pinning down here rather than discovering
 * as a failed insert halfway through a seed.
 */
describe("buildCandidates", () => {
  const data = {
    canonical: ["Marine", "Apparel", "Filtration"],
    aliases: {
      Boating: "Marine",
      "Boat Mattresses": "Marine",
      // Case variants of one spelling: one alias, not three.
      "Aircraft Interiors": "Apparel",
      "aircraft interiors": "Apparel",
      "AIRCRAFT INTERIORS": "Apparel",
      // Already the name of a row — the picker finds it without an alias.
      apparel: "Apparel",
      // Never an industry.
      NIL: null,
      "SHOUTED ONLY": "Filtration",
    },
  };

  const built = buildCandidates(data);

  it("keeps one entry per normalized spelling", () => {
    expect(built.size).toBe(4);
  });

  it("prefers the mixed-case spelling over lower and upper", () => {
    expect(built.get("aircraft interiors")?.name).toBe("Aircraft Interiors");
  });

  it("keeps an all-caps spelling when there is no better one", () => {
    expect(built.get("shouted only")?.name).toBe("SHOUTED ONLY");
  });

  it("drops a spelling that is a segment name", () => {
    expect(built.has("apparel")).toBe(false);
  });

  it("drops a value that maps to nothing", () => {
    expect(built.has("nil")).toBe(false);
  });

  it("carries the segment each spelling points at", () => {
    expect(built.get("boat mattresses")?.target).toBe("Marine");
  });
});

// The file this seeds from, checked as it actually stands. A mapping that
// pointed two spellings at different segments, or named a segment that was
// never seeded, would insert cleanly and then make an import ambiguous.
describe("scripts/data/act-industries.json", () => {
  const data = loadActIndustries();
  const canonicalKeys = new Set(data.canonical.map(normalizeIndustryName));

  it("maps every spelling to a segment that exists", () => {
    const orphans = Object.values(data.aliases).filter(
      (target) => target !== null && !canonicalKeys.has(normalizeIndustryName(target))
    );
    expect(orphans).toEqual([]);
  });

  it("never points one spelling at two segments", () => {
    const byKey = new Map<string, Set<string>>();
    for (const [raw, target] of Object.entries(data.aliases)) {
      if (!target) continue;
      const key = normalizeIndustryName(raw);
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key)!.add(normalizeIndustryName(target));
    }
    expect([...byKey].filter(([, targets]) => targets.size > 1)).toEqual([]);
  });

  it("produces aliases the alias editor would accept", () => {
    const built = buildCandidates(data);
    expect([...built.values()].filter((c) => c.name.trim().length === 0 || c.name.length > 80)).toEqual([]);
  });
});
