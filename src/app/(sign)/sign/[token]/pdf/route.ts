import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { getDocumentForSigning } from "@/lib/queries/signing";
import { getQuoteDocumentsForRegion } from "@/lib/queries/quote-documents";
import { hashSigningToken } from "@/lib/signing/token";
import { resolveLinkState } from "@/lib/signing/link";
import { resolveSignedPdfPath } from "@/lib/uploads";
import { renderQuotationPdfForDocument } from "@/lib/pdf";

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

  const filename = `${found.document.number ?? "quotation"}.pdf`;

  if (state.kind === "completed" && found.document.signedPdfName) {
    const diskPath = resolveSignedPdfPath(found.document.signedPdfName);
    // `signedPdfName` is written only by `completeSigning`
    // (src/lib/actions/signing-client.ts) via `signedPdfFilename()` — it
    // cannot fail this check in practice. Still checked rather than trusted:
    // a `null` here means an unreadable filesystem state gets a 404 instead
    // of a path-traversal-guard bypass or a thrown 500.
    if (!diskPath) return new Response("Not found", { status: 404 });
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
  // both use (`renderQuotationPdfForDocument`, src/lib/pdf.ts). Falls through
  // to here even for a `completed` link whose `signedPdfName` is somehow
  // unset — better an on-the-fly render of the FINAL, SIGNED document than a
  // 404 for a client who signed successfully.
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
