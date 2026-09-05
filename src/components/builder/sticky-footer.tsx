import { FileText } from "lucide-react";
import type { DocumentStatus } from "@prisma/client";
import { formatMoney } from "@/lib/format";
import { toCents } from "@/lib/pricing";
import { StatusBadge, STATUS_TONE } from "@/components/ui-kit";
import { DeleteDraftButton } from "@/components/builder/delete-draft-button";

type TotalsProps = {
  taxName: string;
  taxRate: string;
  subtotal: string;
  /** Combined item-level and document-level discount. */
  discountAmount: string;
  taxAmount: string;
  total: string;
  currency: string;
  /** The salesperson's commission on this document (`DocumentForBuilder.commission`,
   * src/lib/queries/documents.ts) — internal-only, shown here (the builder)
   * and NOWHERE else; see `CommissionResult`'s doc comment in
   * src/lib/pricing.ts. `null`/omitted when no commission tier table is
   * configured, in which case this renders nothing at all — never a
   * misleading $0.00. */
  commission?: { ratePct: number; amount: string } | null;
};

/**
 * Pure subtotal → total breakdown, shared by the mobile sticky bar
 * (`StickyFooter`, below) and the desktop right-hand summary panel (see
 * `[documentId]/page.tsx`) so the two only ever differ in their
 * surrounding chrome, never in the numbers they show.
 *
 * Both of those call sites are internal-only (behind the builder's own
 * session check) — this component must never be reused on a customer-facing
 * surface (the quotation view/PDF go through an entirely separate pipeline,
 * `buildQuotationData` -> `QuotationSheet`, which has no `commission` field
 * at all) or the `commission` line below would leak a salesperson's payout
 * to the customer.
 */
export function DocumentTotals({
  taxName,
  taxRate,
  subtotal,
  discountAmount,
  taxAmount,
  total,
  currency,
  commission,
}: TotalsProps) {
  return (
    <dl className="flex flex-col gap-1.5 text-sm">
      <div className="flex justify-between">
        <dt className="text-slate-500">Subtotal</dt>
        <dd className="tabular-nums text-slate-700">{formatMoney(subtotal, currency)}</dd>
      </div>
      {toCents(discountAmount) !== 0 ? (
        <div className="flex justify-between">
          <dt className="text-slate-500">Discount</dt>
          <dd className="tabular-nums text-slate-700">-{formatMoney(discountAmount, currency)}</dd>
        </div>
      ) : null}
      <div className="flex justify-between">
        <dt className="text-slate-500">
          {taxName} ({taxRate}%)
        </dt>
        <dd className="tabular-nums text-slate-700">{formatMoney(taxAmount, currency)}</dd>
      </div>
      <div className="flex justify-between border-t border-slate-200 pt-1.5 text-base font-semibold text-brand-dark">
        <dt>Total</dt>
        <dd className="tabular-nums">{formatMoney(total, currency)}</dd>
      </div>
      {/* Its own line below a second divider, same size/weight as Total —
          not a footnote hanging off it — in a dark green (the
          `--color-commission` token, src/app/globals.css) chosen specifically
          so it can never be mistaken for the Total row just above it. */}
      {commission ? (
        <div className="text-commission flex justify-between border-t border-slate-200 pt-1.5 text-base font-semibold">
          <dt>Your commission</dt>
          <dd className="tabular-nums">{formatMoney(commission.amount, currency)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * Sticky bottom bar for the <lg builder layout: the document's status
 * badge, the live totals breakdown (recalculated server-side by every
 * mutating action — see recalcDocument in src/lib/actions/documents.ts),
 * and — for a DRAFT — the delete-draft control, which `status` alone decides:
 * only a draft can be deleted, so there is nothing for a caller to say about
 * it that this component cannot read off the status it is already given.
 * Stays visible while
 * scrolling the item list on a phone, which is the primary device this
 * builder targets; `pb-safe` keeps it clear of the home-indicator on
 * notched devices. Hidden at `lg+`, where the same totals live in the
 * sticky right-hand summary panel instead (see `[documentId]/page.tsx`).
 */
export function StickyFooter({
  documentId,
  status,
  taxName,
  taxRate,
  subtotal,
  discountAmount,
  taxAmount,
  total,
  currency,
  commission,
}: {
  documentId: string;
  status: DocumentStatus;
} & TotalsProps) {
  return (
    <div className="pb-safe sticky bottom-0 -mx-4 border-t border-slate-200 bg-white px-4 py-3 sm:mx-0 sm:rounded-xl sm:border sm:px-6 lg:hidden">
      <div className="flex items-center justify-between gap-3">
        <StatusBadge tone={STATUS_TONE[status]} className="gap-1.5">
          <FileText className="size-3.5" aria-hidden="true" />
          {status === "DRAFT" ? "Draft" : "Final"}
        </StatusBadge>
        {status === "DRAFT" ? <DeleteDraftButton documentId={documentId} /> : null}
      </div>

      <div className="mt-2">
        <DocumentTotals
          taxName={taxName}
          taxRate={taxRate}
          subtotal={subtotal}
          discountAmount={discountAmount}
          taxAmount={taxAmount}
          total={total}
          currency={currency}
          commission={commission}
        />
      </div>
    </div>
  );
}
