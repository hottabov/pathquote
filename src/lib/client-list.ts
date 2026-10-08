// The pure half of the /clients list: how the URL's `q`, `page` and
// `pageSize` become a validated request, how a request becomes a Prisma
// `where` and a `skip`/`take`, and how the position on the page is described.
// No database and no React, so every rule below has a unit test; the query
// that runs it is `listCompanies` (src/lib/queries/clients.ts) and the markup
// is src/components/clients/clients-list.tsx.
//
// Why this exists: the ACT! import took /clients from two companies to 8,809,
// and the page used to ship every one of them to the browser.

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

/** What the URL asks for, after validation. */
export type ClientListRequest = {
  /** The normalised search term; `""` means no search. */
  q: string;
  /** 1-based, and not yet clamped to the last page: that needs the total. */
  page: number;
  pageSize: ClientListPageSize;
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

/**
 * The request in a /clients URL. Never throws, and trusts nothing: every field
 * is validated on its own, so one bad parameter does not cost the others -- a
 * good `q` survives a junk `page`.
 */
export function parseClientListParams(params: {
  q?: RawParam;
  page?: RawParam;
  pageSize?: RawParam;
}): ClientListRequest {
  return {
    q: clientListTerm(firstValue(params.q)),
    page: parsePage(firstValue(params.page)),
    pageSize: parsePageSize(firstValue(params.pageSize)),
  };
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
 * default. Leaving `page` out is also what sends a changed search or page size
 * back to page 1 -- a caller that wants to keep the page passes it.
 */
export function clientListHref(request: {
  q?: string;
  page?: number;
  pageSize?: ClientListPageSize;
}): string {
  const search = new URLSearchParams();
  const q = clientListTerm(request.q ?? "");
  if (q) search.set("q", q);
  if (request.pageSize && request.pageSize !== CLIENT_LIST_DEFAULT_PAGE_SIZE) {
    search.set("pageSize", String(request.pageSize));
  }
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
