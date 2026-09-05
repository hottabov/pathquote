import type { QuotationData } from "@/lib/quotation-data";

/**
 * "Remote Support Program" — the admin-authored agreement text and the
 * per-machine coverage table. Either half can be absent (an agreement with no
 * covered machines, or coverage rows with no agreement block authored yet),
 * so each is gated on its own and the section as a whole disappears only when
 * both are.
 */
export function RspSection({ rsp }: { rsp: QuotationData["rsp"] }) {
  if (!rsp.agreementHtml && rsp.coverageRows.length === 0) return null;

  return (
    <section className="pq-section">
      <h1 className="pq-section-title">Remote Support Program</h1>
      {rsp.agreementHtml ? (
        <div className="pq-flow-block pq-block-body" dangerouslySetInnerHTML={{ __html: rsp.agreementHtml }} />
      ) : null}
      {rsp.coverageRows.length > 0 ? (
        <table className="pq-rsp-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Serial Number</th>
              <th>RSP unit cost p/year</th>
            </tr>
          </thead>
          <tbody>
            {rsp.coverageRows.map((row, i) => (
              <tr key={i}>
                <td>{row.name}</td>
                <td>{row.serialNumber || "—"}</td>
                <td>{row.rspUnitCost}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
