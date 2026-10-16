import type { DocumentStatus, SigningStatus } from "@prisma/client";
import type { DocumentListItem } from "@/lib/queries/documents-list";
import { canSeeSalesperson, isAdminRole, isDeveloperRole } from "@/lib/roles";
import { signingStatusLabel } from "@/lib/signing/state";
import { formatMoney, relativeDate } from "@/lib/format";

/**
 * One row of the /quotes list, with every displayed string already
 * rendered on the server.
 *
 * Deliberately a view model rather than the `DocumentListItem` the query
 * returns: `QuotesList` is a client component, so anything it formats itself
 * ships to the browser along with it. Keeping `formatMoney`, `relativeDate`
 * and the two status-label helpers on the server means the search box can
 * also match exactly what the user can see, because the labels it searches
 * ARE the labels on screen — no second formatting path that could drift from
 * the first.
 *
 * `totalValue` and `updatedAtMs` ride along beside their labels purely so
 * those two columns sort by value; "A$1,200" and "Yesterday" sort as text
 * the way nobody wants.
 *
 * Built here, in a module with no React and no database, because two server
 * entry points produce these rows -- the page's first render and the "Show
 * all" server action that loads the rest (src/lib/actions/documents-list.ts)
 * -- and the per-role gating below must come out identical from both.
 */
export type QuoteListRow = {
  id: string;
  numberLabel: string;
  companyLabel: string;
  totalLabel: string;
  totalValue: number;
  status: DocumentStatus;
  statusLabel: string;
  signingStatus: SigningStatus;
  /** Null for NOT_SENT, which renders no second badge — see
   * `signingStatusLabel` (src/lib/signing/state.ts). */
  signingLabel: string | null;
  updatedLabel: string;
  updatedAtMs: number;
  canDelete: boolean;
  /** Who wrote the quote (see `DocumentListItem.salespersonName`), or `""`
   * for a viewer whose list has no Salesperson column -- see
   * `toQuoteListRows` for why the gating happens here and not in the
   * component. */
  salespersonLabel: string;
};

/**
 * Whether the /quotes list should render a delete button for `d` at all --
 * mirrors, but does not replace, what `deleteDocument`
 * (src/lib/actions/documents/lifecycle.ts) itself re-checks server-side.
 *
 * A SIGNED document is its own branch, checked first: `canDeleteDocument`
 * (src/lib/signing/state.ts) refuses it for everyone except a DEVELOPER, a
 * narrower rule than the ordinary "ADMIN, or a DRAFT" one below, so it must
 * be decided before that one rather than folded into it -- an ADMIN viewing
 * a signed quote must NOT see this button just because `isAdminRole` is
 * true for them too. Every other status keeps the existing rule: any
 * MANAGER may delete a DRAFT they can see, an ADMIN (or DEVELOPER, via
 * `isAdminRole`) may delete anything else.
 */
export function canDeleteFromList(
  d: Pick<DocumentListItem, "status" | "signingStatus">,
  role: string | null | undefined
): boolean {
  if (d.signingStatus === "SIGNED") return isDeveloperRole(role);
  return isAdminRole(role) || d.status === "DRAFT";
}

/**
 * The rows the /quotes list renders for a viewer of `role`.
 *
 * `salespersonLabel` is blanked here, before the rows are built, not in the
 * component: `rows` is a prop of a client component, so every row object is
 * serialized into the RSC payload the browser receives. Leaving the name on
 * a row whose column is not rendered would ship colleagues' names to a
 * viewer who never sees them -- harmless for today's roles (a viewer without
 * this column is scoped to their own quotes by `documentWhereForUser`, so the
 * only name on their rows is their own) but only because two hand-maintained
 * lists happen to agree. Gating it here makes the payload match the column
 * instead of relying on that.
 */
export function toQuoteListRows(
  documents: readonly DocumentListItem[],
  role: string | null | undefined
): QuoteListRow[] {
  const showSalesperson = canSeeSalesperson(role);

  return documents.map((d) => ({
    id: d.id,
    numberLabel: d.number ?? "Quote draft",
    companyLabel: d.companyName ?? "No client",
    totalLabel: formatMoney(d.total, d.currency, d.currencySymbol),
    totalValue: Number(d.total),
    status: d.status,
    statusLabel: d.status === "DRAFT" ? "Draft" : "Final",
    signingStatus: d.signingStatus,
    signingLabel: signingStatusLabel(d.signingStatus),
    updatedLabel: relativeDate(d.updatedAt),
    updatedAtMs: d.updatedAt.getTime(),
    canDelete: canDeleteFromList(d, role),
    salespersonLabel: showSalesperson ? d.salespersonName : "",
  }));
}

/**
 * The upper bound on the offset the "Show all" action accepts. Far above any
 * real list (production holds a few hundred quotes) and well below anything
 * that could make `skip` itself expensive; a request past it is not a list
 * continuation but a mistake, and is refused rather than clamped.
 */
export const MAX_LOADED_COUNT = 100_000;

/**
 * Validates what the browser says it already holds before the "Show all"
 * action uses it as an offset. Anything that is not a non-negative integer
 * within `MAX_LOADED_COUNT` -- a float, a negative, a string, `NaN`, a
 * hand-crafted request -- is `null`, and the action answers with an error.
 *
 * This is the only thing the action takes from the client, and it decides
 * nothing about WHICH rows come back: the scope is `documentWhereForUser` on
 * the session, applied inside the action. A wrong offset can at most skip or
 * repeat rows the caller is allowed to see anyway.
 */
export function parseLoadedCount(input: unknown): number | null {
  if (typeof input !== "number" || !Number.isInteger(input)) return null;
  if (input < 0 || input > MAX_LOADED_COUNT) return null;
  return input;
}
