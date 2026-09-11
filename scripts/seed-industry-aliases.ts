/**
 * Turns the raw ACT industry spellings into aliases of the 31 segments.
 *
 * scripts/import-act-industries.ts collapsed 335 distinct spellings from the
 * ACT contact export into 31 trade segments, and the judgement calls behind
 * that live as data in scripts/data/act-industries.json. Seeding the segments
 * used only the left column of that file; this script finally uses the right
 * one -- every raw spelling becomes an IndustryAlias pointing at the segment
 * it was mapped to.
 *
 * WHY IT MATTERS: without the aliases, the mapping exists only in a JSON file
 * two scripts read. The application knows nothing about it, so a manager
 * typing ACT's "Boat Mattresses" into the picker sees no match and creates a
 * 32nd industry -- undoing the cleanup by hand, one contact at a time. With
 * them, that spelling resolves to "Marine" in the picker and in the eventual
 * ACT contact import, which resolves an incoming category against the database
 * rather than against `resolveActIndustry`.
 *
 * Usage:
 *   npx tsx scripts/seed-industry-aliases.ts --dry-run   # print, change nothing
 *   npx tsx scripts/seed-industry-aliases.ts             # create missing aliases
 *
 * Idempotent, and safe to run against a database someone has already been
 * adding aliases to by hand: every candidate is checked against the industry
 * names and the aliases already stored, and anything already present or
 * already claimed is skipped and reported, never overwritten.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { loadActIndustries, type ActIndustries } from "./import-act-industries";
import { industryAliasSchema, normalizeIndustryName } from "../src/lib/validation/industries";

/**
 * Which spelling to keep when the export contains several that differ only in
 * case -- "Aircraft Interiors" / "aircraft interiors" / "AIRCRAFT INTERIORS"
 * are one alias, because the database stores one row per normalized name and
 * matching is case-insensitive anyway.
 *
 * Mixed case first (it is how the name is actually written), then lowercase,
 * then SHOUTING. Ties keep file order, so the choice is deterministic and a
 * re-run of this script never proposes a different spelling for a row it
 * already created.
 */
function casingRank(name: string): number {
  if (name !== name.toLowerCase() && name !== name.toUpperCase()) return 0;
  if (name === name.toLowerCase()) return 1;
  return 2;
}

type Candidate = { name: string; target: string };

/**
 * Every alias worth creating, keyed by its normalized name.
 *
 * Two kinds of entry are dropped here rather than at the database:
 * - a spelling that maps to null -- "NIL", "prospect", the rows that were
 *   never industries;
 * - a spelling that IS one of the segment names ("apparel" against the
 *   "Apparel" row). Industry names and aliases share one namespace, so that
 *   alias would be both redundant and rejected; the picker already finds the
 *   row by its own name.
 */
export function buildCandidates(data: ActIndustries): Map<string, Candidate> {
  // Both lists, not just the targets: a segment nothing maps to is still a
  // name an alias must not collide with.
  const canonicalKeys = new Set(data.canonical.map(normalizeIndustryName));
  for (const target of Object.values(data.aliases)) {
    if (target) canonicalKeys.add(normalizeIndustryName(target));
  }

  const byKey = new Map<string, Candidate>();
  for (const [raw, target] of Object.entries(data.aliases)) {
    if (!target) continue;
    const key = normalizeIndustryName(raw);
    if (canonicalKeys.has(key)) continue;

    const existing = byKey.get(key);
    if (!existing || casingRank(raw) < casingRank(existing.name)) {
      byKey.set(key, { name: raw, target });
    }
  }
  return byKey;
}

async function main() {
  const dryRun = new Set(process.argv.slice(2)).has("--dry-run");

  const data = loadActIndustries();
  const candidates = buildCandidates(data);

  // Same validation the alias editor applies, run before touching the database
  // so a bad entry in the data file is a refusal rather than a half-finished
  // import.
  const invalid = [...candidates.values()].filter(
    (c) => !industryAliasSchema.safeParse(c.name).success
  );
  if (invalid.length > 0) {
    console.error(`invalid aliases: ${invalid.map((c) => c.name).join(", ")}`);
    process.exit(1);
  }

  // Imported here, not at module scope, for the reason import-act-industries.ts
  // gives: Prisma 7 needs an explicit driver adapter, so a bare client at
  // module scope throws before the checks above can run.
  const { db } = await import("../src/lib/db");

  const [industries, existingAliases] = await Promise.all([
    db.industry.findMany(),
    db.industryAlias.findMany(),
  ]);

  const industryByKey = new Map(industries.map((row) => [normalizeIndustryName(row.name), row]));
  const aliasByKey = new Map(existingAliases.map((row) => [normalizeIndustryName(row.name), row]));

  const toCreate: { name: string; industryId: string; target: string }[] = [];
  const alreadyThere: string[] = [];
  const claimedElsewhere: string[] = [];
  const noSegmentRow: string[] = [];
  const isAnIndustryName: string[] = [];

  for (const [key, candidate] of candidates) {
    const industry = industryByKey.get(normalizeIndustryName(candidate.target));
    if (!industry) {
      // The segments are not seeded yet, or this database predates them.
      noSegmentRow.push(`${candidate.name} -> ${candidate.target}`);
      continue;
    }

    // An industry someone added by hand under a name this file treats as a raw
    // spelling. Making it an alias too would put one string in both tables,
    // which is exactly the ambiguity the alias table exists to prevent -- and
    // folding the two rows together is a merge, a decision for a person.
    if (industryByKey.has(key)) {
      isAnIndustryName.push(candidate.name);
      continue;
    }

    const existing = aliasByKey.get(key);
    if (existing) {
      if (existing.industryId === industry.id) alreadyThere.push(candidate.name);
      else claimedElsewhere.push(`${candidate.name} (points at another industry)`);
      continue;
    }

    toCreate.push({ name: candidate.name, industryId: industry.id, target: candidate.target });
  }

  console.log(`${candidates.size} distinct spellings in the mapping`);
  console.log(`already recorded: ${alreadyThere.length}`);
  if (isAnIndustryName.length > 0) {
    console.log(`skipped, exists as an industry of its own (merge it by hand): ${isAnIndustryName.length}`);
    for (const name of isAnIndustryName) console.log(`  ! ${name}`);
  }
  if (claimedElsewhere.length > 0) {
    console.log(`skipped, spelling already claimed: ${claimedElsewhere.length}`);
    for (const name of claimedElsewhere) console.log(`  ! ${name}`);
  }
  if (noSegmentRow.length > 0) {
    console.log(`skipped, no row for the segment: ${noSegmentRow.length}`);
    for (const name of noSegmentRow) console.log(`  ! ${name}`);
  }
  console.log(`to create: ${toCreate.length}`);
  for (const row of toCreate) console.log(`  + ${row.name} -> ${row.target}`);

  if (dryRun) {
    console.log("dry run — nothing written");
    return;
  }

  if (toCreate.length > 0) {
    // One statement, so a failure leaves no half-seeded table. `skipDuplicates`
    // covers the only gap left by the checks above: a row inserted between the
    // read and this write.
    const { count } = await db.industryAlias.createMany({
      data: toCreate.map((row) => ({ name: row.name, industryId: row.industryId })),
      skipDuplicates: true,
    });
    console.log(`created ${count}`);
  } else {
    console.log("nothing to do");
  }
}

// Guarded for the same reason import-act-industries.ts is: `buildCandidates`
// is exported so the mapping rules can be unit-tested without a database, and
// an unguarded `main()` would make importing it open a connection and exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      console.error(error);
      process.exit(1);
    })
    .finally(() => process.exit(0));
}
