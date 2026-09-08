import Link from "next/link";
import type { Metadata } from "next";
import { FileCheck, Plus } from "lucide-react";
import { auth } from "@/auth";
import { isAdminRole } from "@/lib/roles";
import { listQuoteDocuments } from "@/lib/queries/quote-documents";
import { reorderQuoteDocuments } from "@/lib/actions/quote-documents";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PageHeader, EmptyState } from "@/components/ui-kit";
import {
  DocumentBadges,
  DocumentReorderList,
} from "@/components/quote-documents/document-reorder-list";

export const metadata: Metadata = { title: "Documents" };
export const dynamic = "force-dynamic";

/**
 * The legal text a customer signs: Terms, General Conditions of Sale, the
 * Remote Support Program agreement, and whatever a region adds later — one
 * row each, in the order they print on a quote.
 *
 * NOT gated on role, unlike `/settings/content`, the admin-only screen this
 * replaces. That screen 404'd a MANAGER, which meant a salesperson could not
 * read the terms their own client was about to sign — the defect this
 * section exists to fix. A manager gets the same three rows, the same badges
 * and the same documents behind them; what they do not get is a drag handle,
 * because `reorderQuoteDocuments` is `requireAdmin()` and offering a control
 * that cannot work is worse than not offering it.
 *
 * No group headers, unlike the content-block list: `terms.*`, `conditions.*`
 * and `rsp.*` were 22 fragments that needed grouping into three families.
 * They are three documents now, and three rows need no headings.
 *
 * The list is every document, not every default: a key that exists only as
 * one region's version (D2 — an EU-only Data Processing Agreement, say) is
 * shown here with an "Only in: EU" badge and opens like any other. It has to
 * be, because this list is the only way to reach its editor, and because the
 * drag order submitted from here is checked against every key in the table.
 */
export default async function QuoteDocumentsPage() {
  // AppLayout already calls requireSession and redirects an unauthenticated
  // request, so a session is always present here — only the role matters.
  const [session, documents] = await Promise.all([auth(), listQuoteDocuments()]);
  const isAdmin = isAdminRole(session?.user?.role);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Documents"
        description={
          isAdmin
            ? "The legal text printed on every quote. Drag to set the order they print in."
            : "The legal text printed on every quote. Only an admin can change it."
        }
        actions={
          // Admin only. A MANAGER reads this section and edits nothing, and
          // `createQuoteDocument` is `requireAdmin()`, so offering them the
          // button would only be offering a form that cannot submit.
          isAdmin ? (
            <Link
              href="/documents/new"
              className={cn(buttonVariants(), "h-11 w-full bg-brand text-white hover:bg-brand/90 sm:w-auto")}
            >
              <Plus className="size-4" data-icon="inline-start" aria-hidden="true" />
              New document
            </Link>
          ) : null
        }
      />

      {documents.length === 0 ? (
        <EmptyState
          icon={FileCheck}
          title="No documents yet"
          description={
            isAdmin
              ? "Run the database seed to populate Terms, General Conditions of Sale and the Remote Support Program — or write one here."
              : "Nothing is set up yet — a quote currently prints no terms at all."
          }
          action={
            isAdmin ? (
              <Link
                href="/documents/new"
                className={cn(buttonVariants(), "h-11 bg-brand text-white hover:bg-brand/90")}
              >
                <Plus className="size-4" data-icon="inline-start" aria-hidden="true" />
                New document
              </Link>
            ) : undefined
          }
        />
      ) : isAdmin ? (
        <DocumentReorderList documents={documents} reorderQuoteDocumentsAction={reorderQuoteDocuments} />
      ) : (
        <ul className="flex flex-col gap-2">
          {documents.map((doc, index) => (
            <li key={doc.key}>
              <Link
                href={`/documents/${encodeURIComponent(doc.key)}`}
                className="focus-ring flex min-h-11 flex-col gap-1 rounded-xl border border-slate-200 bg-white p-3 transition-colors hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 text-xs tabular-nums text-slate-400">{index + 1}</span>
                    <span className="truncate text-sm font-medium text-brand-dark">{doc.title}</span>
                  </span>
                  <span className="font-mono text-xs text-slate-500">{doc.key}</span>
                </span>
                <DocumentBadges document={doc} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
