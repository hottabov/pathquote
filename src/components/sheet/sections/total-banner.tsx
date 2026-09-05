import { formatMoney } from "@/lib/format";
import type { QuotationData } from "@/lib/quotation-data";

/**
 * Total investment banner (owner: "client must see it immediately" — the
 * grand total for everything, always shown up top regardless of the
 * price-display toggles below, which only gate the itemized per-item/
 * per-option detail further down the page).
 */
export function TotalBanner({
  totals,
  validityDate,
}: {
  totals: QuotationData["totals"];
  validityDate: QuotationData["validityDate"];
}) {
  return (
    <div className="pq-total-banner">
      <span className="pq-total-banner-label">Total investment</span>
      <span className="pq-total-banner-amount">
        {formatMoney(totals.total, totals.currency)} {totals.currency}
      </span>
      <span className="pq-total-banner-note">
        {totals.deliveryTerms === "EX_WORKS"
          ? `(Ex Works — no ${totals.taxName} applicable)`
          : `(incl. ${totals.taxName} ${totals.taxRate}%)`}
      </span>
      {/* Repeats the header's expiry right next to the price it applies
          to (owner: "put the valid-to in this total investment line, so
          it's obvious"). Deliberately larger and full white rather than
          the muted note colour beside it — it is the line that gives the
          reader a reason to decide now, so it has to survive a glance at
          a printed page. */}
      {validityDate ? (
        <span className="pq-total-banner-validity">Price valid until {validityDate}</span>
      ) : null}
    </div>
  );
}
