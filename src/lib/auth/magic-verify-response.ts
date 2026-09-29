// The two halves of /api/auth/magic-verify that touch @auth/core's output:
// reading its redirect, and passing its session cookie on to the browser.
// Both were wrong once, and both failed the same way — the person pressed
// "Sign in", was sent somewhere, and arrived signed out — so they live here,
// where tests/magic-verify-response.test.ts can pin them against the real
// NextResponse rather than against a mock of it.

import { NextResponse } from "next/server";
import { challengeCookieName, challengeCookieOptions } from "./magic-challenge";
import type { ConsumeResult } from "./verify-magic-link";

/** Auth.js `pages.signIn`. src/auth.ts reads it from here so the two cannot drift. */
export const SIGN_IN_PATH = "/login";

/**
 * Turns the Location @auth/core answered the forwarded callback with into a
 * verdict.
 *
 * @auth/core reports every failure as a redirect, but not always to the same
 * page: errors of kind "signIn" (EmailSignInError, MissingCSRF, …) go to
 * `pages.signIn` — our /login — and only the rest go to /api/auth/error.
 * Checking for /api/auth/error alone read a signIn-kind failure as a success
 * and "signed in" the user onto the login form. Both pages carry `?error=`,
 * and a genuine success never lands on either, so the pair is the test.
 */
export function consumeResultFromLocation(location: string, origin: string): ConsumeResult {
  if (!location) return { ok: false, reason: "error" };

  const url = new URL(location, origin);
  const error = url.searchParams.get("error");
  const isErrorPage =
    url.pathname.endsWith("/api/auth/error") || (url.pathname === SIGN_IN_PATH && error !== null);
  if (!isErrorPage) return { ok: true, redirectTo: location };

  // Only `Verification` means the token itself was expired, spent or unknown;
  // `AccessDenied` is the signIn callback refusing a deactivated account;
  // anything else — `Configuration` most of all — is our problem, not the
  // user's, and must not be reported as an expired link.
  if (error === "Verification") return { ok: false, reason: "invalid" };
  if (error === "AccessDenied") return { ok: false, reason: "denied" };
  console.error("[auth] magic-link verify failed:", error);
  return { ok: false, reason: "error" };
}

/**
 * The 200 answer: where to go next, the session cookies @auth/core minted,
 * and the spent challenge cookie cleared.
 *
 * ORDER MATTERS. `NextResponse.cookies` is a view over a map it builds when
 * the response is constructed, and every `.set()` rewrites the whole
 * Set-Cookie header from that map. Session cookies appended to the headers
 * first are not in the map, so a `.set()` after them silently deletes them —
 * which is exactly what shipped on 2026-09-29: the token was spent, the
 * session was minted, and the browser only ever received the challenge
 * cookie's deletion. Every magic-link sign-in ended back on /login.
 *
 * So the challenge goes through the cookies API first, and the session
 * cookies are appended last. Nothing may call `response.cookies` on the
 * returned value.
 */
export function grantedResponse(redirectTo: string, sessionCookies: string[]): NextResponse {
  const response = NextResponse.json({ redirectTo }, { status: 200 });

  // The token is spent, so its challenge is dead weight. Leaving it would let
  // a stale nonce shadow the next sign-in from this browser.
  response.cookies.set(challengeCookieName(), "", { ...challengeCookieOptions(0), maxAge: 0 });

  for (const cookie of sessionCookies) response.headers.append("set-cookie", cookie);
  return response;
}
