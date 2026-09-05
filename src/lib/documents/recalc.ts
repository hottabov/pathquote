import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getCommissionTiers } from "@/lib/queries/settings";
import { isAdminRole } from "@/lib/roles";
import {
  computeTotals,
  concessionCapMessage,
  markupCapMessage,
  type CommissionResult,
  type DocumentConcession,
  type EngineInput,
  type EngineViolation,
} from "@/lib/pricing";
import { resolveDocumentTax } from "./tax";

/**
 * The recalculation half of the document builder, deliberately kept OUT of
 * src/lib/actions/documents.ts. That module carries the use-server
 * directive, which turns every one of its exports into a callable action
 * endpoint reachable by anyone who learns its action id — and `recalcDocument`
 * below both writes money columns and takes no session, so exporting it from
 * there handed the whole `subtotal`/`taxAmount`/`total` triple of any
 * document, FINAL ones included, to an unauthenticated caller. It is only ever
 * meant to be reachable *through* an action that has already checked the
 * session and the caller's scope, which is exactly what living in a plain
 * module makes true.
 */

/** The subset of a Prisma client the functions here need — structurally
 * satisfied by both the plain `db` singleton and the `tx` handed to a
 * `db.$transaction(async (tx) => ...)` callback, so callers that need the
 * recalc to roll back along with their own write (see `NegativeSubtotalError`
 * below) pass `tx`; callers that don't can omit it and get the default `db`.
 * Every read `recalcDocument` performs goes through this one client, never
 * the `db` singleton directly: a read issued on `db` from inside an
 * interactive transaction sees a different snapshot than the transaction
 * itself and checks out a second pool connection while the transaction is
 * already holding one. */
export type RecalcClient = {
  document: Prisma.TransactionClient["document"];
  option: Prisma.TransactionClient["option"];
  setting: Prisma.TransactionClient["setting"];
};

/** Thrown inside a `db.$transaction(async (tx) => ...)` callback to abort
 * and roll it back when `recalcDocument` reports `negativeSubtotal` — see
 * the mutating actions in src/lib/actions/documents.ts, each of which runs
 * its entity write and the recalc in the same transaction so a rejected save
 * never leaves a negative-subtotal line (or a stale total) committed. Never
 * surfaced to a caller directly; every site that can throw it catches it
 * immediately and maps it to `{ error: NEGATIVE_SUBTOTAL_ERROR }`. */
export class NegativeSubtotalError extends Error {}

/** Thrown the same way as `NegativeSubtotalError` — to abort and roll back
 * a `db.$transaction` — when `recalcDocument` reports
 * `documentConcession.exceedsCap` for a MANAGER (an ADMIN is instead let
 * through with a `warning`, same role split `setItemDiscount` already gives
 * a per-item cap breach). Carries the ready-made message (see
 * `concessionCapMessage`) so the catch site at every call can surface it
 * directly, the same way every other error path there does. */
export class ConcessionCapError extends Error {}

/** A concession-free, uncapped placeholder for the (never actually
 * reachable in practice) "document not found" branch of `recalcDocument`
 * below — every real caller has already scope-checked the document exists
 * before calling this, so this value is never inspected for `exceedsCap`,
 * but `documentConcession` is typed as always-present on `RecalcResult`
 * (mirrors `PricingTotals.documentConcession`), so a concrete value is
 * needed either way. */
const NO_CONCESSION: DocumentConcession = {
  concession: "0.00",
  listValue: "0.00",
  effectivePct: 0,
  allowedPct: 100,
  exceedsCap: false,
  allowedMarkupPct: null,
  exceedsMarkupCap: false,
  parts: { documentDiscount: "0.00", itemDiscounts: "0.00", priceAdjustments: "0.00", tradeIns: "0.00" },
};

export type RecalcResult = {
  violations: EngineViolation[];
  negativeSubtotal: boolean;
  documentConcession: DocumentConcession;
  /** Pre-formatted "Concessions total ..." message (see
   * `concessionCapMessage`), present only when `documentConcession.exceedsCap`
   * — built here, not by each caller, since this is the one place that
   * already has the document's region name/currency loaded. */
  concessionMessage: string | null;
  /** Pre-formatted "This quote is priced ... above list" message (see
   * `markupCapMessage`) — the mirror of `concessionMessage` above, present
   * only when `documentConcession.exceedsMarkupCap`. */
  markupMessage: string | null;
  /** The salesperson's LIVE commission on this document — see
   * `CommissionResult`'s doc comment for the shape and the "null means
   * unconfigured" rule. Always the freshly-computed figure, even for a
   * FINAL document — `recalcDocument` never reads or writes the frozen
   * `Document.commission*` columns (see `finalizeDocument`,
   * src/lib/actions/finalize.ts); the builder's own read path
   * (`getDocumentForBuilder`, src/lib/queries/documents.ts) is what
   * chooses between this live figure (DRAFT) and the frozen one (FINAL). */
  commission: CommissionResult | null;
};

/**
 * Recomputes and persists a document's subtotal/taxAmount/total from its
 * current items, item lines and document-level lines, via the pure pricing
 * engine (src/lib/pricing.ts) — the single source of truth for every money
 * total. Every mutating action in src/lib/actions/documents.ts ends by calling
 * this, inside the same `$transaction` as its own entity write when the
 * mutation could ever produce a negative subtotal (see
 * `NegativeSubtotalError`'s doc comment and every call site there). Returns
 * the engine's discount-cap violations — which `finalizeDocument` re-checks
 * via `validateFinalizable`, since a region's maxDiscountPct can be lowered
 * after a discount was saved — alongside `negativeSubtotal` and
 * `documentConcession` (see `recalcAndEnforce` below for how the two
 * guardrails are actually enforced, role-gated, by every mutating action's
 * transaction); this function itself never throws or refuses to persist —
 * it's the caller's job to inspect the result and decide whether to reject
 * the save. A missing document is treated as a no-op — the caller has already
 * scope-checked it before mutating.
 *
 * The discount cap fed to the engine is the document's region cap
 * (`Region.maxDiscountPct`) — the same value applied to every item, not a
 * per-item/series value (discount caps moved from Series to Region — see
 * `setItemDiscount` in src/lib/actions/documents.ts).
 */
export async function recalcDocument(documentId: string, client: RecalcClient = db): Promise<RecalcResult> {
  const document = await client.document.findUnique({
    where: { id: documentId },
    include: {
      // `isCredit`/`noCommission` — see `EngineItem.isCredit`'s and
      // `EngineItem.isNoCommission`'s doc comments (src/lib/pricing.ts) for
      // why these flags (never the sign or size of a typed price) are what
      // drive the engine's credit/no-commission handling.
      items: { include: { lines: true, product: { select: { isCredit: true, noCommission: true } } } },
      lines: { where: { itemId: null } },
      region: true,
    },
  });
  if (!document) {
    return {
      violations: [],
      negativeSubtotal: false,
      documentConcession: NO_CONCESSION,
      concessionMessage: null,
      markupMessage: null,
      commission: null,
    };
  }

  // `Option.noCommission` is read live off the option, the same "joined,
  // never snapshotted" rule `EngineItem.isNoCommission`'s doc comment
  // describes — resolved here via one extra query for every OPTION line's
  // `refId` (a document-level extra line is always CUSTOM, never OPTION —
  // see the `LineKind` enum — so only item lines can ever need this). This
  // is what makes the persisted `subtotal`/`taxAmount`/`total` below (what
  // the customer is actually charged) respect the "a no-commission line
  // takes no discount" rule — without it, `EngineInput.items[].isNoCommission`/
  // `lines[].isNoCommission` would always read `false` here regardless of
  // the catalogue, and the discount-exclusion computeTotals now does would
  // never actually take effect on a saved document.
  const optionRefIds = Array.from(
    new Set(
      document.items
        .flatMap((item) => item.lines)
        .filter((line): line is (typeof document.lines)[number] & { refId: string } => line.kind === "OPTION" && line.refId !== null)
        .map((line) => line.refId)
    )
  );
  // Fetched alongside the option lookup (one round trip, not two) — the
  // admin-editable commission-rate table needed to resolve
  // `totals.commission` below. Read through `client`, not the `db` singleton
  // `getCommissionTiers` defaults to, for the reason `RecalcClient` gives.
  const [optionRows, commissionTiers] = await Promise.all([
    optionRefIds.length > 0
      ? client.option.findMany({ where: { id: { in: optionRefIds } }, select: { id: true, noCommission: true } })
      : Promise.resolve([]),
    getCommissionTiers(client),
  ]);
  const optionNoCommissionMap = new Map(optionRows.map((o) => [o.id, o.noCommission]));

  const regionMaxDiscountPct = document.region.maxDiscountPct ? Number(document.region.maxDiscountPct) : null;
  const regionMaxMarkupPct = document.region.maxMarkupPct ? Number(document.region.maxMarkupPct) : null;

  // The document's effective tax, with both of its rules — the FINAL freeze
  // and the DRAFT refresh — decided in one dependency-free place (./tax.ts,
  // whose header comment carries the full reasoning). The region is already
  // joined above for its discount caps, so resolving this costs no extra
  // query. When `refresh` comes back non-null the label and rate are written
  // back to the row in the same update as the totals below, keeping the
  // "GST 10%" every reader prints and the `taxAmount` it sits beside two
  // views of the same figure rather than two independently stale ones.
  const tax = resolveDocumentTax({
    status: document.status,
    deliveryTerms: document.deliveryTerms,
    document: { taxName: document.taxName, taxRate: document.taxRate.toString() },
    region: { taxName: document.region.taxName, taxRate: document.region.taxRate.toString() },
  });

  const engineInput: EngineInput = {
    items: document.items.map((item) => ({
      unitPrice: Number(item.unitPrice),
      listPrice: item.listPrice !== null ? Number(item.listPrice) : null,
      discountMode: item.discountMode,
      discountValue: item.discountValue !== null ? item.discountValue.toString() : null,
      maxDiscountPct: regionMaxDiscountPct,
      isCredit: item.product?.isCredit ?? false,
      isNoCommission: item.product?.noCommission ?? false,
      lines: item.lines.map((line) => ({
        qty: line.qty,
        unitPrice: Number(line.unitPrice),
        listPrice: line.listPrice !== null ? Number(line.listPrice) : null,
        isNoCommission: line.refId !== null ? (optionNoCommissionMap.get(line.refId) ?? false) : false,
      })),
    })),
    extraLines: document.lines.map((line) => ({ qty: line.qty, unitPrice: Number(line.unitPrice) })),
    documentDiscountMode: document.discountMode,
    documentDiscountValue: document.discountValue !== null ? document.discountValue.toString() : null,
    regionMaxDiscountPct,
    regionMaxMarkupPct,
    taxRate: tax.engineTaxRate,
    commissionTiers,
  };

  const totals = computeTotals(engineInput);

  const concessionMessage = totals.documentConcession.exceedsCap
    ? concessionCapMessage(totals.documentConcession, document.region.name, document.currency)
    : null;
  const markupMessage = totals.documentConcession.exceedsMarkupCap
    ? markupCapMessage(totals.documentConcession, document.region.name, document.currency)
    : null;

  await client.document.update({
    where: { id: documentId },
    data: {
      subtotal: totals.subtotal,
      taxAmount: totals.taxAmount,
      total: totals.total,
      // Only ever present for a DRAFT whose region's tax has moved since the
      // row was written (see `resolveDocumentTax`) — spread rather than set
      // unconditionally so a FINAL document's columns are not merely written
      // back with the same values, but genuinely never named in an update
      // issued from here.
      ...(tax.refresh ? { taxName: tax.refresh.taxName, taxRate: new Prisma.Decimal(tax.refresh.taxRate) } : {}),
    },
  });

  return {
    violations: totals.violations,
    negativeSubtotal: totals.negativeSubtotal,
    documentConcession: totals.documentConcession,
    concessionMessage,
    markupMessage,
    commission: totals.commission,
  };
}

/**
 * Runs `recalcDocument` and enforces the two guardrails every mutating
 * action in src/lib/actions/documents.ts shares, thrown as sentinel errors so
 * the caller's `db.$transaction` rolls back (mirrors the existing
 * `NegativeSubtotalError` pattern, extended here to `ConcessionCapError`):
 *
 *  - `negativeSubtotal` — unconditional, same as before this change.
 *  - `documentConcession.exceedsCap` — a MANAGER's save is rejected and
 *    rolled back (throws `ConcessionCapError`); an ADMIN's save proceeds,
 *    and the message comes back as `warning` for the caller to surface as a
 *    non-blocking toast — the same MANAGER-blocked/ADMIN-warned split
 *    `setItemDiscount`/`setDocumentDiscount` already give a per-item/
 *    per-document discount-cap breach (see their own doc comments), now
 *    applied to the aggregate whole-document figure instead. This is what
 *    actually closes the hole a manual price opens: `EngineViolation`
 *    (the per-item `%`/`AMOUNT` discount check) never fires for a price cut
 *    entered as a straight `unitPrice` edit with no `discountValue` set at
 *    all, so without this, a MANAGER could sell at any price no matter how
 *    far below list, cap or no cap.
 *  - `documentConcession.exceedsMarkupCap` — the mirror of `exceedsCap`
 *    above, for `Region.maxMarkupPct` (Ross: "he's got a minimum selling
 *    price. And a maximum selling price."): same MANAGER-rejected/
 *    ADMIN-warned split, via the same `ConcessionCapError`/`warning` path
 *    (see `markupCapMessage`). Mutually exclusive with `exceedsCap` in
 *    practice — a concession can't be simultaneously a discount and a
 *    markup — so this is checked as a separate `if`, not an `else if`, but
 *    only one of the two bodies below can ever actually run for a given
 *    document.
 *
 * Called by every mutating action in src/lib/actions/documents.ts inside its
 * own `db.$transaction`, immediately after (or in place of) its old bare
 * `recalcDocument` + `negativeSubtotal` check.
 */
export async function recalcAndEnforce(
  documentId: string,
  tx: RecalcClient,
  role: string
): Promise<{ warning?: string }> {
  const { negativeSubtotal, documentConcession, concessionMessage, markupMessage } = await recalcDocument(
    documentId,
    tx
  );
  if (negativeSubtotal) throw new NegativeSubtotalError();
  if (documentConcession.exceedsCap) {
    if (!isAdminRole(role)) throw new ConcessionCapError(concessionMessage!);
    return { warning: concessionMessage! };
  }
  if (documentConcession.exceedsMarkupCap) {
    if (!isAdminRole(role)) throw new ConcessionCapError(markupMessage!);
    return { warning: markupMessage! };
  }
  return {};
}
