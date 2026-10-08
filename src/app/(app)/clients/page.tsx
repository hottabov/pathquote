import Link from "next/link";
import type { Metadata } from "next";
import { Plus } from "lucide-react";
import { auth } from "@/auth";
import { canSeeSalesperson, scopeDescription } from "@/lib/roles";
import { listCompanies } from "@/lib/queries/clients";
import { displayCountry } from "@/lib/countries";
import { clientListWindow, parseClientListParams } from "@/lib/client-list";
import { buttonVariants } from "@/components/ui/button";
import { ClientsList, type ClientListRow } from "@/components/clients/clients-list";
import { PageHeader } from "@/components/ui-kit";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Clients" };
export const dynamic = "force-dynamic";

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // AppLayout (src/app/(app)/layout.tsx) already calls requireSession and
  // redirects unauthenticated requests, so a session is always present here.
  const session = (await auth())!;

  // `q`, `page` and `pageSize` come from the URL, so the back button and a
  // pasted link reproduce a view. They are validated, not trusted: junk in any
  // of them falls back to a default (see `parseClientListParams`), and a page
  // past the end is clamped by `listCompanies`. The query searches and pages
  // on the server -- the list used to ship every company to the browser,
  // which stopped being viable at the ACT! import's 8,809.
  const request = parseClientListParams(await searchParams);
  const { items: companies, total, page, pageSize } = await listCompanies(session.user, request);

  // Decided before the rows are built, so a name for a column that is not
  // rendered never goes on a row. Same predicate as the Owner column -- a
  // MANAGER's list is one person's clients, so the column would be one name
  // repeated down the page.
  const showOwner = canSeeSalesperson(session.user.role);

  const rows = companies.map<ClientListRow>((c) => ({
    id: c.id,
    name: c.name,
    // Resolved here, on the server, so `i18n-iso-countries` stays out of
    // the client bundle — see `ClientListRow`'s own doc comment.
    location: [c.city, displayCountry(c.country)].filter(Boolean).join(", ") || "No address",
    contactCount: c.contactCount,
    contactsLabel: `${c.contactCount} ${c.contactCount === 1 ? "contact" : "contacts"}`,
    website: c.website,
    // "Unassigned" rather than an empty cell: a company with no owner is a
    // real state (`Company.ownerId` is nullable, and an ACT import that
    // cannot resolve an owner leaves it null), and a blank cell reads as a
    // rendering bug. An empty string when the column is not rendered, so the
    // name is not serialized to a browser that will never show it.
    ownerLabel: showOwner ? (c.ownerName ?? "Unassigned") : "",
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Clients"
        description={scopeDescription(session.user.role, {
          everything: "Every company across the business.",
          region: "Every company your region's managers look after.",
          own: "Companies you've added.",
        })}
        actions={
          <Link
            href="/clients/new"
            className={cn(
              buttonVariants({ variant: "brand" }),
              "h-11 w-full sm:w-auto"
            )}
          >
            <Plus className="size-4" data-icon="inline-start" aria-hidden="true" />
            Add company
          </Link>
        }
      />

      <ClientsList
        rows={rows}
        showOwner={showOwner}
        paging={{
          ...clientListWindow(page, pageSize, total),
          total,
          q: request.q,
          pageSize,
        }}
      />
    </div>
  );
}
