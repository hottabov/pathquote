"use server";

import { requireSession } from "@/lib/authz";
import { searchClientCompanies, type ClientSearchCompany } from "@/lib/queries/client-search";

export type SearchClientsResult =
  | { ok: true; companies: ClientSearchCompany[] }
  | { error: string };

/**
 * The builder client picker's search, as called from the browser while a
 * manager types.
 *
 * Takes the query and nothing else. Whose clients to search is never an
 * argument: it comes from the session here, because an action is a public POST
 * endpoint and a `user` parameter would let the caller pick whose scope they
 * are searched in. (A forged `query` can only ever search the caller's own
 * scope, and `searchClientCompanies` bounds its length and its page.)
 *
 * What this shows is not what `setDocumentClient` allows: that action
 * re-checks the company against the caller's scope itself, and stays the
 * boundary on what can be attached to a quote.
 *
 * Note for whoever calls this on every keystroke: Next.js dispatches Server
 * Actions one at a time per client (docs: "Sequential dispatch on the
 * client"), so a search in flight delays any other action behind it --
 * `setDocumentClient` included. The picker debounces for that reason.
 */
export async function searchClients(query: string): Promise<SearchClientsResult> {
  const session = await requireSession();
  if (typeof query !== "string") return { error: "Invalid input" };

  return { ok: true, companies: await searchClientCompanies(session.user, query) };
}
