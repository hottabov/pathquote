import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { auth } from "@/auth";
import { getDocumentForBuilder } from "@/lib/queries/documents";
import { resolveSignedPdfPath } from "@/lib/uploads";
import { quotationPdfFilename } from "@/lib/pdf";

// Streaming the archived file from disk needs real filesystem APIs — not
// available on the edge runtime. Same reasoning as the sibling
// quotation-pdf route and the client's own `/sign/[token]/pdf` route.
export const runtime = "nodejs";

type Params = { documentId: string };

/**
 * The manager-facing counterpart to the client's `/sign/[token]/pdf` route
 * (src/app/(sign)/sign/[token]/pdf/route.ts): once a quote is SIGNED, this
 * streams back the exact archived bytes the client saw and confirmed —
 * never a live re-render — so a manager checking a signed quote later sees
 * precisely what was agreed, byte-for-byte matching `Document.signedPdfSha256`.
 *
 * Deliberately does not fall back to `renderQuotationPdfForDocument` the way
 * `.../quotation-pdf` does for a DRAFT/FINAL document: that route exists
 * because a document with no fixed text yet has nothing else to show, but a
 * SIGNED document already has a frozen artifact, and re-rendering it could
 * show a manager something other than what the client actually signed (see
 * the client route's own doc comment on the same tradeoff).
 *
 * 404s uniformly for a foreign/nonexistent document (via
 * `getDocumentForBuilder`'s own scoping), a document that isn't SIGNED, or
 * an archive missing from disk — the last case is logged, since it can only
 * mean data corruption a human should investigate (see the client route's
 * identical check).
 */
export async function GET(_request: Request, { params }: { params: Promise<Params> }) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { documentId } = await params;
  const document = await getDocumentForBuilder(session.user, documentId);
  if (!document || document.signingStatus !== "SIGNED" || !document.signedPdfName) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const diskPath = resolveSignedPdfPath(document.signedPdfName);
  if (!diskPath) return Response.json({ error: "Not found" }, { status: 404 });

  try {
    await stat(diskPath);
  } catch {
    console.error("[signing] archived PDF missing on disk", document.id);
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const filename = quotationPdfFilename(document.number);

  return new Response(Readable.toWeb(createReadStream(diskPath)) as ReadableStream, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
