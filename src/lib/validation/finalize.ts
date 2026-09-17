// Pure finalize-eligibility check, split out of src/lib/actions/finalize.ts
// for the same reason src/lib/validation/documents.ts is split out of
// src/lib/actions/documents.ts: this file must have zero `@/lib/db` or
// `next/*` imports (importing `@/lib/db` eagerly constructs a Prisma client
// against `DATABASE_URL`, which isn't set — and shouldn't need to be — for
// a plain `vitest run` of pure logic; see tests/finalize-validation.test.ts).
// `EngineViolation` is a plain type from the dependency-free pricing engine
// (src/lib/pricing.ts).
import { concessionCapMessage, markupCapMessage, type DocumentConcession, type EngineViolation } from "../pricing";

/** The minimal shape `validateFinalizable` needs — deliberately not typed
 * against Prisma's generated `Document` payload so this stays trivial to
 * unit test with hand-built fixtures. `lines` is expected to already be
 * narrowed to document-level lines the way `finalizeDocument` loads them
 * (`lines: { where: { itemId: null } }`) — but the `itemId` check is still
 * applied here defensively in case a caller passes an unfiltered list. */
export type FinalizableDocument = {
  companyId: string | null;
  items: unknown[];
  lines: { itemId: string | null }[];
};

/** The roles that can ever call `finalizeDocument` — kept as a local
 * string-literal union rather than importing Prisma's generated `Role` enum,
 * for the same "no `@/lib/db`-adjacent import" reason as everything else in
 * this file (the enum itself has no runtime/env dependency, but there's no
 * need to couple this pure module to `@prisma/client` either). DEVELOPER
 * carries the same finalize rights as ADMIN — see `isAdminRole`. */
export type FinalizerRole = "ADMIN" | "MANAGER" | "DEVELOPER";

/**
 * Returns a human-readable reason the document can't be finalized, or
 * `null` when it's ready. Checked in this order so a caller only ever sees
 * one actionable message at a time:
 *   1. no client selected yet;
 *   2. nothing to bill — zero items AND zero document-level lines;
 *   3. the pricing engine flagged a discount above its region cap (an item
 *      discount can end up violating its cap after the fact if an admin
 *      lowers `Region.maxDiscountPct` later — see the NOTE on
 *      `recalcDocument` in src/lib/actions/documents.ts — so this must be
 *      re-checked at finalize time, not just at save time). Blocks every
 *      role: any role may SAVE an over-cap draft, but none may finalize it.
 *   4. the whole-document `documentConcession` (see its own doc comment on
 *      `PricingTotals` in src/lib/pricing.ts) exceeds the region cap — same
 *      re-check-at-finalize-time reasoning as #3 (a cap can be lowered after
 *      a manual price was saved), and likewise blocks every role; the markup
 *      ceiling (`exceedsMarkupCap`) is checked the same way. This is the finalize-time half of closing Ross's hole: without
 *      it, a MANAGER could still get an over-cap manually-priced document
 *      *saved* as a draft (blocked at every mutating action — see
 *      `recalcAndEnforce`, src/lib/actions/documents.ts) but never actually
 *      finalized only by luck of ordering; checking it here too means
 *      finalize refuses on its own even if some future save path ever
 *      forgets to.
 */
export function validateFinalizable(
  doc: FinalizableDocument,
  violations: EngineViolation[],
  documentConcession: DocumentConcession,
  role: FinalizerRole,
  regionName: string,
  currency: string,
  currencySymbol: string | null = null
): string | null {
  if (!doc.companyId) {
    return "Select a client before finalizing";
  }

  const hasDocumentLevelLines = doc.lines.some((line) => line.itemId === null);
  if (doc.items.length === 0 && !hasDocumentLevelLines) {
    return "Add at least one item or line before finalizing";
  }

  // The region's discount cap and markup ceiling are hard limits at
  // finalize, for EVERY role (Vadym, 2026-09-17): a quote over the limit is
  // never finalized, not even by an admin -- an admin who wants the deal
  // raises the region's limit in Settings first, which is a visible,
  // deliberate act rather than a warning clicked past. `role` is kept in the
  // signature for callers and for any future role-specific rule.
  void role;

  if (violations.length > 0) {
    const detail = violations
      .map((v) => `item ${v.itemIndex + 1} (max ${v.allowedPct}%)`)
      .join(", ");
    return `Reduce the discount before finalizing: ${detail}`;
  }

  if (documentConcession.exceedsCap) {
    return `Reduce the discount before finalizing: ${concessionCapMessage(documentConcession, regionName, currency, currencySymbol)}`;
  }

  if (documentConcession.exceedsMarkupCap) {
    return `Reduce the price before finalizing: ${markupCapMessage(documentConcession, regionName, currency, currencySymbol)}`;
  }

  return null;
}
