import type { Metadata } from "next";
import { Plus } from "lucide-react";
import { auth } from "@/auth";
import { canSeeSalesperson, isAdminRole, isDeveloperRole, scopeDescription } from "@/lib/roles";
import { listDocuments, type DocumentListItem } from "@/lib/queries/documents";
import { createDraft, deleteDocument } from "@/lib/actions/documents";
import { signingStatusLabel } from "@/lib/signing/state";
import { formatMoney, relativeDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { QuotesList, type QuoteListRow } from "@/components/documents/quotes-list";
import { PageHeader } from "@/components/ui-kit";

export const metadata: Metadata = { title: "Quotes" };
export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  // AppLayout (src/app/(app)/layout.tsx) already calls requireSession and
  // redirects unauthenticated requests, so a session is always present here.
  const session = (await auth())!;

  // No `q` here any more: search and sorting both happen in `QuotesList`,
  // in the browser, over the whole scoped list. That is what makes the
  // table filter as you type instead of once per round trip — and it also
  // means a search can now match the number, total, status or date, not
  // just the company name the old SQL `contains` could reach.
  const documents = await listDocuments(session.user);

  // Computed before the rows are built, not after: `rows` is a prop of a
  // client component, so every row object is serialized into the RSC payload
  // the browser receives. Leaving the name on a row whose column is not
  // rendered would ship colleagues' names to a viewer who never sees them --
  // harmless for today's roles (a viewer without this column is scoped to
  // their own quotes by `documentWhereForUser`, so the only name on their rows
  // is their own) but only because two hand-maintained lists happen to agree.
  // Gating it here makes the payload match the column instead of relying on
  // that.
  const showSalesperson = canSeeSalesperson(session.user.role);

  const rows = documents.map<QuoteListRow>((d) => ({
    id: d.id,
    numberLabel: d.number ?? "Quote draft",
    companyLabel: d.companyName ?? "No client",
    totalLabel: formatMoney(d.total, d.currency, d.currencySymbol),
    totalValue: Number(d.total),
    status: d.status,
    statusLabel: d.status === "DRAFT" ? "Draft" : "Final",
    signingStatus: d.signingStatus,
    signingLabel: signingStatusLabel(d.signingStatus),
    updatedLabel: relativeDate(d.updatedAt),
    updatedAtMs: d.updatedAt.getTime(),
    canDelete: canDeleteFromList(d, session.user.role),
    salespersonLabel: showSalesperson ? d.salespersonName : "",
  }));

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

      <QuotesList rows={rows} deleteAction={deleteDocument} showSalesperson={showSalesperson} />
    </div>
  );
}

/**
 * Whether the /quotes list should render a delete button for `d` at all --
 * mirrors, but does not replace, what `deleteDocument`
 * (src/lib/actions/documents/lifecycle.ts) itself re-checks server-side.
 *
 * A SIGNED document is its own branch, checked first: `canDeleteDocument`
 * (src/lib/signing/state.ts) refuses it for everyone except a DEVELOPER, a
 * narrower rule than the ordinary "ADMIN, or a DRAFT" one below, so it must
 * be decided before that one rather than folded into it -- an ADMIN viewing
 * a signed quote must NOT see this button just because `isAdminRole` is
 * true for them too. Every other status keeps the existing rule: any
 * MANAGER may delete a DRAFT they can see, an ADMIN (or DEVELOPER, via
 * `isAdminRole`) may delete anything else.
 */
function canDeleteFromList(d: DocumentListItem, role: string | null | undefined): boolean {
  if (d.signingStatus === "SIGNED") return isDeveloperRole(role);
  return isAdminRole(role) || d.status === "DRAFT";
}
