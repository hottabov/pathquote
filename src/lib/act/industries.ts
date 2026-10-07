import actIndustries from "../../../scripts/data/act-industries.json";
import { normalizeIndustryName } from "@/lib/validation/industries";

// ACT!'s Industry field is free text and twenty years of it produced 335
// distinct spellings across 17,373 contacts -- "CARPET" and "carpET",
// "Leatrher & Skins", "BoatingBrunswick", and 307 rows of "NIL".
//
// scripts/data/act-industries.json is the cleaned mapping: 31 canonical trade
// segments and 352 raw spellings that point at them. It was built for
// scripts/import-act-industries.ts, which seeds the Industry table, and the
// sync resolves against the same table rather than inventing a second,
// dirtier one.
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
export const ACT_INDUSTRIES_PATH = "scripts/data/act-industries.json";

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
 * A resolver from raw ACT! industry text to a canonical segment name, or null.
 *
 * The alias table is indexed once by normalised key. The previous
 * implementation scanned all 352 aliases per call, normalising both sides each
 * time; over 12,000 contacts that is 4.2 million normalisations to answer
 * 12,000 questions.
 */
export function buildIndustryResolver(
  data: ActIndustries = loadActIndustries(),
): (raw: string | null | undefined) => string | null {
  const index = new Map<string, string | null>();
  for (const [alias, segment] of Object.entries(data.aliases)) {
    index.set(normalizeIndustryName(alias), segment);
  }
  // Canonical names are not always present in the alias table; a segment must
  // always resolve to itself.
  for (const name of data.canonical) {
    index.set(normalizeIndustryName(name), name);
  }

  return (raw) => {
    if (!raw) return null;
    const key = normalizeIndustryName(raw);
    if (!key) return null;
    return index.get(key) ?? null;
  };
}
