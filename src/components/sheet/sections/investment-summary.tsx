import { formatMoney, isNegativeAmount } from "@/lib/format";
import type { QuotationData } from "@/lib/quotation-data";
import { ItemBreakdownRows } from "@/components/sheet/item-breakdown";

/**
 * "Investment Summary" — the itemized table (one `<tbody>` group per item,
 * plus one for the document-level extra lines) and the Subtotal / Discount /
 * Tax / TOTAL block underneath it.
 *
 * Unlike every other section here this one always renders, even for a quote
 * with no items at all: the totals block below the table carries the figure
 * the customer is agreeing to, and that is never conditional on there being
 * itemized detail to show (see `itemPriceVisible`, which can hide the detail
 * while the totals stay).
 */
export function InvestmentSummary({
  items,
  extraLines,
  totals,
  itemPriceVisible,
}: {
  items: QuotationData["items"];
  extraLines: QuotationData["extraLines"];
  totals: QuotationData["totals"];
  itemPriceVisible: boolean;
}) {
  return (
    <section className="pq-section pq-summary-section">
      <h1 className="pq-section-title">Investment Summary</h1>
      <table className="pq-items">
        <colgroup>
          <col className="pq-col-item" />
          <col className="pq-col-qty" />
          <col className="pq-col-amount" />
        </colgroup>
        <thead>
          <tr>
            <th className="pq-col-item">Item</th>
            <th className="pq-col-qty">Qty</th>
            <th className="pq-col-amount">Price</th>
          </tr>
        </thead>
        {items.map((item) => (
          <tbody className="pq-item-group" key={item.id}>
            <tr className="pq-item-row">
              <td className="pq-col-item">
                <div className="pq-item-name">
                  {item.name} <span className="pq-item-code">{item.code}</span>
                </div>
                {item.descriptionHtml ? (
                  <div
                    className="pq-item-desc pq-block-body"
                    dangerouslySetInnerHTML={{ __html: item.descriptionHtml }}
                  />
                ) : null}
              </td>
              <td className="pq-col-qty" />
              <td className="pq-col-amount pq-amount" />
            </tr>
            {/* Base price, options, item discount, per-item subtotal —
                the shared presenter (see item-breakdown.tsx) so this
                three-part idea is expressed once, not per sheet. The
                old lump-sum total here (base + every option) used to
                read as one confusing number — the base price now always
                gets its own row. */}
            <ItemBreakdownRows
              breakdown={item.breakdown}
              code={item.code}
              currency={totals.currency}
              showPrices={itemPriceVisible}
            />
          </tbody>
        ))}

        {extraLines.length > 0 ? (
          <tbody className="pq-item-group">
            {extraLines.map((line) => {
              const isNegative = isNegativeAmount(line.unitPrice);
              return (
                <tr className="pq-item-row" key={line.id}>
                  <td className="pq-col-item">
                    <div className="pq-item-head">
                      {line.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={line.image} alt={line.name} className="pq-thumb" />
                      ) : null}
                      <div>
                        <div className="pq-item-name">{line.name}</div>
                        {line.description ? <div className="pq-item-desc">{line.description}</div> : null}
                      </div>
                    </div>
                  </td>
                  <td className={isNegative && itemPriceVisible ? "pq-col-qty pq-negative" : "pq-col-qty"}>
                    {itemPriceVisible ? (
                      <>
                        {line.qty} × {formatMoney(line.unitPrice, totals.currency)}
                      </>
                    ) : (
                      line.qty
                    )}
                  </td>
                  <td
                    className={
                      isNegative && itemPriceVisible
                        ? "pq-col-amount pq-amount pq-negative"
                        : "pq-col-amount pq-amount"
                    }
                  >
                    {itemPriceVisible ? formatMoney(line.lineTotal, totals.currency) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        ) : null}
      </table>

      <div className="pq-totals">
        <div className="pq-totals-row">
          <span>Subtotal</span>
          <span>{formatMoney(totals.subtotal, totals.currency)}</span>
        </div>
        {/* An explicit `0` discount (as opposed to no discount set at
            all, `discountValue === null`) must print nothing — a "Discount
            0%" line invites the customer to haggle for one (owner: "this
            gives the client room to negotiate"). Checking the numeric
            value (not just non-null) is what catches the explicit-zero
            case, for both PERCENT "0" and AMOUNT "0.00". */}
        {totals.discountValue !== null && Number(totals.discountValue) !== 0 ? (
          <div className="pq-totals-row">
            <span>
              Discount {totals.discountMode === "PERCENT" ? `${totals.discountValue}%` : formatMoney(totals.discountValue, totals.currency)}
            </span>
            <span>-{formatMoney(totals.discountAmount, totals.currency)}</span>
          </div>
        ) : null}
        {totals.deliveryTerms === "EX_WORKS" ? (
          // Same reasoning as the banner note above — no `{taxName} 0%`
          // line, which would read as a mistake rather than the
          // deliberate export-terms choice it is.
          <div className="pq-totals-row">
            <span>Ex Works — no {totals.taxName} applicable</span>
            <span>{formatMoney(totals.taxAmount, totals.currency)}</span>
          </div>
        ) : (
          <div className="pq-totals-row">
            <span>
              {totals.taxName} {totals.taxRate}%
            </span>
            <span>{formatMoney(totals.taxAmount, totals.currency)}</span>
          </div>
        )}
        <div className="pq-totals-row pq-totals-final">
          <span>TOTAL</span>
          <span>
            {formatMoney(totals.total, totals.currency)} {totals.currency}
          </span>
        </div>
      </div>
    </section>
  );
}
