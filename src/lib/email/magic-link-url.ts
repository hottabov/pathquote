// Turns the Auth.js one-time callback URL into a link that is safe to put in
// an email.
//
// WHY THIS EXISTS — 2026-09-07 incident. A magic link sent to a Microsoft 365
// mailbox was consumed 24 seconds after sending, 31 seconds before it reached
// the recipient's inbox, by an automated link scanner (a datacenter IP with a
// spoofed desktop-Chrome user agent). The human's click 90 seconds later hit
// "The sign in link is no longer valid".
//
// That is not a bug in Auth.js so much as an unavoidable consequence of its
// shape: @auth/prisma-adapter's `useVerificationToken` is a DELETE, and
// @auth/core runs it *before* any validity check (see
// node_modules/@auth/core/lib/actions/callback/index.js, where the delete's
// result is what the `hasInvite`/`expired` checks then examine). So the very
// first GET of the callback URL burns the token — and, worse, that GET is a
// complete sign-in: the scanner received a valid 7-day session cookie.
//
// The fix is to make a GET incapable of consuming anything. The email links to
// /login/confirm, which is an ordinary idempotent page; the token is only spent
// when a human presses the button there, which submits a POST to the real
// callback. Scanners follow links; they do not submit forms.
//
// POST works for this without extra plumbing: @auth/core validates a CSRF token
// on a POSTed `callback` action only when `provider.type === "credentials"`
// (lib/index.js), and it reads `token`/`email` from the query string rather
// than the body (lib/actions/callback/index.js), so the parameters can stay
// exactly where they already are.
//
// Kept as a pure function in its own module — no env reads, no NextAuth
// imports — for the same reason as magic-link.ts next door: it is the piece
// most worth unit-testing. See tests/magic-link-confirm-url.test.ts.

/** Path of the interstitial page. Must match src/app/login/confirm/page.tsx. */
export const CONFIRM_PATH = "/login/confirm";

/**
 * Rewrite `${basePath}/callback/nodemailer?…` to `/login/confirm?…` on the
 * same origin, leaving the query string byte-for-byte intact.
 *
 * Throws rather than falling back to the original URL. Every input rejected
 * here is one we don't recognise, and quietly emailing an unrecognised link
 * would restore exactly the behaviour this module exists to prevent — a link
 * that signs you in on GET. A failed send is loud (`sendMagicLink` logs it and
 * tells the user to try again or use a password) and safe; a silent fallback
 * is neither.
 */
export function toConfirmUrl(callbackUrl: string): string {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new Error("Magic-link callback URL is not an absolute URL");
  }

  // Matches any basePath (`/api/auth`, `/auth`, …) but pins the provider, so a
  // future second email-style provider has to come through here deliberately.
  if (!url.pathname.endsWith("/callback/nodemailer")) {
    throw new Error(`Unexpected magic-link callback path: ${url.pathname}`);
  }

  // Without both of these the confirm page has nothing to POST and the user
  // would meet a broken button instead of a failed send.
  for (const param of ["token", "email"] as const) {
    if (!url.searchParams.get(param)) {
      throw new Error(`Magic-link callback URL is missing "${param}"`);
    }
  }

  // Assigning `pathname` alone leaves `search` untouched, which is the point:
  // the token is compared byte-for-byte against sha256(token + AUTH_SECRET),
  // so a round-trip through URLSearchParams — which would re-encode it — is a
  // risk with no upside.
  url.pathname = CONFIRM_PATH;
  return url.toString();
}
