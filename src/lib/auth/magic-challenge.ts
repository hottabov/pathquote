// Device-binding challenge for magic-link sign-in.
//
// Background: a magic link is a credential sent by email, and email is now
// routinely opened by machines before it is opened by people. On 2026-09-07 a
// link scanner fetched one of ours 24 seconds after sending — 31 seconds
// before the mail reached the inbox — and, because consuming the token was
// reachable by a plain GET, both burned the link and collected a valid
// session. Moving consumption to POST (src/app/login/confirm) fixed the burn;
// this module is the second half, which buys the click back.
//
// The shape: when a link is requested, we mint a nonce, hand the raw value to
// the requesting browser as an httpOnly cookie, and store only its SHA-256 on
// the token row. At verify time a browser that presents the matching cookie is
// the browser that asked, so it signs in with no interaction. Anything else —
// a scanner, or the same person's phone — is asked to press a button.
//
// WHAT THIS IS NOT: it is not an authorization gate. Possession of the link
// still authenticates; that is what a magic link *is*. The confirm button
// bypasses the challenge with no nonce at all, on purpose. Making the nonce
// mandatory would "harden" the feature straight into breaking the ordinary
// cross-device case — requested on a laptop, opened in the phone's mail app —
// which shares a lane with the scanner and must keep working. The scanner is
// stopped by needing a POST, not by needing the cookie.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Name of the challenge cookie. Mirrors how Auth.js names its own cookies:
 * the `__Secure-` prefix (which browsers only honour on a Secure cookie with
 * Path=/) whenever the deployment is https, and the bare name in local dev
 * over http, where the prefix would make the cookie be rejected outright.
 */
export function challengeCookieName(authUrl = process.env.AUTH_URL): string {
  const secure = !!authUrl && authUrl.startsWith("https://");
  return secure ? "__Secure-authjs.magic-challenge" : "authjs.magic-challenge";
}

/**
 * Cookie attributes for the challenge, mirroring the ones Auth.js gives its
 * own session cookie (httpOnly, Lax, Path=/, Secure on https, host-only).
 *
 * Lax rather than Strict is what makes the flow work at all: the user arrives
 * from their mail client, which is a cross-site top-level navigation, and Lax
 * is the setting that still sends the cookie on one of those.
 *
 * `maxAge` is the token's own lifetime — a challenge that outlived its token
 * would linger in the browser and shadow the next sign-in.
 */
export function challengeCookieOptions(maxAgeSeconds: number, authUrl = process.env.AUTH_URL) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: !!authUrl && authUrl.startsWith("https://"),
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** Raw nonce for the cookie. 32 bytes, URL-safe so it needs no cookie escaping. */
export function generateChallenge(): string {
  return randomBytes(32).toString("base64url");
}

/** What actually goes in the database. The raw nonce is never stored. */
export function hashChallenge(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Recomputes the `VerificationToken.token` value for a raw token from the
 * sign-in URL.
 *
 * This must stay bit-identical to @auth/core's own hashing — see
 * node_modules/@auth/core/lib/actions/signin/send-token.js, which stores
 * `createHash(`${token}${secret}`)`. We are looking up a row @auth/core wrote,
 * and this is a read-only lookup: the row is still consumed by @auth/core
 * itself, never by us.
 */
export function hashVerificationToken(rawToken: string, secret: string): string {
  return createHash("sha256").update(`${rawToken}${secret}`).digest("hex");
}

/**
 * Constant-time comparison of a presented nonce against a stored hash.
 *
 * Lengths are compared first because `timingSafeEqual` throws when its inputs
 * differ in length, and a throw here would become a 500 instead of a refusal.
 * Comparing the length of two SHA-256 hex digests leaks nothing — it is always
 * 64 either way.
 */
export function challengeMatches(
  cookieValue: string | undefined | null,
  storedHash: string | undefined | null
): boolean {
  if (!cookieValue || !storedHash) return false;
  const presented = Buffer.from(hashChallenge(cookieValue), "utf8");
  const stored = Buffer.from(storedHash, "utf8");
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}

/** The row shape the pre-check needs; `null` when no such token exists. */
export type ChallengeRow = { expires: Date; challengeHash: string | null } | null;

export type ChallengeDecision = "consume" | "confirm";

/**
 * Decides whether a verify attempt may proceed to consumption, or must first
 * be confirmed by a human.
 *
 * Deliberately pure and total, because every interesting rule in this feature
 * is a rule about *when not to fire*:
 *
 * - It never grants anything. "consume" means only "this pre-check has no
 *   objection"; the actual spend is @auth/core's atomic DELETE, which decides
 *   for itself whether the token is real. The pre-check can refuse and nothing
 *   else.
 *
 * - It fires only for a live row that carries a challenge. An unknown token,
 *   an expired one, or one already spent falls through to the normal path and
 *   earns the ordinary 401. Were any of those to earn a 409 instead, the
 *   response would become an oracle telling an attacker which tokens are still
 *   worth attacking.
 *
 * - A NULL `challengeHash` means the row was issued before this change. Those
 *   consume on first verify exactly as they used to, so links in flight during
 *   the deploy do not break.
 */
export function decideChallenge({
  row,
  cookie,
  confirmed,
  now = new Date(),
}: {
  row: ChallengeRow;
  cookie: string | undefined | null;
  confirmed: boolean;
  now?: Date;
}): ChallengeDecision {
  if (confirmed) return "consume";
  if (!row) return "consume";
  if (row.expires.getTime() <= now.getTime()) return "consume";
  if (!row.challengeHash) return "consume";
  return challengeMatches(cookie, row.challengeHash) ? "consume" : "confirm";
}
