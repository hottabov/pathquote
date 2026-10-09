import actIndustries from "./act-industries.json";
import { normalizeIndustryName } from "@/lib/validation/industries";

// ACT!'s Industry field is free text and twenty years of it produced 335
// distinct spellings across 17,373 contacts -- "CARPET" and "carpET",
// "Leatrher & Skins", "BoatingBrunswick", and 307 rows of "NIL".
//
// act-industries.json, beside this file, is the cleaned mapping: 31 canonical
// trade segments and 355 raw spellings that point at them. It was built for
// scripts/import-act-industries.ts, which seeds the Industry table, and the
// sync resolves against the same table rather than inventing a second,
// dirtier one.
//
// It lives here rather than under scripts/ because the app statically imports
// it: the Dockerfile's `build` stage copies src/ and not scripts/, so a file
// the app needs has to be inside src/. tests/build-image-imports.test.ts
// holds that line for every file under src/.
//
// The importer never creates an industry row. An unknown spelling leaves the
// company's industry unset and goes in the unresolved report, because
// auto-creating is exactly what produced 335 spellings.

export type ActIndustries = {
  /** The segments to seed. */
  canonical: string[];
  /** Raw ACT! spelling -> segment, or null for a value that is not an
   * industry. Also carries intermediate names from an earlier cleanup pass. */
  aliases: Record<string, string | null>;
};

/** Where the mapping lives, for error messages. Not used to read the file. */
export const ACT_INDUSTRIES_PATH = "src/lib/act/act-industries.json";

/**
 * The mapping, as data.
 *
 * Imported statically rather than read with `readFileSync`: `resolveJsonModule`
 * is on, so this needs no filesystem at runtime and no assumption about the
 * working directory. The script this moved from used `import.meta.dirname`,
 * which does not survive Next's bundler, and `process.cwd()` would have made
 * the sync depend on being run from the repo root.
 */
export function loadActIndustries(): ActIndustries {
  return actIndustries as ActIndustries;
}

/**
 * Both questions the sync asks of the table, answered from one index.
 *
 * `resolve` says what a spelling means. `isKnown` says whether the table has an
 * opinion about it at all. They differ for a value like "NIL": the table knows
 * it and says it is not an industry, so `resolve` returns null and `isKnown`
 * returns true. A spelling nobody has seen also resolves to null, but there
 * `isKnown` is false -- and only that one is worth putting in front of a person
 * to map.
 *
 * Without `isKnown` the unresolved-industry report listed every deliberate null
 * as if it were a gap (4 of its 7 entries), which teaches the reader to ignore
 * the report.
 */
export type IndustryLookup = {
  /** A canonical segment name, or null when the value is not an industry or is
   * not in the table. */
  resolve: (raw: string | null | undefined) => string | null;
  /** True when the table has an opinion about this spelling, including the
   * opinion that it is not an industry at all. */
  isKnown: (raw: string | null | undefined) => boolean;
};

/**
 * Index the alias table once by normalised key and answer both questions from
 * it. The previous implementation scanned all the aliases per call, normalising
 * both sides each time; over ~17,500 contacts that is millions of
 * normalisations to answer ~17,500 questions.
 */
export function buildIndustryLookup(data: ActIndustries = loadActIndustries()): IndustryLookup {
  const index = new Map<string, string | null>();
  for (const [alias, segment] of Object.entries(data.aliases)) {
    index.set(normalizeIndustryName(alias), segment);
  }
  // Canonical names are not always present in the alias table; a segment must
  // always resolve to itself.
  for (const name of data.canonical) {
    index.set(normalizeIndustryName(name), name);
  }

  function keyOf(raw: string | null | undefined): string | null {
    if (!raw) return null;
    return normalizeIndustryName(raw) || null;
  }

  return {
    resolve(raw) {
      const key = keyOf(raw);
      return key === null ? null : (index.get(key) ?? null);
    },
    isKnown(raw) {
      const key = keyOf(raw);
      return key !== null && index.has(key);
    },
  };
}

/**
 * A resolver from raw ACT! industry text to a canonical segment name, or null.
 * Callers that also need `isKnown` should use `buildIndustryLookup` so the two
 * share one index.
 */
export function buildIndustryResolver(
  data: ActIndustries = loadActIndustries(),
): (raw: string | null | undefined) => string | null {
  return buildIndustryLookup(data).resolve;
}

/**
 * True when the table has an opinion about this spelling, including the opinion
 * that it is not an industry at all.
 */
export function buildIndustryKnownCheck(
  data: ActIndustries = loadActIndustries(),
): (raw: string | null | undefined) => boolean {
  return buildIndustryLookup(data).isKnown;
}
