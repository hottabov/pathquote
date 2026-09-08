import { getDocumentForSigning } from "@/lib/queries/signing";
import { getQuoteDocumentsForRegion } from "@/lib/queries/quote-documents";
import { hashSigningToken } from "@/lib/signing/token";
import { resolveLinkState } from "@/lib/signing/link";
import { ViewBeacon } from "@/components/signing/view-beacon";
import { buildQuotationData } from "@/lib/quotation-data";
import { fileImageResolver, renderQuotationSheetHtml } from "@/lib/pdf";
import { formatMoney } from "@/lib/format";
import { LinkProblem } from "@/components/signing/link-problem";
import { ClientActionBar, DeclineLink } from "@/components/signing/client-action-bar";

// renderQuotationSheetHtml reads uploaded files off disk (src/lib/pdf.ts) —
// Node runtime only, not the edge runtime. force-dynamic because the page is
// per-token and its link state (expired, revoked, declined) is evaluated
// against the clock on every request; it must never be served from a cache.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The quote as the client sees it: the same `QuotationSheet` the in-app
 * preview and the PDF pipeline render, with the real signing bar
 * (`ClientActionBar`) under it and a restrained decline link
 * (`DeclineLink`) below that — see both components' own doc comments.
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

  // Rendering this page records nothing. Promoting SENT to VIEWED used to
  // happen right here, which let a machine do it on the client's behalf —
  // Microsoft 365 Defender renders every emailed URL in a headless browser, so
  // a quote flipped to VIEWED seconds after it was sent and the manager was
  // told the client had opened it. The write now lives behind evidence of a
  // person: <ViewBeacon> posts to ./viewed on the first real interaction. See
  // that route's doc comment for the trade being made.
  const quoteDocuments = await getQuoteDocumentsForRegion(request.document.regionId);
  const data = buildQuotationData(request.document, quoteDocuments, { resolveImage: fileImageResolver });
  const sheetHtml = await renderQuotationSheetHtml(data);

  const completed = state.kind === "completed";

  return (
    <main className="mx-auto max-w-4xl pb-28">
      {completed ? null : <ViewBeacon token={token} />}
      <div className="bg-white shadow-sm" dangerouslySetInnerHTML={{ __html: sheetHtml }} />
      {completed ? null : <DeclineLink token={token} />}
      <ClientActionBar
        token={token}
        completed={completed}
        hasClientSignature={data.signatures.client !== null}
        quoteNumber={data.number ?? ""}
        total={formatMoney(data.totals.total, data.totals.currency)}
        authorName={data.preparedBy.name ?? data.preparedBy.email}
        authorEmail={data.preparedBy.email}
        signedOn={data.signatures.client?.signedAt ?? null}
      />
    </main>
  );
}
