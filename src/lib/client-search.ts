// The pure half of the builder's client search: how a typed query becomes a
// search term, how that term becomes a Prisma `where` and an ordering, how a
// result row is described, and what the open list says about the search. No
// database here, so every rule below has a unit test; the query that runs it
// is src/lib/queries/client-search.ts and stays a thin shell.

import { displayCountry } from "./countries";
import type { CompanyScopeWhere } from "./scope";

/** Results per search. Also what an empty or too-short query returns: the
 * newest companies (see `clientSearchOrderBy`), so the picker never opens onto
 * a blank list.
 *
 * It was 20, which hid companies a manager knew were there: with 8,809 imported
 * companies, "Ikon Boats" was simply not among the first twenty. A hundred rows
 * is a scrolling list, not a full catalogue, and it is still a proportion of
 * the 2,158 kB the old preload shipped -- roughly 25 kB, against 5 kB for
 * twenty -- so the page size is a trade, not free. Raise it with the payload in
 * mind, not just because a list felt short. */
export const CLIENT_SEARCH_PAGE_SIZE = 100;

/** The shortest term that is searched for. Two things agree on three: the
 * trigram indexes of z62_client_search_trgm cannot serve a shorter pattern, so
 * a one- or two-letter `contains` would be a sequential scan that matches a
 * large part of the table anyway -- and below three letters a manager has not
 * yet said what they are looking for. Shorter queries list the first page. */
export const CLIENT_SEARCH_MIN_LENGTH = 3;

/** Longest query honoured; the rest is cut. Generous for a company name, and
 * it bounds what a hand-built request can make the database compare. */
export const CLIENT_SEARCH_MAX_LENGTH = 100;

/** Words of a query that are used; the rest are ignored. Each word is a
 * subquery on `Contact`, so this bounds the cost of a pasted paragraph. */
export const CLIENT_SEARCH_MAX_WORDS = 5;

/**
 * The term to search for, or `""` when the query is empty or too short to
 * search. Whitespace is trimmed and runs of it collapsed, so "  pt   noitex "
 * and "pt noitex" are one search -- which is also what lets the picker skip a
 * request when a keystroke changes nothing that counts.
 *
 * Length is measured after trimming: three spaces are not a search.
 */
export function clientSearchTerm(raw: string): string {
  const term = raw.trim().replace(/\s+/g, " ").slice(0, CLIENT_SEARCH_MAX_LENGTH).trim();
  return term.length >= CLIENT_SEARCH_MIN_LENGTH ? term : "";
}

/** The words of a term, in order, at most `CLIENT_SEARCH_MAX_WORDS`. */
export function clientSearchWords(term: string): string[] {
  if (term === "") return [];
  return term.split(" ").slice(0, CLIENT_SEARCH_MAX_WORDS);
}

/**
 * The `where` for one search: `scope` (what the viewer may see) AND, for every
 * word of `term`, "the company's name contains it, or one of its contacts'
 * first or last names does" -- all case-insensitive.
 *
 * Every word must match somewhere, not the whole phrase as one string. That is
 * what makes "john smith" find a company with a contact called John Smith:
 * the name is split across two columns, so no single `contains` could. For a
 * one-word query it is exactly "name or any contact name contains it". A word
 * may be satisfied by a different contact than its neighbour ("john" by one
 * person, "smith" by another at the same company); that over-matches slightly,
 * in the direction of showing a manager one more candidate, never one they may
 * not see -- the scope is applied regardless.
 *
 * `scope` goes in `AND` untouched and is never spread next to the search
 * clauses. `companyWhereForUser` returns `{ OR: [...] }` for a manager holding
 * a country grant, and this filter needs an `OR` of its own: spreading both
 * into one object would let whichever came second silently replace the
 * other. Losing the scope's `OR` would show a manager clients they do not own
 * and have no grant for; losing ours would turn the search off.
 *
 * An empty `term` is no search: the scope alone.
 */
export function clientSearchWhere(
  scope: CompanyScopeWhere,
  term: string
): { AND: CompanySearchClause[] } | CompanyScopeWhere {
  const words = clientSearchWords(term);
  if (words.length === 0) return scope;
  return { AND: [scope, ...words.map(wordClause)] };
}

type Contains = { contains: string; mode: "insensitive" };

/** One of the clauses `clientSearchWhere` puts in its `AND`: the viewer's
 * scope, or a per-word match. Typed loosely on purpose -- it is handed to
 * Prisma as a `CompanyWhereInput`, which checks the real shape. */
export type CompanySearchClause =
  | CompanyScopeWhere
  | {
      OR: [
        { name: Contains },
        { contacts: { some: { OR: [{ firstName: Contains }, { lastName: Contains }] } } },
      ];
    };

function wordClause(word: string): Exclude<CompanySearchClause, CompanyScopeWhere> {
  const contains: Contains = { contains: word, mode: "insensitive" };
  return {
    OR: [
      { name: contains },
      { contacts: { some: { OR: [{ firstName: contains }, { lastName: contains }] } } },
    ],
  };
}

/** A `Company` order-by clause, as far as the search uses them. Assignable to
 * Prisma's `CompanyOrderByWithRelationInput`; kept structural so this file
 * stays free of the Prisma client. */
export type ClientSearchOrder = { createdAt: "desc" } | { name: "asc" } | { id: "asc" };

/**
 * How a page of results is ordered.
 *
 * With no term -- the picker just opened, or too little was typed to search --
 * the NEWEST companies come first. A manager who entered a client in ACT! this
 * week, and let the sync run, is about to build that client's quote; the first
 * thing they should see is that company, not the same twenty beginning with
 * "A". Ordering by name there was a list that never changed.
 *
 * A caveat that is true today and will stop being true: the initial ACT!
 * import created 8,735 companies within a few minutes, so for now the head of
 * this order is the tail of that import and carries no meaning of its own. It
 * becomes useful as new clients trickle in on top of it, and that steady state
 * is what it is for.
 *
 * With a term the order is by name: someone who types is looking for a specific
 * company, not a recent one, and name order is what lets them scan the matches.
 *
 * `id` breaks ties in both -- same-named companies (an ACT! import can hold two
 * of one name in different countries) and same-instant creations (a batch)
 * would otherwise swap places between identical requests.
 */
export function clientSearchOrderBy(term: string): ClientSearchOrder[] {
  return term === "" ? [{ createdAt: "desc" }, { id: "asc" }] : [{ name: "asc" }, { id: "asc" }];
}

/**
 * Where a company is, for a result row: "Sydney, Australia", "Australia", the
 * city alone, or null when neither is on file. The country is stored as an ISO
 * code (or, for older rows, free text) and shown as its English name, the same
 * as everywhere else (`displayCountry`).
 *
 * This is what tells two similarly-named companies apart, so it is the second
 * line of every row that has it.
 */
export function clientLocation(company: { city: string | null; country: string | null }): string | null {
  const parts = [company.city?.trim(), displayCountry(company.country)?.trim()].filter(
    (part): part is string => Boolean(part)
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

type NamedContact = { firstName: string; lastName: string | null };

function fullName(contact: NamedContact): string {
  return [contact.firstName, contact.lastName].filter(Boolean).join(" ");
}

/** Contacts named on a row before "+N more" takes over. */
const MATCHED_CONTACTS_SHOWN = 2;

/**
 * Why a company is in the results when its own name is not the reason: the
 * contacts that matched, as a line for the row ("Matches contact John Smith",
 * "Matches contacts John Smith, Anna Jones +1 more"). Null when the row needs
 * no such line.
 *
 * A company gets one only when its name does not already contain every word of
 * the search; a name that does is the reason it matched, and naming contacts
 * beside it would be noise. Matching mirrors the server's (case-insensitive
 * `contains`, on first or last name), so a contact is named here exactly when
 * it could have caused the match. Without the line, a manager who typed
 * "smith" is shown "Acme Pty Ltd" and cannot tell why.
 *
 * `term` is the term the results answer, not whatever has been typed since.
 */
export function clientContactMatchText(
  company: { name: string; contacts: NamedContact[] },
  term: string
): string | null {
  const words = clientSearchWords(term).map((word) => word.toLowerCase());
  if (words.length === 0) return null;

  const name = company.name.toLowerCase();
  if (words.every((word) => name.includes(word))) return null;

  const matching = company.contacts.filter((contact) => {
    const first = contact.firstName.toLowerCase();
    const last = (contact.lastName ?? "").toLowerCase();
    return words.some((word) => first.includes(word) || last.includes(word));
  });
  if (matching.length === 0) return null;

  const shown = matching.slice(0, MATCHED_CONTACTS_SHOWN).map(fullName).join(", ");
  const more = matching.length - MATCHED_CONTACTS_SHOWN;
  return `Matches ${matching.length === 1 ? "contact" : "contacts"} ${shown}${more > 0 ? ` +${more} more` : ""}`;
}

export type ClientSearchStatusKind =
  | "failed"
  | "tooShort"
  | "loading"
  | "searching"
  | "empty"
  | "full"
  | "results";

/**
 * What the open list says about itself, in order of importance: a failure, a
 * hint that what was typed is too short to search, the first load, a search in
 * flight, nothing found (with what to do about it), a page that may be cut
 * short, then the plain count. The same text is shown at the top of the list
 * and announced to a screen reader when the list opens or the answer changes.
 *
 * - `tooShort` outranks `loading` and `searching`: a person who has typed two
 *   letters needs to hear why nothing is narrowing, more than that a request
 *   for the default list is under way.
 * - `outcome` is the latest finished search, or null before the first answer;
 *   `outcome.term` is the term it answered, which is what the wording about
 *   the results is for. `searching` is true when that differs from the term now
 *   typed.
 */
export function clientSearchStatus(input: {
  tooShort: boolean;
  searching: boolean;
  outcome: { term: string; count: number; failed: boolean } | null;
}): { kind: ClientSearchStatusKind; text: string } {
  const { tooShort, searching, outcome } = input;

  if (outcome?.failed && !searching) return { kind: "failed", text: "Search failed." };
  if (tooShort) {
    return { kind: "tooShort", text: `Type ${CLIENT_SEARCH_MIN_LENGTH} or more letters to search.` };
  }
  if (outcome === null) return { kind: "loading", text: "Loading companies…" };
  if (searching) return { kind: "searching", text: "Searching…" };

  if (outcome.count === 0) {
    return {
      kind: "empty",
      text:
        outcome.term === ""
          ? "No clients are available to you yet. Use + New company to add one."
          : `No company or contact matches “${outcome.term}”. Check the spelling, try fewer letters, or use + New company.`,
    };
  }

  if (outcome.count >= CLIENT_SEARCH_PAGE_SIZE) {
    return {
      kind: "full",
      text:
        outcome.term === ""
          ? `Showing the ${CLIENT_SEARCH_PAGE_SIZE} newest companies. Type ${CLIENT_SEARCH_MIN_LENGTH} or more letters to search.`
          : `Showing the first ${CLIENT_SEARCH_PAGE_SIZE} matches. Type more to narrow them down.`,
    };
  }

  return {
    kind: "results",
    text:
      outcome.term === ""
        ? `Newest companies first. Type ${CLIENT_SEARCH_MIN_LENGTH} or more letters to search.`
        : `${outcome.count} ${outcome.count === 1 ? "match" : "matches"}`,
  };
}
