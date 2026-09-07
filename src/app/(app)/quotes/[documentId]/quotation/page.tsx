import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { ChevronLeft, Download, TriangleAlert } from "lucide-react";
import { auth } from "@/auth";
import { getDocumentForBuilder } from "@/lib/queries/documents";
import { getContentBlocksForRegion } from "@/lib/queries/content";
import { buildQuotationData } from "@/lib/quotation-data";
import { QuotationSheet } from "@/components/sheet/quotation-sheet";
import { buttonVariants } from "@/components/ui/button";
import { StatusBadge, STATUS_TONE } from "@/components/ui-kit";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Params = { documentId: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { documentId } = await params;
  // Metadata runs before the page body — re-check scope here too so a
  // manager browsing to a foreign document's quotation URL never even sees
  // its number in the tab title.
  const session = (await auth())!;
  const document = await getDocumentForBuilder(session.user, documentId);
  if (!document) return { title: "Quotation" };
  return { title: document.number ? `${document.number} — quotation` : "Quotation" };
}

/**
 * Read-only render of the extended, content-block-driven quotation sheet —
 * the same `QuotationSheet` the quotation PDF route (`/api/quotes/
 * [documentId]/quotation-pdf`) posts to Gotenberg — lets an author sanity-
 * check the full equipment write-up, terms, conditions and RSP detail
 * before downloading. Images are passed straight through as their stored
 * `/api/files/<name>` URL (the default resolver) since this page runs in an
 * already-authenticated browser tab.
 */
export default async function QuotationPreviewPage({ params }: { params: Promise<Params> }) {
  const { documentId } = await params;
  // AppLayout (src/app/(app)/layout.tsx) already calls requireSession and
  // redirects unauthenticated requests, so a session is always present here.
  const session = (await auth())!;

  const document = await getDocumentForBuilder(session.user, documentId);
  // A foreign document and a nonexistent one both 404 here — never
  // distinguish which case it was.
  if (!document) notFound();

  const blocks = await getContentBlocksForRegion(document.regionId);
  const quotationData = buildQuotationData(document, blocks);

  const statusLabel = document.status === "DRAFT" ? "Draft" : "Final";
  const numberLabel = document.number ?? "Quote draft";

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 pb-8">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href={`/quotes/${document.id}`}
            className="focus-ring -my-1 inline-flex items-center gap-1 rounded-md py-1 text-sm font-medium text-slate-500 transition-colors hover:text-brand-dark"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
            Back to editor
          </Link>
          <span className="h-4 w-px shrink-0 bg-slate-200" aria-hidden="true" />
          <span className="truncate font-mono text-sm text-brand-dark">{numberLabel}</span>
          <StatusBadge tone={STATUS_TONE[document.status]} className="shrink-0">
            {statusLabel}
          </StatusBadge>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <a
            href={`/api/quotes/${document.id}/quotation-pdf`}
            className={cn(buttonVariants(), "h-11 flex-1 bg-brand text-white hover:bg-brand/90 sm:flex-none")}
          >
            <Download className="size-4" data-icon="inline-start" aria-hidden="true" />
            Download Quotation PDF
          </a>
        </div>
      </div>

      {/* Draft-only: a FINAL quote must show exactly what the customer sees,
          so this never renders once `isDraft` is false — see
          `strippedTokens`'s own doc comment in quotation-data.ts. Same
          amber/TriangleAlert language as `ConcessionCapBadge`, the other
          persistent admin-facing notice in this app: not an error to fix
          before saving (there's nothing to save here), a still-true fact
          about this quote. */}
      {quotationData.isDraft && quotationData.strippedTokens.length > 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            <strong className="font-semibold">Some lines were removed.</strong> No value for{" "}
            {quotationData.strippedTokens.map((token, index) => (
              <span key={token}>
                {index > 0 ? ", " : ""}
                <code className="font-mono">{`{{${token}}}`}</code>
              </span>
            ))}{" "}
            in this quote, so the {quotationData.strippedTokens.length > 1 ? "lines using them are" : "line using it is"}{" "}
            not printed. Edit the category&apos;s quote description in the catalog, or ignore this if the omission is
            intended.
          </span>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-xl bg-slate-100 p-4 sm:p-8">
        <div className="mx-auto w-fit shadow-lg">
          <QuotationSheet data={quotationData} />
        </div>
      </div>
    </div>
  );
}
