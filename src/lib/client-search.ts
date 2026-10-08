// The pure half of the builder's client search: how a typed query becomes a
// search term, how that term becomes a Prisma `where`, and how a result is
// labelled. No database here, so every rule below has a unit test; the query
// that runs it is src/lib/queries/client-search.ts and stays a thin shell.

import type { CompanyScopeWhere } from "./scope";

/** Results per search. Also what an empty or too-short query returns: the
 * first page by name, so the picker never opens onto a blank list. */
export const CLIENT_SEARCH_PAGE_SIZE = 20;

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

type LabelledContact = { firstName: string; lastName: string | null };

function fullName(contact: LabelledContact): string {
  return [contact.firstName, contact.lastName].filter(Boolean).join(" ");
}

/** Contacts shown beside a company before "+N" takes over. */
const LABEL_CONTACTS = 2;

/**
 * The text of a result row. The company's name, plus -- when the company is
 * here because of a contact rather than its own name -- which contacts, so a
 * manager who typed "smith" can see why "Acme Pty Ltd" is on the list.
 *
 * A company is labelled with contacts only when its name does not already
 * contain every word of the search; a name that does is the reason it matched,
 * and naming contacts beside it would be noise. Matching mirrors the server's
 * (case-insensitive `contains`, on first or last name), so a contact is named
 * here exactly when it could have caused the match.
 */
export function clientResultLabel(
  company: { name: string; contacts: LabelledContact[] },
  term: string
): string {
  const words = clientSearchWords(term).map((word) => word.toLowerCase());
  if (words.length === 0) return company.name;

  const name = company.name.toLowerCase();
  if (words.every((word) => name.includes(word))) return company.name;

  const matching = company.contacts.filter((contact) => {
    const first = contact.firstName.toLowerCase();
    const last = (contact.lastName ?? "").toLowerCase();
    return words.some((word) => first.includes(word) || last.includes(word));
  });
  if (matching.length === 0) return company.name;

  const shown = matching.slice(0, LABEL_CONTACTS).map(fullName).join(", ");
  const more = matching.length - LABEL_CONTACTS;
  return `${company.name} — ${shown}${more > 0 ? ` +${more}` : ""}`;
}
