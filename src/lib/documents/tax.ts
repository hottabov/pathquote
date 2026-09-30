/**
 * Resolving a document's tax — the one decision about which rate a quote is
 * actually charged at. `recalcDocument` (./recalc.ts) is the only caller: it
 * builds the suggestion (./tax-rules.ts), calls this, feeds `taxRate` to the
 * pricing engine and persists `refresh` when it is non-null.
 *
 * Three rules, in order:
 *
 * 1. Freeze. A FINAL document is a quote a customer holds. Its tax is
 *    whatever it was when the number was allocated; no later region edit,
 *    client edit or rule change may rewrite it. Any status other than
 *    DRAFT is treated as frozen, so a status added later defaults to the
 *    conservative behaviour.
 * 2. Override. A draft whose salesperson chose Custom keeps their name and
 *    rate. It never blocks on the suggestion (Custom is how a blocked
 *    suggestion is resolved), only on a missing reason.
 * 3. Suggestion. An Auto draft carries the current suggestion: the row is a
 *    cache of it, refreshed on every recalc, and only becomes a snapshot at
 *    finalize.
 *
 * `taxRate` is the rate actually charged (0 on an export), not the region's
 * nominal rate. Pure: no Prisma, no `@/lib/db`.
 */
import type { TaxSuggestion, TaxTreatment } from "./tax-rules";

export type DocumentTaxRow = {
  taxTreatment: TaxTreatment;
  taxName: string;
  /** `Decimal(5,2)` rendered with `.toString()`. */
  taxRate: string;
  taxOverridden: boolean;
  taxNote: string | null;
};

export type ResolveTaxInput = {
  /** `Document.status`. */
  status: string;
  document: DocumentTaxRow;
  suggestion: TaxSuggestion;
};

export type TaxFigures = { taxTreatment: TaxTreatment; taxName: string; taxRate: string };

export type ResolvedTax = TaxFigures & {
  /** What to write back to the row, or null when it already agrees. Always
   * null for a frozen or overridden document. */
  refresh: TaxFigures | null;
  /** Why the document cannot be finalized as it stands, or null. */
  blocker: string | null;
};

export function resolveDocumentTax(input: ResolveTaxInput): ResolvedTax {
  const { document, suggestion } = input;
  const current: TaxFigures = {
    taxTreatment: document.taxTreatment,
    taxName: document.taxName,
    taxRate: document.taxRate,
  };

  if (input.status !== "DRAFT") {
    return { ...current, refresh: null, blocker: null };
  }

  if (document.taxOverridden) {
    return {
      ...current,
      refresh: null,
      blocker: document.taxNote?.trim() ? null : "Give a reason for the custom tax",
    };
  }

  const next: TaxFigures = {
    taxTreatment: suggestion.treatment,
    taxName: suggestion.taxName,
    taxRate: suggestion.taxRate,
  };
  // Numeric rate comparison: "10" and "10.00" are the same Decimal.
  const changed =
    next.taxTreatment !== current.taxTreatment ||
    next.taxName !== current.taxName ||
    Number(next.taxRate) !== Number(current.taxRate);

  return { ...next, refresh: changed ? next : null, blocker: suggestion.blocker };
}
