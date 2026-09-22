"use client";

import Link from "next/link";
import { Building2, ExternalLink } from "lucide-react";
import { EmptyState } from "@/components/ui-kit/empty-state";
import {
  TableShell,
  RowCell,
  tableClassName,
  tableHeadRowClassName,
  tableRowClassName,
} from "@/components/ui-kit/data-table";
import {
  ListResultCount,
  ListSearchInput,
  SortableTh,
  useListTable,
} from "@/components/ui-kit/list-table";

/**
 * One row of the /clients list, with its location string already built by
 * the server page.
 *
 * `location` arrives pre-rendered rather than as `city`/`country` for the
 * reason `QuoteListRow` (src/components/documents/quotes-list.tsx) spells
 * out at greater length — but here it is load-bearing beyond tidiness:
 * resolving a country code to a name goes through `displayCountry`
 * (src/lib/countries.ts), and importing that from a client component would
 * pull `i18n-iso-countries` and its locale JSON into this page's bundle
 * (see the header comment on src/components/ui-kit/index.ts).
 */
export type ClientListRow = {
  id: string;
  name: string;
  location: string;
  contactCount: number;
  contactsLabel: string;
  website: string | null;
  /** Which manager looks after this client, already rendered by the server
   * page — "Unassigned" for a company with no owner, so the column never has
   * a blank cell to explain, and an empty string when the column is not
   * rendered at all (see `showOwner`). */
  ownerLabel: string;
};

type SortKey = "name" | "location" | "contacts" | "owner";

export function ClientsList({
  rows,
  showOwner,
}: {
  rows: ClientListRow[];
  /** Whether to render the trailing `Owner` column — `canSeeSalesperson`
   * (src/lib/roles.ts), resolved on the server page. False for a MANAGER,
   * every one of whose clients is their own. Also gates whether the name
   * joins the search text, so a search matches only what is on screen. */
  showOwner: boolean;
}) {
  const { query, setQuery, sort, toggleSort, visible, isFiltered } = useListTable<
    ClientListRow,
    SortKey
  >({
    rows,
    // Matches `listCompanies`' own `name: "asc"`.
    defaultSort: { key: "name", direction: "asc" },
    defaultDirections: { contacts: "desc" },
    sortValues: (row) => ({
      name: row.name,
      location: row.location,
      contacts: row.contactCount,
      owner: row.ownerLabel,
    }),
    searchText: (row) =>
      [
        row.name,
        row.location,
        row.contactsLabel,
        row.website ?? "",
        showOwner ? row.ownerLabel : "",
      ].join(" "),
  });

  return (
    <div className="flex flex-col gap-6">
      <ListSearchInput
        value={query}
        onChange={setQuery}
        label="Search companies"
        placeholder="Search companies…"
        className="sm:w-72"
      />

      <ListResultCount count={visible.length} noun="company" />

      {visible.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={isFiltered ? "No companies match your search" : "No companies yet"}
          description={
            isFiltered ? "Try a different name, city or website." : "Add your first client company above."
          }
        />
      ) : (
        <TableShell
          table={
            <table className={tableClassName}>
              <thead>
                <tr className={tableHeadRowClassName}>
                  <SortableTh label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
                  <SortableTh label="Location" sortKey="location" sort={sort} onSort={toggleSort} />
                  <SortableTh label="Contacts" sortKey="contacts" sort={sort} onSort={toggleSort} />
                  {showOwner ? (
                    <SortableTh label="Owner" sortKey="owner" sort={sort} onSort={toggleSort} />
                  ) : null}
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Website</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <CompanyRow key={row.id} row={row} showOwner={showOwner} />
                ))}
              </tbody>
            </table>
          }
          cards={visible.map((row) => (
            <CompanyCard key={row.id} row={row} showOwner={showOwner} />
          ))}
        />
      )}
    </div>
  );
}

function CompanyRow({ row, showOwner }: { row: ClientListRow; showOwner: boolean }) {
  const href = `/clients/${row.id}`;

  return (
    <tr className={tableRowClassName}>
      <RowCell href={href} primary={`Open ${row.name}`}>
        <span aria-hidden="true" className="font-medium text-brand-dark">
          {row.name}
        </span>
      </RowCell>
      <RowCell href={href}>
        <span className="text-sm text-slate-600">{row.location}</span>
      </RowCell>
      <RowCell href={href}>
        <span className="text-sm text-slate-500">{row.contactsLabel}</span>
      </RowCell>
      {showOwner ? (
        <RowCell href={href}>
          <span className="text-sm text-slate-600">{row.ownerLabel}</span>
        </RowCell>
      ) : null}
      {/* Deliberately its own plain `<td>` (no `RowCell`/row link) — the
          external website link must stay independently clickable, and
          nesting an `<a>` inside a `RowCell`'s own `<Link>` would be invalid
          HTML and would fight the row link for clicks. */}
      <td className="p-0 align-middle">
        {row.website ? (
          <div className="flex justify-end px-2">
            <a
              href={row.website}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${row.name}'s website`}
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

function CompanyCard({ row, showOwner }: { row: ClientListRow; showOwner: boolean }) {
  return (
    <div className="relative flex min-h-12 flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4 transition-colors active:bg-slate-100">
      <Link
        href={`/clients/${row.id}`}
        className="focus-ring absolute inset-0 rounded-xl focus-visible:z-10"
      >
        <span className="sr-only">Open {row.name}</span>
      </Link>
      <div className="flex items-start justify-between gap-3">
        <div className="relative flex min-w-0 items-center gap-2">
          <Building2 className="size-4 shrink-0 text-brand" aria-hidden="true" />
          <p className="truncate font-medium text-brand-dark">{row.name}</p>
        </div>
      </div>
      <div className="relative flex items-center justify-between gap-3 text-sm text-slate-500">
        <span className="truncate">{row.location}</span>
        <span className="shrink-0">{row.contactsLabel}</span>
      </div>
      {/* Prefixed, like the Salesperson line on a quote card: unprefixed, a
          bare name under the location reads as more metadata rather than as
          the person who looks after this client. */}
      {showOwner ? (
        <p className="relative truncate text-xs text-slate-500">Owner: {row.ownerLabel}</p>
      ) : null}
      {row.website ? (
        <a
          href={row.website}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${row.name}'s website`}
          className="focus-ring relative z-10 -my-1 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-md text-sm text-slate-500 hover:text-brand"
        >
          <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{row.website}</span>
        </a>
      ) : null}
    </div>
  );
}
