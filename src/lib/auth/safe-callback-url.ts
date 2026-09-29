// Where a completed sign-in is allowed to land.
//
// `callbackUrl` arrives in a URL that was mailed to someone, so it is a
// redirect target under attacker control — the classic open-redirect shape,
// and a phishing primitive when it rides on the end of a real sign-in. Only
// same-origin destinations survive; anything else is dropped and the caller
// falls back to "/".

/**
 * Returns the destination if it is same-origin, otherwise `undefined`.
 *
 * Accepts a relative path or an absolute URL on `origin`. A protocol-relative
 * "//evil.example/path" is rejected: browsers read it as an absolute URL on
 * another host, and a naive `startsWith("/")` check would wave it through.
 */
export function safeCallbackUrl(
  value: string | undefined | null,
  origin: string | undefined | null
): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("//")) return undefined;
  if (value.startsWith("/")) return value;
  if (!origin) return undefined;
  try {
    return new URL(value).origin === new URL(origin).origin ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Where a signed-in visitor has no business being sent: the sign-in page
 * itself. Sending them there after a successful sign-in reads as "it didn't
 * work", which is what every magic link did while the email carried
 * callbackUrl=/login (the Referer next-auth falls back to). */
function isSignInPage(path: string): boolean {
  return path === "/login" || path.startsWith("/login?") || path.startsWith("/login/");
}

/**
 * The relative-path-only form, for values that arrive from our own login
 * form rather than from a URL: a same-origin path, or "/".
 *
 * Rejects "//host" and "/\host" (browsers read both as protocol-relative,
 * i.e. another host) and the sign-in page itself, so that "after signing in,
 * go to X" can never mean "go back to the login form".
 */
export function safeRelativeCallbackUrl(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (isSignInPage(value)) return "/";
  return value;
}
