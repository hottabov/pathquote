import type { QuotationData } from "@/lib/quotation-data";

/**
 * "General Conditions of Sale" — the same flow-block shape as `TermsSection`,
 * but every condition is numbered from its position in the list rather than
 * carrying a number of its own, so inserting one in the admin never leaves
 * the printed clauses misnumbered.
 */
export function ConditionsSection({ sections }: { sections: QuotationData["conditionsSections"] }) {
  if (sections.length === 0) return null;

  return (
    <section className="pq-section pq-conditions-section">
      <h1 className="pq-section-title">General Conditions of Sale</h1>
      {sections.map((condition, index) => (
        <div className="pq-flow-block" key={condition.key}>
          <h2 className="pq-block-title">
            {index + 1}. {condition.title}
          </h2>
          <div className="pq-block-body" dangerouslySetInnerHTML={{ __html: condition.bodyHtml }} />
        </div>
      ))}
    </section>
  );
}
