import { auth } from "@/auth";
import { getDocumentForBuilder } from "@/lib/queries/documents";
import { getQuoteDocumentsForRegion } from "@/lib/queries/quote-documents";
import { renderQuotationPdfForDocument, quotationPdfFilename } from "@/lib/pdf";

// `react-dom/server` (used transitively via src/lib/pdf.ts) and Gotenberg's
// HTTP call both need the Node runtime — not available on the edge runtime.
export const runtime = "nodejs";

type Params = { documentId: string };

/**
 * Streams a document (DRAFT or FINAL) back as a downloadable extended
 * quotation PDF — the content-block-driven equipment write-up, terms,
 * general conditions and RSP detail; the only customer-facing PDF the app
 * produces now (the older plain line-item "Summary" PDF was removed). 404s
 * for a foreign/nonexistent document. Every image is inlined as a base64
 * data URI via `fileImageResolver` — Gotenberg's headless Chromium has no
 * session cookie to hit the auth-gated `/api/files/...` route with.
 */
export async function GET(_request: Request, { params }: { params: Promise<Params> }) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { documentId } = await params;
  const document = await getDocumentForBuilder(session.user, documentId);
  if (!document) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // See the same call in src/app/(app)/quotes/[documentId]/quotation/page.tsx
  // — both read this document's region's own QuoteDocument rows so the
  // preview and the PDF resolve Terms/Conditions/RSP identically.
  const documents = await getQuoteDocumentsForRegion(document.regionId);

  let pdf: Buffer;
  try {
    // Shared with `completeSigning` (src/lib/actions/signing-client.ts) and
    // the client's own `/sign/[token]/pdf` route — see
    // `renderQuotationPdfForDocument`'s own doc comment in src/lib/pdf.ts for
    // why it takes this already-loaded `document` rather than an id.
    pdf = await renderQuotationPdfForDocument(document, documents);
  } catch (error) {
    console.error("Quotation PDF generation failed", error);
    return Response.json({ error: "PDF service unavailable" }, { status: 502 });
  }

  const filename = quotationPdfFilename(document.number);

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
