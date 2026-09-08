"use server";

import { cookies } from "next/headers";
import { AuthError } from "next-auth";
import { MAGIC_LINK_MAX_AGE_SECONDS, signIn, signOut } from "@/auth";
import { withPendingChallenge } from "@/lib/auth/adapter";
import {
  challengeCookieName,
  challengeCookieOptions,
  generateChallenge,
  hashChallenge,
} from "@/lib/auth/magic-challenge";

type ActionResult = {
  error?: string;
  success?: string;
  /** Address a magic link was actually sent to, for the confirmation screen. */
  sentTo?: string;
};

const GENERIC_ERROR = "Email or password is incorrect";

// --- In-memory rate limiting ------------------------------------------------
//
// Keyed by normalized email. This is intentionally simple: a plain Map held
// in the module's memory, not backed by Redis or the database. It resets on
// every process restart/deploy and is not shared across instances. That's an
// accepted tradeoff for this single-instance internal app — the goal is to
// blunt casual brute-force/spam attempts, not to withstand a distributed
// attacker.

type AttemptWindow = { count: number; windowStart: number };

function isRateLimited(
  attempts: Map<string, AttemptWindow>,
  key: string,
  max: number,
  windowMs: number
): boolean {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.windowStart >= windowMs) return false;
  return entry.count >= max;
}

function recordAttempt(attempts: Map<string, AttemptWindow>, key: string, windowMs: number) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    attempts.set(key, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
}

// --- callbackUrl -------------------------------------------------------------

// Only allow same-origin relative paths for post-login redirects: must start
// with a single "/" and not "//" (a "//host/path" value is treated by
// browsers — and by some redirect() implementations — as protocol-relative,
// i.e. it navigates to an attacker-controlled external host). Anything else
// falls back to "/".
function safeCallbackUrl(value: FormDataEntryValue | null): string {
  if (typeof value !== "string") return "/";
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  return "/";
}

// --- Password login ----------------------------------------------------------

const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_MAX = 5;
const loginAttempts = new Map<string, AttemptWindow>();

export async function loginWithPassword(formData: FormData): Promise<ActionResult> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");
  const callbackUrl = safeCallbackUrl(formData.get("callbackUrl"));

  if (!email || !password) {
    return { error: GENERIC_ERROR };
  }

  if (isRateLimited(loginAttempts, email, LOGIN_ATTEMPT_MAX, LOGIN_ATTEMPT_WINDOW_MS)) {
    // Same generic message as any other failure — don't reveal that the
    // account is being rate-limited.
    return { error: GENERIC_ERROR };
  }

  try {
    await signIn("credentials", {
      email,
      password,
      redirectTo: callbackUrl,
    });
    return {};
  } catch (error) {
    if (error instanceof AuthError) {
      // Never reveal whether the email exists, whether the password was
      // wrong, or whether the account is inactive — always the same
      // generic message.
      recordAttempt(loginAttempts, email, LOGIN_ATTEMPT_WINDOW_MS);
      return { error: GENERIC_ERROR };
    }
    // Next's redirect() throws a special error to perform the navigation;
    // rethrow anything that isn't an AuthError so that redirect works. This
    // is the success path, so clear this email's failed-attempt counter.
    loginAttempts.delete(email);
    throw error;
  }
}

// --- Magic link --------------------------------------------------------------

const MAGIC_LINK_SENT = "Check your email for a sign-in link.";
const MAGIC_LINK_NO_EMAIL = "Enter your email address";
const MAGIC_LINK_SEND_FAILED = "Couldn't send the sign-in link. Try again, or sign in with your password.";
const MAGIC_LINK_WINDOW_MS = 15 * 60 * 1000;
const MAGIC_LINK_MAX = 3;
const magicLinkSends = new Map<string, AttemptWindow>();

/**
 * Request a magic sign-in link.
 *
 * NOTE ON EMAIL ENUMERATION — an unregistered address gets exactly the same
 * "check your email" confirmation as a registered one, so this endpoint can't
 * be used to discover which company addresses have accounts. That is why the
 * confirmation is worded as an instruction ("we sent a link to X") rather than
 * a claim about the account.
 *
 * Saying the same thing either way does NOT mean sending either way: the
 * `signIn` callback in src/auth.ts runs before @auth/core issues a token or
 * calls sendVerificationRequest (see @auth/core/lib/actions/signin/send-token,
 * where callbacks.signIn is awaited well ahead of the send), so an unknown or
 * inactive address costs nothing — no SMTP call, no Resend quota.
 */
export async function sendMagicLink(formData: FormData): Promise<ActionResult> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();

  if (!email) return { error: MAGIC_LINK_NO_EMAIL };

  if (isRateLimited(magicLinkSends, email, MAGIC_LINK_MAX, MAGIC_LINK_WINDOW_MS)) {
    // Report success rather than "slow down": the address is registered (we
    // got here), a link was already sent within the window, and telling the
    // user to check their email is both true and the action we want.
    return { success: MAGIC_LINK_SENT, sentTo: email };
  }
  recordAttempt(magicLinkSends, email, MAGIC_LINK_WINDOW_MS);

  // Mint the challenge before asking @auth/core for a link. Only its hash
  // reaches the database, attached to the token row by the adapter wrapper;
  // the raw value goes to this browser as an httpOnly cookie below. A browser
  // that presents it back at verify time is demonstrably the one that asked,
  // and signs in with no click. Anything else — a link scanner in the
  // recipient's mail pipeline, or the same person's phone — gets a button.
  // See src/lib/auth/magic-challenge.ts.
  const challenge = generateChallenge();

  try {
    await withPendingChallenge(hashChallenge(challenge), () =>
      signIn("nodemailer", { email, redirect: false })
    );
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;

    // The `signIn` callback in src/auth.ts rejects unknown/inactive emails
    // with AccessDenied *before* a verification token is created or an email
    // is sent. Auth.js throws it all the way out here even with
    // `redirect: false`, because Next Server Actions run through the "raw"
    // codepath. Report the same confirmation as a real send — including
    // `sentTo`, so the rendered screen is byte-identical either way.
    if (error.type === "AccessDenied") {
      return { success: MAGIC_LINK_SENT, sentTo: email };
    }

    // Anything else is a genuine send failure — most often SMTP auth or an
    // unverified sending domain. Auth.js wraps a throwing
    // sendVerificationRequest in EmailSignInError, which is also an AuthError,
    // so this used to be swallowed and reported as success: the login page
    // said "check your email" while nothing had been sent and nothing was
    // logged. Log the cause and tell the user the truth.
    //
    // This branch is only reachable for a registered address (an unregistered
    // one was rejected above), so during an SMTP outage the distinct message
    // does confirm the account exists. Accepted: it requires mail to be broken
    // at that moment, and the alternative — a silent lie while nobody can sign
    // in — is worse. To close it, return the success shape here as well and
    // rely on the server log.
    console.error("[auth] magic link send failed", error);
    return { error: MAGIC_LINK_SEND_FAILED };
  }

  // Set only once a link is genuinely on its way. The AccessDenied branch
  // above returns before this point, so an unknown or inactive address leaves
  // no cookie behind — which also keeps this endpoint from becoming a way to
  // probe which addresses have accounts by watching for a Set-Cookie header.
  (await cookies()).set(
    challengeCookieName(),
    challenge,
    challengeCookieOptions(MAGIC_LINK_MAX_AGE_SECONDS)
  );

  return { success: MAGIC_LINK_SENT, sentTo: email };
}

export async function logout(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
