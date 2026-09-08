import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { getDocumentForSigning } from "@/lib/queries/signing";
import { getQuoteDocumentsForRegion } from "@/lib/queries/quote-documents";
import { hashSigningToken } from "@/lib/signing/token";
import { resolveLinkState } from "@/lib/signing/link";
import { resolveSignedPdfPath } from "@/lib/uploads";
import { renderQuotationPdfForDocument, quotationPdfFilename } from "@/lib/pdf";

// renderQuotationPdfForDocument (transitively, via src/lib/pdf.ts) and the
// archived-file stream both need real filesystem/Node APIs — not available
// on the edge runtime. Same reasoning as the authenticated quotation-pdf
// route and the client's own sign page.
export const runtime = "nodejs";

/**
 * The client's Print button.
 *
 * Before completion this renders the quote live, exactly as the in-app PDF
 * route does. After completion it streams the ARCHIVED bytes — never a
 * re-render — so what the client prints in a year is what they signed, and
 * its digest still matches `Document.signedPdfSha256`.
 *
 * Reachable by anyone holding the token, with no session — see
 * src/proxy.ts's PUBLIC_PATHS and src/app/(sign)/layout.tsx's own doc comment
 * for the boundary this route sits behind. It must never call `auth()` or
 * import from the `(app)` route group, and does neither: the token is
 * re-resolved from scratch via `getDocumentForSigning` (the one
 * unauthenticated-safe document query — see that file's own header comment)
 * and gated on a fresh `resolveLinkState`, exactly like the client's sign
 * page (src/app/(sign)/sign/[token]/page.tsx). Every refusal below returns
 * the identical 404 — a missing token and someone else's live one must be
 * indistinguishable to whoever is holding this URL.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const found = await getDocumentForSigning(hashSigningToken(token));
  if (!found) return new Response("Not found", { status: 404 });

  const state = resolveLinkState({
    expiresAt: found.expiresAt,
    revokedAt: found.revokedAt,
    declinedAt: found.declinedAt,
    signingStatus: found.document.signingStatus,
    now: new Date(),
  });
  if (state.kind !== "live" && state.kind !== "completed") {
    return new Response("Not found", { status: 404 });
  }

  const filename = quotationPdfFilename(found.document.number);

  if (state.kind === "completed") {
    // Fail closed instead of falling back to a live render below.
    // `completeSigning` (src/lib/actions/signing-client.ts) is the only
    // place that ever sets `signingStatus: "SIGNED"`, and it always writes
    // `signedPdfName`/`signedPdfSha256` in that same statement — so a
    // `completed` link with no archived name can only mean the data is
    // corrupt (wrong `UPLOADS_DIR`, a restore skew, disk trouble), and that
    // is exactly when a fresh render is most dangerous: templates, catalogue
    // data and the quote's own documents can all have moved since the client
    // signed, so a live re-render could show them something other than what
    // they signed, presented as their signed copy. Logged, since a 404 here
    // is silent evidence of corruption a human should go looking for.
    if (!found.document.signedPdfName) {
      console.error("[signing] completed link has no archived PDF", found.document.id);
      return new Response("Not found", { status: 404 });
    }

    const diskPath = resolveSignedPdfPath(found.document.signedPdfName);
    // A `null` here means an unreadable filesystem state gets a 404 instead
    // of a path-traversal-guard bypass or a thrown 500.
    if (!diskPath) return new Response("Not found", { status: 404 });

    // `stat` first, inside its own try/catch, before opening the stream —
    // same pattern as src/app/api/files/[name]/route.ts. Opening the stream
    // first would mean any headers this response sets are already committed
    // by the time a missing file surfaces, turning a clean 404 into a
    // truncated connection instead.
    try {
      await stat(diskPath);
    } catch {
      console.error("[signing] archived PDF missing on disk", found.document.id);
      return new Response("Not found", { status: 404 });
    }

    return new Response(Readable.toWeb(createReadStream(diskPath)) as ReadableStream, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
      },
    });
  }

  // Live render, sharing the pipeline the in-app route and `completeSigning`
  // both use (`renderQuotationPdfForDocument`, src/lib/pdf.ts). Only reached
  // for a `live` link now — every `completed` one returns above, one way or
  // another.
  const quoteDocuments = await getQuoteDocumentsForRegion(found.document.regionId);
  const pdf = await renderQuotationPdfForDocument(found.document, quoteDocuments);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
