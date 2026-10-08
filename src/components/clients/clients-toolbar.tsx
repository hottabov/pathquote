"use client";

import { useTransition, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldInputClass } from "@/components/ui-kit/field-row";
import {
  CLIENT_LIST_ALL,
  CLIENT_LIST_DEFAULT_SORT,
  CLIENT_LIST_PAGE_SIZES,
  clientListDefaultDir,
  clientListHref,
  clientListSortOptions,
  parseClientListParams,
  type ClientListPageSize,
  type ClientListSortDir,
  type ClientListSortKey,
} from "@/lib/client-list";
import { cn } from "@/lib/utils";

/**
 * The search box and the page-size selector of /clients, as one GET form whose
 * state is the URL.
 *
 * Submitting builds a URL from `clientListHref` and pushes it, so the back
 * button and a copied link both work, and `page` is left out of it on purpose:
 * a new search or a new page size starts again at page 1, because page 7 of a
 * two-page result is a dead end. The page controls under the table are plain
 * links and are the only place the page number is carried.
 *
 * Without JavaScript the form still works as an ordinary GET to `/clients`
 * (same field names as the URL's), just with a longer URL.
 *
 * The inputs are uncontrolled and keyed on the URL's values, so the back
 * button resets what is typed to what the URL says rather than leaving the
 * box showing a search the list is no longer filtered by.
 *
 * The sort is not changed here on a wide screen (the table's headers do that,
 * as links) but it is kept: a new search or page size stays in the order the
 * manager chose, carried through two hidden fields that are present only when
 * the order is not the default. Below md there is no header to click, so a
 * "Sort by" select offers the same orderings; it has no `name` and acts on
 * change, so without JavaScript it does nothing, where search and page size
 * still work as a plain GET.
 */
export function ClientsToolbar({
  q,
  pageSize,
  sort,
  dir,
  showOwner,
}: {
  /** The validated search term from the URL. */
  q: string;
  pageSize: ClientListPageSize;
  sort: ClientListSortKey;
  dir: ClientListSortDir;
  /** Whether the Owner column, and so ordering by owner, is offered. */
  showOwner: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const sortOptions = clientListSortOptions(showOwner);

  function go(form: HTMLFormElement) {
    const data = new FormData(form);
    // Through the same parser the page uses, so the URL pushed here is one the
    // server would have produced itself.
    const request = parseClientListParams(
      {
        q: String(data.get("q") ?? ""),
        pageSize: String(data.get("pageSize") ?? ""),
        sort: String(data.get("sort") ?? ""),
        dir: String(data.get("dir") ?? ""),
      },
      { ownerSortable: showOwner }
    );
    startTransition(() =>
      router.push(
        clientListHref({
          q: request.q,
          pageSize: request.pageSize,
          sort: request.sort,
          dir: request.dir,
        })
      )
    );
  }

  function onSortChange(value: string) {
    // Looked up in the offered list rather than split on ":", so a value that
    // is not one of the options (a tampered DOM) changes nothing.
    const chosen = sortOptions.find((option) => option.value === value);
    if (!chosen) return;
    startTransition(() => router.push(clientListHref({ q, pageSize, sort: chosen.sort, dir: chosen.dir })));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    go(event.currentTarget);
  }

  return (
    <form
      method="get"
      action="/clients"
      role="search"
      onSubmit={onSubmit}
      aria-busy={pending}
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-end",
        pending && "opacity-70 transition-opacity"
      )}
    >
      <div className="flex flex-1 flex-col gap-1.5 sm:max-w-md">
        <label htmlFor="clients-q" className="text-sm font-medium text-slate-600">
          Search
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            key={q}
            id="clients-q"
            name="q"
            type="text"
            defaultValue={q}
            placeholder="Company, city, website, or a contact's name or email"
            autoComplete="off"
            className={cn(fieldInputClass, "min-h-11 pl-9")}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="clients-page-size" className="text-sm font-medium text-slate-600">
          Per page
        </label>
        <select
          key={String(pageSize)}
          id="clients-page-size"
          name="pageSize"
          defaultValue={String(pageSize)}
          onChange={(event) => go(event.currentTarget.form!)}
          className={cn(fieldInputClass, "min-h-11 sm:w-28")}
        >
          {CLIENT_LIST_PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
          <option value={CLIENT_LIST_ALL}>All</option>
        </select>
      </div>

      {/* Only below md: from there up the table's headers sort. The value is
          the pair as one string because a <select> carries one. */}
      <div className="flex flex-col gap-1.5 md:hidden">
        <label htmlFor="clients-sort" className="text-sm font-medium text-slate-600">
          Sort by
        </label>
        <select
          key={`${sort}:${dir}`}
          id="clients-sort"
          defaultValue={`${sort}:${dir}`}
          onChange={(event) => onSortChange(event.currentTarget.value)}
          className={cn(fieldInputClass, "min-h-11 sm:w-48")}
        >
          {sortOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {/* The current order, so a search or a page-size change keeps it. Left
          out at the defaults, like the URL does. */}
      {sort !== CLIENT_LIST_DEFAULT_SORT ? <input type="hidden" name="sort" value={sort} /> : null}
      {dir !== clientListDefaultDir(sort) ? <input type="hidden" name="dir" value={dir} /> : null}

      <div className="flex items-center gap-2">
        <Button type="submit" variant="brand" className="h-11 flex-1 px-4 sm:flex-none">
          Search
        </Button>
        {q ? (
          <Link
            href={clientListHref({ pageSize, sort, dir })}
            className="focus-ring inline-flex min-h-11 items-center rounded-md px-3 text-sm text-slate-600 hover:bg-slate-50 hover:text-brand-dark"
          >
            Clear
          </Link>
        ) : null}
      </div>
    </form>
  );
}
