/**
 * The client "Send quotation" email: token-fill for the editable subject/body,
 * and the bulletproof HTML + plain-text bodies (spec §7.3/§7.4).
 *
 * Pure — no Prisma, no transport, no env — so it is unit-testable and so the
 * Send dialog can call the exact same builders for its live preview as the
 * server does for the real send (the manager previews what the client gets).
 * The server action resolves the values, calls `renderQuoteSendDraft` to
 * prefill the dialog, then `buildQuoteSendEmail` to produce what nodemailer
 * sends and what is stored on `QuoteEmail`.
 *
 * Tokens are flat (`{{clientFirstName}}`, `{{signLink}}`, …), not the spec's
 * dotted `{{client.firstName}}`: the repo's placeholder pattern only matches
 * `[A-Za-z0-9_]`. An unresolved token is replaced with "" and the stray
 * spaces/punctuation it leaves are tidied (spec §7.2) — deliberately NOT the
 * whole-line strip the legal-document resolver does, because these tokens sit
 * mid-sentence and mid-subject, where dropping the line would be wrong.
 */

// --- tokens ------------------------------------------------------------------

export const QUOTE_SEND_TOKENS = [
  "clientFirstName",
  "clientLastName",
  "clientCompany",
  "quoteNumber",
  "quoteLabel",
  "quoteRevision",
  "quoteTotal",
  "quoteCurrency",
  "quoteValidUntil",
  "managerFirstName",
  "managerFullName",
  "managerTitle",
  "managerPhone",
  "managerEmail",
  "companyName",
  "companyWebsite",
  "companyAddress",
  "signLink",
] as const;

export type QuoteSendToken = (typeof QUOTE_SEND_TOKENS)[number];
export type QuoteSendVars = Record<QuoteSendToken, string>;

const TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Replaces every `{{token}}` with its value (empty string when missing or
 * unknown), then tidies the debris an emptied token leaves: a space before a
 * comma/period, doubled spaces, and a dangling separator at a line's end
 * (e.g. "prepared for ." → "prepared for"). Operates per line so a blank line
 * in the manager's message survives.
 */
export function fillTokens(text: string, vars: Partial<QuoteSendVars>): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(TOKEN_PATTERN, (_match, name: string) => vars[name as QuoteSendToken] ?? "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\s+([,.;:])/g, "$1")
        .replace(/[ \t]+$/g, "")
    )
    .join("\n");
}

// --- default templates (spec §7.3) -------------------------------------------
//
// Code constants that are the fallback when no admin-edited Setting exists.
// `revision === 0` picks the first-send copy; anything higher picks "revised".

export const DEFAULT_FIRST_SEND_SUBJECT = "{{companyName}} — Quotation {{quoteLabel}} for {{clientCompany}}";
export const DEFAULT_FIRST_SEND_BODY = `Hi {{clientFirstName}},

Thank you for your interest in our cutting solutions. Please find attached quotation {{quoteLabel}}, prepared for {{clientCompany}}.

The quotation is valid until {{quoteValidUntil}}. If anything needs adjusting — a different configuration, additional options, or delivery terms — just reply to this email and I'll update it for you.

Kind regards,`;

export const DEFAULT_RESEND_SUBJECT = "{{companyName}} — Quotation {{quoteLabel}} (revised)";
export const DEFAULT_RESEND_BODY = `Hi {{clientFirstName}},

As discussed, I've updated the quotation. Attached is revision {{quoteLabel}}, which replaces the previous version.

Let me know if this works for you or if you'd like any further changes.

Kind regards,`;

export interface QuoteSendTemplates {
  subject: string;
  body: string;
}

/** Picks the first-send or revised template pair by revision, preferring an
 * admin-edited override when supplied. */
export function pickQuoteSendTemplate(
  revision: number,
  overrides?: { firstSend?: Partial<QuoteSendTemplates>; resend?: Partial<QuoteSendTemplates> }
): QuoteSendTemplates {
  if (revision > 0) {
    return {
      subject: overrides?.resend?.subject ?? DEFAULT_RESEND_SUBJECT,
      body: overrides?.resend?.body ?? DEFAULT_RESEND_BODY,
    };
  }
  return {
    subject: overrides?.firstSend?.subject ?? DEFAULT_FIRST_SEND_SUBJECT,
    body: overrides?.firstSend?.body ?? DEFAULT_FIRST_SEND_BODY,
  };
}

/** Fills a template pair with resolved values, ready to prefill the Send
 * dialog (the manager sees finished text, not `{{tokens}}`). */
export function renderQuoteSendDraft(templates: QuoteSendTemplates, vars: QuoteSendVars): QuoteSendTemplates {
  return { subject: fillTokens(templates.subject, vars), body: fillTokens(templates.body, vars) };
}

// --- HTML + plain-text bodies (spec §7.4) ------------------------------------

export interface QuoteSendEmail {
  subject: string;
  html: string;
  text: string;
}

export interface QuoteSendContext {
  /** Final subject/message the manager is sending — already token-filled (the
   * dialog shows and lets them edit the resolved text). */
  subject: string;
  message: string;
  /** The summary card. */
  summary: { label: string; configuration: string; total: string; validUntil: string };
  /** The auto-composed manager signature — the manager cannot mistype it. */
  signature: { fullName: string; title: string | null; phone: string | null; email: string | null };
  company: { name: string; website: string | null; address: string | null };
  /** The single CTA — the signing page for this revision. */
  signLink: string;
  /** Absolute URL of the company logo, or null to fall back to the name. */
  logoUrl?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Manager message → HTML paragraphs, blank line = paragraph break, single
 * newlines become <br>. Preserves the line breaks the manager typed. */
function messageToHtml(message: string): string {
  return message
    .trim()
    .split(/\n{2,}/)
    .map(
      (para) =>
        `<p style="margin:0 0 16px;color:#1f2937;font-size:15px;line-height:1.6;">${escapeHtml(para)
          .split("\n")
          .join("<br>")}</p>`
    )
    .join("");
}

const BG = "#f3f4f6";
const CARD = "#ffffff";
const INK = "#1f2937";
const MUTED = "#6b7280";
const BRAND = "#111827";

/**
 * The bulletproof email: a 600px table layout, every style inline, every
 * background explicit (so a dark-mode client can't repaint the card),
 * `role="presentation"` on the layout tables, alt text on the logo, and a
 * table-based button rather than a padded `<a>` (Outlook eats the padding).
 * The signature and footer are composed here, not typed by the manager.
 */
export function buildQuoteSendHtml(ctx: QuoteSendContext): string {
  const logo = ctx.logoUrl
    ? `<img src="${escapeHtml(ctx.logoUrl)}" alt="${escapeHtml(ctx.company.name)}" width="160" style="display:block;border:0;max-width:160px;height:auto;" />`
    : `<span style="font-size:20px;font-weight:700;color:${BRAND};">${escapeHtml(ctx.company.name)}</span>`;

  const sigLines = [
    ctx.signature.fullName,
    ctx.signature.title,
    ctx.signature.phone,
    ctx.signature.email,
  ]
    .filter((line): line is string => Boolean(line && line.trim() !== ""))
    .map((line) => `<div style="color:${INK};font-size:14px;line-height:1.5;">${escapeHtml(line)}</div>`)
    .join("");

  const footerLines = [ctx.company.name, ctx.company.address, ctx.company.website]
    .filter((line): line is string => Boolean(line && line.trim() !== ""))
    .map((line) => escapeHtml(line))
    .join(" &nbsp;·&nbsp; ");

  return `<!-- preheader hidden --><div style="display:none;max-height:0;overflow:hidden;">Quotation ${escapeHtml(
    ctx.summary.label
  )}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};margin:0;padding:0;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:${CARD};border-radius:8px;overflow:hidden;">
        <tr>
          <td style="padding:24px 32px;border-bottom:1px solid #e5e7eb;background:${CARD};">${logo}</td>
        </tr>
        <tr>
          <td style="padding:24px 32px;background:${CARD};">
            ${messageToHtml(ctx.message)}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;margin:8px 0 24px;">
              <tr><td style="padding:16px 20px;">
                <div style="font-size:16px;font-weight:700;color:${INK};margin-bottom:6px;">${escapeHtml(
                  ctx.summary.label
                )}</div>
                <div style="font-size:14px;color:${MUTED};line-height:1.5;">${escapeHtml(
                  ctx.summary.configuration
                )}</div>
                <div style="font-size:14px;color:${INK};margin-top:8px;">Total: <strong>${escapeHtml(
                  ctx.summary.total
                )}</strong></div>
                <div style="font-size:13px;color:${MUTED};margin-top:2px;">Valid until ${escapeHtml(
                  ctx.summary.validUntil
                )}</div>
              </td></tr>
            </table>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
              <tr><td align="center" bgcolor="${BRAND}" style="border-radius:6px;">
                <a href="${escapeHtml(
                  ctx.signLink
                )}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">Review &amp; sign quotation</a>
              </td></tr>
            </table>
            ${sigLines}
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;border-top:1px solid #e5e7eb;background:#f9fafb;font-size:12px;color:${MUTED};line-height:1.6;">
            ${footerLines}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

/** The mandatory text/plain alternative — without it the message trips spam
 * filters (spec §7.4). Mirrors the HTML's information, no markup. */
export function buildQuoteSendText(ctx: QuoteSendContext): string {
  const sig = [ctx.signature.fullName, ctx.signature.title, ctx.signature.phone, ctx.signature.email]
    .filter((line): line is string => Boolean(line && line.trim() !== ""))
    .join("\n");
  const footer = [ctx.company.name, ctx.company.address, ctx.company.website]
    .filter((line): line is string => Boolean(line && line.trim() !== ""))
    .join(" · ");
  return [
    ctx.message.trim(),
    "",
    `${ctx.summary.label}`,
    ctx.summary.configuration,
    `Total: ${ctx.summary.total}`,
    `Valid until ${ctx.summary.validUntil}`,
    "",
    `Review & sign: ${ctx.signLink}`,
    "",
    sig,
    "",
    footer,
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Builds the whole email — subject, HTML and text — in one call. */
export function buildQuoteSendEmail(ctx: QuoteSendContext): QuoteSendEmail {
  return { subject: ctx.subject, html: buildQuoteSendHtml(ctx), text: buildQuoteSendText(ctx) };
}
