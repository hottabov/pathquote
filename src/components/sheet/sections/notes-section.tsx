import type { QuotationData } from "@/lib/quotation-data";

/**
 * Free-text notes (Document.notes, admin-authored markdown — see the
 * builder's Notes section / setDocumentNotes) — after the equipment write-up,
 * before the Investment Summary, same placement the reference template gives
 * freeform quote remarks.
 */
export function NotesSection({ notesHtml }: { notesHtml: QuotationData["notesHtml"] }) {
  if (!notesHtml) return null;

  return (
    <section className="pq-section">
      <h1 className="pq-section-title">Notes</h1>
      <div className="pq-flow-block pq-block-body" dangerouslySetInnerHTML={{ __html: notesHtml }} />
    </section>
  );
}
