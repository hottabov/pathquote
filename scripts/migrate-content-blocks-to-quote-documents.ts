import "dotenv/config";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { DOCUMENT_TOKENS, findUnknownTokens } from "../src/lib/quote-variables";
import {
  assembleConditionsBody,
  assembleSingleBlockBody,
  assembleTermsBody,
  buildConditionsBody,
  buildSingleBlockBody,
  buildTermsBody,
  countStructure,
  orderBlocks,
  type LegalBlock,
} from "./lib/quote-document-bodies";

/**
 * One-shot data migration for Task 10 of
 * docs/superpowers/plans/2026-09-07-quote-documents.md: assembles the legal
 * text a customer signs out of the `ContentBlock` fragments it has been stored
 * as -- 7 `terms.*` rows, 14 `conditions.*` rows and `rsp.agreement` -- into
 * three whole `QuoteDocument` rows, then deletes the rows it consumed.
 *
 *   npx tsx scripts/migrate-content-blocks-to-quote-documents.ts          # dry run, writes nothing
 *   npx tsx scripts/migrate-content-blocks-to-quote-documents.ts --apply  # applies the plan above
 *
 * Cannot be run from the agent sandbox that wrote this file -- the development
 * database only listens on Vadym's machine (see the plan's "Environment
 * constraint") -- and unlike everything else in this plan its output is the
 * text of a contract. It follows the shape
 * `scripts/migrate-content-blocks-to-series.ts` was hardened into, which is the
 * house pattern for a one-shot migration now:
 *
 *  - dry run by default; only --apply writes or deletes anything
 *  - the FULL plan is computed and printed before a single row is touched, and
 *    the print is deliberately long: each assembled document's length, its
 *    clause/section count, an outline of its headings or clause titles, and the
 *    WHOLE body, indented by structure. An 80-character preview is no way to
 *    catch a mangled `<ol>` in text a customer signs, and this dry run is the
 *    only review this migration will ever get
 *  - --apply writes a JSON backup to `migration-backup-<ISO8601>.json` in the
 *    repo root BEFORE the first write or delete: every ContentBlock row this
 *    run touches (all columns, full body, region overrides included), every
 *    QuoteDocument row that already exists for these keys, and every body this
 *    run intends to write. If the backup cannot be written the run aborts
 *    without touching the database. The filename pattern is gitignored -- this
 *    prose does not belong in git
 *  - every write and delete of an --apply run happens inside ONE
 *    `db.$transaction`: an interrupt rolls back rather than leaving the
 *    fragments deleted and the documents half-written, which is the one state
 *    this migration cannot be finished by re-running it from
 *  - idempotent. A second run finds the QuoteDocument rows already there with
 *    exactly these bodies, reports each as [DONE], and writes nothing. A row
 *    that exists with a DIFFERENT body is never overwritten: it is reported as
 *    a [SKIP], its source ContentBlock rows are kept, and the run exits 2
 *  - a group's source rows are deleted only when EVERY document of that group
 *    (the default and each region version) is resolved. If one region version
 *    was skipped, that region's overrides -- and the defaults its document is
 *    partly assembled from -- all stay, so the text still exists somewhere
 *  - each assembled body is finished with `sanitizeIfHtml`, the same
 *    write-boundary sanitizer `updateQuoteDocument` applies to every editor
 *    save, and the report says so whenever the allowlist actually changed
 *    something (`# heading` markdown renders `<h1>`, which is not on the
 *    allowlist -- the tag goes, the words stay)
 *  - each assembled body is validated against `DOCUMENT_TOKENS`, the exact
 *    list `updateQuoteDocument` validates a save against. An out-of-scope
 *    token is a [WARN] that fails the run (status 1). Today that is exactly
 *    one: `{{rspYear2Cost}}` in `terms.rsp`, which has no source in code and
 *    never had one -- its line has been silently stripped from every quote
 *    ever sent. It is deliberately NOT stripped or rewritten here: an admin
 *    must decide what that clause should say, and the [WARN] is how they find
 *    out it needs deciding
 *  - a ContentBlock key this script does not recognise is reported, left
 *    completely untouched, and makes the run exit non-zero -- far more likely
 *    a sign this script has drifted from a database that changed underneath it
 *    than something safe to ignore. Every `machine.*`/`equipment.*`/`option.*`/
 *    `software.*` key is Plan 2's migration's business, not this one's, and
 *    should already be gone by the time this runs
 *
 * Mapping (the plan's table):
 *
 *   terms.* x 7, in sortOrder       -> QuoteDocument key "terms", "Terms", sortOrder 10
 *   conditions.1..14, in sortOrder  -> key "conditions", "General Conditions of Sale", 20
 *   rsp.agreement                   -> key "rsp", "Remote Support Program", 30
 *   rsp.coverage-note               -> deleted; nothing ever fetched or rendered it
 *                                      (D10 removed the coverage table with it)
 *
 * How the bodies are assembled is `scripts/lib/quote-document-bodies.ts`, which
 * is pure and unit-tested (`tests/quote-document-bodies.test.ts`) precisely
 * because this file cannot be run in CI. In short: Terms is an `<h2>` of each
 * block's title followed by its body; General Conditions is one `<ol>` whose
 * `<li>`s are the clauses, each opening with its title in `<strong>` (the old
 * renderer numbered them by array position -- the numbering is the list's own
 * now); RSP is its one body alone. Every body goes through
 * `renderStoredRichText` first, the same function the renderer already applied
 * to these rows, so a migrated document prints what customers have been
 * receiving.
 *
 * Region versions: for each region holding an override of ANY block in a
 * group, this assembles that region's WHOLE document -- its own row where it
 * has one, the default elsewhere -- and writes it with that `regionId`. It is
 * the one place the migration creates something that never existed as a unit,
 * so every region document's report lists, block by block, which came from the
 * override and which from the default.
 *
 * Exit codes -- the full contract:
 *
 *   0  Clean. Every document exists with exactly the assembled body, every
 *      consumed ContentBlock row is gone, and nothing unexpected was reported.
 *   1  Unexpected -- a human must look. Any one of: an assembled body carrying
 *      a token no document can fill (`{{rspYear2Cost}}` today); a ContentBlock
 *      key this script does not recognise; a group with region overrides but
 *      no default rows to assemble around; the backup file could not be
 *      written (in which case NOTHING was written or deleted); unexpected
 *      leftover rows after applying; or an uncaught error.
 *   2  Skip-only. The run's ONLY unresolved items are QuoteDocument rows that
 *      already exist with a DIFFERENT body, which this script refuses to
 *      overwrite. A human decision is pending; that is neither a clean run nor
 *      a malfunction, so it gets its own status.
 *
 *   1 outranks 2. The dry run reports the same status the corresponding
 *   --apply would, so `$?` means the same thing either way.
 */

/** One document to assemble: which ContentBlock keys feed it, and how they are
 * put together. `single` is the RSP agreement -- one block key, whose body
 * becomes the document body with no heading of its own, because
 * `DocumentsSection` prints `QuoteDocument.title` in exactly the place
 * `RspSection` printed its hardcoded one. */
type GroupSpec = {
  documentKey: string;
  title: string;
  sortOrder: number;
  shape: "terms" | "conditions" | "single";
  /** True for the ContentBlock keys that feed this document. A predicate
   * rather than a hardcoded list of all 22 keys, so this script acts on
   * whatever the live database has under these prefixes rather than on what
   * content-blocks.json happened to list when it was written -- with
   * `rsp.coverage-note` excluded by name, since `rsp.` covers both it and the
   * agreement. */
  owns: (blockKey: string) => boolean;
};

const GROUPS: readonly GroupSpec[] = [
  {
    documentKey: "terms",
    title: "Terms",
    sortOrder: 10,
    shape: "terms",
    owns: (key) => key.startsWith("terms."),
  },
  {
    documentKey: "conditions",
    title: "General Conditions of Sale",
    sortOrder: 20,
    shape: "conditions",
    owns: (key) => key.startsWith("conditions."),
  },
  {
    documentKey: "rsp",
    title: "Remote Support Program",
    sortOrder: 30,
    shape: "single",
    owns: (key) => key === "rsp.agreement",
  },
];

/** Deleted outright, no migration. `rsp.coverage-note` held the per-machine
 * coverage table: nothing fetched it (the renderer built that table from the
 * quote's own items, not from this block), every price in it read TBA, and
 * D10 removed the table itself in Task 3. Its text is in the backup file. */
const DELETE_EXACT_KEYS = ["rsp.coverage-note"] as const;

/** Every document this migration creates starts included -- the column's own
 * default. RSP is the one an author routinely unticks per quote, which the
 * builder panel (Task 8) is for; that is a per-quote exclusion, not a
 * different default. */
const INCLUDED_BY_DEFAULT = true;

/** Interactive-transaction bounds for the one `$transaction` in `apply`.
 * Nothing in this codebase configures a client-wide `transactionOptions`, so
 * Prisma's 5s default would apply unless overridden here. This migration is
 * ~6 statements, but they match the sibling one-shot scripts
 * (migrate-content-blocks-to-series.ts:209, migrate-catalog-v2.ts:272) so a
 * slow or contended local database cannot abort a half-run migration on a
 * timer -- the whole point of wrapping it. */
const TRANSACTION_OPTIONS = { maxWait: 30_000, timeout: 300_000 } as const;

/** Above this, a body is truncated in the terminal report with a pointer to
 * the backup file. Generous on purpose: General Conditions is ~20k characters
 * and printing all of it is the point of this dry run. */
const MAX_PRINTED_BODY = 80_000;

type Db = PrismaClient;
/** Accepts both the bare client (reads, outside any transaction) and the `tx`
 * handed to a `db.$transaction(async (tx) => ...)` callback (`apply`). */
type Tx = Prisma.TransactionClient | PrismaClient;

/** A ContentBlock row as this script reads it. */
type BlockRow = LegalBlock & { id: string; regionId: string | null; regionCode: string | null };

/** Where each block of an assembled document came from. Only interesting for a
 * region version -- that is the composition nobody has ever seen as a unit --
 * but recorded for the default too so the report reads the same way for both. */
type BlockSource = { blockKey: string; from: "override" | "default"; bodyLength: number };

type DocumentPlan = {
  documentKey: string;
  title: string;
  sortOrder: number;
  regionId: string | null;
  regionCode: string | null;
  /** The blocks this document was assembled from, in printed order. */
  sources: BlockSource[];
  /** Assembled but not yet sanitized, and the sanitized body that actually
   * gets written. Kept apart so the report can say what the ALLOWLIST changed
   * rather than folding it into the assembly. */
  assembled: string;
  body: string;
  /** Tokens in the body that no document can fill -- see the header's note on
   * `{{rspYear2Cost}}`. Empty is the only good value. */
  outOfScopeTokens: string[];
  /** "create": no QuoteDocument row for this (key, regionId) yet.
   *  "already": one exists holding exactly this body -- an earlier run wrote
   *  it, nothing to do, and it counts as resolved so the source rows can go.
   *  "skip-existing": one exists holding something DIFFERENT. Never
   *  overwritten; the source rows stay and the run exits 2. */
  status: "create" | "already" | "skip-existing";
  /** Length of the existing row's body, for the [SKIP] line. */
  existingLength: number | null;
};

type GroupPlan = {
  spec: GroupSpec;
  /** Every ContentBlock row feeding this group, defaults and overrides. */
  rows: BlockRow[];
  documents: DocumentPlan[];
  /** True when every document of this group is resolved (created or already
   * present with this exact body), so the rows above may be deleted. False
   * when any document was skipped: the fragments must outlive a document this
   * script refused to write, or the text exists nowhere. */
  fullyResolved: boolean;
  /** Set when the group has region overrides but no default rows at all --
   * a shape this script will not guess at. Reported, and nothing is written
   * for the group. */
  problem: string | null;
};

type DeleteRow = { id: string; key: string; regionCode: string | null; bodyLength: number };

type BackupBlock = {
  id: string;
  key: string;
  regionId: string | null;
  regionCode: string | null;
  title: string | null;
  body: string;
  sortOrder: number;
  disposition: "consumed-by-document" | "delete-outright" | "kept-pending-human-review";
};

function isRecognisedKey(key: string): boolean {
  return GROUPS.some((g) => g.owns(key)) || (DELETE_EXACT_KEYS as readonly string[]).includes(key);
}

/** Assembles one group's blocks both ways: unsanitized (for the [SANITIZED]
 * report) and sanitized (what is written). `single` takes the first block --
 * the group owns exactly one key, and `(key, regionId)` is unique, so there is
 * never more than one row per document. */
function assemble(spec: GroupSpec, blocks: LegalBlock[]): { assembled: string; body: string } {
  if (spec.shape === "terms") return { assembled: assembleTermsBody(blocks), body: buildTermsBody(blocks) };
  if (spec.shape === "conditions")
    return { assembled: assembleConditionsBody(blocks), body: buildConditionsBody(blocks) };
  const block = blocks[0];
  if (!block) return { assembled: "", body: "" };
  return { assembled: assembleSingleBlockBody(block), body: buildSingleBlockBody(block) };
}

/**
 * One region's version of a group's document: its own row for each block key it
 * overrides, the default row for every key it does not, plus any key it has a
 * row for that has no default at all. The composition, block by block, is
 * returned alongside so the report can show which half each clause came from.
 */
function composeForRegion(
  defaults: BlockRow[],
  overrides: BlockRow[]
): { blocks: BlockRow[]; sources: BlockSource[] } {
  const byKey = new Map<string, { row: BlockRow; from: "override" | "default" }>();
  for (const row of defaults) byKey.set(row.key, { row, from: "default" });
  for (const row of overrides) byKey.set(row.key, { row, from: "override" });
  const ordered = orderBlocks([...byKey.values()].map((v) => v.row));
  return {
    blocks: ordered,
    sources: ordered.map((row) => ({
      blockKey: row.key,
      from: byKey.get(row.key)?.from ?? "default",
      bodyLength: row.body.length,
    })),
  };
}

async function computePlan(db: Db) {
  const allBlocks = await db.contentBlock.findMany({ include: { region: true } });
  const rows: BlockRow[] = allBlocks.map((b) => ({
    id: b.id,
    key: b.key,
    title: b.title,
    body: b.body,
    sortOrder: b.sortOrder,
    regionId: b.regionId,
    regionCode: b.region?.code ?? null,
  }));

  const existingDocuments = await db.quoteDocument.findMany({
    where: { key: { in: GROUPS.map((g) => g.documentKey) } },
    include: { region: true },
  });
  const existingByKey = new Map(existingDocuments.map((d) => [`${d.key}::${d.regionId ?? ""}`, d]));

  const groupPlans: GroupPlan[] = GROUPS.map((spec) => {
    const groupRows = rows.filter((r) => spec.owns(r.key));
    const defaults = orderBlocks(groupRows.filter((r) => r.regionId === null));
    const overrides = groupRows.filter((r) => r.regionId !== null);

    const documents: DocumentPlan[] = [];
    let problem: string | null = null;

    const regionIds = [...new Set(overrides.map((r) => r.regionId as string))];
    if (defaults.length === 0 && regionIds.length > 0) {
      // A region override with nothing to assemble around. Never true for this
      // catalog, and not a shape to guess at: the region document would be
      // whatever fragments that region happens to override and nothing else --
      // a Terms document missing five of its seven sections.
      problem = `${overrides.length} region override row(s) but no default (regionId: null) rows to assemble around`;
    } else if (defaults.length > 0) {
      const { assembled, body } = assemble(spec, defaults);
      documents.push(
        planDocument(spec, null, null, defaults.map((r) => ({ blockKey: r.key, from: "default" as const, bodyLength: r.body.length })), assembled, body, existingByKey)
      );
      for (const regionId of regionIds) {
        const regionRows = overrides.filter((r) => r.regionId === regionId);
        const composed = composeForRegion(defaults, regionRows);
        const regionAssembly = assemble(spec, composed.blocks);
        documents.push(
          planDocument(
            spec,
            regionId,
            regionRows[0]?.regionCode ?? null,
            composed.sources,
            regionAssembly.assembled,
            regionAssembly.body,
            existingByKey
          )
        );
      }
    }
    // defaults.length === 0 and no overrides: nothing left for this group --
    // an earlier run migrated and deleted its rows, or it never had any.

    const fullyResolved =
      problem === null && documents.length > 0 && documents.every((d) => d.status !== "skip-existing");

    return { spec, rows: groupRows, documents, fullyResolved, problem };
  });

  const deleteRows: DeleteRow[] = rows
    .filter((r) => (DELETE_EXACT_KEYS as readonly string[]).includes(r.key))
    .map((r) => ({ id: r.id, key: r.key, regionCode: r.regionCode, bodyLength: r.body.length }));

  const unrecognized = rows.filter((r) => !isRecognisedKey(r.key));

  const dispositionById = new Map<string, BackupBlock["disposition"]>();
  for (const group of groupPlans) {
    const disposition = group.fullyResolved ? "consumed-by-document" : "kept-pending-human-review";
    for (const row of group.rows) dispositionById.set(row.id, disposition);
  }
  const backupBlocks: BackupBlock[] = rows
    .filter((r) => dispositionById.has(r.id) || (DELETE_EXACT_KEYS as readonly string[]).includes(r.key))
    .map((r) => ({
      id: r.id,
      key: r.key,
      regionId: r.regionId,
      regionCode: r.regionCode,
      title: r.title,
      body: r.body,
      sortOrder: r.sortOrder,
      disposition: dispositionById.get(r.id) ?? "delete-outright",
    }));

  const quoteDocumentsBefore = existingDocuments.map((d) => ({
    id: d.id,
    key: d.key,
    regionId: d.regionId,
    regionCode: d.region?.code ?? null,
    title: d.title,
    body: d.body,
    sortOrder: d.sortOrder,
    includedByDefault: d.includedByDefault,
  }));

  return { groupPlans, deleteRows, unrecognized, backupBlocks, quoteDocumentsBefore };
}

/** The per-document half of `computePlan`, extracted only because it is the
 * same six steps for the default and for every region version. */
function planDocument(
  spec: GroupSpec,
  regionId: string | null,
  regionCode: string | null,
  sources: BlockSource[],
  assembled: string,
  body: string,
  existingByKey: Map<string, { body: string }>
): DocumentPlan {
  const existing = existingByKey.get(`${spec.documentKey}::${regionId ?? ""}`);
  const status: DocumentPlan["status"] = !existing
    ? "create"
    : existing.body.trim() === body.trim()
      ? "already"
      : "skip-existing";
  return {
    documentKey: spec.documentKey,
    title: spec.title,
    sortOrder: spec.sortOrder,
    regionId,
    regionCode,
    sources,
    assembled,
    body,
    // The exact check `updateQuoteDocument` runs when an admin saves: a token
    // outside the document scope renders as a silently stripped line AND makes
    // the document unsavable from the editor until a human removes it.
    outOfScopeTokens: findUnknownTokens(body, DOCUMENT_TOKENS),
    status,
    existingLength: existing?.body.length ?? null,
  };
}

type Plan = Awaited<ReturnType<typeof computePlan>>;

/** ISO 8601 basic format (`20260907T131415Z`) -- the same instant
 * `toISOString()` gives, without the `:` and `.` that make a filename awkward
 * to type, quote and copy between machines. */
function timestampForFilename(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Serialises every ContentBlock row this run touches, every QuoteDocument row
 * that already exists for these keys, and every body this run intends to write,
 * to the repo root; returns the absolute path. Called before the first write or
 * delete: afterwards the only other trace of a deleted fragment is terminal
 * scrollback. Throws on any failure -- the caller aborts rather than deleting
 * anything it has not first written down. `wx` so a backup from an earlier run
 * in the same second is never clobbered. */
function writeBackup(plan: Plan, now = new Date()): string {
  const file = path.resolve(__dirname, "..", `migration-backup-${timestampForFilename(now)}.json`);
  const payload = {
    generatedAt: now.toISOString(),
    script: "scripts/migrate-content-blocks-to-quote-documents.ts",
    what: "Pre-migration snapshot, written before the first write or delete of an --apply run.",
    contentBlocks: plan.backupBlocks,
    quoteDocumentsBefore: plan.quoteDocumentsBefore,
    documentsToWrite: plan.groupPlans.flatMap((g) =>
      g.documents.map((d) => ({
        key: d.documentKey,
        regionId: d.regionId,
        regionCode: d.regionCode,
        title: d.title,
        sortOrder: d.sortOrder,
        status: d.status,
        body: d.body,
        assembledFrom: d.sources,
      }))
    ),
  };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return file;
}

/** Breaks an assembled body onto one line per block-level element and indents
 * by list depth, purely for reading in a terminal. Never touches what is
 * stored -- this is the difference between a reviewer being able to see a
 * mangled `<ol>` and being handed 20,000 characters on one line. */
function formatForReading(html: string): string {
  const pieces = html
    .replace(/\n/g, "")
    .split(/(?=<(?:h2|h3|p|ul|ol|li|blockquote)\b)|(?=<\/(?:ul|ol|li)>)/i)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);

  let depth = 0;
  return pieces
    .map((piece) => {
      if (/^<\/(?:ul|ol)>/i.test(piece)) depth = Math.max(0, depth - 1);
      const line = `${"  ".repeat(depth)}${piece}`;
      if (/^<(?:ul|ol)\b/i.test(piece)) depth += 1;
      return line;
    })
    .join("\n");
}

/** The whole body, indented and prefixed so it reads as a quoted block rather
 * than as the script's own output. */
function printBody(body: string): void {
  const shown = body.length > MAX_PRINTED_BODY ? `${body.slice(0, MAX_PRINTED_BODY)}\n… truncated, see the backup file` : body;
  for (const line of formatForReading(shown).split("\n")) console.log(`    | ${line}`);
}

const TAG_PATTERN = /<\/?([a-z0-9]+)\b[^>]*>/gi;
const ENTITIES: Record<string, string> = { amp: "&", quot: '"', "#39": "'", lt: "<", gt: ">", nbsp: " " };

/** The tags of `html` in order, names only. Two bodies with the same tag
 * sequence have the same structure whatever their attributes or entities. */
function tagSequence(html: string): string[] {
  return [...html.matchAll(TAG_PATTERN)].map((m) => (m[0].startsWith("</") ? `/${m[1].toLowerCase()}` : m[1].toLowerCase()));
}

/** The words of `html`, tags gone and entities decoded in one pass (so
 * `&amp;quot;` decodes once, to `&quot;`, rather than twice). */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|quot|#39|lt|gt|nbsp);/g, (_m, entity: string) => ENTITIES[entity])
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Why the stored body differs from the assembly, in the terms a reviewer of
 * legal text actually needs: was anything REMOVED, or did the sanitizer merely
 * re-serialise entities?
 *
 * The second is the common case and is invisible on the page — DOMPurify
 * parses `&quot;Equipment&quot;` to a text node and serialises it back as
 * `"Equipment"`, which prints identically. The first is not: `# heading`
 * markdown renders `<h1>`, which is not on `ALLOWED_TAGS` (the Tiptap editor
 * only ever produces h2/h3), so the tag is dropped and the words are kept —
 * something a human should decide about rather than discover on a signed
 * quote.
 */
function describeSanitizerChange(assembled: string, body: string): string {
  const before = tagSequence(assembled);
  const after = tagSequence(body);
  const sameTags = before.length === after.length && before.every((tag, i) => tag === after[i]);
  if (sameTags && textOf(assembled) === textOf(body)) {
    return 'same tags, same words -- the sanitizer only re-serialised HTML entities (&quot; -> ", &#39; -> \'), which print identically';
  }
  const count = (tags: string[]) =>
    tags.reduce<Record<string, number>>((acc, tag) => ({ ...acc, [tag]: (acc[tag] ?? 0) + 1 }), {});
  const beforeCount = count(before);
  const afterCount = count(after);
  const changed = [...new Set([...before, ...after])]
    .filter((tag) => (beforeCount[tag] ?? 0) !== (afterCount[tag] ?? 0))
    .map((tag) => `<${tag}> ${beforeCount[tag] ?? 0} -> ${afterCount[tag] ?? 0}`);
  const words = textOf(assembled) === textOf(body) ? "no words lost" : "WORDS CHANGED TOO -- read the body above closely";
  return `MARKUP REMOVED: ${changed.join(", ")} (${words})`;
}

/** One line per source block: which came from the region's own row and which
 * from the default. The whole reason a region version can be checked at all --
 * it is a composition that has never existed as a document before. */
function printSources(doc: DocumentPlan): void {
  const overrides = doc.sources.filter((s) => s.from === "override");
  if (doc.regionId === null) {
    console.log(`    assembled from ${doc.sources.length} default block(s): ${doc.sources.map((s) => s.blockKey).join(", ")}`);
    return;
  }
  console.log(
    `    assembled from ${doc.sources.length} block(s) -- ${overrides.length} from region ${doc.regionCode ?? doc.regionId}, ${doc.sources.length - overrides.length} from the default:`
  );
  for (const source of doc.sources) {
    const from = source.from === "override" ? `region ${doc.regionCode ?? doc.regionId} OVERRIDE` : "default";
    console.log(`      ${source.blockKey.padEnd(34)} ${from} (${source.bodyLength} chars)`);
  }
}

/** The headings of a Terms-shaped body or the clause titles of a
 * Conditions-shaped one -- the structure, before the full body below it. */
function printOutline(spec: GroupSpec, body: string): void {
  if (spec.shape === "conditions") {
    const items = [...body.matchAll(/<li>(?:<p><strong>(.*?)<\/strong><\/p>)?/gi)];
    items.forEach((match, i) => console.log(`      ${String(i + 1).padStart(2)}. ${match[1] ?? "(no title)"}`));
    return;
  }
  for (const match of body.matchAll(/<h2>(.*?)<\/h2>/gi)) console.log(`      <h2> ${match[1]}`);
}

function printPlan(plan: Plan): { hadUnexpectedIssue: boolean; skipsExisting: number } {
  let hadUnexpectedIssue = false;

  console.log("=== Legal text migration: ContentBlock fragments -> whole QuoteDocument rows ===\n");

  for (const group of plan.groupPlans) {
    const { spec } = group;
    console.log(`${spec.documentKey} ("${spec.title}", sortOrder ${spec.sortOrder}):`);
    if (group.problem) {
      console.log(`  [ERROR]  ${group.problem} -- nothing written for this document`);
      hadUnexpectedIssue = true;
      console.log("");
      continue;
    }
    if (group.documents.length === 0) {
      console.log(`  no ContentBlock rows left for this document -- already migrated, nothing to write`);
      console.log("");
      continue;
    }

    for (const doc of group.documents) {
      const scope = doc.regionId === null ? "default" : `region ${doc.regionCode ?? doc.regionId}`;
      const structure = countStructure(doc.body);
      const shape =
        spec.shape === "conditions"
          ? `${structure.listItems} clause(s) in one <ol>`
          : `${structure.headings} <h2> section(s)`;
      const verb =
        doc.status === "create" ? "[WRITE]" : doc.status === "already" ? "[DONE] " : "[SKIP] ";
      console.log(`  ${verb}  ${spec.documentKey} (${scope}): ${doc.body.length} chars, ${shape}`);
      printSources(doc);

      if (doc.assembled !== doc.body) {
        // Not an issue in itself -- the same sanitizer runs on every editor
        // save -- but the run should say out loud that what is stored is not
        // byte-for-byte the assembly of the fragments. `# heading` markdown
        // renders <h1>, which is not on the allowlist: the tag goes, the words
        // stay.
        console.log(
          `    [SANITIZED] the allowlist changed this body (${doc.assembled.length} -> ${doc.body.length} chars): ${describeSanitizerChange(doc.assembled, doc.body)}`
        );
      }
      if (doc.outOfScopeTokens.length > 0) {
        console.log(
          `    [WARN]   ${doc.outOfScopeTokens.map((t) => `{{${t}}}`).join(", ")} in "${spec.title}"${doc.regionId ? ` (${scope})` : ""} -- no document token fills this. The line using it is stripped from every quote, and the document cannot be saved from the editor until an admin decides what that clause should say. Deliberately NOT stripped or rewritten by this migration`
        );
        hadUnexpectedIssue = true;
      }
      if (doc.status === "skip-existing") {
        console.log(
          `    [SKIP]   a QuoteDocument row already exists for (${spec.documentKey}, ${scope}) holding a DIFFERENT body (${doc.existingLength} chars) -- refusing to overwrite`
        );
        console.log(`    [KEEP]   this group's ContentBlock rows are retained because of it`);
      }
      if (doc.status === "already") {
        console.log(`    an earlier run wrote exactly this body -- no write needed`);
      }
      if (doc.status !== "skip-existing") {
        console.log(`    ----- body as it will be stored -----`);
        printBody(doc.body);
        console.log(`    ----- outline -----`);
        printOutline(spec, doc.body);
      }
      console.log("");
    }

    if (group.rows.length > 0) {
      if (group.fullyResolved) {
        console.log(`  [DELETE] ${group.rows.length} ContentBlock row(s) consumed by "${spec.title}"`);
      } else {
        console.log(
          `  [KEEP]   ${group.rows.length} ContentBlock row(s) left in place -- not every document of this group was written (see above)`
        );
      }
    }
    console.log("");
  }

  console.log("=== Delete outright: rsp.coverage-note ===\n");
  if (plan.deleteRows.length === 0) {
    console.log("  nothing to delete -- already gone\n");
  } else {
    for (const row of plan.deleteRows) {
      console.log(
        `  [DELETE] ${row.key} (${row.regionCode ?? "default"}): ${row.bodyLength} chars -- nothing ever fetched or rendered it (the coverage table came off the quote's own items, and D10 removed it)`
      );
    }
    console.log("");
  }

  if (plan.unrecognized.length > 0) {
    console.log("=== Unrecognized ContentBlock keys (left untouched) ===\n");
    for (const row of plan.unrecognized) {
      console.log(
        `  [WARN]   key "${row.key}" (${row.regionCode ?? "default"}) feeds none of these three documents and is not rsp.coverage-note -- this script does not know what to do with it and is leaving it alone. Every machine./equipment./option./software. key belongs to scripts/migrate-content-blocks-to-series.ts, which should have run first`
      );
    }
    console.log("");
    hadUnexpectedIssue = true;
  }

  const allDocuments = plan.groupPlans.flatMap((g) => g.documents);
  const creates = allDocuments.filter((d) => d.status === "create").length;
  const already = allDocuments.filter((d) => d.status === "already").length;
  const skipsExisting = allDocuments.filter((d) => d.status === "skip-existing").length;
  const regionVersions = allDocuments.filter((d) => d.regionId !== null).length;
  const outOfScope = allDocuments.filter((d) => d.outOfScopeTokens.length > 0).length;
  const rowsConsumed = plan.groupPlans.filter((g) => g.fullyResolved).reduce((n, g) => n + g.rows.length, 0);

  console.log("=== Summary ===");
  console.log(`  QuoteDocument rows to create:            ${creates}`);
  console.log(`    of which region versions:              ${regionVersions}`);
  console.log(`  already written by an earlier run:       ${already}`);
  console.log(`  skipped (row exists with other text):    ${skipsExisting}`);
  console.log(`  documents with out-of-scope token(s):    ${outOfScope}`);
  console.log(`  ContentBlock rows to delete (consumed):  ${rowsConsumed}`);
  console.log(`  ContentBlock rows to delete (outright):  ${plan.deleteRows.length}`);
  console.log(`  unrecognized ContentBlock keys:          ${plan.unrecognized.length}`);
  console.log("");

  return { hadUnexpectedIssue, skipsExisting };
}

/** Every write and delete of the migration, inside one `db.$transaction`: an
 * interrupt between two statements rolls the whole thing back rather than
 * leaving the fragments deleted and the documents half-written -- the one
 * state this migration cannot be re-run from. `tx`, not the bare client, for
 * exactly that reason. */
async function apply(tx: Tx, plan: Plan) {
  for (const group of plan.groupPlans) {
    for (const doc of group.documents) {
      if (doc.status !== "create") continue;
      await tx.quoteDocument.create({
        data: {
          key: doc.documentKey,
          regionId: doc.regionId,
          title: doc.title,
          body: doc.body,
          sortOrder: doc.sortOrder,
          includedByDefault: INCLUDED_BY_DEFAULT,
        },
      });
      console.log(
        `wrote QuoteDocument ${doc.documentKey} (${doc.regionId === null ? "default" : `region ${doc.regionCode ?? doc.regionId}`}): ${doc.body.length} chars`
      );
    }
    if (group.fullyResolved && group.rows.length > 0) {
      await tx.contentBlock.deleteMany({ where: { id: { in: group.rows.map((r) => r.id) } } });
      console.log(`deleted ${group.rows.length} ContentBlock row(s) consumed by ${group.spec.documentKey}`);
    }
  }

  if (plan.deleteRows.length > 0) {
    await tx.contentBlock.deleteMany({ where: { id: { in: plan.deleteRows.map((r) => r.id) } } });
    console.log(`deleted ${plan.deleteRows.length} ContentBlock row(s) (rsp.coverage-note)`);
  }
}

/** Exit-code policy for a run whose only unresolved items are documents that
 * already exist holding different text: a human decision waiting to happen,
 * not a clean run (0) and not a malfunction (1, reserved for
 * `hadUnexpectedIssue`). No-op once `hadUnexpectedIssue` is true, since status
 * 1 already covers that run. */
function reportPendingSkips(hadUnexpectedIssue: boolean, skipsExisting: number): void {
  if (hadUnexpectedIssue || skipsExisting === 0) return;
  console.log(
    `note: ${skipsExisting} document(s) skipped because a QuoteDocument row already holds different text -- exiting with status 2 (a human decision is pending; this is not a failure).`
  );
  process.exitCode = 2;
}

async function main() {
  const isApply = process.argv.includes("--apply");

  const { db } = await import("../src/lib/db");

  const plan = await computePlan(db);
  const { hadUnexpectedIssue, skipsExisting } = printPlan(plan);

  const nothingToDo =
    plan.groupPlans.every((g) => g.rows.length === 0) &&
    plan.deleteRows.length === 0 &&
    plan.unrecognized.length === 0;
  if (nothingToDo) {
    console.log("nothing to do -- every ContentBlock row is gone and the documents already exist");
    if (hadUnexpectedIssue) process.exitCode = 1;
    return;
  }

  if (!isApply) {
    console.log("dry run -- nothing written. Read the bodies above, then re-run with --apply.");
    if (hadUnexpectedIssue) {
      console.log("note: at least one unexpected issue was reported above -- exiting non-zero even though this was a dry run.");
      process.exitCode = 1;
    }
    reportPendingSkips(hadUnexpectedIssue, skipsExisting);
    return;
  }

  // Before the first write or delete: get every fragment onto disk, and abort
  // untouched if that fails.
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
  console.log(`  ${plan.backupBlocks.length} ContentBlock row(s), every column and the full body, region overrides included`);
  console.log(`  ${plan.quoteDocumentsBefore.length} QuoteDocument row(s) as they stand right now`);
  console.log(`  every assembled body this run intends to write`);
  console.log("  This is the only copy of every fragment deleted below. Keep it until the migration is confirmed good.");
  console.log(rule);
  console.log("");

  await db.$transaction((tx) => apply(tx, plan), TRANSACTION_OPTIONS);

  // Prove idempotence right away: a second plan should find every fully
  // resolved group's rows gone and its documents already written. A group that
  // was NOT fully resolved is expected to still show up -- its rows were
  // deliberately kept.
  const after = await computePlan(db);
  const expectedRemaining = new Set(plan.groupPlans.filter((g) => !g.fullyResolved).map((g) => g.spec.documentKey));
  const unexpectedLeftover = after.groupPlans.filter(
    (g) => g.rows.length > 0 && !expectedRemaining.has(g.spec.documentKey)
  );
  const hasUnexpectedLeftover = unexpectedLeftover.length > 0 || after.deleteRows.length > 0;

  if (hasUnexpectedLeftover) {
    console.warn("warning: a second plan finds unexpected leftover rows after applying -- re-run with no flags to see what remains");
    process.exitCode = 1;
  } else if (expectedRemaining.size > 0) {
    console.log(
      `verified: a second plan finds nothing unexpected -- ${expectedRemaining.size} document(s) intentionally left in place pending human review: ${[...expectedRemaining].join(", ")}`
    );
  } else {
    console.log("verified: a second plan finds nothing left to do");
  }

  if (hadUnexpectedIssue || hasUnexpectedLeftover) process.exitCode = 1;
  else reportPendingSkips(hadUnexpectedIssue, skipsExisting);
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
