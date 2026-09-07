import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { ChevronLeft, Download, TriangleAlert } from "lucide-react";
import { auth } from "@/auth";
import { getDocumentForBuilder } from "@/lib/queries/documents";
import { buildQuotationData, type StrippedCopyToken } from "@/lib/quotation-data";
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

/** One category's worth of the draft banner: the category to open, and the
 * items under it that lost a line, each with the tokens that cost them. */
type StrippedTokenGroup = {
  /** Stable list key. The category's id when it has one; otherwise its name,
   * prefixed so an id can never collide with a name. */
  key: string;
  seriesId: string | null;
  seriesName: string | null;
  items: Array<{ itemName: string; tokens: string[] }>;
};

/**
 * Folds the flat, per-(item, token) report into one entry per category.
 *
 * One category's copy is one thing to go and edit, however many items on this
 * quote came out of it — so a quote with three M-Series machines all missing
 * a figure reads "M-Series" once, with the three items listed under it,
 * rather than repeating the category (and its link) three times. Order is
 * first-seen, which is the order the items appear on the sheet.
 *
 * A category the item's product no longer resolves (`seriesId === null`)
 * groups by name, and by the empty string when even the name is gone — one
 * "Uncategorised" bucket, never one bucket per orphaned item.
 */
function groupStrippedTokens(stripped: readonly StrippedCopyToken[]): StrippedTokenGroup[] {
  const groups: StrippedTokenGroup[] = [];
  for (const entry of stripped) {
    const key = entry.seriesId ?? `name:${entry.seriesName ?? ""}`;
    let group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      group = { key, seriesId: entry.seriesId, seriesName: entry.seriesName, items: [] };
      groups.push(group);
    }
    let item = group.items.find((candidate) => candidate.itemName === entry.itemName);
    if (!item) {
      item = { itemName: entry.itemName, tokens: [] };
      group.items.push(item);
    }
    // buildQuotationData already de-duplicates per (item, category, token);
    // belt and braces, so a future change there can't double a token here.
    if (!item.tokens.includes(entry.token)) item.tokens.push(entry.token);
  }
  return groups;
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

  // See the same call in src/app/api/quotes/[documentId]/quotation-pdf/route.ts
  // — the `ContentBlock` read this used to pass is not a `QuoteDocument` read,
  // and `getQuoteDocumentsForRegion` replaces it in the next task.
  const quotationData = buildQuotationData(document, []);

  const statusLabel = document.status === "DRAFT" ? "Draft" : "Final";
  const numberLabel = document.number ?? "Quote draft";
  // Computed unconditionally, rendered only on a DRAFT (see the banner
  // below) — grouping an empty list is an empty list.
  const strippedGroups = groupStrippedTokens(quotationData.strippedTokens);

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
      {quotationData.isDraft && strippedGroups.length > 0 ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-2">
            <p>
              <strong className="font-semibold">Some lines were removed.</strong> These variables have no value in this
              quote, so the lines using them are not printed. Open a category below to edit its quote description, or
              ignore this if the omission is intended.
            </p>
            {/* One list item per category, its items nested under it — the
                category is the thing to go and open, so it is the heading and
                the link, and an item that shares it never repeats it. A
                category whose product no longer resolves has no id to link,
                so it stays plain text rather than becoming /catalog/null. */}
            <ul className="flex flex-col gap-1.5">
              {strippedGroups.map((group) => (
                <li key={group.key} className="min-w-0">
                  {group.seriesId ? (
                    <Link
                      href={`/catalog/${group.seriesId}`}
                      className="focus-ring -my-1 inline-block rounded-md py-1 font-semibold underline underline-offset-2 transition-colors hover:text-amber-900"
                    >
                      {group.seriesName ?? "Uncategorised"}
                    </Link>
                  ) : (
                    <span className="font-semibold">{group.seriesName ?? "Uncategorised"}</span>
                  )}
                  <ul className="mt-0.5 flex flex-col gap-0.5 pl-4">
                    {group.items.map((item) => (
                      <li key={item.itemName} className="break-words">
                        {item.itemName}
                        {" — "}
                        {item.tokens.map((token, index) => (
                          <span key={token}>
                            {index > 0 ? ", " : ""}
                            <code className="font-mono">{`{{${token}}}`}</code>
                          </span>
                        ))}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
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
