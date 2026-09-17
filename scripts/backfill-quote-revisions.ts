/**
 * Backfill revision 0 for quotes that were already FINAL before the
 * z43_quote_revisions_send migration (spec §2, §10.1).
 *
 * The migration only added the columns; it could not create the QuoteRevision
 * rows, because building each snapshot needs application code (the region, the
 * resolved legal-document bodies, the item/line rows) — reimplementing that in
 * SQL would be a second, drifting definition of what a quote froze. So it runs
 * here, sharing `documentToRevisionSnapshotInput` with `finalizeDocument` so
 * the two can never disagree on the shape.
 *
 * For every FINAL document that has no QuoteRevision yet it writes one at
 * `revision = 0`, labelled with the bare quote number, and stamps
 * `Document.revision = 0` (+ `finalizedAt`/`finalizedById`, falling back to
 * `issueDate`/`authorId` — the row never recorded them before this feature).
 * The per-revision PDF is NOT generated here (it is best-effort and slow); it
 * fills in on the next finalize, or via a later PDF pass.
 *
 * Usage:
 *   npx tsx scripts/backfill-quote-revisions.ts          # dry run, prints what it would do
 *   npx tsx scripts/backfill-quote-revisions.ts --yes    # actually write
 */
import "dotenv/config";
import { db } from "@/lib/db";
import { resolveQuoteDocuments } from "@/lib/quotation-data";
import { getQuoteDocumentsForRegion } from "@/lib/queries/quote-documents";
import {
  buildAndHashRevisionSnapshot,
  documentToRevisionSnapshotInput,
  type EntityForSnapshot,
} from "@/lib/documents/revision-snapshot";
import { revisionLabel } from "@/lib/documents/revision-plan";

const apply = process.argv.includes("--yes");

async function main() {
  // FINAL documents with no revision row yet. `revisions: { none: {} }` is the
  // idempotency guard — re-running never double-writes.
  const documents = await db.document.findMany({
    where: { status: "FINAL", revisions: { none: {} } },
    include: {
      items: { include: { lines: true } },
      lines: { where: { itemId: null } },
      company: true,
      contact: true,
      region: true,
      exclusions: true,
    },
  });

  console.log(`Found ${documents.length} FINAL quote(s) without a revision row.`);
  if (documents.length === 0) return;

  let written = 0;
  for (const document of documents) {
    // Prefer the frozen entitySnapshot; fall back to the live region only for
    // a quote finalized before entitySnapshot existed.
    const frozen = document.entitySnapshot as Partial<EntityForSnapshot> | null;
    const entity: EntityForSnapshot = {
      entityName: frozen?.entityName ?? document.region.entityName,
      entityLegalId: frozen?.entityLegalId ?? document.region.entityLegalId,
      entityAddress: frozen?.entityAddress ?? document.region.entityAddress,
      bankDetails: frozen?.bankDetails ?? document.region.bankDetails,
      logoUrl: frozen?.logoUrl ?? document.region.logoUrl,
      footerText: frozen?.footerText ?? document.region.footerText,
      regionCode: frozen?.regionCode ?? document.region.code,
    };

    const excluded = new Set(document.exclusions.map((row) => row.quoteDocumentKey));
    const quoteDocuments = await getQuoteDocumentsForRegion(document.regionId);
    const documents_ = Array.from(resolveQuoteDocuments(quoteDocuments, document.regionId).values())
      .filter((row) => row.includedByDefault && !excluded.has(row.key))
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((row) => ({ key: row.key, title: row.title, body: row.body }));

    const input = documentToRevisionSnapshotInput({
      document,
      entity,
      totals: { subtotal: document.subtotal, taxAmount: document.taxAmount, total: document.total },
      validityDays: document.validityDays,
      documents: documents_,
    });
    const { snapshot, snapshotHash } = buildAndHashRevisionSnapshot(input);
    const label = revisionLabel(document.number, 0) ?? document.number ?? document.id;

    console.log(`  ${apply ? "writing" : "would write"} revision 0 for ${label} (${document.id})`);

    if (!apply) continue;

    await db.$transaction(async (tx) => {
      await tx.quoteRevision.create({
        data: {
          documentId: document.id,
          revision: 0,
          label,
          snapshot: snapshot as object,
          snapshotHash,
          total: document.total,
          createdById: document.finalizedById ?? document.authorId,
        },
      });
      await tx.document.update({
        where: { id: document.id },
        data: {
          revision: 0,
          finalizedAt: document.finalizedAt ?? document.issueDate,
          finalizedById: document.finalizedById ?? document.authorId,
        },
      });
    });
    written += 1;
  }

  console.log(apply ? `Done. Wrote ${written} revision row(s).` : "Dry run — pass --yes to write.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
