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
