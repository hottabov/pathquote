import Link from "next/link";
import type { Metadata } from "next";
import { Plus, Search, Building2, ExternalLink } from "lucide-react";
import { auth } from "@/auth";
import { isAdminRole } from "@/lib/roles";
import { listCompanies, type CompanyListItem } from "@/lib/queries/clients";
import { displayCountry } from "@/lib/countries";
import { buttonVariants } from "@/components/ui/button";
import {
  PageHeader,
  TableShell,
  RowCell,
  tableClassName,
  tableHeadRowClassName,
  tableRowClassName,
  EmptyState,
  fieldInputClass,
} from "@/components/ui-kit";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Clients" };
export const dynamic = "force-dynamic";

type SearchParams = { q?: string };

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { q } = await searchParams;
  // AppLayout (src/app/(app)/layout.tsx) already calls requireSession and
  // redirects unauthenticated requests, so a session is always present here.
  const session = (await auth())!;

  const companies = await listCompanies(session.user, { q });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Clients"
        description={
          isAdminRole(session.user.role)
            ? "Every company across the business."
            : "Companies you've added."
        }
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

      <form method="GET" className="sm:w-72">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            type="search"
            name="q"
            defaultValue={q ?? ""}
            aria-label="Search companies"
            placeholder="Search companies by name…"
            className={cn(fieldInputClass, "pl-9")}
          />
        </div>
      </form>

      {companies.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={q ? "No companies match your search" : "No companies yet"}
          description={q ? "Try a different name." : "Add your first client company above."}
        />
      ) : (
        <TableShell
          table={
            <table className={tableClassName}>
              <thead>
                <tr className={tableHeadRowClassName}>
                  <th scope="col" className="px-4 py-3">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Location
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Contacts
                  </th>
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Website</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {companies.map((c) => (
                  <CompanyRow key={c.id} company={c} />
                ))}
              </tbody>
            </table>
          }
          cards={companies.map((c) => (
            <CompanyCard key={c.id} company={c} />
          ))}
        />
      )}
    </div>
  );
}

function CompanyRow({ company: c }: { company: CompanyListItem }) {
  const location = [c.city, displayCountry(c.country)].filter(Boolean).join(", ") || "No address";
  const href = `/clients/${c.id}`;

  return (
    <tr className={tableRowClassName}>
      <RowCell href={href} primary={`Open ${c.name}`}>
        <span aria-hidden="true" className="font-medium text-brand-dark">
          {c.name}
        </span>
      </RowCell>
      <RowCell href={href}>
        <span className="text-sm text-slate-600">{location}</span>
      </RowCell>
      <RowCell href={href}>
        <span className="text-sm text-slate-500">
          {c.contactCount} {c.contactCount === 1 ? "contact" : "contacts"}
        </span>
      </RowCell>
      {/* Deliberately its own plain `<td>` (no `RowCell`/row link) — the
          external website link must stay independently clickable, and
          nesting an `<a>` inside a `RowCell`'s own `<Link>` would be invalid
          HTML and would fight the row link for clicks. */}
      <td className="p-0 align-middle">
        {c.website ? (
          <div className="flex justify-end px-2">
            <a
              href={c.website}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${c.name}'s website`}
              className="focus-ring inline-flex size-11 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-brand"
            >
              <ExternalLink className="size-4" aria-hidden="true" />
            </a>
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function CompanyCard({ company: c }: { company: CompanyListItem }) {
  const location = [c.city, displayCountry(c.country)].filter(Boolean).join(", ") || "No address";

  return (
    <div className="relative flex min-h-12 flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4 transition-colors active:bg-slate-100">
      <Link
        href={`/clients/${c.id}`}
        className="focus-ring absolute inset-0 rounded-xl focus-visible:z-10"
      >
        <span className="sr-only">Open {c.name}</span>
      </Link>
      <div className="flex items-start justify-between gap-3">
        <div className="relative flex min-w-0 items-center gap-2">
          <Building2 className="size-4 shrink-0 text-brand" aria-hidden="true" />
          <p className="truncate font-medium text-brand-dark">{c.name}</p>
        </div>
      </div>
      <div className="relative flex items-center justify-between gap-3 text-sm text-slate-500">
        <span className="truncate">{location}</span>
        <span className="shrink-0">
          {c.contactCount} {c.contactCount === 1 ? "contact" : "contacts"}
        </span>
      </div>
      {c.website ? (
        <a
          href={c.website}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${c.name}'s website`}
          className="focus-ring relative z-10 -my-1 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-md text-sm text-slate-500 hover:text-brand"
        >
          <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{c.website}</span>
        </a>
      ) : null}
    </div>
  );
}
