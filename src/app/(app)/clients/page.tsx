import Link from "next/link";
import type { Metadata } from "next";
import { Plus } from "lucide-react";
import { auth } from "@/auth";
import { scopeDescription } from "@/lib/roles";
import { listCompanies } from "@/lib/queries/clients";
import { displayCountry } from "@/lib/countries";
import { buttonVariants } from "@/components/ui/button";
import { ClientsList, type ClientListRow } from "@/components/clients/clients-list";
import { PageHeader } from "@/components/ui-kit";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Clients" };
export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  // AppLayout (src/app/(app)/layout.tsx) already calls requireSession and
  // redirects unauthenticated requests, so a session is always present here.
  const session = (await auth())!;

  // No `q` here any more — see the same note on the /quotes page: the
  // search box in `ClientsList` filters the whole scoped list in the
  // browser, across the location and website columns too, not just name.
  const companies = await listCompanies(session.user);

  const rows = companies.map<ClientListRow>((c) => ({
    id: c.id,
    name: c.name,
    // Resolved here, on the server, so `i18n-iso-countries` stays out of
    // the client bundle — see `ClientListRow`'s own doc comment.
    location: [c.city, displayCountry(c.country)].filter(Boolean).join(", ") || "No address",
    contactCount: c.contactCount,
    contactsLabel: `${c.contactCount} ${c.contactCount === 1 ? "contact" : "contacts"}`,
    website: c.website,
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
              buttonVariants(),
              "h-11 w-full bg-brand text-white hover:bg-brand/90 sm:w-auto"
            )}
          >
            <Plus className="size-4" data-icon="inline-start" aria-hidden="true" />
            Add company
          </Link>
        }
      />

      <ClientsList rows={rows} />
    </div>
  );
}
