import "dotenv/config";
import type { PrismaClient } from "@prisma/client";
import { CATEGORY_TOKENS, tokensIn } from "../src/lib/quote-variables";

/**
 * One-shot data migration for Task 10 of
 * docs/superpowers/plans/2026-09-07-category-quote-copy.md: moves the
 * quotation copy that used to live in `ContentBlock` rows onto
 * `Series.quoteDescription`, then deletes every `ContentBlock` row this
 * catalog no longer needs. `terms.*`, `conditions.*` and `rsp.*` are left
 * completely alone -- a separate plan migrates those.
 *
 *   npx tsx scripts/migrate-content-blocks-to-series.ts            # dry run, writes nothing
 *   npx tsx scripts/migrate-content-blocks-to-series.ts --apply    # applies the plan above
 *
 * Cannot be run from the agent sandbox that wrote this file -- the
 * development database only listens on Vadym's machine (see the plan's
 * "Environment constraint" section) -- so this is written defensively:
 *
 *  - dry run by default; only --apply writes or deletes anything
 *  - the FULL plan (every write, skip, discard and delete) is computed and
 *    printed before a single row is touched
 *  - refuses to overwrite a Series.quoteDescription that is already
 *    non-empty -- reports and skips that one write, and does not fail the
 *    whole run over it
 *  - safe to run twice: everything this script would touch is gone after a
 *    first --apply, so a second run (dry or --apply) finds nothing to do
 *  - a target series code that does not exist is reported clearly and does
 *    not crash the script -- but it does leave that key's ContentBlock
 *    row(s) in place (not fully migrated) and makes the run exit non-zero
 *  - a ContentBlock key this script doesn't recognise (not a migration
 *    source, not one of the delete-outright keys, not terms./conditions./
 *    rsp.) is reported and left completely untouched, and also makes the
 *    run exit non-zero -- an unrecognised key is far more likely a sign this
 *    script has drifted from a database that changed underneath it than
 *    something safe to silently ignore
 *
 * Mapping (spec's migration table, global defaults only -- regionId: null):
 *   machine.m-series      -> Series M and Series X (same body, both)
 *   equipment.easy-loader -> Series EL
 *   equipment.fabric-pro  -> Series FP
 *
 * A region override of one of these three keys is discarded outright (never
 * written anywhere) and logged individually -- per the spec, category copy
 * is not region-scoped, a machine cuts the same in Mexico City and Sydney.
 *
 * Deleted outright, no migration, per the spec's migration table: all 17
 * option.* blocks, plus the orphans equipment.fabric-master and
 * equipment.spreading-table, plus the six software.* blocks -- no catalog
 * category maps to any of them. Matched by key prefix/exact key rather than
 * a hardcoded list of all 25, so this script acts on whatever the live
 * database actually has under those keys rather than what
 * content-blocks.json happened to list when this file was written.
 */

const MIGRATIONS: ReadonlyArray<{ blockKey: string; targetSeriesCodes: readonly string[] }> = [
  { blockKey: "machine.m-series", targetSeriesCodes: ["M", "X"] },
  { blockKey: "equipment.easy-loader", targetSeriesCodes: ["EL"] },
  { blockKey: "equipment.fabric-pro", targetSeriesCodes: ["FP"] },
];

/** Deleted outright with no body migration -- no catalog category maps to
 * any of them. `option.` and `software.` are prefixes (17 and 6 keys today,
 * respectively); the two equipment orphans are named explicitly since most
 * `equipment.*` keys ARE migration sources (see MIGRATIONS above), not
 * delete-outright. */
const DELETE_PREFIXES = ["option.", "software."] as const;
const DELETE_EXACT_KEYS = ["equipment.fabric-master", "equipment.spreading-table"] as const;

/** Never touched by this script -- a separate plan migrates these. */
const UNTOUCHED_PREFIXES = ["terms.", "conditions.", "rsp."] as const;

const KNOWN_TOKENS = new Set(CATEGORY_TOKENS.map((t) => t.token));

function isMigrationKey(key: string): boolean {
  return MIGRATIONS.some((m) => m.blockKey === key);
}
function isDeleteOutrightKey(key: string): boolean {
  return DELETE_PREFIXES.some((p) => key.startsWith(p)) || (DELETE_EXACT_KEYS as readonly string[]).includes(key);
}
function isUntouchedKey(key: string): boolean {
  return UNTOUCHED_PREFIXES.some((p) => key.startsWith(p));
}

/** Flattens a body to a single line and caps it at ~80 characters, purely so
 * the dry-run report reads as one line per row rather than reproducing whole
 * multi-paragraph bodies. */
function preview(body: string, max = 80): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

type Db = PrismaClient;

type SeriesWritePlan =
  | { status: "write"; seriesCode: string; seriesId: string }
  | { status: "skip-nonempty"; seriesCode: string; existingLength: number }
  | { status: "missing-series"; seriesCode: string };

type KeyPlan = {
  blockKey: string;
  targetSeriesCodes: readonly string[];
  /** null when the default (regionId: null) block for this key no longer
   * exists -- i.e. an earlier run already migrated and deleted it. */
  defaultBlock: { id: string; body: string } | null;
  overrides: Array<{ id: string; regionCode: string; body: string }>;
  writes: SeriesWritePlan[];
  unknownTokens: string[];
  /** True when every write for this key resolved one way or another (write
   * or skip-nonempty) -- i.e. nothing is left for a future run to do. False
   * when at least one target series is missing, in which case this key's
   * ContentBlock row(s) are left in place rather than deleted. */
  fullyResolved: boolean;
};

type DeleteRow = { id: string; key: string; regionCode: string | null; bodyLength: number; preview: string };

async function computePlan(db: Db) {
  const allBlocks = await db.contentBlock.findMany({ include: { region: true } });

  const keyPlans: KeyPlan[] = [];
  for (const migration of MIGRATIONS) {
    const rowsForKey = allBlocks.filter((b) => b.key === migration.blockKey);
    const defaultRow = rowsForKey.find((b) => b.regionId === null) ?? null;
    const overrideRows = rowsForKey.filter((b) => b.regionId !== null);

    const writes: SeriesWritePlan[] = [];
    let fullyResolved = true;
    if (defaultRow) {
      for (const seriesCode of migration.targetSeriesCodes) {
        const series = await db.series.findUnique({ where: { code: seriesCode } });
        if (!series) {
          writes.push({ status: "missing-series", seriesCode });
          fullyResolved = false;
        } else if (series.quoteDescription && series.quoteDescription.trim() !== "") {
          writes.push({ status: "skip-nonempty", seriesCode, existingLength: series.quoteDescription.length });
        } else {
          writes.push({ status: "write", seriesCode, seriesId: series.id });
        }
      }
    }
    // No default row: either already migrated by an earlier run (nothing
    // left to write), or never existed -- either way there is nothing for
    // this run to write, and `fullyResolved` stays true so any leftover
    // override row for the key is still cleaned up below.

    keyPlans.push({
      blockKey: migration.blockKey,
      targetSeriesCodes: migration.targetSeriesCodes,
      defaultBlock: defaultRow ? { id: defaultRow.id, body: defaultRow.body } : null,
      overrides: overrideRows.map((o) => ({ id: o.id, regionCode: o.region?.code ?? "?", body: o.body })),
      writes,
      unknownTokens: defaultRow ? tokensIn(defaultRow.body).filter((t) => !KNOWN_TOKENS.has(t)) : [],
      fullyResolved,
    });
  }

  const deleteRows: DeleteRow[] = allBlocks
    .filter((b) => isDeleteOutrightKey(b.key))
    .map((b) => ({
      id: b.id,
      key: b.key,
      regionCode: b.region?.code ?? null,
      bodyLength: b.body.length,
      preview: preview(b.body),
    }));

  const unrecognized = allBlocks.filter(
    (b) => !isMigrationKey(b.key) && !isDeleteOutrightKey(b.key) && !isUntouchedKey(b.key)
  );

  return { keyPlans, deleteRows, unrecognized };
}

function printPlan(plan: Awaited<ReturnType<typeof computePlan>>): { hadUnexpectedIssue: boolean } {
  let hadUnexpectedIssue = false;

  console.log("=== Category copy migration: machine.*/equipment.* -> Series.quoteDescription ===\n");
  for (const key of plan.keyPlans) {
    console.log(`${key.blockKey}:`);
    if (!key.defaultBlock) {
      console.log("  no default (regionId: null) ContentBlock row -- already migrated, nothing to write");
    } else {
      console.log(`  source body: ${key.defaultBlock.body.length} chars, "${preview(key.defaultBlock.body)}"`);
      for (const w of key.writes) {
        if (w.status === "write") {
          console.log(`  [WRITE]  Series ${w.seriesCode}.quoteDescription <- this body`);
        } else if (w.status === "skip-nonempty") {
          console.log(
            `  [SKIP]   Series ${w.seriesCode} already has a non-empty quoteDescription (${w.existingLength} chars) -- refusing to overwrite`
          );
        } else {
          console.log(`  [ERROR]  Series code "${w.seriesCode}" not found in the catalog -- cannot migrate ${key.blockKey}`);
          hadUnexpectedIssue = true;
        }
      }
      if (key.unknownTokens.length > 0) {
        console.log(
          `  [NOTE]   body uses token(s) not in the quote-variable registry: ${key.unknownTokens.map((t) => `{{${t}}}`).join(", ")} -- will render as unresolved/stripped; review after migrating`
        );
      }
    }
    for (const o of key.overrides) {
      console.log(
        `  [DISCARD OVERRIDE] region=${o.regionCode}: ${o.body.length} chars, "${preview(o.body)}" -- category copy is not region-scoped, this override is not written anywhere`
      );
    }
    if (key.defaultBlock || key.overrides.length > 0) {
      const rowCount = (key.defaultBlock ? 1 : 0) + key.overrides.length;
      if (key.fullyResolved) {
        console.log(`  [DELETE] ${rowCount} ContentBlock row(s) for key "${key.blockKey}" once every write above is resolved`);
      } else {
        console.log(
          `  [KEEP]   ${rowCount} ContentBlock row(s) for key "${key.blockKey}" left in place -- not fully migrated (see [ERROR] above)`
        );
      }
    }
    console.log("");
  }

  console.log("=== Delete outright: option.*, software.*, and the two equipment orphans ===\n");
  if (plan.deleteRows.length === 0) {
    console.log("  nothing to delete -- already gone\n");
  } else {
    for (const row of plan.deleteRows) {
      console.log(
        `  [DELETE] ${row.key} (${row.regionCode ?? "default"}): ${row.bodyLength} chars, "${row.preview}"`
      );
    }
    console.log("");
  }

  if (plan.unrecognized.length > 0) {
    console.log("=== Unrecognized ContentBlock keys (left untouched) ===\n");
    for (const row of plan.unrecognized) {
      console.log(
        `  [WARN]   key "${row.key}" (${row.region?.code ?? "default"}) matches neither a migration source, a delete-outright key, nor terms./conditions./rsp. -- this script does not know what to do with it and is leaving it alone`
      );
    }
    console.log("");
    hadUnexpectedIssue = true;
  }

  const writesPlanned = plan.keyPlans.flatMap((k) => k.writes).filter((w) => w.status === "write").length;
  const skipsNonempty = plan.keyPlans.flatMap((k) => k.writes).filter((w) => w.status === "skip-nonempty").length;
  const missingSeries = plan.keyPlans.flatMap((k) => k.writes).filter((w) => w.status === "missing-series").length;
  const overridesDiscarded = plan.keyPlans.reduce((n, k) => n + k.overrides.length, 0);
  const keyBlocksDeleted = plan.keyPlans.filter((k) => k.fullyResolved && (k.defaultBlock || k.overrides.length > 0)).reduce((n, k) => n + (k.defaultBlock ? 1 : 0) + k.overrides.length, 0);

  console.log("=== Summary ===");
  console.log(`  Series.quoteDescription writes planned: ${writesPlanned}`);
  console.log(`  skipped (already non-empty):            ${skipsNonempty}`);
  console.log(`  errors (target series code not found):  ${missingSeries}`);
  console.log(`  region overrides discarded:              ${overridesDiscarded}`);
  console.log(`  ContentBlock rows to delete (3 migrated keys): ${keyBlocksDeleted}`);
  console.log(`  ContentBlock rows to delete (delete-outright): ${plan.deleteRows.length}`);
  console.log(`  unrecognized ContentBlock keys:          ${plan.unrecognized.length}`);
  console.log("");

  return { hadUnexpectedIssue };
}

async function apply(db: Db, plan: Awaited<ReturnType<typeof computePlan>>) {
  for (const key of plan.keyPlans) {
    for (const w of key.writes) {
      if (w.status !== "write" || !key.defaultBlock) continue;
      await db.series.update({ where: { id: w.seriesId }, data: { quoteDescription: key.defaultBlock.body } });
      console.log(`wrote Series ${w.seriesCode}.quoteDescription from ${key.blockKey}`);
    }
    if (key.fullyResolved) {
      const idsToDelete = [...(key.defaultBlock ? [key.defaultBlock.id] : []), ...key.overrides.map((o) => o.id)];
      if (idsToDelete.length > 0) {
        await db.contentBlock.deleteMany({ where: { id: { in: idsToDelete } } });
        console.log(`deleted ${idsToDelete.length} ContentBlock row(s) for key ${key.blockKey}`);
      }
    }
  }

  if (plan.deleteRows.length > 0) {
    await db.contentBlock.deleteMany({ where: { id: { in: plan.deleteRows.map((r) => r.id) } } });
    console.log(`deleted ${plan.deleteRows.length} ContentBlock row(s) (option.*/software.*/equipment orphans)`);
  }
}

async function main() {
  const isApply = process.argv.includes("--apply");

  const { db } = await import("../src/lib/db");

  const plan = await computePlan(db);
  const { hadUnexpectedIssue } = printPlan(plan);

  const nothingToDo =
    plan.keyPlans.every((k) => !k.defaultBlock && k.overrides.length === 0) && plan.deleteRows.length === 0;
  if (nothingToDo) {
    console.log("nothing to do -- the database already reflects the target state");
    if (hadUnexpectedIssue) process.exitCode = 1;
    return;
  }

  if (!isApply) {
    console.log("dry run -- nothing written. Re-run with --apply to perform the writes/deletes above.");
    if (hadUnexpectedIssue) {
      console.log("note: at least one unexpected issue was reported above -- exiting non-zero even though this was a dry run.");
      process.exitCode = 1;
    }
    return;
  }

  await apply(db, plan);

  // Prove idempotence right away: a second plan over the migrated rows
  // should find nothing left to migrate or delete (it may still legitimately
  // report an unresolved key if a target series was missing and is still
  // missing).
  const after = await computePlan(db);
  const afterNothingToDo =
    after.keyPlans.every((k) => !k.defaultBlock && k.overrides.length === 0) && after.deleteRows.length === 0;
  if (!afterNothingToDo) {
    console.warn("warning: a second plan is not empty after applying -- re-run with no flags to see what remains");
    process.exitCode = 1;
  } else {
    console.log("verified: a second plan finds nothing left to do");
  }

  if (hadUnexpectedIssue) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    const { db } = await import("../src/lib/db");
    await db.$disconnect();
  });
