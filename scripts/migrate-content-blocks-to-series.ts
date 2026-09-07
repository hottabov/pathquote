import "dotenv/config";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { categorySpecPresence, categoryTokensFor, findUnknownTokens } from "../src/lib/quote-variables";
// The same write-boundary sanitizer `updateSeriesQuoteDescription` applies to
// every editor save. Pure (no `@/lib/db`, no `next/*` -- see rich-text.ts's
// header), so importing it here costs this script nothing.
import { sanitizeIfHtml } from "../src/lib/rich-text";

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
 *  - --apply writes a JSON backup to `migration-backup-<ISO8601>.json` in the
 *    repo root BEFORE the first write or delete: every ContentBlock row this
 *    run touches (all columns, full body, region overrides included) plus the
 *    current `Series.quoteDescription` of every target series. The terminal
 *    report only ever shows an 80-character preview of a body, which is not a
 *    record of legal-adjacent prose; the backup file is. If the backup cannot
 *    be written the run aborts without touching the database. The filename
 *    pattern is gitignored -- these bodies do not belong in git
 *  - every write and delete of an --apply run happens inside ONE
 *    `db.$transaction`, so an interrupt or a crash rolls the whole thing back
 *    rather than leaving the catalog half-migrated
 *  - refuses to overwrite a Series.quoteDescription that holds copy DIFFERENT
 *    from the block body -- reports and skips that one write, and does not
 *    fail the whole run over it. A destination already holding exactly this
 *    body (`.trim()`-equal) is not a skip: it is a write an earlier run
 *    already made, so it counts as resolved and needs no second write.
 *    Crucially, a key's ContentBlock row(s) are only ever deleted once EVERY
 *    one of its target series holds the body (see `machine.m-series`, which
 *    targets both M and X) -- if even one target was skipped or had a missing
 *    series code, the source row is left in place so the body still exists
 *    somewhere and a human can reconcile it by hand
 *  - safe to run twice: a key whose every target series holds the body has
 *    its ContentBlock row(s) gone after the first --apply, so a second run
 *    (dry or --apply) finds nothing left to do for that key. A key with a
 *    skipped or missing target keeps its ContentBlock row(s) and keeps
 *    reporting the same skip/error on every subsequent run until a human
 *    resolves it by hand -- that is not a bug, it is the point
 *  - a body carrying a token that has since been RENAMED is rewritten on its
 *    way onto the series -- see TOKEN_REWRITES. Today that is one token in one
 *    key: `equipment.easy-loader` opens "Conveyorised Spreading Table
 *    ({{lengthM}}mtr)", and `{{lengthM}}` was a per-option-line attribute
 *    variable whose mechanism was deleted. `{{tableLengthM}}` replaces it and
 *    computes the same figure from the item's own module lines. Every rewrite
 *    is printed as its own `[REWRITE]` line so a dry run shows it happening
 *    rather than a body quietly differing from its source row
 *  - each body goes through `sanitizeIfHtml` on its way onto the series, the
 *    same write-boundary sanitizer `updateSeriesQuoteDescription` applies to
 *    every editor save. Without it, migrated copy would be the only
 *    `Series.quoteDescription` in the database never to have met the
 *    allowlist -- a different shape from every other row in the same column,
 *    which the author's first re-save through the editor would then silently
 *    change. The report says so whenever the sanitizer actually alters a body
 *  - each body is validated against the tokens ITS OWN target category can
 *    fill -- `categoryTokensFor(categorySpecPresence(series.products))`, the
 *    exact pair `updateSeriesQuoteDescription` uses when an admin saves. A
 *    token the target cannot fill would render as a silently stripped line on
 *    every quote AND make that category unsavable through the editor
 *    afterwards, so it is a [WARN] that fails the run (status 1), not a note.
 *    The body is still written and the source row still deleted: the copy is
 *    not lost (it is on the series, and in the backup file), it just needs a
 *    human to edit the offending token out
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
 * Exit codes -- the full contract:
 *
 *   0  Clean. Every target series holds its body, every doomed row is gone,
 *      and nothing unexpected was reported.
 *   1  Unexpected -- a human must look. Any one of: a target series code not
 *      found in the catalog; a ContentBlock key this script does not
 *      recognise; a body carrying a token its target category cannot fill;
 *      the backup file could not be written (in which case NOTHING was
 *      written or deleted); unexpected leftover rows after applying; or an
 *      uncaught error (the top-level catch exits 1 too).
 *   2  Skip-only. The run's ONLY unresolved items are non-empty-destination
 *      skips: a series already holds copy that differs from the block body,
 *      so the write was refused and the source row kept. A human decision is
 *      pending; this is neither a clean run nor a malfunction, so it gets its
 *      own status, visible to a script checking `$?` without being mistaken
 *      for a crash.
 *
 *   1 outranks 2: a run with both an unexpected issue and a pending skip
 *   exits 1. The dry run reports the same status the corresponding --apply
 *   would, so `$?` means the same thing either way.
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

/**
 * Tokens renamed since the block body was written, rewritten on the way onto
 * the category. Scoped to one block key each rather than applied globally: a
 * rename is a fact about a specific body someone actually wrote, and a blanket
 * search-and-replace across every migrated body is how an unrelated key
 * acquires a token nobody chose for it.
 *
 * `equipment.easy-loader`'s `{{lengthM}}` is the only entry. It was a
 * per-option-line attribute variable; that mechanism was deleted, so the line
 * strips on every quote AND the category cannot be re-saved from the editor
 * (`updateSeriesQuoteDescription` rejects a token the category cannot fill).
 * `{{tableLengthM}}` is the replacement -- computed from the item's own
 * EasyLoader module option lines, see src/lib/quote-variables.ts -- so this
 * rewrite is what makes the migrated body both correct and savable, and is
 * why that key no longer trips the out-of-scope [WARN] below. Any OTHER
 * out-of-scope token is left exactly as it is and still warns: this table is
 * a list of known renames, not a way to silence the check.
 */
const TOKEN_REWRITES: ReadonlyArray<{ blockKey: string; from: string; to: string }> = [
  { blockKey: "equipment.easy-loader", from: "lengthM", to: "tableLengthM" },
];

/** A literal metre unit written immediately after the token, which the OLD
 * token needed (it substituted a bare number) and the new one must not have:
 * `formatMetres` prints "4.8 m", so "({{tableLengthM}}mtr)" would render
 * "(4.8 mmtr)". Longest alternative first, and the trailing guard stops "m"
 * from eating the first letter of a real word. */
const UNIT_SUFFIX = "(?:mtrs|mtr|metres|metre|m)(?![A-Za-z])";

/** Applies every rewrite registered for `blockKey`, returning the new body and
 * a one-line description of each rewrite for the report. A key with no
 * registered rewrite returns its body untouched and an empty list. */
function rewriteTokens(blockKey: string, body: string): { body: string; rewrites: string[] } {
  const rewrites: string[] = [];
  let out = body;
  for (const rule of TOKEN_REWRITES) {
    if (rule.blockKey !== blockKey) continue;
    // Same inner-whitespace tolerance `tokensIn` and the renderer both have,
    // so "{{ lengthM }}" is rewritten too rather than left to strip.
    const tokenPattern = new RegExp(`\\{\\{\\s*${rule.from}\\s*\\}\\}`, "g");
    if (!tokenPattern.test(out)) continue;
    out = out.replace(tokenPattern, `{{${rule.to}}}`);
    rewrites.push(`{{${rule.from}}} -> {{${rule.to}}}`);

    const suffixPattern = new RegExp(`(\\{\\{${rule.to}\\}\\})\\s*${UNIT_SUFFIX}`, "gi");
    if (suffixPattern.test(out)) {
      out = out.replace(suffixPattern, "$1");
      rewrites.push(
        `dropped the literal metre unit written after {{${rule.to}}} -- the value already carries it ("4.8 m")`
      );
    }
  }
  return { body: out, rewrites };
}

/** Deleted outright with no body migration -- no catalog category maps to
 * any of them. `option.` and `software.` are prefixes (17 and 6 keys today,
 * respectively); the two equipment orphans are named explicitly since most
 * `equipment.*` keys ARE migration sources (see MIGRATIONS above), not
 * delete-outright. */
const DELETE_PREFIXES = ["option.", "software."] as const;
const DELETE_EXACT_KEYS = ["equipment.fabric-master", "equipment.spreading-table"] as const;

/** Never touched by this script -- a separate plan migrates these. */
const UNTOUCHED_PREFIXES = ["terms.", "conditions.", "rsp."] as const;

/** Interactive-transaction bounds for the one `$transaction` in `apply`.
 * Nothing in this codebase configures a client-wide `transactionOptions`
 * (src/lib/db.ts constructs `new PrismaClient({ adapter })` and nothing
 * else), so Prisma's 5s default would apply unless overridden here. ~30
 * statements over a local database finish in well under a second, but these
 * match the sibling one-shot script (scripts/migrate-catalog-v2.ts:272) so
 * a slow or contended local database cannot abort a half-run migration on a
 * timer -- the whole point of wrapping it. */
const TRANSACTION_OPTIONS = { maxWait: 30_000, timeout: 300_000 } as const;

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
 * multi-paragraph bodies. Never the record of a body -- see `writeBackup`. */
function preview(body: string, max = 80): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

type Db = PrismaClient;
/** Accepts both the bare client (reads, outside any transaction) and the
 * `tx` handed to a `db.$transaction(async (tx) => ...)` callback (`apply`). */
type Tx = Prisma.TransactionClient | PrismaClient;

type SeriesWritePlan =
  | {
      status: "write";
      seriesCode: string;
      seriesId: string;
      /** True when this series ALREADY holds exactly this body (`.trim()`-
       * equal) -- an earlier, interrupted run wrote it. Counts as resolved
       * (so a multi-target key can finish), and `apply` issues no statement
       * for it. */
      alreadyMatches: boolean;
      /** Tokens in the body that THIS target category has no data for --
       * see the header. Empty is the only good value. */
      outOfScopeTokens: string[];
    }
  | { status: "skip-nonempty"; seriesCode: string; existingLength: number }
  | { status: "missing-series"; seriesCode: string };

type KeyPlan = {
  blockKey: string;
  targetSeriesCodes: readonly string[];
  /** null when the default (regionId: null) block for this key no longer
   * exists -- i.e. an earlier run already migrated and deleted it.
   *
   * `body` is the row exactly as stored; `bodyToWrite` is that body through
   * `rewriteTokens` and then `sanitizeIfHtml`, and is what actually lands on
   * the series -- see the header's notes on the rewrites and the sanitizer.
   * The two are equal for every body with no renamed token that the allowlist
   * already accepts; they are kept apart so the report and the backup describe
   * the SOURCE row while the write and the already-written comparison both use
   * the value that ends up in the column. `rewrites` is one line per rewrite
   * actually applied, for the report -- empty for a body nothing was renamed
   * in, which is every key but `equipment.easy-loader`. `bodyRewritten` sits
   * between the two -- the body after the rewrites but before the sanitizer --
   * purely so the [SANITIZED] line reports what the ALLOWLIST changed rather
   * than blaming it for a rewrite the line above already announced. */
  defaultBlock: {
    id: string;
    body: string;
    bodyRewritten: string;
    bodyToWrite: string;
    rewrites: string[];
  } | null;
  overrides: Array<{ id: string; regionCode: string; body: string }>;
  writes: SeriesWritePlan[];
  /** True only when every target series for this key holds this body -- either
   * because this run will write it, or because an earlier run already did
   * (status "write", with or without `alreadyMatches`). Then there is nothing
   * left for a human or a future run to do, so this key's ContentBlock row(s)
   * may be deleted. False when at least one target resolved to
   * "skip-nonempty" (destination holds DIFFERENT copy) or "missing-series"
   * (series code not found): either way at least one destination never got
   * this body, so the source row must survive so the body isn't lost from
   * both places at once. */
  fullyResolved: boolean;
};

type DeleteRow = { id: string; key: string; regionCode: string | null; bodyLength: number; preview: string };

/** One ContentBlock row, every column, verbatim -- what goes in the backup
 * file. `disposition` says what this run intends to do with it. */
type BackupBlock = {
  id: string;
  key: string;
  regionId: string | null;
  regionCode: string | null;
  title: string | null;
  body: string;
  sortOrder: number;
  disposition: "delete-with-migrated-key" | "delete-outright" | "kept-pending-human-review";
};

type SeriesBefore = { code: string; id: string | null; found: boolean; quoteDescription: string | null };

async function computePlan(db: Db) {
  const allBlocks = await db.contentBlock.findMany({ include: { region: true } });

  // One lookup per distinct target series code, reused by both the write
  // classification and the token check below (which needs the category's
  // products to know which tokens it can fill).
  const targetCodes = [...new Set(MIGRATIONS.flatMap((m) => m.targetSeriesCodes))];
  const seriesByCode = new Map<
    string,
    { id: string; quoteDescription: string | null; products: Array<{ specs: unknown; kind: string }> }
  >();
  for (const code of targetCodes) {
    const series = await db.series.findUnique({
      where: { code },
      include: { products: { select: { specs: true, kind: true } } },
    });
    if (series) {
      seriesByCode.set(code, {
        id: series.id,
        quoteDescription: series.quoteDescription,
        products: series.products,
      });
    }
  }

  /** Recorded in the backup before anything is written, so the pre-migration
   * value of every destination is on disk even for the destinations this run
   * overwrites nothing in. */
  const seriesBefore: SeriesBefore[] = targetCodes.map((code) => {
    const series = seriesByCode.get(code);
    return {
      code,
      id: series?.id ?? null,
      found: series !== undefined,
      quoteDescription: series?.quoteDescription ?? null,
    };
  });

  const keyPlans: KeyPlan[] = [];
  for (const migration of MIGRATIONS) {
    const rowsForKey = allBlocks.filter((b) => b.key === migration.blockKey);
    const defaultRow = rowsForKey.find((b) => b.regionId === null) ?? null;
    const overrideRows = rowsForKey.filter((b) => b.regionId !== null);

    const writes: SeriesWritePlan[] = [];
    let fullyResolved = true;
    // Every editor save goes through `sanitizeIfHtml`
    // (updateSeriesQuoteDescription), so a body written raw by this script
    // would be the one Series.quoteDescription in the database that had never
    // met the allowlist -- a different shape from every other row in the same
    // column, and one whose first re-save through the editor would silently
    // change it. Both paths now store the same thing.
    // Rewrite renamed tokens BEFORE both the sanitizer and the out-of-scope
    // check: the check must be asked of the body that actually lands on the
    // series, or `equipment.easy-loader` would warn about a `{{lengthM}}` this
    // run has already replaced.
    const rewritten = rewriteTokens(migration.blockKey, defaultRow?.body ?? "");
    const bodyToWrite = defaultRow ? sanitizeIfHtml(rewritten.body) : "";
    if (defaultRow) {
      for (const seriesCode of migration.targetSeriesCodes) {
        const series = seriesByCode.get(seriesCode);
        if (!series) {
          writes.push({ status: "missing-series", seriesCode });
          fullyResolved = false;
          continue;
        }
        const existing = series.quoteDescription?.trim() ?? "";
        // Compared against the SANITIZED body, since that is what an earlier
        // run of this script would have written.
        if (existing !== "" && existing !== bodyToWrite.trim()) {
          writes.push({
            status: "skip-nonempty",
            seriesCode,
            existingLength: series.quoteDescription?.length ?? 0,
          });
          // A destination holding DIFFERENT copy means this key is NOT fully
          // migrated: that body still needs to live somewhere, so the source
          // ContentBlock row(s) must not be deleted below (see `apply`'s
          // `fullyResolved` check). This is the fix for the data-loss path
          // where a hand-authored Series.quoteDescription caused the write to
          // be (correctly) skipped but the source row was deleted anyway.
          fullyResolved = false;
          continue;
        }
        // Empty, or already holding exactly this body. The second case is an
        // earlier run that got interrupted partway through a multi-target key
        // (machine.m-series writes M then X): treating it as a skip would set
        // `fullyResolved = false` and strand X forever, since the source row
        // is kept but M keeps re-classifying as "already has copy". It is a
        // write that has already happened, so it resolves.
        writes.push({
          status: "write",
          seriesCode,
          seriesId: series.id,
          alreadyMatches: existing !== "",
          outOfScopeTokens: findUnknownTokens(
            bodyToWrite,
            categoryTokensFor(categorySpecPresence(series.products))
          ),
        });
      }
    }
    // No default row: either already migrated by an earlier run (nothing
    // left to write), or never existed -- either way there is nothing for
    // this run to write, and `fullyResolved` stays true so any leftover
    // override row for the key is still cleaned up below.

    keyPlans.push({
      blockKey: migration.blockKey,
      targetSeriesCodes: migration.targetSeriesCodes,
      defaultBlock: defaultRow
        ? {
            id: defaultRow.id,
            body: defaultRow.body,
            bodyRewritten: rewritten.body,
            bodyToWrite,
            rewrites: rewritten.rewrites,
          }
        : null,
      overrides: overrideRows.map((o) => ({ id: o.id, regionCode: o.region?.code ?? "?", body: o.body })),
      writes,
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

  // Every row this run touches, in full. A superset of "about to be deleted":
  // the rows a not-fully-resolved key keeps are recorded too, labelled as
  // kept, since a human reconciling one by hand wants it in the same file.
  const dispositionById = new Map<string, BackupBlock["disposition"]>();
  for (const key of keyPlans) {
    const disposition = key.fullyResolved ? "delete-with-migrated-key" : "kept-pending-human-review";
    if (key.defaultBlock) dispositionById.set(key.defaultBlock.id, disposition);
    for (const o of key.overrides) dispositionById.set(o.id, disposition);
  }
  const backupBlocks: BackupBlock[] = allBlocks
    .filter((b) => dispositionById.has(b.id) || isDeleteOutrightKey(b.key))
    .map((b) => ({
      id: b.id,
      key: b.key,
      regionId: b.regionId,
      regionCode: b.region?.code ?? null,
      title: b.title,
      body: b.body,
      sortOrder: b.sortOrder,
      disposition: dispositionById.get(b.id) ?? "delete-outright",
    }));

  return { keyPlans, deleteRows, unrecognized, seriesBefore, backupBlocks };
}

type Plan = Awaited<ReturnType<typeof computePlan>>;

/** ISO 8601 basic format (`20260907T131415Z`) -- the same instant
 * `toISOString()` gives, without the `:` and `.` that make a filename
 * awkward to type, quote and copy between machines. */
function timestampForFilename(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Serialises every ContentBlock row this run touches (all columns, full
 * body, region overrides included) and the current `Series.quoteDescription`
 * of every target series to the repo root, and returns the absolute path.
 *
 * Called before the first write or delete: once `apply` runs, the only other
 * trace of a deleted body is an 80-character preview in terminal scrollback,
 * which is not a record of copy that is legal-adjacent and was, in places,
 * hand-authored. Throws on any failure -- the caller aborts the run rather
 * than deleting anything it has not first written down. `wx` so a backup
 * from an earlier run in the same second is never clobbered. */
function writeBackup(plan: Plan, now = new Date()): string {
  const file = path.resolve(__dirname, "..", `migration-backup-${timestampForFilename(now)}.json`);
  const payload = {
    generatedAt: now.toISOString(),
    script: "scripts/migrate-content-blocks-to-series.ts",
    what: "Pre-migration snapshot, written before the first write or delete of an --apply run.",
    seriesQuoteDescriptionBefore: plan.seriesBefore,
    contentBlocks: plan.backupBlocks,
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return file;
}

function printPlan(plan: Plan): { hadUnexpectedIssue: boolean; skipsNonempty: number } {
  let hadUnexpectedIssue = false;

  console.log("=== Category copy migration: machine.*/equipment.* -> Series.quoteDescription ===\n");
  for (const key of plan.keyPlans) {
    console.log(`${key.blockKey}:`);
    if (!key.defaultBlock) {
      console.log("  no default (regionId: null) ContentBlock row -- already migrated, nothing to write");
    } else {
      console.log(`  source body: ${key.defaultBlock.body.length} chars, "${preview(key.defaultBlock.body)}"`);
      // Printed before [SANITIZED] because it happens before it, and printed
      // at all because a body silently differing from its source row is
      // exactly what someone reading a dry run needs to be told about.
      for (const rewrite of key.defaultBlock.rewrites) {
        console.log(`  [REWRITE] ${key.blockKey}: ${rewrite}`);
      }
      if (key.defaultBlock.bodyToWrite !== key.defaultBlock.bodyRewritten) {
        // Not an issue -- the sanitizer is the same one every editor save
        // applies -- but the run should say out loud that what lands on the
        // series is not byte-for-byte the source row, and what it will be.
        console.log(
          `  [SANITIZED] the allowlist changed this body (${key.defaultBlock.bodyRewritten.length} -> ${key.defaultBlock.bodyToWrite.length} chars): "${preview(key.defaultBlock.bodyToWrite)}"`
        );
      }
      for (const w of key.writes) {
        if (w.status === "write") {
          if (w.alreadyMatches) {
            console.log(
              `  [DONE]   Series ${w.seriesCode}.quoteDescription already holds exactly this body -- an earlier run wrote it, nothing to do`
            );
          } else {
            console.log(`  [WRITE]  Series ${w.seriesCode}.quoteDescription <- this body`);
          }
          if (w.outOfScopeTokens.length > 0) {
            console.log(
              `  [WARN]   Series ${w.seriesCode} has no data for ${w.outOfScopeTokens.map((t) => `{{${t}}}`).join(", ")} -- no product in that category carries the figure. The line using it is stripped from every quote, and the category cannot be re-saved from the editor until a human removes the token (updateSeriesQuoteDescription rejects it)`
            );
            hadUnexpectedIssue = true;
          }
        } else if (w.status === "skip-nonempty") {
          console.log(
            `  [SKIP]   Series ${w.seriesCode} already has a non-empty quoteDescription (${w.existingLength} chars) that differs from this body -- refusing to overwrite`
          );
          console.log(
            `  [KEEP]   ContentBlock "${key.blockKey}" retained -- ${w.seriesCode} already has different copy`
          );
        } else {
          console.log(`  [ERROR]  Series code "${w.seriesCode}" not found in the catalog -- cannot migrate ${key.blockKey}`);
          hadUnexpectedIssue = true;
        }
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
          `  [KEEP]   ${rowCount} ContentBlock row(s) for key "${key.blockKey}" left in place -- not every target series holds this body (see [SKIP]/[ERROR] above)`
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

  const allWrites = plan.keyPlans.flatMap((k) => k.writes);
  const writesPlanned = allWrites.filter((w) => w.status === "write" && !w.alreadyMatches).length;
  const alreadyWritten = allWrites.filter((w) => w.status === "write" && w.alreadyMatches).length;
  const skipsNonempty = allWrites.filter((w) => w.status === "skip-nonempty").length;
  const missingSeries = allWrites.filter((w) => w.status === "missing-series").length;
  const outOfScope = allWrites.filter((w) => w.status === "write" && w.outOfScopeTokens.length > 0).length;
  const overridesDiscarded = plan.keyPlans.reduce((n, k) => n + k.overrides.length, 0);
  const keyBlocksDeleted = plan.keyPlans.filter((k) => k.fullyResolved && (k.defaultBlock || k.overrides.length > 0)).reduce((n, k) => n + (k.defaultBlock ? 1 : 0) + k.overrides.length, 0);

  console.log("=== Summary ===");
  console.log(`  Series.quoteDescription writes planned: ${writesPlanned}`);
  console.log(`  already written by an earlier run:      ${alreadyWritten}`);
  console.log(`  skipped (destination has other copy):   ${skipsNonempty}`);
  console.log(`  errors (target series code not found):  ${missingSeries}`);
  console.log(`  bodies with out-of-scope token(s):      ${outOfScope}`);
  console.log(
    `  token rewrites applied:                ${plan.keyPlans.reduce((n, k) => n + (k.defaultBlock?.rewrites.length ?? 0), 0)}`
  );
  console.log(`  region overrides discarded:              ${overridesDiscarded}`);
  console.log(`  ContentBlock rows to delete (3 migrated keys): ${keyBlocksDeleted}`);
  console.log(`  ContentBlock rows to delete (delete-outright): ${plan.deleteRows.length}`);
  console.log(`  unrecognized ContentBlock keys:          ${plan.unrecognized.length}`);
  console.log("");

  return { hadUnexpectedIssue, skipsNonempty };
}

/** Every write and delete of the migration. Runs inside one
 * `db.$transaction`, so an interrupt between two of its statements rolls the
 * whole thing back: a half-applied multi-target key (M written, X not, source
 * row already gone) is the one state from which this migration cannot be
 * finished by re-running it. `tx`, not the bare client, for exactly that
 * reason -- never call this with `db`. */
async function apply(tx: Tx, plan: Plan) {
  for (const key of plan.keyPlans) {
    for (const w of key.writes) {
      if (w.status !== "write" || !key.defaultBlock) continue;
      if (w.alreadyMatches) {
        console.log(`Series ${w.seriesCode}.quoteDescription already holds ${key.blockKey}'s body -- no write needed`);
        continue;
      }
      await tx.series.update({
        where: { id: w.seriesId },
        data: { quoteDescription: key.defaultBlock.bodyToWrite },
      });
      console.log(`wrote Series ${w.seriesCode}.quoteDescription from ${key.blockKey}`);
    }
    if (key.fullyResolved) {
      const idsToDelete = [...(key.defaultBlock ? [key.defaultBlock.id] : []), ...key.overrides.map((o) => o.id)];
      if (idsToDelete.length > 0) {
        await tx.contentBlock.deleteMany({ where: { id: { in: idsToDelete } } });
        console.log(`deleted ${idsToDelete.length} ContentBlock row(s) for key ${key.blockKey}`);
      }
    }
  }

  if (plan.deleteRows.length > 0) {
    await tx.contentBlock.deleteMany({ where: { id: { in: plan.deleteRows.map((r) => r.id) } } });
    console.log(`deleted ${plan.deleteRows.length} ContentBlock row(s) (option.*/software.*/equipment orphans)`);
  }
}

/** Exit-code policy for a run whose only unresolved items are non-empty-
 * destination skips (no missing series, no unrecognized keys, no out-of-scope
 * tokens): that is a human decision waiting to happen, not a clean run
 * (status 0) and not a malfunction (status 1, reserved for
 * `hadUnexpectedIssue`) -- so it gets its own status, 2, visible to a script
 * or CI checking `$?` without being mistaken for a crash. No-op (and does not
 * touch `process.exitCode`) once `hadUnexpectedIssue` is true, since status 1
 * already covers that run. */
function reportPendingSkips(hadUnexpectedIssue: boolean, skipsNonempty: number): void {
  if (hadUnexpectedIssue || skipsNonempty === 0) return;
  console.log(
    `note: ${skipsNonempty} write(s) skipped because the destination already has different copy -- exiting with status 2 (a human decision is pending; this is not a failure).`
  );
  process.exitCode = 2;
}

async function main() {
  const isApply = process.argv.includes("--apply");

  const { db } = await import("../src/lib/db");

  const plan = await computePlan(db);
  const { hadUnexpectedIssue, skipsNonempty } = printPlan(plan);

  // `plan.unrecognized` belongs in this condition: without it a run whose
  // only finding is an unrecognized key prints that warning and then claims
  // "the database already reflects the target state", which is precisely the
  // claim an unrecognized key disproves.
  const nothingToDo =
    plan.keyPlans.every((k) => !k.defaultBlock && k.overrides.length === 0) &&
    plan.deleteRows.length === 0 &&
    plan.unrecognized.length === 0;
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
    reportPendingSkips(hadUnexpectedIssue, skipsNonempty);
    return;
  }

  // Before the first write or delete: get every doomed body onto disk, and
  // abort untouched if that fails.
  let backupPath: string;
  try {
    backupPath = writeBackup(plan);
  } catch (e) {
    console.error("FAILED to write the pre-migration backup -- aborting. NOTHING was written or deleted.");
    console.error(e);
    process.exitCode = 1;
    return;
  }
  const rule = "=".repeat(78);
  console.log(rule);
  console.log("BACKUP WRITTEN -- before any write or delete:");
  console.log(`  ${backupPath}`);
  console.log(
    `  ${plan.backupBlocks.length} ContentBlock row(s), every column and the full body, region overrides included`
  );
  console.log(`  ${plan.seriesBefore.length} Series.quoteDescription value(s) as they stand right now`);
  console.log("  This is the only copy of every body deleted below. Keep it until the migration is confirmed good.");
  console.log(rule);
  console.log("");

  // One transaction for every write and delete: an interrupt rolls back to
  // the state the backup above describes, rather than leaving a multi-target
  // key half-written with its source row already gone.
  await db.$transaction((tx) => apply(tx, plan), TRANSACTION_OPTIONS);

  // Prove idempotence right away: a second plan over the migrated rows
  // should find nothing left to migrate or delete for any key that was
  // fully resolved above. A key that was NOT fully resolved (a skipped
  // non-empty destination, or a missing series code) is expected to still
  // show up -- its ContentBlock row(s) were deliberately kept -- so only an
  // UNEXPECTED leftover (a key that fullyResolved said was clear, but still
  // has rows; or any delete-outright row still present) counts as a
  // regression worth warning about.
  const after = await computePlan(db);
  const expectedRemainingKeys = new Set(plan.keyPlans.filter((k) => !k.fullyResolved).map((k) => k.blockKey));
  const unexpectedLeftoverKeys = after.keyPlans.filter(
    (k) => (k.defaultBlock !== null || k.overrides.length > 0) && !expectedRemainingKeys.has(k.blockKey)
  );
  const hasUnexpectedLeftover = unexpectedLeftoverKeys.length > 0 || after.deleteRows.length > 0;

  if (hasUnexpectedLeftover) {
    console.warn("warning: a second plan finds unexpected leftover rows after applying -- re-run with no flags to see what remains");
    process.exitCode = 1;
  } else if (expectedRemainingKeys.size > 0) {
    console.log(
      `verified: a second plan finds nothing unexpected -- ${expectedRemainingKeys.size} key(s) intentionally left in place pending human review: ${[...expectedRemainingKeys].join(", ")}`
    );
  } else {
    console.log("verified: a second plan finds nothing left to do");
  }

  if (hadUnexpectedIssue || hasUnexpectedLeftover) process.exitCode = 1;
  else reportPendingSkips(hadUnexpectedIssue, skipsNonempty);
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
