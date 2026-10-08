/**
 * Rewrite every `Company` city and state into the case it should be printed in.
 *
 * The ACT! import brought in a free-text field twenty years old: `st paul`,
 * `gleason`, `rEVERS cASE`, `bELL gARDDENS`, and whole columns in capitals. The
 * city is printed on the quote a client receives, so this is not only cosmetic
 * in the clients list -- `bELL gARDDENS` goes out in a PDF.
 *
 * It runs each value through `normalisePlaceName` (cities) or
 * `normaliseStateName` (states) -- the same functions the importer and the
 * company form use. Doing it here rather than in SQL is the point: a second
 * implementation would drift from the first, and the first is the one with the
 * tests.
 *
 * Covers `city`, `state`, `deliveryCity` and `deliveryState`. `country` is not
 * touched: it holds an ISO code and has its own handling.
 *
 * WHAT IT CHANGES is the case of letters and the whitespace between them, and
 * nothing else. The letters themselves are identical before and after, so
 * `bELL gARDDENS` becomes `Bell Garddens`, not `Bell Gardens`: spelling is a
 * guess about what somebody meant, and a guessed address is worse than one
 * that is visibly odd for a person to correct.
 *
 * What it does to each value:
 *   already canonical        left alone
 *   wrong case or spacing    rewritten
 *   only whitespace          cleared to empty (it carries nothing)
 *
 * The report separates the changes so a person can scan them. A few thousand
 * lines of `foo -> Foo` cannot be reviewed, so:
 *
 *   NOT A CASE FLIP     printed in full, first. A change that alters anything
 *                       but case and spacing is not expected; if this section
 *                       is not empty, something is wrong -- stop and look.
 *   MIXED CASE          printed in full. `bELL gARDDENS`, `Los angeles`: the
 *                       odd ones, and the few where a rule has to decide.
 *   ALL LOWER CASE      distinct values, most common first, first 30.
 *   ALL CAPITALS        the same.
 *   CITIES IN CAPITALS  cities the rule chose NOT to touch because they are
 *                       short enough to be abbreviations (`NYC`). Listed so a
 *                       person can spot the real towns among them (`ULM`).
 *
 * `--all` lists every distinct value in the two long sections.
 *
 * Writing is guarded: a row is only updated if the stored value is still the
 * one the report read, so a client edited while this ran is left as the person
 * made it and counted as skipped.
 *
 * Usage:
 *     npm run clients:normalise-place-names                  # report, writes nothing
 *     npm run clients:normalise-place-names -- --all         # report, every value listed
 *     npm run clients:normalise-place-names -- --apply       # writes
 */
import "dotenv/config";
import { normalisePlaceName, normaliseStateName } from "../src/lib/place-name";

const APPLY = "--apply";
const ALL = "--all";
const KNOWN = [APPLY, ALL];
/** How many distinct values the two long sections list unless `--all`. */
const SAMPLE = 30;

const FIELDS = [
  { key: "city", kind: "city", normalise: normalisePlaceName },
  { key: "state", kind: "state", normalise: normaliseStateName },
  { key: "deliveryCity", kind: "city", normalise: normalisePlaceName },
  { key: "deliveryState", kind: "state", normalise: normaliseStateName },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];
type Kind = (typeof FIELDS)[number]["kind"];

type Category = "blank" | "other" | "mixed" | "lower" | "upper";

interface Change {
  id: string;
  name: string;
  field: FieldKey;
  kind: Kind;
  from: string;
  to: string | null;
  category: Category;
}

interface Pair {
  kind: Kind;
  from: string;
  to: string | null;
  count: number;
}

const squash = (value: string) => value.replace(/\s+/g, " ").trim();

/** Why a value changed, from the value and what it became. */
function categorise(from: string, to: string | null): Category {
  if (to === null) return "blank";
  const spaced = squash(from);
  if (spaced.toLowerCase() !== to.toLowerCase()) return "other";
  if (spaced === spaced.toLowerCase()) return "lower";
  if (spaced === spaced.toUpperCase()) return "upper";
  return "mixed";
}

/** Distinct (kind, from, to) with how many times each occurred. */
function tally(changes: Change[]): Pair[] {
  const pairs = new Map<string, Pair>();
  for (const change of changes) {
    const key = `${change.kind}\u0000${change.from}\u0000${change.to}`;
    const pair = pairs.get(key);
    if (pair) pair.count += 1;
    else pairs.set(key, { kind: change.kind, from: change.from, to: change.to, count: 1 });
  }
  return [...pairs.values()].sort(
    (a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.kind.localeCompare(b.kind),
  );
}

const show = (value: string | null) => (value === null ? "(empty)" : JSON.stringify(value));

function printPairs(title: string, note: string, pairs: Pair[], limit: number) {
  if (pairs.length === 0) return;
  const total = pairs.reduce((sum, pair) => sum + pair.count, 0);
  console.log("");
  console.log(`${title} -- ${total} value${total === 1 ? "" : "s"}, ${pairs.length} distinct`);
  if (note) console.log(`  ${note}`);
  for (const pair of pairs.slice(0, limit)) {
    console.log(
      `  ${String(pair.count).padStart(5)}x  ${pair.kind.padEnd(5)}  ${show(pair.from)}  ->  ${show(pair.to)}`,
    );
  }
  if (pairs.length > limit) {
    console.log(`  ... and ${pairs.length - limit} more distinct. Re-run with ${ALL} to list them.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => !KNOWN.includes(arg));
  if (unknown.length > 0) {
    console.error(`unknown argument: ${unknown.join(", ")}. The options are ${KNOWN.join(" and ")}.`);
    process.exit(2);
  }
  // npm keeps a flag that is not after `--`, so the script would run in report
  // mode while the operator believed they had asked for a write -- or worse,
  // the other way round. Refuse rather than guess. (npm also knows `--all`.)
  if (process.env.npm_config_apply || process.env.npm_config_all) {
    console.error(
      `put the flags after a bare -- : npm run clients:normalise-place-names -- ${APPLY}`,
    );
    process.exit(2);
  }
  const apply = args.includes(APPLY);
  const limit = args.includes(ALL) ? Infinity : SAMPLE;

  // Imported late, as the other operator scripts do: Prisma 7 needs an explicit
  // driver adapter, so a client at module scope throws before main() runs.
  const { db } = await import("../src/lib/db");

  const rows = await db.company.findMany({
    where: {
      OR: FIELDS.map(({ key }) => ({ [key]: { not: null } })),
    },
    select: { id: true, name: true, city: true, state: true, deliveryCity: true, deliveryState: true },
    orderBy: { name: "asc" },
  });

  const changes: Change[] = [];
  const leftCapitals = new Map<string, { kind: Kind; value: string; count: number }>();
  const perField = FIELDS.map(({ key }) => ({ key, values: 0, canonical: 0, changing: 0 }));

  for (const row of rows) {
    FIELDS.forEach(({ key, kind, normalise }, index) => {
      const current = row[key];
      if (current === null) return;
      const counts = perField[index];
      counts.values += 1;

      const canonical = normalise(current);
      if (canonical === current) {
        counts.canonical += 1;
        // Capitals the rule left alone: an abbreviation, or a short town. Only
        // cities are worth a look -- a state left in capitals is a code.
        if (kind === "city" && current === current.toUpperCase() && current !== current.toLowerCase()) {
          const mapKey = `${kind}\u0000${current}`;
          const seen = leftCapitals.get(mapKey);
          if (seen) seen.count += 1;
          else leftCapitals.set(mapKey, { kind, value: current, count: 1 });
        }
        return;
      }
      counts.changing += 1;
      changes.push({
        id: row.id,
        name: row.name,
        field: key,
        kind,
        from: current,
        to: canonical,
        category: categorise(current, canonical),
      });
    });
  }

  const companies = new Set(changes.map((change) => change.id)).size;
  const totalValues = perField.reduce((sum, field) => sum + field.values, 0);

  console.log(`${rows.length} companies have a city or a state`);
  console.log("");
  console.log(`  ${"".padEnd(14)}${"values".padStart(8)}${"canonical".padStart(11)}${"to change".padStart(11)}`);
  for (const field of perField) {
    console.log(
      `  ${field.key.padEnd(14)}${String(field.values).padStart(8)}${String(field.canonical).padStart(11)}${String(field.changing).padStart(11)}`,
    );
  }
  console.log(
    `  ${"total".padEnd(14)}${String(totalValues).padStart(8)}${String(totalValues - changes.length).padStart(11)}${String(changes.length).padStart(11)}`,
  );
  console.log("");
  console.log(`${changes.length} values to rewrite, across ${companies} companies`);

  const by = (category: Category) => changes.filter((change) => change.category === category);

  const notCase = [...by("other"), ...by("blank")];
  if (notCase.length > 0) {
    console.log("");
    console.log(`NOT A CASE FLIP -- ${notCase.length} value${notCase.length === 1 ? "" : "s"}. Read these first.`);
    console.log("  Anything that changes more than case and spacing is unexpected. A value");
    console.log("  that becomes (empty) held only whitespace; any other line here means the");
    console.log("  rule altered letters, which it must never do -- do not apply until explained.");
    for (const change of notCase) {
      console.log(`  ${change.name}  [${change.field}]  ${show(change.from)}  ->  ${show(change.to)}`);
    }
  }

  printPairs(
    "MIXED CASE",
    "Odd shapes (bELL gARDDENS) and part-right values (Los angeles). Check each.",
    tally(by("mixed")),
    Infinity,
  );
  printPairs("ALL LOWER CASE", "Most common first.", tally(by("lower")), limit);
  printPairs("ALL CAPITALS", "Most common first.", tally(by("upper")), limit);

  const left = [...leftCapitals.values()].sort(
    (a, b) => b.count - a.count || a.value.localeCompare(b.value),
  );
  if (left.length > 0) {
    const total = left.reduce((sum, item) => sum + item.count, 0);
    console.log("");
    console.log(`CITIES IN CAPITALS, LEFT AS THEY ARE -- ${total} value${total === 1 ? "" : "s"}, ${left.length} distinct`);
    console.log("  Short enough to be abbreviations (NYC, USA), so not re-cased. A real");
    console.log("  town of three letters or fewer (ULM, RIO) would be among them; fix those by hand.");
    for (const item of left.slice(0, limit)) {
      console.log(`  ${String(item.count).padStart(5)}x  ${item.kind.padEnd(5)}  ${JSON.stringify(item.value)}`);
    }
    if (left.length > limit) {
      console.log(`  ... and ${left.length - limit} more distinct. Re-run with ${ALL} to list them.`);
    }
  }

  if (!apply) {
    console.log("");
    console.log(
      changes.length > 0
        ? `Report only. Re-run with ${APPLY} to write the ${changes.length} rewrites.`
        : "Report only. Nothing to rewrite.",
    );
    await db.$disconnect();
    return;
  }

  // One update per company, carrying every field that changes, and guarded: the
  // update only matches while each field still holds the value the report read.
  const perCompany = new Map<
    string,
    { data: Partial<Record<FieldKey, string | null>>; guard: Partial<Record<FieldKey, string>> }
  >();
  for (const change of changes) {
    const entry = perCompany.get(change.id) ?? { data: {}, guard: {} };
    entry.data[change.field] = change.to;
    entry.guard[change.field] = change.from;
    perCompany.set(change.id, entry);
  }

  let written = 0;
  let skipped = 0;
  for (const [id, { data, guard }] of perCompany) {
    const result = await db.company.updateMany({ where: { id, ...guard }, data });
    if (result.count === 1) written += 1;
    else skipped += 1;
  }
  console.log("");
  console.log(`wrote ${written} of ${perCompany.size} companies`);
  if (skipped > 0) {
    console.log(
      `${skipped} changed since the report was read and were left as they are -- re-run to pick them up`,
    );
  }
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
