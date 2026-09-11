/**
 * Seeds the Industry table with the 31 trade segments, from the cleaned ACT
 * list.
 *
 * The source is the Industry column of an ACT contact export
 * (RAW/ACT/PF_Contacts_*.xlsx): 17,373 contacts, 335 distinct spellings. Most
 * of that spread was noise rather than meaning — case ("CARPET" / "carpET"),
 * typos ("Leatrher & Skins", "Piloows", "Outdooor Furniture"), truncations
 * ("composites/", "bags Fashion/"), values with a company name glued onto the
 * end ("BoatingBrunswick", "ApparelSTORMR"), and 307 rows of "NIL" / "Poor
 * info" / "prospect", which are not industries at all.
 *
 * What survives is named the way the US technical-textiles trade names it, not
 * the way a free-text field grew over twenty years: "Marine" rather than
 * Boating + Sails + boat seats + Boat Mattresses, "Bus, Rail & Transit
 * Interiors" rather than Railway + transport Interiors + trim. Broad enough to
 * be recognisable to anyone in the industry; narrow enough that two genuinely
 * different trades never share a row — marine and automotive stay apart, and so
 * do awnings and tents, because a shop that does one rarely does the other.
 *
 * The segment list and the full raw->segment mapping live in
 * scripts/data/act-industries.json, deliberately as data rather than in this
 * file: every judgement call about which spellings are the same trade is
 * reviewable there in one place, and the same mapping is what the planned ACT
 * contact import will need — `resolveActIndustry` below is exported for it, so
 * a contact's raw industry text resolves to a row created here rather than
 * seeding a second, dirtier list beside this one.
 *
 * Usage:
 *   npx tsx scripts/import-act-industries.ts --dry-run   # print, change nothing
 *   npx tsx scripts/import-act-industries.ts             # create missing rows
 *   npx tsx scripts/import-act-industries.ts --merge     # also fold existing
 *                                                        # raw-named rows in
 *
 * Idempotent: re-running creates nothing new. Existing rows are matched
 * case-insensitively (`normalizeIndustryName`), the same rule the picker and
 * the database's own functional unique index use, so a row someone already
 * added by hand is never duplicated with different capitalisation.
 *
 * `--merge` is the cleanup pass, and the only destructive mode. If an earlier
 * import already put raw ACT spellings in the table, it moves every company
 * from each raw row onto its canonical row and deletes the raw one — the same
 * thing Settings -> Industries does by hand, in bulk. Without the flag those
 * rows are listed and left alone.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { industryNameSchema, normalizeIndustryName } from "../src/lib/validation/industries";

export type ActIndustries = {
  /** The segments to seed. */
  canonical: string[];
  /** Raw ACT spelling -> segment, or null for a value that is not an industry.
   * Also carries the intermediate cleaned names (the 86-row pass that preceded
   * these segments), so a database seeded from that earlier list can be folded
   * in with `--merge`. */
  aliases: Record<string, string | null>;
};

const DATA_PATH = path.join(import.meta.dirname, "data", "act-industries.json");

/** The mapping, as data. Exported for the ACT contact import, which needs to
 * resolve each contact's raw industry text against the same table this script
 * seeded rather than inventing its own. */
export function loadActIndustries(): ActIndustries {
  return JSON.parse(readFileSync(DATA_PATH, "utf8")) as ActIndustries;
}

/**
 * The segment for one raw ACT industry value, or null when the value maps to
 * nothing (junk) or isn't in the mapping at all — the caller decides whether an
 * unknown value is worth failing over or just leaving the company's industry
 * unset. Matched on the normalized key, so capitalisation and stray whitespace
 * in the export don't miss.
 */
export function resolveActIndustry(aliases: ActIndustries["aliases"], raw: string): string | null {
  const key = normalizeIndustryName(raw);
  for (const [alias, segment] of Object.entries(aliases)) {
    if (normalizeIndustryName(alias) === key) return segment;
  }
  return null;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const merge = args.has("--merge");

  const data = loadActIndustries();

  // Every canonical name must survive the same validation the picker applies,
  // checked before touching the database so a bad entry in the data file is a
  // refusal rather than a half-finished import.
  const invalid = data.canonical.filter((name) => !industryNameSchema.safeParse(name).success);
  if (invalid.length > 0) {
    console.error(`invalid names in ${DATA_PATH}: ${invalid.join(", ")}`);
    process.exit(1);
  }

  // Imported here, not at module scope, so the checks above can't be skipped by
  // an early DB/env failure — Prisma 7 needs an explicit driver adapter (see
  // src/lib/db.ts), so a bare client at module scope throws before main() runs.
  // Mirrors scripts/import-industries.ts and scripts/create-user.ts.
  const { db } = await import("../src/lib/db");

  const existing = await db.industry.findMany();
  const byKey = new Map(existing.map((row) => [normalizeIndustryName(row.name), row]));

  const canonicalKeys = new Set(data.canonical.map(normalizeIndustryName));

  const toCreate = data.canonical.filter((name) => !byKey.has(normalizeIndustryName(name)));

  // Rows already in the table whose name is a raw ACT spelling of something
  // else in the canonical list. A row that IS its own canonical name is not one
  // of these, hence the key comparison rather than a plain lookup.
  const toMerge: { from: (typeof existing)[number]; to: string }[] = [];
  for (const row of existing) {
    const key = normalizeIndustryName(row.name);
    if (canonicalKeys.has(key)) continue;
    const target = resolveActIndustry(data.aliases, row.name);
    if (target && normalizeIndustryName(target) !== key) {
      toMerge.push({ from: row, to: target });
    }
  }

  console.log(
    `${data.canonical.length} segments; ${existing.length} rows already in the database`
  );
  console.log(`to create: ${toCreate.length}`);
  for (const name of toCreate) console.log(`  + ${name}`);

  if (toMerge.length > 0) {
    console.log(
      `rows to fold into a segment: ${toMerge.length}${merge ? "" : " (run with --merge to do it)"}`
    );
    for (const { from, to } of toMerge) console.log(`  ~ ${from.name} -> ${to}`);
  }

  if (dryRun) {
    console.log("dry run — nothing written");
    return;
  }

  for (const name of toCreate) {
    const created = await db.industry.create({ data: { name } });
    byKey.set(normalizeIndustryName(name), created);
  }

  let moved = 0;
  if (merge) {
    for (const { from, to } of toMerge) {
      const target = byKey.get(normalizeIndustryName(to));
      if (!target) {
        console.warn(`  skipped ${from.name}: no row for ${to}`);
        continue;
      }
      // One transaction per merge, same as the Settings screen's own action: a
      // half-done merge would leave companies split across two rows with no way
      // to tell which half ran.
      await db.$transaction(async (tx) => {
        const { count } = await tx.company.updateMany({
          where: { industryId: from.id },
          data: { industryId: target.id },
        });
        await tx.industry.delete({ where: { id: from.id } });
        moved += count;
      });
    }
  }

  console.log(
    `created ${toCreate.length}` +
      (merge ? `, merged ${toMerge.length} rows (${moved} companies moved)` : "")
  );
}

// Only when this file is what was run. `loadActIndustries` and
// `resolveActIndustry` above are exported to be imported -- by
// scripts/seed-industry-aliases.ts today and by the ACT contact import later --
// and an unguarded `main()` would mean importing either one silently seeds the
// Industry table and then calls process.exit(0) out from under the caller.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      console.error(error);
      process.exit(1);
    })
    .finally(() => process.exit(0));
}
