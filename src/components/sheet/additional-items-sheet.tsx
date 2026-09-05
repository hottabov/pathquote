/**
 * Standalone HTML page for whatever a production form run could not place on
 * a machine form: document-level lines (services, training, custom entries)
 * and any option whose form has no box for it (see `unmatchedOptions`).
 *
 * Same no-Tailwind, self-contained-`<style>` discipline as `QuotationSheet`
 * (src/components/sheet/quotation-sheet.tsx): this markup is posted to
 * Gotenberg's Chromium as a raw HTML string with no app stylesheet attached,
 * so every rule it needs has to live in the one embedded block below. Colors
 * are the same brand values `QuotationSheet` hardcodes for the same reason.
 */
export type AdditionalItem = {
  name: string;
  qty: number;
  description: string | null;
  /** Which machine this came from, or null for a document-level line. */
  source: string | null;
};

type Props = { documentNumber: string; companyName: string; items: AdditionalItem[] };

/**
 * One sheet at the back rather than one after each form -- the workshop
 * hands forms out per machine, and a page stapled between two forms travels
 * with the wrong one. The machine form stays purely about what gets built;
 * nothing is silently dropped.
 */
export function AdditionalItemsSheet({ documentNumber, companyName, items }: Props) {
  return (
    <div className="pq-content">
      <style>{SHEET_CSS}</style>
      <h1 className="pq-title">Additional items</h1>
      <p className="pq-subtitle">
        {documentNumber} — {companyName}
      </p>
      <table className="pq-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            <th>From</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={index}>
              <td>{item.name}</td>
              <td>{item.qty}</td>
              <td>{item.source ?? "—"}</td>
              <td>{item.description ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="pq-note">Not part of any production form. For office reference only.</p>
    </div>
  );
}

// Same brand palette as SHEET_CSS in quotation-sheet.tsx: #243478 (primary
// rule/heading), #2b304f (dark text), #777777/#444444 (muted text) --
// hardcoded for the same reason: this markup never has the app's compiled
// stylesheet available.
const SHEET_CSS = `
  .pq-content {
    width: 180mm;
    margin: 0 auto;
    background: #ffffff;
    color: #1a1a1a;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 11px;
    line-height: 1.4;
    box-sizing: border-box;
  }
  .pq-content * {
    box-sizing: border-box;
  }
  .pq-title {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: 1px;
    color: #243478;
    margin: 0 0 6px 0;
    padding-bottom: 10px;
    border-bottom: 3px solid #243478;
  }
  .pq-subtitle {
    color: #444444;
    margin: 10px 0 18px 0;
  }
  .pq-table {
    width: 100%;
    border-collapse: collapse;
  }
  .pq-table th {
    text-align: left;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #2b304f;
    border-bottom: 2px solid #243478;
    padding: 6px 4px;
  }
  .pq-table td {
    padding: 6px 4px;
    vertical-align: top;
    border-bottom: 1px solid #e4e4e4;
    color: #333333;
  }
  .pq-note {
    margin-top: 18px;
    color: #777777;
    font-size: 10px;
    font-style: italic;
  }
`;
