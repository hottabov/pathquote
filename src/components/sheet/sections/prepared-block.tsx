import type { ReactNode } from "react";

import type { QuotationData } from "@/lib/quotation-data";

/**
 * `tel:` target for a phone as the user typed it. Strips everything a dialer
 * cannot use (spaces, brackets, dashes) but keeps a leading `+`, so
 * "+61 3 9988 7766" dials as "+61399887766" while the visible text stays in
 * whatever shape the record holds it. Nothing but punctuation left means there
 * is no number to link, only decoration — the caller falls back to plain text.
 */
function telHref(phone: string): string | null {
  const dialable = phone.replace(/[^\d+]/g, "");
  return /\d/.test(dialable) ? `tel:${dialable}` : null;
}

/**
 * `href` for a website field. Clients type "democompany.com.au" as often as
 * "https://democompany.com.au", and a bare host in an href resolves relative
 * to the document — inside a PDF that is a dead link, not a wrong one. Any
 * explicit scheme is left alone; anything else gets https://.
 */
function siteHref(website: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(website) ? website : `https://${website}`;
}

/**
 * One contact line that is a link when it can be and plain text when it
 * cannot. Every link carries `.pq-link`, which strips the browser's
 * blue-and-underline — on a customer-facing quote these must read as ordinary
 * address lines that merely happen to be tappable. Chromium turns each
 * `<a href>` into a real PDF link annotation, so this is what makes the
 * printed quote clickable too, not just the in-app preview.
 */
function ContactLine({
  href,
  className,
  children,
}: {
  href: string | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className ? `pq-client-line ${className}` : "pq-client-line"}>
      {href ? (
        <a className="pq-link" href={href}>
          {children}
        </a>
      ) : (
        children
      )}
    </div>
  );
}

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
            {client.website ? (
              <ContactLine href={siteHref(client.website)}>{client.website}</ContactLine>
            ) : null}
            {client.contactName ? (
              <div className="pq-client-line pq-client-contact">Attn: {client.contactName}</div>
            ) : null}
            {client.contactEmail ? (
              <ContactLine href={`mailto:${client.contactEmail}`}>{client.contactEmail}</ContactLine>
            ) : null}
            {client.contactPhone ? (
              <ContactLine href={telHref(client.contactPhone)}>{client.contactPhone}</ContactLine>
            ) : null}
          </div>
        ) : null}

        {/* "Prepared by" stacks rather than sitting in one row with the photo.
            The photo used to be a flex sibling of the whole text column, which
            is what broke the email: the box is (170mm - 16px gap) / 2 =
            ~313px, so after padding and the accent rule the content had ~286px
            to share, and a 100px photo plus its gap took 110px of it. ~176px
            cannot hold an address like brandon.clark@pathfindercut.com (~226px
            at 14px Arial), so `overflow-wrap: anywhere` did what it was told
            and split the domain across two lines — on the one line a customer
            is meant to read a contact off. Now the photo shares a row with the
            NAME only (`.pq-prepared-by-identity`, a short string that breaks
            at spaces and can shrink), and phone + email sit below on the box's
            full width. Nothing competes with the email for horizontal space,
            so nothing has to break it. */}
        <div className="pq-client pq-prepared-by-client">
          <div className="pq-client-label">Prepared by</div>
          <div className="pq-prepared-by-identity">
            {preparedBy.avatar ? (
              // Plain <img>, not next/image — same reasoning as the logo
              // above: this markup is also posted to Gotenberg as a raw
              // HTML string. No initials fallback here (unlike the in-app
              // `Avatar` component) — a customer-facing quote either shows
              // the real photo or none at all, and nothing reserves the
              // space when there's no photo, so the name just moves left.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preparedBy.avatar} alt="" className="pq-prepared-by-avatar" />
            ) : null}
            <div className="pq-client-name pq-prepared-by-name">
              {preparedBy.name ?? preparedBy.email}
            </div>
          </div>
          <div className="pq-prepared-by-contact">
            {preparedBy.phone ? (
              <ContactLine href={telHref(preparedBy.phone)}>{preparedBy.phone}</ContactLine>
            ) : null}
            {preparedBy.name ? (
              <ContactLine href={`mailto:${preparedBy.email}`}>{preparedBy.email}</ContactLine>
            ) : null}
          </div>
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
              // Built as nodes rather than the old `.filter().join(" · ")`:
              // the phone half has to be its own <a> to be dialable, and a
              // joined string cannot carry one. The separator still appears
              // only when both halves do, same as the join it replaces.
              <div className="pq-client-line pq-client-contact">
                {delivery.contactName ? `Attn: ${delivery.contactName}` : null}
                {delivery.contactName && delivery.phone ? " · " : null}
                {delivery.phone ? <PhoneText phone={delivery.phone} /> : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * A phone as an inline fragment rather than its own line — the delivery row
 * puts it after "Attn: <name> · " inside one `.pq-client-line`, so it cannot
 * use `ContactLine` (which owns a whole div) without breaking that row in two.
 */
function PhoneText({ phone }: { phone: string }) {
  const href = telHref(phone);
  return href ? (
    <a className="pq-link" href={href}>
      {phone}
    </a>
  ) : (
    <>{phone}</>
  );
}
