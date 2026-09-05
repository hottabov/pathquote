/**
 * The two signature rules at the foot of the quote — purchaser on the left,
 * Pathfinder on the right. Purely structural: nothing about them varies with
 * the document, so the only input is whether they are printed at all.
 */
export function Signatures({ showSignature }: { showSignature: boolean }) {
  if (!showSignature) return null;

  return (
    <div className="pq-signatures">
      <div className="pq-sig-block">
        <div className="pq-sig-line" />
        <div className="pq-sig-label">Purchaser</div>
      </div>
      <div className="pq-sig-block">
        <div className="pq-sig-line" />
        <div className="pq-sig-label">Pathfinder</div>
      </div>
    </div>
  );
}
