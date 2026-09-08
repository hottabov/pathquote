import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/auth";
import { isAdminRole } from "@/lib/roles";
import { listQuoteDocuments } from "@/lib/queries/quote-documents";
import { DOCUMENT_TOKENS } from "@/lib/quote-variables";
import { PageHeader } from "@/components/ui-kit";
import { NewQuoteDocumentForm } from "@/components/quote-documents/new-quote-document-form";

export const metadata: Metadata = { title: "New document" };
export const dynamic = "force-dynamic";

/**
 * Adds a whole document to the set printed on a quote — a Data Processing
 * Agreement for the EU, say. This route is the reason `QuoteDocument` exists
 * as a table rather than three hardcoded sections: without it, `Documents`
 * could only ever hold what the migration put there, and adding one would be
 * a code change again.
 *
 * ADMIN only, and a MANAGER is redirected rather than 404'd: they may read
 * every document (that is the whole point of this section) and simply have no
 * business on the create screen. `createQuoteDocument` is `requireAdmin()`
 * regardless, so this is about not showing a form that cannot submit.
 *
 * NOTE: this static `new` segment shadows `/documents/[key]`, which is why
 * `newQuoteDocumentSchema` refuses "new" as a key — a document keyed "new"
 * would be created happily and then be unreachable forever.
 */
export default async function NewQuoteDocumentPage() {
  // Role first, then the read: a MANAGER never reaches the query, so the
  // redirect costs nothing.
  const session = await auth();
  if (!isAdminRole(session?.user?.role)) redirect("/documents");
  const documents = await listQuoteDocuments();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        backHref="/documents"
        backLabel="Documents"
        title="New document"
        description="A whole document printed on a quote, alongside Terms and General Conditions of Sale."
      />

      <NewQuoteDocumentForm
        // Last in the print order. `reorderQuoteDocuments` writes 0…n-1 over
        // every key, so the count IS the next free position; the admin drags
        // it where they want it from the list afterwards.
        sortOrder={documents.length}
        // The same registry `updateQuoteDocument` validates a save against, so
        // the palette offers exactly the tokens a document may carry — and
        // passing it from the server keeps quote-variables.ts (and its zod)
        // out of the client chunk, as `/documents/[key]` does.
        tokens={DOCUMENT_TOKENS}
      />
    </div>
  );
}
