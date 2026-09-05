import { ImageUpload } from "@/components/catalog/image-upload";
import { setDocumentHeroImage } from "@/lib/actions/documents";

/**
 * The builder's "Setup image" card (owner, relaying the director: a
 * salesperson has usually already drawn the whole configuration — cutter,
 * table, spreader together — in SketchUp and shown it to the customer; that
 * image should go on the quotation's first page rather than nowhere). Thin
 * wrapper around the shared `ImageUpload` (purpose `document-hero` — raster
 * only, same allow-list reasoning as a document line's own photo) bound to
 * `setDocumentHeroImage`, which persists `Document.heroImageUrl`.
 *
 * One image per quote, not per item — the point is showing every item
 * together — so this lives once at the document level, not inside
 * `ItemsSection`. Read-only (a FINAL document) shows the image with no
 * upload/remove controls, same as `ImageUpload`'s own `readOnly` behaviour
 * elsewhere; when there's no image at all, it simply shows the empty
 * dropzone state — the "no trace on the customer's copy" rule is enforced by
 * `QuotationSheet` (see `pq-hero-image`), not by hiding this card.
 */
export function HeroImageSection({
  documentId,
  heroImageUrl,
  readOnly = false,
}: {
  documentId: string;
  heroImageUrl: string | null;
  readOnly?: boolean;
}) {
  return (
    <ImageUpload
      currentUrl={heroImageUrl}
      alt="Setup image"
      onSave={setDocumentHeroImage.bind(null, documentId)}
      readOnly={readOnly}
      purpose="document-hero"
      removeLabel="Remove setup image"
    />
  );
}
