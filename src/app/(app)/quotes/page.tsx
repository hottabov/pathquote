import type { Metadata } from "next";
import { Plus } from "lucide-react";
import { auth } from "@/auth";
import { canSeeSalesperson, scopeDescription } from "@/lib/roles";
import { listDocuments } from "@/lib/queries/documents";
import { createDraft, deleteDocument } from "@/lib/actions/documents";
import { listRemainingQuotes } from "@/lib/actions/documents-list";
import { toQuoteListRows } from "@/components/documents/quote-list-rows";
import { Button } from "@/components/ui/button";
import { QuotesList } from "@/components/documents/quotes-list";
import { PageHeader } from "@/components/ui-kit";

export const metadata: Metadata = { title: "Quotes" };
export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  // AppLayout (src/app/(app)/layout.tsx) already calls requireSession and
  // redirects unauthenticated requests, so a session is always present here.
  const session = (await auth())!;

  // No `q` here: search and sorting both happen in `QuotesList`, in the
  // browser, over the rows it holds. That is what makes the table filter as
  // you type instead of once per round trip -- and it also means a search can
  // match the number, total, status or date, not just the company name the
  // old SQL `contains` could reach.
  //
  // Bounded, though: the most recent `DOCUMENT_LIST_PAGE_SIZE` rows come with
  // the page, and `total` says how many the scope holds in all. When there
  // are more, the list offers "Show all" and fetches the rest through
  // `listRemainingQuotes`, which applies the same scope from the session. The
  // audit measured ~7.5 KB per row before the bound existed: 602 quotes made a
  // 4.5 MB page for an admin.
  const { rows: documents, total } = await listDocuments(session.user, { withTotal: true });

  // Rendered strings, per-role gating (`canDelete`, the Salesperson column)
  // -- all decided here, on the server, by the same `toQuoteListRows` the
  // "Show all" action uses, so the first 200 rows and the rest cannot differ.
  const rows = toQuoteListRows(documents, session.user.role);
  const showSalesperson = canSeeSalesperson(session.user.role);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Quotes"
        description={scopeDescription(session.user.role, {
          everything: "Every quote across the business.",
          region: "Every quote in your region.",
          own: "Quotes you've created.",
        })}
        actions={
          <form action={createDraft}>
            <Button variant="brand" type="submit" className="h-11 w-full sm:w-auto">
              <Plus className="size-4" data-icon="inline-start" aria-hidden="true" />
              New quote
            </Button>
          </form>
        }
      />

      <QuotesList
        rows={rows}
        total={total}
        deleteAction={deleteDocument}
        loadRemaining={listRemainingQuotes}
        showSalesperson={showSalesperson}
      />
    </div>
  );
}
