import type { QuotationData } from "@/lib/quotation-data";

/**
 * The page-foot band carrying the entity's bank details and its free-text
 * footer line — both come from the FINAL document's frozen entity snapshot
 * (or the live region for a draft; see `toSheetData`), and either can be
 * absent, so the band renders only when there is something to put in it.
 */
export function EntityFooter({ entity }: { entity: QuotationData["entity"] }) {
  if (entity.bankDetails.length === 0 && !entity.footerText) return null;

  return (
    <div className="pq-footer">
      {entity.bankDetails.length > 0 ? (
        <div className="pq-bank">
          <div className="pq-bank-title">Bank Details</div>
          {entity.bankDetails.map((row) => (
            <div className="pq-bank-row" key={row.label}>
              <span className="pq-bank-label">{row.label}:</span> {row.value}
            </div>
          ))}
        </div>
      ) : null}
      {entity.footerText ? <div className="pq-footer-text">{entity.footerText}</div> : null}
    </div>
  );
}
