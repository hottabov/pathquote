import { formatMoney } from "@/lib/format";
import { toCents } from "@/lib/pricing";

type TotalsProps = {
  taxName: string;
  taxRate: string;
  subtotal: string;
  /** Combined item-level and document-level discount. */
  discountAmount: string;
  taxAmount: string;
  total: string;
  currency: string;
  currencySymbol: string | null;
  /** The salesperson's commission on this document (`DocumentForBuilder.commission`,
   * src/lib/queries/documents.ts) — internal-only, shown here (the builder)
   * and NOWHERE else; see `CommissionResult`'s doc comment in
   * src/lib/pricing.ts. `null`/omitted when no commission tier table is
   * configured, in which case this renders nothing at all — never a
   * misleading $0.00. */
  commission?: { ratePct: number; amount: string } | null;
  /** A salesperson's custom tax: shown as a "custom" badge beside the tax
   * line, with the reason as its tooltip. Only the people who can open the
   * builder see it (author, Regional manager, Admin, Developer). */
  taxOverridden?: boolean;
  taxNote?: string | null;
};

/**
 * Pure subtotal → total breakdown, rendered by the builder's summary panels
 * (see `[documentId]/page.tsx`) so every one of them shows the same numbers.
 *
 * Every call site is internal-only (behind the builder's own
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
  currencySymbol,
  commission,
  taxOverridden,
  taxNote,
}: TotalsProps) {
  return (
    <dl className="flex flex-col gap-1.5 text-sm">
      <div className="flex justify-between">
        <dt className="text-slate-500">Subtotal</dt>
        <dd className="tabular-nums text-slate-700">{formatMoney(subtotal, currency, currencySymbol)}</dd>
      </div>
      {toCents(discountAmount) !== 0 ? (
        <div className="flex justify-between">
          <dt className="text-slate-500">Discount</dt>
          <dd className="tabular-nums text-slate-700">-{formatMoney(discountAmount, currency, currencySymbol)}</dd>
        </div>
      ) : null}
      <div className="flex justify-between">
        <dt className="text-slate-500">
          {Number(taxRate) === 0 ? `${taxName} (none)` : `${taxName} (${taxRate}%)`}
          {taxOverridden ? (
            <span
              title={taxNote ?? "No reason given yet"}
              className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-800"
            >
              custom
            </span>
          ) : null}
        </dt>
        <dd className="tabular-nums text-slate-700">{formatMoney(taxAmount, currency, currencySymbol)}</dd>
      </div>
      <div className="flex justify-between border-t border-slate-200 pt-1.5 text-base font-semibold text-brand-dark">
        <dt>Total</dt>
        <dd className="tabular-nums">{formatMoney(total, currency, currencySymbol)}</dd>
      </div>
      {/* Its own line below a second divider, same size/weight as Total —
          not a footnote hanging off it — in a dark green (the
          `--color-commission` token, src/app/globals.css) chosen specifically
          so it can never be mistaken for the Total row just above it. */}
      {commission ? (
        <div className="text-commission flex justify-between border-t border-slate-200 pt-1.5 text-base font-semibold">
          <dt>Your commission</dt>
          <dd className="tabular-nums">{formatMoney(commission.amount, currency, currencySymbol)}</dd>
        </div>
      ) : null}
    </dl>
  );
}
