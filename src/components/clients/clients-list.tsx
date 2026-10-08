import Link from "next/link";
import { Building2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ExternalLink } from "lucide-react";
import { EmptyState } from "@/components/ui-kit/empty-state";
import {
  TableShell,
  RowCell,
  tableClassName,
  tableHeadRowClassName,
  tableRowClassName,
} from "@/components/ui-kit/data-table";
import { ClientsToolbar } from "@/components/clients/clients-toolbar";
import { SortLinkTh } from "@/components/ui-kit/sort-link-th";
import {
  CLIENT_LIST_SORT_LABELS,
  clientListHref,
  clientListSummary,
  nextClientListSort,
  type ClientListPageSize,
  type ClientListSortDir,
  type ClientListSortKey,
  type ClientListWindow,
} from "@/lib/client-list";
import { websiteHref, websiteLabel } from "@/lib/website";

/**
 * One row of the /clients list, with its location string already built by
 * the server page.
 *
 * `location` arrives pre-rendered rather than as `city`/`country` because
 * resolving a country code to a name goes through `displayCountry`
 * (src/lib/countries.ts), and that module pulls `i18n-iso-countries` and its
 * locale JSON; the page resolves it once, next to the query, and this file
 * stays a plain renderer (see the header comment on src/components/ui-kit/
 * index.ts for how that dependency leaks into client bundles).
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

/** Where the list is in its result set -- see `clientListWindow` -- plus what
 * the URL asked for, so the controls can rebuild it. */
export type ClientListPaging = ClientListWindow & {
  /** Every company matching the search, across all pages. */
  total: number;
  q: string;
  pageSize: ClientListPageSize;
  sort: ClientListSortKey;
  dir: ClientListSortDir;
};

/**
 * The /clients list: search, page-size and (below md) sort controls, a line
 * saying what is on screen, the table (cards below md), and the page controls.
 *
 * A Server Component with no state of its own. The old version filtered and
 * sorted every company in the browser, which was instant and was the problem
 * once the ACT! import made it 8,809 of them; now the URL is the state and the
 * server does the filtering, the ordering and the paging. Only the toolbar is
 * a client component (it pushes the URL), and the page controls and the column
 * headers are plain links.
 *
 * The column headers sort on the server, and that is the point: this list is
 * shown 20 rows at a time, so a header that re-sorted the rows in the browser
 * (what `useListTable` and `SortableTh` do for the small lists) would order
 * only those 20 and look as if it had ordered the list. That version was
 * removed once for exactly that reason; do not restore it. A header here is a
 * link (`SortLinkTh`) to the same URL with `sort` and `dir` changed -- keeping
 * the search and page size, dropping the page, because page 7 of a re-sorted
 * list shows rows unrelated to the click -- and the database orders every
 * matching company before it takes the page. How, and how ties and missing
 * values are ordered so that paging never repeats or skips a company, is in
 * `clientListOrderBy` (src/lib/client-list.ts).
 *
 * Below md there is no table header, so the toolbar offers the same orderings
 * in a "Sort by" select instead.
 */
export function ClientsList({
  rows,
  showOwner,
  paging,
}: {
  rows: ClientListRow[];
  /** Whether to render the trailing `Owner` column — `canSeeSalesperson`
   * (src/lib/roles.ts), resolved on the server page. False for a MANAGER,
   * every one of whose clients is their own. */
  showOwner: boolean;
  paging: ClientListPaging;
}) {
  const searching = paging.q !== "";

  return (
    <div className="flex flex-col gap-6">
      <ClientsToolbar
        q={paging.q}
        pageSize={paging.pageSize}
        sort={paging.sort}
        dir={paging.dir}
        showOwner={showOwner}
      />

      {/* Always rendered, zero results included: "0 matching companies" is
          what tells a manager a search found nothing rather than failed. The
          hidden half is the announcement for a sort, which changes nothing
          else on screen that a screen reader would be told about. */}
      <p aria-live="polite" className="text-sm text-slate-600">
        {clientListSummary(paging, paging.total, searching)}
        {rows.length > 0 ? (
          <span className="sr-only">
            . Sorted by {CLIENT_LIST_SORT_LABELS[paging.sort]},{" "}
            {paging.dir === "asc" ? "ascending" : "descending"}.
          </span>
        ) : null}
      </p>

      {rows.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={searching ? "No companies match your search" : "No companies yet"}
          description={
            searching
              ? "We searched company names, cities, countries and websites, and your contacts' first names, last names and emails. Try fewer words or a different spelling."
              : "Add your first client company above."
          }
        />
      ) : (
        <>
          <TableShell
            table={
              <table className={tableClassName}>
                <thead>
                  <tr className={tableHeadRowClassName}>
                    <SortHeader column="name" paging={paging} />
                    <SortHeader column="location" paging={paging} />
                    <SortHeader column="contacts" paging={paging} />
                    {showOwner ? <SortHeader column="owner" paging={paging} /> : null}
                    <th scope="col" className="px-4 py-3">
                      <span className="sr-only">Website</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <CompanyRow key={row.id} row={row} showOwner={showOwner} />
                  ))}
                </tbody>
              </table>
            }
            cards={rows.map((row) => (
              <CompanyCard key={row.id} row={row} showOwner={showOwner} />
            ))}
          />
          <PageControls paging={paging} />
        </>
      )}
    </div>
  );
}

/** One sortable column header. The link carries the current search and page
 * size and the sort that a click would give (`nextClientListSort`), and no
 * `page`: it starts the new order at page 1. */
function SortHeader({ column, paging }: { column: ClientListSortKey; paging: ClientListPaging }) {
  const { q, pageSize, sort, dir } = paging;
  const next = nextClientListSort({ sort, dir }, column);

  return (
    <SortLinkTh
      label={CLIENT_LIST_SORT_LABELS[column]}
      href={clientListHref({ q, pageSize, sort: next.sort, dir: next.dir })}
      direction={sort === column ? dir : null}
      nextDirection={next.dir}
    />
  );
}

const pageLinkClass =
  "focus-ring inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md border border-slate-200 bg-white px-3 text-sm text-brand-dark transition-colors hover:bg-slate-50";
const pageLinkDisabledClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md border border-slate-100 px-3 text-sm text-slate-400";

/** First / previous / "Page X of Y" / next / last. Links, not buttons, so each
 * page has a URL: the back button, a bookmark and a pasted link all land on the
 * same rows. Renders nothing when there is only one page, which is also every
 * "All" view. */
function PageControls({ paging }: { paging: ClientListPaging }) {
  const { page, pageCount, q, pageSize, sort, dir } = paging;
  if (pageCount <= 1) return null;

  // The sort is carried from page to page: without it, page 2 of a list
  // sorted by contacts would be page 2 of the list sorted by name.
  const href = (target: number) => clientListHref({ q, pageSize, sort, dir, page: target });
  const atStart = page <= 1;
  const atEnd = page >= pageCount;

  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-slate-600">
        Page {page.toLocaleString("en-US")} of {pageCount.toLocaleString("en-US")}
      </p>
      <div className="flex items-center gap-2">
        <PageLink href={atStart ? null : href(1)} label="First page">
          <ChevronsLeft className="size-4" aria-hidden="true" />
        </PageLink>
        <PageLink href={atStart ? null : href(page - 1)} label="Previous page">
          <ChevronLeft className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">Previous</span>
        </PageLink>
        <PageLink href={atEnd ? null : href(page + 1)} label="Next page">
          <span className="hidden sm:inline">Next</span>
          <ChevronRight className="size-4" aria-hidden="true" />
        </PageLink>
        <PageLink href={atEnd ? null : href(pageCount)} label="Last page">
          <ChevronsRight className="size-4" aria-hidden="true" />
        </PageLink>
      </div>
    </nav>
  );
}

/** A page link, or -- with a `null` href, at either end of the range -- the
 * same box inert and dimmed. The inert one is a `span` with `aria-disabled`,
 * not a link to the current page, so it is not a tab stop that does nothing. */
function PageLink({
  href,
  label,
  children,
}: {
  href: string | null;
  label: string;
  children: React.ReactNode;
}) {
  if (href === null) {
    return (
      <span aria-disabled="true" aria-label={label} role="link" className={pageLinkDisabledClass}>
        {children}
      </span>
    );
  }
  return (
    <Link href={href} aria-label={label} className={pageLinkClass}>
      {children}
    </Link>
  );
}

function CompanyRow({ row, showOwner }: { row: ClientListRow; showOwner: boolean }) {
  const href = `/clients/${row.id}`;
  // The stored website is a bare domain; an href needs the scheme added or the
  // browser reads it as a path on this app. Null for a value that is not a site.
  const siteHref = websiteHref(row.website);

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
        {siteHref ? (
          <div className="flex justify-end px-2">
            <a
              href={siteHref}
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
  const siteHref = websiteHref(row.website);

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
      {siteHref ? (
        <a
          href={siteHref}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${row.name}'s website`}
          className="focus-ring relative z-10 -my-1 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-md text-sm text-slate-500 hover:text-brand"
        >
          <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{websiteLabel(row.website)}</span>
        </a>
      ) : null}
    </div>
  );
}
