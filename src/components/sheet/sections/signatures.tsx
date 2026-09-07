import type { QuotationSignature } from "@/lib/quotation-data";

/**
 * The two signature rules at the foot of the quote — purchaser on the left,
 * Pathfinder on the right.
 *
 * A side with no signature prints exactly what it printed before quotes
 * could be signed electronically: an empty rule to be signed by hand. That
 * is deliberate, and it is what keeps the printed fallback working for a
 * client who would rather use a pen.
 */
export function Signatures({
  showSignature,
  author,
  client,
}: {
  showSignature: boolean;
  author: QuotationSignature | null;
  client: QuotationSignature | null;
}) {
  if (!showSignature) return null;

  return (
    <div className="pq-signatures">
      <SignatureBlock label="Purchaser" signature={client} />
      <SignatureBlock label="Pathfinder" signature={author} />
    </div>
  );
}

function SignatureBlock({
  label,
  signature,
}: {
  label: string;
  signature: QuotationSignature | null;
}) {
  return (
    <div className="pq-sig-block">
      <div className="pq-sig-ink">
        {signature ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="pq-sig-image" src={signature.image} alt="" />
        ) : null}
      </div>
      <div className="pq-sig-line" />
      <div className="pq-sig-label">
        {label}
        {signature ? (
          <span className="pq-sig-meta">
            {signature.name} — signed {signature.signedAt}
          </span>
        ) : null}
      </div>
    </div>
  );
}
