import type { QuotationData } from "@/lib/quotation-data";

/**
 * The cover header: the entity's logo and identity block above the brand
 * rule, and the "QUOTATION" title row with the document's number, issue date
 * and expiry beside it.
 *
 * Like every component under this directory it is a fragment of
 * `QuotationSheet` (src/components/sheet/quotation-sheet.tsx) rather than an
 * app component — see that file's doc comment for why nothing here may use
 * Tailwind, `next/image`, data fetching or `async`.
 */
export function DocumentHeader({
  logo,
  entity,
  number,
  issueDate,
  validityDate,
}: {
  logo: QuotationData["logo"];
  entity: QuotationData["entity"];
  number: QuotationData["number"];
  issueDate: QuotationData["issueDate"];
  validityDate: QuotationData["validityDate"];
}) {
  return (
    <>
      <header className="pq-header">
        <div className="pq-header-logo">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt={entity.name} className="pq-logo-img" />
          ) : null}
        </div>
        <div className="pq-header-entity">
          <div className="pq-entity-name">{entity.name}</div>
          {entity.legalId ? <div className="pq-entity-line">{entity.legalId}</div> : null}
          {entity.address
            ? entity.address.split("\n").map((line, i) => (
                // entityAddress is a single free-text Region field that may
                // carry embedded newlines (street / city+postcode / phone /
                // email / web, one per line) -- split rather than a single
                // <div> so each line actually breaks instead of the "\n"
                // rendering as a literal character.
                <div className="pq-entity-line" key={i}>
                  {line}
                </div>
              ))
            : null}
        </div>
      </header>

      <div className="pq-title-row">
        <div className="pq-title">QUOTATION</div>
        <div className="pq-meta">
          {number ? (
            <div className="pq-meta-row">
              <span className="pq-meta-label">No.</span> {number}
            </div>
          ) : null}
          <div className="pq-meta-row">
            <span className="pq-meta-label">Date</span> {issueDate}
          </div>
          {validityDate ? (
            <div className="pq-meta-row">
              <span className="pq-meta-label">Price valid until</span> {validityDate}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
