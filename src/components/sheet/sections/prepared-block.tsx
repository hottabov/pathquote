import type { QuotationData } from "@/lib/quotation-data";

/**
 * The two "who" boxes under the header — "Prepared for" (the client) and
 * "Prepared by" (the document's author) — plus the delivery address row that
 * follows them when the client has one distinct from its office address.
 *
 * The delivery row travels with this component rather than standing on its
 * own because it only ever renders directly underneath these two boxes and
 * shares their `.pq-client` box styling; splitting it out would separate a
 * row from the row it is positioned against.
 */
export function PreparedBlock({
  client,
  delivery,
  preparedBy,
}: {
  client: QuotationData["client"];
  delivery: QuotationData["delivery"];
  preparedBy: QuotationData["preparedBy"];
}) {
  return (
    <>
      {/* Header client block (owner reference doc: "Prepared for: <contact,
          company, address>" / "Prepared by: <manager name / phone>,
          <email>") — two columns, the client's own info relabeled
          "Prepared for" alongside a new "Prepared by" column for the
          document's author. `preparedBy` is always present (every
          document has an author), so the row always renders even for a
          not-yet-client-assigned draft. */}
      <div className="pq-prepared-row">
        {client ? (
          <div className="pq-client">
            <div className="pq-client-label">Prepared for</div>
            <div className="pq-client-name">{client.companyName}</div>
            {client.addressLines.map((line, i) => (
              <div className="pq-client-line" key={i}>
                {line}
              </div>
            ))}
            {client.website ? <div className="pq-client-line">{client.website}</div> : null}
            {client.contactName ? (
              <div className="pq-client-line pq-client-contact">Attn: {client.contactName}</div>
            ) : null}
            {client.contactEmail ? <div className="pq-client-line">{client.contactEmail}</div> : null}
            {client.contactPhone ? <div className="pq-client-line">{client.contactPhone}</div> : null}
          </div>
        ) : null}
        <div className="pq-client pq-prepared-by-client">
          <div>
            <div className="pq-client-label">Prepared by</div>
            <div className="pq-client-name">{preparedBy.name ?? preparedBy.email}</div>
            {preparedBy.phone ? <div className="pq-client-line">{preparedBy.phone}</div> : null}
            {preparedBy.name ? <div className="pq-client-line">{preparedBy.email}</div> : null}
          </div>
          {preparedBy.avatar ? (
            // Plain <img>, not next/image — same reasoning as the logo
            // above: this markup is also posted to Gotenberg as a raw
            // HTML string. No initials fallback here (unlike the in-app
            // `Avatar` component) — a customer-facing quote either shows
            // the real photo or none at all, and nothing reserves the
            // space when there's no photo.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preparedBy.avatar} alt="" className="pq-prepared-by-avatar" />
          ) : null}
        </div>
      </div>

      {/* Delivery address — its own full-width row under "Prepared
          for"/"Prepared by" (owner: "client office is not always the
          manufacturing site"), only when the company actually has one
          distinct from its main address. */}
      {delivery ? (
        <div className="pq-delivery-row">
          <div className="pq-client">
            <div className="pq-client-label">Delivery Address</div>
            {delivery.addressLines.map((line, i) => (
              <div className="pq-client-line" key={i}>
                {line}
              </div>
            ))}
            {delivery.contactName || delivery.phone ? (
              <div className="pq-client-line pq-client-contact">
                {[delivery.contactName ? `Attn: ${delivery.contactName}` : null, delivery.phone]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
