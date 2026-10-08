import { db } from "@/lib/db";
import { companyWhereForUser, type ScopeUser } from "@/lib/scope";
import {
  CLIENT_SEARCH_PAGE_SIZE,
  clientSearchOrderBy,
  clientSearchTerm,
  clientSearchWhere,
} from "@/lib/client-search";

/**
 * What the builder's client picker is offered: one page of companies, each
 * with its contacts. The rules that decide *which* companies, and in what
 * order -- the search term, the match on contact names, the AND with the
 * viewer's scope, newest-first when there is no term -- are the pure functions
 * in src/lib/client-search.ts; this file only runs them.
 *
 * This replaced `listClientPickerCompanies`, which loaded every visible
 * company with every contact and let the browser filter. After the ACT!
 * import that was 8,810 companies and 10,473 contacts: 2,158 kB of JSON on
 * every builder page open, against 29 ms of SQL (measured on the rehearsal
 * database, 2026-10-08). Do not reintroduce a full preload as an
 * optimisation.
 */

export type ClientSearchCompany = {
  id: string;
  name: string;
  /** `Industry.id`, or null. */
  industryId: string | null;
  /** Shown on a result row, with `country`, to tell similarly-named companies
   * apart -- see `clientLocation`. */
  city: string | null;
  /** An ISO 3166-1 alpha-2 code, or free text on older rows. */
  country: string | null;
  /** Ordered `isPrimary` desc, `firstName` asc -- see `searchClientCompanies`. */
  contacts: { id: string; firstName: string; lastName: string | null; isPrimary: boolean }[];
};

/**
 * The picker's page: up to `CLIENT_SEARCH_PAGE_SIZE` companies matching
 * `query`, among those `user` may see -- by name when there is a search, newest
 * first when there is not (`clientSearchOrderBy`). An empty or too-short query
 * is not a search and returns the newest page -- see `clientSearchTerm`.
 *
 * `Company.createdAt` has no index, so the unsearched page sorts every visible
 * company in memory to take its top hundred. The by-name order it replaced was
 * no better off (`name` only has a trigram index, which cannot serve an ORDER
 * BY), so this is not a regression; if the table ever grows by an order of
 * magnitude, an index on `createdAt` is the fix. Not measured.
 *
 * Scoped through `companyWhereForUser`, always. The scope is what the viewer
 * may see; `setDocumentClient` separately re-checks what they may attach, and
 * that stays the real boundary -- this narrows what is shown.
 *
 * Each company's contacts come back ordered `isPrimary` desc, `firstName` asc,
 * exactly as the preload's query ordered them. The picker's client component
 * auto-selects `contacts[0]` to mirror the contact `setDocumentClient` assigns
 * when none is submitted (see lifecycle.ts), so that ordering is load-bearing,
 * not cosmetic. `id` breaks ties in the company order, so a page does not
 * reshuffle between identical requests.
 */
export async function searchClientCompanies(
  user: ScopeUser,
  query: string
): Promise<ClientSearchCompany[]> {
  const term = clientSearchTerm(query);
  return db.company.findMany({
    where: clientSearchWhere(companyWhereForUser(user), term),
    orderBy: clientSearchOrderBy(term),
    take: CLIENT_SEARCH_PAGE_SIZE,
    select: {
      id: true,
      name: true,
      industryId: true,
      city: true,
      country: true,
      contacts: {
        orderBy: [{ isPrimary: "desc" }, { firstName: "asc" }],
        select: { id: true, firstName: true, lastName: true, isPrimary: true },
      },
    },
  });
}
