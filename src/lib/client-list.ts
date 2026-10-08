// The pure half of the /clients list: how the URL's `q`, `page`, `pageSize`,
// `sort` and `dir` become a validated request, how a request becomes a Prisma
// `where`, `orderBy` and `skip`/`take`, and how the position on the page is
// described. No database and no React, so every rule below has a unit test;
// the query that runs it is `listCompanies` (src/lib/queries/clients.ts) and
// the markup is src/components/clients/clients-list.tsx.
//
// Why this exists: the ACT! import took /clients from two companies to 8,809,
// and the page used to ship every one of them to the browser.

import type { Prisma } from "@prisma/client";
import { CLIENT_SEARCH_MAX_LENGTH, clientSearchWords } from "./client-search";
import { normalizeCountryInput } from "./countries";
import type { CompanyScopeWhere } from "./scope";

/** The page sizes a manager can pick, besides "all". */
export const CLIENT_LIST_PAGE_SIZES = [20, 50, 100, 200] as const;

/** The `pageSize` value that means "every row". A deliberate choice made from
 * the selector, never a default: nobody should land on 8,809 rows by accident. */
export const CLIENT_LIST_ALL = "all";

export type ClientListPageSize = (typeof CLIENT_LIST_PAGE_SIZES)[number] | typeof CLIENT_LIST_ALL;

export const CLIENT_LIST_DEFAULT_PAGE_SIZE: ClientListPageSize = 20;

/** Highest page number honoured from a URL. Far past any real last page (even
 * 200 rows a page over millions of companies), and low enough that `skip`
 * stays a small integer however long the digits in a hand-built URL. The
 * query clamps to the real last page afterwards. */
export const CLIENT_LIST_MAX_PAGE = 999_999;

/** The columns the list can be ordered by, in the order the headers appear. */
export const CLIENT_LIST_SORT_KEYS = ["name", "location", "contacts", "owner"] as const;

export type ClientListSortKey = (typeof CLIENT_LIST_SORT_KEYS)[number];

export type ClientListSortDir = "asc" | "desc";

/** The column a bare /clients is ordered by. */
export const CLIENT_LIST_DEFAULT_SORT: ClientListSortKey = "name";

/**
 * The direction a column opens in when `dir` is absent from the URL, and so
 * the direction a first click on its header asks for. Ascending for the text
 * columns. Descending for `contacts`: the question people put to that column
 * is "who has the most", and an ascending first click would open on a screen
 * of companies with none -- most imported companies have one contact or none.
 *
 * It is also what `dir` means when left out, which is why a URL for the
 * default direction of any column carries no `dir` at all.
 */
export function clientListDefaultDir(sort: ClientListSortKey): ClientListSortDir {
  return sort === "contacts" ? "desc" : "asc";
}

/** What the URL asks for, after validation. */
export type ClientListRequest = {
  /** The normalised search term; `""` means no search. */
  q: string;
  /** 1-based, and not yet clamped to the last page: that needs the total. */
  page: number;
  pageSize: ClientListPageSize;
  sort: ClientListSortKey;
  /** Always explicit here, with the column's own default filled in; only the
   * URL leaves it out. */
  dir: ClientListSortDir;
};

/** One search-param value as Next hands it over. */
type RawParam = string | string[] | undefined;

/** The first value of a param. `?q=a&q=b` arrives as an array; the first wins,
 * because any one choice is as good as another and it must not throw. */
function firstValue(raw: RawParam): string {
  return (Array.isArray(raw) ? raw[0] : raw) ?? "";
}

/**
 * The search term for `raw`, or `""` for none. Whitespace is trimmed and runs
 * of it collapsed, and the term is cut at `CLIENT_SEARCH_MAX_LENGTH`, which
 * bounds what a hand-built URL can make the database compare.
 *
 * Unlike the builder's picker (`clientSearchTerm`) there is no minimum length:
 * this is a list the user is narrowing, not a menu that must not open on
 * everything, and the match count tells them how wide a short term is. The
 * trigram indexes cannot serve a short pattern, but see `clientListWhere`:
 * they are not used here at any length.
 */
export function clientListTerm(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, CLIENT_SEARCH_MAX_LENGTH).trim();
}

/** `raw` as a page size, or the default for anything that is not one of the
 * offered values. Compared as a string against the offered list rather than
 * parsed, so "20.0", "0x14", "1e2", " 50" and "50abc" are all rejected rather
 * than coerced into something that happens to match. */
function parsePageSize(raw: string): ClientListPageSize {
  if (raw === CLIENT_LIST_ALL) return CLIENT_LIST_ALL;
  for (const size of CLIENT_LIST_PAGE_SIZES) {
    if (raw === String(size)) return size;
  }
  return CLIENT_LIST_DEFAULT_PAGE_SIZE;
}

/** `raw` as a 1-based page number: plain digits only, 1 for anything else
 * (empty, "0", negative, fractional, "1e3", text), and at most
 * `CLIENT_LIST_MAX_PAGE` for digits too many to mean anything. */
function parsePage(raw: string): number {
  if (!/^\d+$/.test(raw)) return 1;
  return Math.min(Math.max(Number(raw), 1), CLIENT_LIST_MAX_PAGE);
}

/** `raw` as a sort column, or the default for anything that is not one. An
 * exact, case-sensitive match against the list, so "Name", "name " and
 * "constructor" are all rejected. `ownerSortable` is false for a viewer who is
 * not shown the Owner column. */
function parseSort(raw: string, ownerSortable: boolean): ClientListSortKey {
  for (const key of CLIENT_LIST_SORT_KEYS) {
    if (raw === key && (key !== "owner" || ownerSortable)) return key;
  }
  return CLIENT_LIST_DEFAULT_SORT;
}

/** `raw` as a direction, or the column's own default for anything else. */
function parseDir(raw: string, sort: ClientListSortKey): ClientListSortDir {
  return raw === "asc" || raw === "desc" ? raw : clientListDefaultDir(sort);
}

/**
 * The request in a /clients URL. Never throws, and trusts nothing: every field
 * is validated on its own, so one bad parameter does not cost the others -- a
 * good `q` survives a junk `page`.
 *
 * `dir` is read against the `sort` that survived validation, so `?sort=contacts`
 * is descending and `?sort=junk&dir=junk` is the plain name order.
 *
 * `ownerSortable: false` is for a viewer who is not shown the Owner column
 * (`canSeeSalesperson`, src/lib/roles.ts): `sort=owner` is then as unrecognised
 * as any other junk. Ordering by a column the viewer cannot see would both
 * look like no order at all and tell them how the names they are not shown
 * compare.
 */
export function parseClientListParams(
  params: {
    q?: RawParam;
    page?: RawParam;
    pageSize?: RawParam;
    sort?: RawParam;
    dir?: RawParam;
  },
  options: { ownerSortable?: boolean } = {}
): ClientListRequest {
  const sort = parseSort(firstValue(params.sort), options.ownerSortable ?? true);
  return {
    q: clientListTerm(firstValue(params.q)),
    page: parsePage(firstValue(params.page)),
    pageSize: parsePageSize(firstValue(params.pageSize)),
    sort,
    dir: parseDir(firstValue(params.dir), sort),
  };
}

/**
 * The sort a click on `key`'s header asks for: the opposite direction if it is
 * already the active column, otherwise that column in its own default
 * direction. Never "no sort": the list is always ordered by something, so the
 * way back to the plain order is to click Name.
 */
export function nextClientListSort(
  current: Pick<ClientListRequest, "sort" | "dir">,
  key: ClientListSortKey
): { sort: ClientListSortKey; dir: ClientListSortDir } {
  if (current.sort !== key) return { sort: key, dir: clientListDefaultDir(key) };
  return { sort: key, dir: current.dir === "asc" ? "desc" : "asc" };
}

/**
 * The orderings offered by the sort selector on small screens, where there is
 * no table header to click. One entry per column per direction, each column's
 * own default direction first; `value` is what the `<select>` carries.
 * `owner` is left out for a viewer who is not shown that column.
 */
export function clientListSortOptions(showOwner: boolean): {
  value: string;
  sort: ClientListSortKey;
  dir: ClientListSortDir;
  label: string;
}[] {
  const labels: Record<ClientListSortKey, Record<ClientListSortDir, string>> = {
    name: { asc: "Name, A to Z", desc: "Name, Z to A" },
    location: { asc: "Location, A to Z", desc: "Location, Z to A" },
    contacts: { desc: "Contacts, most first", asc: "Contacts, fewest first" },
    owner: { asc: "Owner, A to Z", desc: "Owner, Z to A" },
  };
  return CLIENT_LIST_SORT_KEYS.filter((sort) => showOwner || sort !== "owner").flatMap((sort) => {
    const first = clientListDefaultDir(sort);
    const second: ClientListSortDir = first === "asc" ? "desc" : "asc";
    return [first, second].map((dir) => ({
      value: `${sort}:${dir}`,
      sort,
      dir,
      label: labels[sort][dir],
    }));
  });
}

/** The label of a column header, for the places that name the column (the
 * header itself, and what a screen reader is told the list is sorted by). */
export const CLIENT_LIST_SORT_LABELS: Record<ClientListSortKey, string> = {
  name: "Name",
  location: "Location",
  contacts: "Contacts",
  owner: "Owner",
};

const NULLS_LAST = "last" as const;

/**
 * The Prisma `orderBy` for the list. Pure, so the exact query shape has a unit
 * test without a database.
 *
 * Every ordering ends the same way, and that ending is not decoration:
 *
 *  - `id` always comes last. `ORDER BY` on a column with equal values leaves
 *    those rows in no defined order, and with `skip`/`take` each page is its
 *    own query, so one company could appear on two pages and another on none.
 *    `id` is unique, so nothing ties past it.
 *  - Every ordering other than `name` has `name` just before `id`. That is
 *    for the reader as much as for stability: companies that tie on the sorted
 *    column (all the one-contact companies, all the ones in one city, all one
 *    manager's) come out alphabetical inside the tie rather than in the order
 *    they were imported.
 *  - Both are ascending whatever `dir` is. "Z to A" reverses the column the
 *    user clicked, not the tie-break inside it.
 *
 * Nulls: `country`, `city` and the owner's name are nullable, and are all
 * `nulls: "last"` in both directions. Postgres's own default would put them
 * first in descending order, and most imported companies have no owner, so
 * "Owner, Z to A" would open on thousands of unassigned rows. A company with
 * nothing to sort on belongs after every company that has something, whichever
 * way the column is sorted.
 *
 * Per column:
 *  - `location`: `country`, then `city`. `country` holds an ISO code, so the
 *    order is by code, not by the country name the list displays ("AT" before
 *    "AU", so Austria before Australia).
 *  - `contacts`: the count of the `contacts` relation, which Prisma orders by
 *    directly (`_count`), with no rows fetched to count in memory.
 *  - `owner`: the owner's `name`, then `ownerId`. The second key keeps one
 *    manager's companies together when two managers share a name. It also
 *    separates the two kinds of company the first key cannot: an owner with no
 *    `name` is listed by their email, so they are a real owner, yet their
 *    `name` is null exactly like an unowned company's. `ownerId` is null only
 *    for the unowned, so with `nulls: "last"` the unowned come after nameless
 *    owners in both directions. Nameless owners follow every named one, in
 *    id order rather than alphabetically by email.
 */
export function clientListOrderBy(
  sort: ClientListSortKey,
  dir: ClientListSortDir
): Prisma.CompanyOrderByWithRelationInput[] {
  const nullable = { sort: dir, nulls: NULLS_LAST };
  const tail: Prisma.CompanyOrderByWithRelationInput[] = [{ name: "asc" }, { id: "asc" }];

  switch (sort) {
    case "name":
      return [{ name: dir }, { id: "asc" }];
    case "location":
      return [{ country: nullable }, { city: nullable }, ...tail];
    case "contacts":
      return [{ contacts: { _count: dir } }, ...tail];
    case "owner":
      return [
        { owner: { name: nullable } },
        { ownerId: { sort: "asc", nulls: NULLS_LAST } },
        ...tail,
      ];
  }
}

/** The `skip`/`take` for `page` of `pageSize`. `take` is `undefined` for "all",
 * which Prisma reads as no limit. */
export function clientListSlice(
  page: number,
  pageSize: ClientListPageSize
): { skip: number; take: number | undefined } {
  if (pageSize === CLIENT_LIST_ALL) return { skip: 0, take: undefined };
  return { skip: (Math.max(page, 1) - 1) * pageSize, take: pageSize };
}

/** Where a result set sits: the page actually shown (clamped to the real
 * range), how many pages there are, and which rows -- 1-based, inclusive --
 * the page covers. For no rows at all, `from` and `to` are both 0. */
export type ClientListWindow = {
  page: number;
  pageCount: number;
  from: number;
  to: number;
};

/**
 * The window onto `total` rows for the requested `page`. A page past the end
 * is clamped to the last one, not to the first and not an error: a manager
 * whose link was made when there were more results, or who deleted the last
 * company on page 7, should land on the nearest page that exists.
 *
 * "All" is always page 1 of 1. An empty result is page 1 of 1 as well, so the
 * controls never read "page 1 of 0".
 */
export function clientListWindow(
  page: number,
  pageSize: ClientListPageSize,
  total: number
): ClientListWindow {
  if (total <= 0) return { page: 1, pageCount: 1, from: 0, to: 0 };
  if (pageSize === CLIENT_LIST_ALL) return { page: 1, pageCount: 1, from: 1, to: total };

  const pageCount = Math.ceil(total / pageSize);
  const clamped = Math.min(Math.max(page, 1), pageCount);
  const from = (clamped - 1) * pageSize + 1;
  return { page: clamped, pageCount, from, to: Math.min(clamped * pageSize, total) };
}

const NUMBER = new Intl.NumberFormat("en-US");

/**
 * The line that says what is on screen: "21–40 of 1,284 companies", or
 * "1–7 of 7 matching companies" when a search is active. Without the total a
 * manager cannot tell a narrow search from a broken one.
 *
 * Fixed to the `en-US` formatter on purpose: the server renders this, and a
 * locale that differs between the server and the viewer would otherwise be a
 * hydration mismatch for anything that rendered it twice.
 */
export function clientListSummary(
  window: Pick<ClientListWindow, "from" | "to">,
  total: number,
  searching: boolean
): string {
  const adjective = searching ? "matching " : "";
  if (total <= 0) return `0 ${adjective}companies`;
  const noun = `${adjective}${total === 1 ? "company" : "companies"}`;
  const range =
    window.from === window.to
      ? NUMBER.format(window.from)
      : `${NUMBER.format(window.from)}–${NUMBER.format(window.to)}`;
  return `${range} of ${NUMBER.format(total)} ${noun}`;
}

/**
 * The URL for a /clients view, with defaults left out so a shared link stays
 * short: no `q` when empty, no `page` for page 1, no `pageSize` for the
 * default, no `sort` for name, and no `dir` for the sorted column's own default
 * direction (see `clientListDefaultDir`). Leaving `page` out is also what sends
 * a changed search, page size or sort back to page 1 -- a caller that wants to
 * keep the page passes it.
 *
 * `dir` is only meaningful next to the `sort` it is given with, so a caller
 * changing the column passes both (see `nextClientListSort`). A `dir` with no
 * `sort` means the default column, name.
 */
export function clientListHref(request: {
  q?: string;
  page?: number;
  pageSize?: ClientListPageSize;
  sort?: ClientListSortKey;
  dir?: ClientListSortDir;
}): string {
  const search = new URLSearchParams();
  const q = clientListTerm(request.q ?? "");
  if (q) search.set("q", q);
  if (request.pageSize && request.pageSize !== CLIENT_LIST_DEFAULT_PAGE_SIZE) {
    search.set("pageSize", String(request.pageSize));
  }
  const sort = request.sort ?? CLIENT_LIST_DEFAULT_SORT;
  if (sort !== CLIENT_LIST_DEFAULT_SORT) search.set("sort", sort);
  if (request.dir && request.dir !== clientListDefaultDir(sort)) search.set("dir", request.dir);
  if (request.page && request.page > 1) search.set("page", String(request.page));
  const query = search.toString();
  return query ? `/clients?${query}` : "/clients";
}

type Contains = { contains: string; mode: "insensitive" };

/** One column test inside a word's `OR`. An array rather than a tuple: the
 * country clause is conditional, since a word only yields one when it resolves
 * to a country code, and a fixed-length tuple cannot express "sometimes six". */
type WordMatch =
  | { name: Contains }
  | { city: Contains }
  | { country: Contains }
  | { country: { equals: string } }
  | { website: Contains }
  | {
      contacts: {
        some: { OR: [{ firstName: Contains }, { lastName: Contains }, { email: Contains }] };
      };
    };

/** One of the clauses `clientListWhere` puts in its `AND`: the viewer's scope,
 * or a per-word match. Typed loosely on purpose -- it is handed to Prisma as a
 * `CompanyWhereInput`, which checks the real shape. */
export type ClientListClause = CompanyScopeWhere | { OR: WordMatch[] };

function wordClause(word: string): Exclude<ClientListClause, CompanyScopeWhere> {
  const contains: Contains = { contains: word, mode: "insensitive" };

  // `Company.country` stores an ISO alpha-2 code, so a manager typing
  // "Australia" would match nothing without this -- and typing the country is
  // the obvious thing to do on a list whose visibility is granted by country.
  // `normalizeCountryInput` knows the official names, the colloquial ones the
  // ACT! import added ("China", "Turkey") and a few aliases ("UK" -> "GB"), so
  // one extra clause covers all of them. A word that is not a country resolves
  // to null and adds nothing.
  const asCountryCode = normalizeCountryInput(word);

  return {
    OR: [
      { name: contains },
      { city: contains },
      { country: contains },
      ...(asCountryCode ? [{ country: { equals: asCountryCode } }] : []),
      { website: contains },
      {
        contacts: {
          some: { OR: [{ firstName: contains }, { lastName: contains }, { email: contains }] },
        },
      },
    ],
  };
}

/**
 * The `where` for the clients list: `scope` (what the viewer may see) AND, for
 * every word of `term`, "the company's name, city, country or website contains
 * it, or one of its contacts' first name, last name or email does" -- all
 * case-insensitive `contains`.
 *
 * A one-word term is exactly one `OR` over those columns. A longer one is one
 * such `OR` per word, ANDed, so "john smith" finds a company with a contact
 * called John Smith (the name is split across two columns, so no single
 * `contains` of the phrase could) and "acme sydney" finds Acme in Sydney. Same
 * rule, and same cap on words, as the builder's picker: see `clientSearchWhere`
 * in ./client-search.ts.
 *
 * `country` is matched both as stored -- an ISO alpha-2 code for most
 * companies ("AU"), free text for a few legacy ones -- and as a name resolved
 * through `normalizeCountryInput`, so "Australia", "USA" and "Turkey" all find
 * their companies. Without that second clause, typing a country name found
 * nothing, which is a poor answer on a list whose visibility is itself granted
 * by country.
 *
 * `scope` goes in `AND` untouched and is never spread next to the search
 * clauses, for the reason `clientSearchWhere` gives at length:
 * `companyWhereForUser` returns `{ OR: [...] }` for a manager with a country
 * grant, and a spread of two `OR`s keeps only the second.
 *
 * Indexes: do not add any for this. The trigram indexes from
 * z62_client_search_trgm (Company.name, Contact.firstName/lastName) exist, and
 * Postgres does not choose them for an `OR` that contains a subquery; it scans.
 * That is fine at this size -- the same shape measured 20.6 ms over 8,810
 * companies and 10,473 contacts on the production-sized rehearsal database
 * (2026-10-08), sequential scan included. A further index would be written,
 * stored and maintained on every ACT! import and never read.
 *
 * An empty `term` is no search: the scope alone.
 */
export function clientListWhere(
  scope: CompanyScopeWhere,
  term: string
): { AND: ClientListClause[] } | CompanyScopeWhere {
  const words = clientSearchWords(term);
  if (words.length === 0) return scope;
  return { AND: [scope, ...words.map(wordClause)] };
}
