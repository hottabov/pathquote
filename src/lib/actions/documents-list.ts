"use server";

import { requireSession } from "@/lib/authz";
import { listDocuments } from "@/lib/queries/documents-list";
import { parseLoadedCount, toQuoteListRows, type QuoteListRow } from "@/components/documents/quote-list-rows";

/** What `listRemainingQuotes` hands back: the rows the browser did not yet
 * have plus the current total, or the one error a caller can show. */
export type RemainingQuotesResult = { rows: QuoteListRow[]; total: number } | { error: string };

/**
 * The "Show all" half of the /quotes list.
 *
 * The page renders the most recent `DOCUMENT_LIST_PAGE_SIZE` quotes
 * (src/app/(app)/quotes/page.tsx); when the viewer's scope holds more, the
 * list offers to load the rest, and this is what it calls. `loaded` is how
 * many rows the browser already holds, used as the offset to continue from --
 * nothing else about the request comes from the client.
 *
 * The scope is NOT a parameter. It is `documentWhereForUser` on the session
 * this action reads for itself, applied inside `listDocuments` exactly as the
 * page applied it, so a MANAGER's "Show all" is all of THEIR quotes however the
 * request was shaped. The rows are then built by the same `toQuoteListRows`
 * the page used, so `canDelete` and the Salesperson gating cannot differ
 * between the first 200 rows and the rest.
 *
 * `requireSession` redirects to /login when there is no session; inside a
 * server action that surfaces to the caller as a thrown redirect rather than
 * a result, which is the right outcome for a list request from a signed-out
 * tab.
 */
export async function listRemainingQuotes(loaded: unknown): Promise<RemainingQuotesResult> {
  const session = await requireSession();

  const skip = parseLoadedCount(loaded);
  if (skip === null) return { error: "Could not load the remaining quotes. Reload the page and try again." };

  const { rows, total } = await listDocuments(session.user, { skip, limit: null, withTotal: true });
  return { rows: toQuoteListRows(rows, session.user.role), total };
}
