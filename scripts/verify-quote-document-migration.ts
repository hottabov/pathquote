import "dotenv/config";

/**
 * The gate on `npm run db:migrate` for z37_drop_content_block.
 *
 * That migration runs `DROP TABLE "ContentBlock"` and drops both
 * `contentBlockKey` columns. It is not reversible without a restore, and what
 * it destroys is category copy and the text a customer signs. So before it
 * runs, two things must both be true, and this script is the only way to see
 * them: `npx prisma db execute` runs a statement but prints no rows, so a
 * SELECT through it looks like it succeeded while telling you nothing.
 *
 *   1. The category-copy migration has run  -- `Series.quoteDescription` holds
 *      copy for M/X/EL/FP, and no `machine.*`/`equipment.*`/`option.*`/
 *      `software.*` block is left.
 *   2. The legal-document migration has run -- `QuoteDocument` holds Terms,
 *      General Conditions of Sale and the RSP agreement, and no `terms.*`/
 *      `conditions.*`/`rsp.*` block is left.
 *
 *   npx tsx scripts/verify-quote-document-migration.ts
 *
 * Read-only. Exits 0 when dropping ContentBlock is safe, 1 when it is not,
 * 2 when the answer is mixed and a human should look.
 *
 * `ContentBlock` is read with raw SQL rather than through `db.contentBlock`,
 * because by the time this script matters `prisma/schema.prisma` has already
 * stopped declaring the model -- the whole point is to inspect a table the
 * code has let go of but the database still has. A missing table is not an
 * error here: it means the drop has already happened, and the script says so.
 */

/** Postgres's "relation does not exist" -- i.e. z37 has already been applied. */
const UNDEFINED_TABLE = "42P01";

type BlockRow = { key: string };

/** Every `ContentBlock.key` still in the database, or `null` when the table is
 * gone. Anything else (a connection failure, a permissions problem) is a real
 * error and is rethrown rather than being read as "no rows left". */
async function contentBlockKeys(db: { $queryRawUnsafe: (sql: string) => Promise<unknown> }): Promise<string[] | null> {
  try {
    const rows = (await db.$queryRawUnsafe('SELECT "key" FROM "ContentBlock" ORDER BY "key" ASC')) as BlockRow[];
    return rows.map((r) => r.key);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === UNDEFINED_TABLE) return null;
    throw error;
  }
}

/** The three documents Task 10's migration assembles, and what the seed
 * (prisma/seed-data/quote-documents.json) puts on a fresh database. A region
 * version of any of them is a bonus, not a requirement. */
const EXPECTED_DOCUMENT_KEYS = ["terms", "conditions", "rsp"];

/** The four categories scripts/migrate-content-blocks-to-series.ts wrote. */
const MIGRATED_SERIES_CODES = ["M", "X", "EL", "FP"];

/** Block-key prefixes each migration consumed, for splitting whatever is left
 * into "category migration has not run" and "document migration has not run". */
const CATEGORY_PREFIXES = ["machine.", "equipment.", "software.", "option."];
const LEGAL_PREFIXES = ["terms.", "conditions.", "rsp."];

async function main() {
  const { db } = await import("../src/lib/db");

  const series = await db.series.findMany({
    select: { code: true, name: true, quoteDescription: true },
    orderBy: { code: "asc" },
  });

  const documents = await db.quoteDocument.findMany({
    select: { key: true, title: true, body: true, sortOrder: true, region: { select: { code: true } } },
    orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
  });

  const blocks = await contentBlockKeys(db);
  const alreadyDropped = blocks === null;
  const remaining = blocks ?? [];

  // --- 1. category copy ---------------------------------------------------

  const withCopy = series.filter((s) => (s.quoteDescription ?? "").trim() !== "").map((s) => s.code);
  const categoriesDone = MIGRATED_SERIES_CODES.filter((code) => withCopy.includes(code));
  const categoryBlocksLeft = remaining.filter((k) => CATEGORY_PREFIXES.some((p) => k.startsWith(p)));

  console.log("Series.quoteDescription");
  for (const s of series) {
    const has = (s.quoteDescription ?? "").trim() !== "";
    const expected = MIGRATED_SERIES_CODES.includes(s.code);
    const mark = has ? "yes" : expected ? "NO  <- expected copy here" : "no";
    console.log(`  ${s.code.padEnd(5)} ${mark.padEnd(26)} ${s.name}`);
  }

  // --- 2. legal documents -------------------------------------------------

  const defaults = documents.filter((d) => d.region === null);
  const documentKeys = defaults.map((d) => d.key);
  const missingDocuments = EXPECTED_DOCUMENT_KEYS.filter((key) => !documentKeys.includes(key));
  // A document that exists but is empty would print a heading and no terms --
  // worse than no document, and not something to drop the source rows over.
  const emptyDocuments = documents.filter((d) => d.body.trim() === "").map((d) => label(d));
  const legalBlocksLeft = remaining.filter((k) => LEGAL_PREFIXES.some((p) => k.startsWith(p)));

  console.log("");
  console.log(`QuoteDocument rows: ${documents.length}`);
  if (documents.length === 0) {
    console.log("  none -- a quote would print no legal text at all");
  }
  for (const d of documents) {
    console.log(`  ${label(d).padEnd(28)} sortOrder ${String(d.sortOrder).padStart(3)}  ${String(d.body.length).padStart(6)} chars  "${d.title}"`);
  }
  if (missingDocuments.length > 0) {
    console.log(`  MISSING default document(s): ${missingDocuments.join(", ")}`);
  }
  if (emptyDocuments.length > 0) {
    console.log(`  EMPTY body: ${emptyDocuments.join(", ")}`);
  }

  // --- 3. what is left in ContentBlock ------------------------------------

  console.log("");
  if (alreadyDropped) {
    console.log('ContentBlock: the table does not exist -- z37_drop_content_block has already been applied.');
  } else {
    const other = remaining.filter(
      (k) => ![...CATEGORY_PREFIXES, ...LEGAL_PREFIXES].some((p) => k.startsWith(p))
    );
    console.log(`ContentBlock rows: ${remaining.length}`);
    console.log(`  category/option rows the category migration deletes:  ${categoryBlocksLeft.length}`);
    if (categoryBlocksLeft.length > 0) console.log(`    still present: ${categoryBlocksLeft.join(", ")}`);
    console.log(`  legal rows the quote-document migration consumes:     ${legalBlocksLeft.length}`);
    if (legalBlocksLeft.length > 0) console.log(`    still present: ${legalBlocksLeft.join(", ")}`);
    if (other.length > 0) {
      console.log(`  keys neither migration recognises:                    ${other.length}`);
      console.log(`    ${other.join(", ")}`);
    }
  }

  // --- verdict ------------------------------------------------------------

  const categoryOk = categoriesDone.length === MIGRATED_SERIES_CODES.length && categoryBlocksLeft.length === 0;
  const documentsOk = missingDocuments.length === 0 && emptyDocuments.length === 0 && legalBlocksLeft.length === 0;
  const nothingLeft = alreadyDropped || remaining.length === 0;

  console.log("");
  if (categoryOk && documentsOk && nothingLeft) {
    console.log("VERDICT: both migrations HAVE run and ContentBlock is empty.");
    console.log(alreadyDropped ? "  Nothing left to drop -- z37 is applied." : "  Dropping ContentBlock (npm run db:migrate, z37) is safe.");
    await db.$disconnect();
    return;
  }

  const failures: string[] = [];
  if (!categoryOk) {
    failures.push(
      `category copy: ${categoriesDone.length}/${MIGRATED_SERIES_CODES.length} categories written` +
        (categoryBlocksLeft.length > 0 ? `, ${categoryBlocksLeft.length} block row(s) still to delete` : "")
    );
  }
  if (!documentsOk) {
    failures.push(
      `legal documents: ${defaults.length} default document(s)` +
        (missingDocuments.length > 0 ? `, missing ${missingDocuments.join("/")}` : "") +
        (emptyDocuments.length > 0 ? `, empty ${emptyDocuments.join("/")}` : "") +
        (legalBlocksLeft.length > 0 ? `, ${legalBlocksLeft.length} block row(s) still to consume` : "")
    );
  }
  if (categoryOk && documentsOk && !nothingLeft) {
    failures.push(`${remaining.length} ContentBlock row(s) left that neither migration claims`);
  }

  console.log("VERDICT: DO NOT drop ContentBlock yet.");
  for (const failure of failures) console.log(`  - ${failure}`);
  console.log("");
  console.log("Both one-shot migration scripts were deleted with the model they read");
  console.log("(git show eb77f76:scripts/migrate-content-blocks-to-series.ts, and");
  console.log("scripts/migrate-content-blocks-to-quote-documents.ts alongside it).");
  console.log("Recover the one you need from git before applying z37, and restore");
  console.log("prisma/schema.prisma's `model ContentBlock` so it can run.");

  // 1 when a migration has plainly not run at all; 2 when it is part-done and
  // the state needs a human eye rather than a re-run.
  const plainlyNotRun =
    (categoriesDone.length === 0 && categoryBlocksLeft.length > 0) ||
    (defaults.length === 0 && legalBlocksLeft.length > 0);
  process.exitCode = plainlyNotRun ? 1 : 2;
  await db.$disconnect();
}

function label(d: { key: string; region: { code: string } | null }): string {
  return d.region === null ? `${d.key} (default)` : `${d.key} (${d.region.code})`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
