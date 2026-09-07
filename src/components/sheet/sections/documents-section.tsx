import type { QuotationData } from "@/lib/quotation-data";

/**
 * Every legal document this quote includes, in the order an admin set. One
 * component for all of them, where there used to be three hardcoded ones —
 * so adding a Data Processing Agreement for an EU entity is an admin's job
 * and touches no code. Each document's heading is its own `title`; the old
 * components hardcoded "Terms", "General Conditions of Sale" and "Remote
 * Support Program" in the markup.
 *
 * `ConditionsSection` also numbered its clauses `{index + 1}.` from their
 * position in an array of 14 rows. A document is one body now, so its clauses
 * are numbered by the ordered list its author wrote in the editor and nothing
 * in code renumbers them — see `.pq-block-body ol` in sheet-css.ts.
 */
export function DocumentsSection({ documents }: { documents: QuotationData["documents"] }) {
  if (documents.length === 0) return null;

  return (
    <>
      {documents.map((doc) => (
        <section className="pq-section" key={doc.key}>
          <h1 className="pq-section-title">{doc.title}</h1>
          <div
            className="pq-flow-block pq-block-body pq-legal-body"
            dangerouslySetInnerHTML={{ __html: doc.bodyHtml }}
          />
        </section>
      ))}
    </>
  );
}
