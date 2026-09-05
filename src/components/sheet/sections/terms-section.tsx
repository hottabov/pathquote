import type { QuotationData } from "@/lib/quotation-data";

/**
 * "Terms" — the admin-authored terms blocks, each with its own optional
 * heading. A block whose content block carries no title renders its body
 * alone rather than an empty heading.
 */
export function TermsSection({ sections }: { sections: QuotationData["termsSections"] }) {
  if (sections.length === 0) return null;

  return (
    <section className="pq-section">
      <h1 className="pq-section-title">Terms</h1>
      {sections.map((term) => (
        <div className="pq-flow-block" key={term.key}>
          {term.title ? <h2 className="pq-block-title">{term.title}</h2> : null}
          <div className="pq-block-body" dangerouslySetInnerHTML={{ __html: term.bodyHtml }} />
        </div>
      ))}
    </section>
  );
}
