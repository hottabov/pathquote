import { db } from "@/lib/db";
import { getDocumentForSigning } from "@/lib/queries/signing";
import { getQuoteDocumentsForRegion } from "@/lib/queries/quote-documents";
import { hashSigningToken } from "@/lib/signing/token";
import { resolveLinkState } from "@/lib/signing/link";
import { statusAfterView } from "@/lib/signing/state";
import { buildQuotationData } from "@/lib/quotation-data";
import { fileImageResolver, renderQuotationSheetHtml } from "@/lib/pdf";
import { LinkProblem } from "@/components/signing/link-problem";
import { ClientActionBar } from "@/components/signing/client-action-bar";

// renderQuotationSheetHtml reads uploaded files off disk (src/lib/pdf.ts) —
// Node runtime only, not the edge runtime. force-dynamic because the view
// (firstViewedAt / signingStatus) below writes on every uncached request.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The quote as the client sees it: the same `QuotationSheet` the in-app
 * preview and the PDF pipeline render, with a signing bar under it (a
 * placeholder today — see `ClientActionBar`'s own doc comment; Task 14
 * replaces it).
 *
 * Reachable by anyone holding the token, with no session — see
 * src/proxy.ts's PUBLIC_PATHS and src/app/(sign)/layout.tsx's own doc
 * comment for the boundary this page sits behind. It must never call
 * `auth()` or import from the `(app)` route group, and does neither.
 *
 * Images are inlined as base64 `data:` URIs via `renderQuotationSheetHtml`
 * (src/lib/pdf.ts), the same mechanism Gotenberg's cookie-less Chromium
 * already uses for the downloadable PDF — this visitor's browser can no more
 * fetch the auth-gated `/api/files/...` route than Gotenberg can. That
 * function returns already-rendered HTML rather than a React element, which
 * is why the sheet is embedded via `dangerouslySetInnerHTML` below instead of
 * `<QuotationSheet data={data} />`: `fileImageResolver` only marks an image,
 * and the mark is meaningless outside the string-rewrite pass that resolves
 * it (see that module's own doc comments).
 */
export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const request = await getDocumentForSigning(hashSigningToken(token));
  if (!request) return <LinkProblem kind="not-found" />;

  const state = resolveLinkState({
    expiresAt: request.expiresAt,
    revokedAt: request.revokedAt,
    declinedAt: request.declinedAt,
    signingStatus: request.document.signingStatus,
    now: new Date(),
  });

  if (state.kind === "expired" || state.kind === "revoked" || state.kind === "declined") {
    return (
      <LinkProblem
        kind={state.kind}
        authorName={request.document.author.name ?? request.document.author.email}
        authorEmail={request.document.author.email}
      />
    );
  }

  // First open promotes SENT to VIEWED. Guarded on firstViewedAt being null
  // so a reload is not a second event, and written with a status-guarded
  // updateMany (matching sendQuoteForSignature's own claim idiom, src/lib/
  // actions/signing.ts) so two simultaneous opens cannot both claim it.
  if (request.firstViewedAt === null) {
    const now = new Date();
    await db.$transaction(async (tx) => {
      const claimed = await tx.signingRequest.updateMany({
        where: { id: request.id, firstViewedAt: null },
        data: { firstViewedAt: now },
      });
      if (claimed.count === 0) return;
      await tx.document.update({
        where: { id: request.document.id },
        data: { signingStatus: statusAfterView(request.document.signingStatus) },
      });
    });
  }

  const quoteDocuments = await getQuoteDocumentsForRegion(request.document.regionId);
  const data = buildQuotationData(request.document, quoteDocuments, { resolveImage: fileImageResolver });
  const sheetHtml = await renderQuotationSheetHtml(data);

  return (
    <main className="mx-auto max-w-4xl pb-28">
      <div className="bg-white shadow-sm" dangerouslySetInnerHTML={{ __html: sheetHtml }} />
      <ClientActionBar
        token={token}
        completed={state.kind === "completed"}
        hasClientSignature={data.signatures.client !== null}
      />
    </main>
  );
}
