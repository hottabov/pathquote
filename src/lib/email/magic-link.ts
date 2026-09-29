// Magic-link sign-in email.
//
// Kept separate from `src/auth.ts` (which only wires up the SMTP transport) so
// the template is a pure function: no Prisma, no NextAuth, no env reads, and
// therefore unit-testable. See tests/magic-link-email.test.ts.
//
// Auth.js ships a default template, but it lives at an unexported deep path
// inside @auth/core and is branded "Auth.js". Ours also needs a Reply-To,
// because the From address (noreply@q.pathfindercut.com) is on the Resend
// sending subdomain and receives nothing.

const PRODUCT_NAME = "PathQuote";

// The app's own palette (src/app/globals.css: --color-brand, -brand-dark,
// -brand-accent), repeated here as literals because mail has no CSS variables.
const BRAND = "#243478";
const BRAND_DARK = "#2b304f";
const ACCENT = "#00b8e2";
const INK = "#334155";
const MUTED = "#64748b";
const RULE = "#e2e8f0";
const PAGE_BG = "#eef1f6";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type MagicLinkEmailInput = {
  /** The one-time Auth.js callback URL. */
  url: string;
  /** Address a human actually reads. Blank/whitespace is treated as unset. */
  replyTo?: string;
  /** Link lifetime, for the copy only. Should match the provider's `maxAge`. */
  maxAgeMinutes?: number;
};

export type MagicLinkEmail = {
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
};

export function buildMagicLinkEmail({
  url,
  replyTo,
  maxAgeMinutes = 15,
}: MagicLinkEmailInput): MagicLinkEmail {
  const href = escapeHtml(url);
  const validFor = `${maxAgeMinutes} minutes`;

  const text = [
    `Sign in to ${PRODUCT_NAME}`,
    "",
    "Open this link to sign in:",
    url,
    "",
    `The link is valid for ${validFor} and can only be used once.`,
    "If you didn't request it, you can ignore this email.",
  ].join("\n");

  // Table-based layout and inline styles only: Outlook on Windows renders
  // mail with Word's engine, which ignores <style> blocks, padding on an <a>,
  // and most modern CSS. That last one is why the button used to collapse to
  // the size of its label — its padding lived on the link. Here the colour
  // and padding sit on the table cell (`bgcolor` too, for clients that drop
  // `background`), and the link inside is display:block so the whole button
  // is clickable where the client allows it. Every background is explicit so
  // a dark-mode client cannot repaint the card and leave white-on-white text.
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>Sign in to ${PRODUCT_NAME}</title>
  </head>
  <body style="margin:0;padding:0;background:${PAGE_BG};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PAGE_BG};">Your one-time sign-in link, valid for ${validFor}.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE_BG}" style="background:${PAGE_BG};">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:480px;">
            <tr>
              <td bgcolor="${BRAND}" style="background:${BRAND};border-radius:12px 12px 0 0;padding:22px 40px;font-family:${FONT};font-size:20px;line-height:24px;font-weight:700;letter-spacing:0.2px;color:#ffffff;">
                ${PRODUCT_NAME}
              </td>
            </tr>
            <tr>
              <td bgcolor="${ACCENT}" style="background:${ACCENT};height:4px;line-height:4px;font-size:4px;">&nbsp;</td>
            </tr>
            <tr>
              <td bgcolor="#ffffff" style="background:#ffffff;border-radius:0 0 12px 12px;padding:36px 40px 32px;font-family:${FONT};color:${INK};">
                <h1 style="margin:0 0 12px;font-family:${FONT};font-size:22px;line-height:30px;font-weight:700;color:${BRAND_DARK};">Sign in to ${PRODUCT_NAME}</h1>
                <p style="margin:0 0 28px;font-size:15px;line-height:24px;color:${INK};">Press the button below to sign in. No password needed.</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" bgcolor="${BRAND}" style="background:${BRAND};border-radius:8px;">
                      <a href="${href}" target="_blank" style="display:block;padding:16px 32px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;text-align:center;border-radius:8px;">Sign in to ${PRODUCT_NAME}</a>
                    </td>
                  </tr>
                </table>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;">
                  <tr>
                    <td style="border-top:1px solid ${RULE};padding-top:20px;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};">
                      The link is valid for <strong style="color:${INK};">${validFor}</strong> and can only be used once.<br />
                      If you didn't request it, you can ignore this email.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:20px 16px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">
                ${PRODUCT_NAME} &middot; Pathfinder Cutting Solutions
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const trimmedReplyTo = replyTo?.trim();

  return {
    subject: `Sign in to ${PRODUCT_NAME}`,
    text,
    html,
    replyTo: trimmedReplyTo ? trimmedReplyTo : undefined,
  };
}
