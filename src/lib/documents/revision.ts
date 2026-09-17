/**
 * The DB/PDF glue for quote revisions. The pure decisions live in
 * revision-snapshot.ts (what to freeze, and its hash) and revision-plan.ts
 * (whether to mint a new one); this module is the thin side that touches
 * Prisma and Gotenberg. Kept separate from finalize.ts only so the PDF step —
 * which is slow (Gotenberg) and best-effort — is not tangled into the finalize
 * transaction.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { uploadsDir } from "@/lib/uploads";
import { renderQuotationPdfForDocument } from "@/lib/pdf";
import { getDocumentForBuilder } from "@/lib/queries/documents";
import { getQuoteDocumentsForRegion } from "@/lib/queries/quote-documents";

type BuilderUser = Parameters<typeof getDocumentForBuilder>[0];

/**
 * Renders the quote as it stands right now (which, called straight after a
 * finalize, is exactly this revision's frozen content) to a PDF, writes it to
 * the uploads volume under a fresh uuid filename — the same store and naming
 * as the archived signed PDFs — and records that filename on the revision.
 *
 * Best-effort by contract: the caller runs it AFTER the finalize transaction
 * has committed and swallows any failure, so a Gotenberg hiccup can never roll
 * back an issued quote. A revision with a null `pdfPath` is simply one whose
 * PDF hasn't been generated yet; it can be regenerated. No-ops if the revision
 * already has a PDF, so a retry never orphans a file.
 */
export async function generateRevisionPdf(
  user: BuilderUser,
  documentId: string,
  revisionId: string
): Promise<void> {
  const revision = await db.quoteRevision.findUnique({
    where: { id: revisionId },
    select: { id: true, pdfPath: true },
  });
  if (!revision || revision.pdfPath) return;

  const doc = await getDocumentForBuilder(user, documentId);
  if (!doc) return;
  const quoteDocuments = await getQuoteDocumentsForRegion(doc.regionId);
  const pdf = await renderQuotationPdfForDocument(doc, quoteDocuments);

  const filename = `${randomUUID()}.pdf`;
  await writeFile(path.join(uploadsDir(), filename), pdf);
  await db.quoteRevision.update({ where: { id: revisionId }, data: { pdfPath: filename } });
}
