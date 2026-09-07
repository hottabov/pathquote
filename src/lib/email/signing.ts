/**
 * The four emails the signing flow sends, as pure functions.
 *
 * No Prisma, no environment, no transport — every value arrives as an
 * argument, which is what lets these be tested without booting the mail
 * stack (see tests/signing-emails.test.ts), exactly as
 * `buildMagicLinkEmail` (src/lib/email/magic-link.ts) is.
 */
export type BuiltEmail = {
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
};

/** Same five-entity escape as `escapeHtml` in src/lib/markdown.ts, duplicated
 * locally rather than importing a markdown module for one string helper —
 * the convention magic-link.ts already follows. */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The invitation. Its call to action is an anchor reading "Review and sign
 * this quote" — the raw URL never appears as visible HTML text, so a
 * forwarded screenshot of the message does not carry a working credential.
 * The plain-text part must contain the URL, because there is no href there.
 */
export function buildSigningInviteEmail(input: {
  url: string;
  quoteNumber: string;
  total: string;
  authorName: string;
  entityName: string;
  expiresOn: string;
  replyTo?: string;
}): BuiltEmail {
  const subject = `Quotation ${input.quoteNumber} from ${input.entityName}`;

  const text = [
    `${input.authorName} has sent you quotation ${input.quoteNumber} for ${input.total}.`,
    ``,
    `Review and sign it here:`,
    input.url,
    ``,
    `This link works until ${input.expiresOn}.`,
    ``,
    `${input.entityName}`,
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">
      <p style="margin:0 0 16px">
        ${escapeHtml(input.authorName)} has sent you quotation
        <strong>${escapeHtml(input.quoteNumber)}</strong> for
        <strong>${escapeHtml(input.total)}</strong>.
      </p>
      <p style="margin:0 0 24px">
        <a href="${escapeHtml(input.url)}"
           style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px">
          Review and sign this quote
        </a>
      </p>
      <p style="margin:0 0 8px;color:#666;font-size:13px">
        This link works until ${escapeHtml(input.expiresOn)}.
      </p>
      <p style="margin:24px 0 0;color:#666;font-size:13px">${escapeHtml(input.entityName)}</p>
    </div>
  `.trim();

  return { subject, text, html, replyTo: input.replyTo };
}

/**
 * Sent to the client once they complete signing. No link — their own copy of
 * the link expires (or is already spent), and the PDF they need is attached
 * to this message instead.
 */
export function buildCompletionEmailForClient(input: {
  quoteNumber: string;
  entityName: string;
  authorName: string;
  replyTo?: string;
}): BuiltEmail {
  const subject = `Signed: quotation ${input.quoteNumber}`;

  const text = [
    `Thanks — your signature on quotation ${input.quoteNumber} has been received.`,
    ``,
    `A signed copy is attached to this email for your records.`,
    ``,
    `${input.authorName}`,
    `${input.entityName}`,
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">
      <p style="margin:0 0 16px">
        Thanks — your signature on quotation
        <strong>${escapeHtml(input.quoteNumber)}</strong> has been received.
      </p>
      <p style="margin:0 0 24px">A signed copy is attached to this email for your records.</p>
      <p style="margin:24px 0 0;color:#666;font-size:13px">
        ${escapeHtml(input.authorName)}<br />
        ${escapeHtml(input.entityName)}
      </p>
    </div>
  `.trim();

  return { subject, text, html, replyTo: input.replyTo };
}

/**
 * Sent to the document's author once the client completes signing. Links
 * into the app rather than attaching anything — the author already has full
 * access to the document there. `replyTo` is always `undefined`: the author
 * is the reply target everywhere else in this feature, and a message to
 * themselves needs no Reply-To.
 */
export function buildCompletionEmailForAuthor(input: {
  quoteNumber: string;
  clientName: string;
  companyName: string;
  documentUrl: string;
  replyTo?: string | null;
}): BuiltEmail {
  const subject = `${input.clientName} signed quotation ${input.quoteNumber}`;

  const text = [
    `${input.clientName} (${input.companyName}) has signed quotation ${input.quoteNumber}.`,
    ``,
    `View it here:`,
    input.documentUrl,
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">
      <p style="margin:0 0 24px">
        ${escapeHtml(input.clientName)} (${escapeHtml(input.companyName)}) has signed quotation
        <strong>${escapeHtml(input.quoteNumber)}</strong>.
      </p>
      <p style="margin:0 0 24px">
        <a href="${escapeHtml(input.documentUrl)}"
           style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px">
          View the quote
        </a>
      </p>
    </div>
  `.trim();

  return { subject, text, html, replyTo: undefined };
}

/**
 * Sent to the client when a manager revokes an outstanding link. No blame,
 * no detail: the client did nothing wrong and the reason is the manager's to
 * give, not this email's.
 */
export function buildRevokedEmail(input: {
  quoteNumber: string;
  authorName: string;
  replyTo?: string;
}): BuiltEmail {
  const subject = `Quotation ${input.quoteNumber} is no longer current`;

  const text = [
    `The link previously sent for quotation ${input.quoteNumber} has been withdrawn.`,
    ``,
    `${input.authorName} will be in touch with an update.`,
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">
      <p style="margin:0 0 16px">
        The link previously sent for quotation
        <strong>${escapeHtml(input.quoteNumber)}</strong> has been withdrawn.
      </p>
      <p style="margin:0">${escapeHtml(input.authorName)} will be in touch with an update.</p>
    </div>
  `.trim();

  return { subject, text, html, replyTo: input.replyTo };
}
