// A company's website: how it is stored, how it is shown, how it is linked.
//
// Pure on purpose. The ACT! import, the company form and every place that
// renders a link all need the same rule, and a rule that lives in one of them
// is a rule the others quietly disagree with. That is how the clients list came
// to link `<a href="www.erpo.de">`: the import stored what ACT! held, the form
// stored something else, and the renderer trusted both.
//
// THE DESIGN: the column holds a bare address -- no scheme -- and the scheme is
// added where a link is drawn. `www.erpo.de` is stored; `https://www.erpo.de`
// is what an href gets. Never put `href={company.website}` anywhere: a value
// with no scheme is a RELATIVE url, so the browser resolves it against the page
// it is on and the link goes to `https://<this app>/www.erpo.de`. eslint.config
// has a rule that refuses the pattern; use `websiteHref` instead.
//
// WHAT THIS GIVES UP: the scheme is not stored, so it cannot be remembered, and
// `http://` input is folded to `https://`. A site that is genuinely http-only
// in 2026 is rare enough that forcing https is the better default -- but for
// that rare site the link will fail to load (certificate or connection error)
// until someone fixes the site or types the address into the browser by hand.
// This is the one thing the design trades away; everything else it keeps.

/** The longest stored website. Matches the form field's `maxLength`. */
export const WEBSITE_MAX_LENGTH = 200;

// Letters and digits in any script, so `müller-holz.de` and `пример.рф` pass:
// a browser handles an internationalised host natively. Built with `new RegExp`
// because the tsconfig target (ES2017) rejects `\p{...}` in a regex literal even
// though every runtime this app runs on supports it.
const LABEL = "[\\p{L}\\p{N}\\p{M}](?:[\\p{L}\\p{N}\\p{M}-]*[\\p{L}\\p{N}\\p{M}])?";
// At least two labels; the last (the TLD) is letters only (or `xn--` punycode),
// which is what keeps `192.168.0.1`, `localhost` and `a.1` out. An optional
// port is allowed because `example.com:8443` is a real address.
const HOST = new RegExp(
  `^(?:${LABEL}\\.)+(?:\\p{L}{2,}|xn--[a-z0-9-]+)(?::\\d{1,5})?$`,
  "iu",
);

// `http://` and `https://`, nothing else. `ftp://`, `javascript:`, `data:`,
// `mailto:` and a protocol-relative `//host` are not websites a person would
// click through to, and two of them are XSS vectors, so they fall through to
// the host check and fail it (the colon is not a host character).
const WEB_SCHEME = /^https?:\/\//i;

export type WebsiteCheck =
  | { ok: true; value: string }
  | { ok: false; reason: "invalid" | "too-long" };

/**
 * The same decision as `normaliseWebsite`, with the reason when the answer is
 * no. The company form needs to tell "that is not a website" from "that is a
 * website but too long to store"; everything else wants only the value.
 */
export function checkWebsite(value: string | null | undefined): WebsiteCheck {
  if (typeof value !== "string") return { ok: false, reason: "invalid" };

  let rest = value.trim();
  if (rest === "") return { ok: false, reason: "invalid" };

  // Leading punctuation that can never begin a hostname, stripped before
  // anything else because the markdown case below arrives behind one.
  //
  // At most ONE slash, deliberately: "/3dbelt.com/our-brands" is a real row and
  // recovers, while "//evil.com" keeps a slash, leaves an empty host and is
  // still refused. Protocol-relative values must not become links -- see the
  // test named for it.
  rest = rest.replace(/^[.@\s]*\/?[.@\s]*/, "");

  // A markdown link, which really is in the imported data:
  //   "/[www.texasspacovers.com/about-us/](https://www.texasspacovers.com/...)"
  // Somebody pasted a formatted link into Act!'s free-text field years ago.
  // Take the target and carry on with it; the label is usually the same URL
  // without its scheme, so either would do, but the target is the one meant to
  // be followed.
  const markdown = rest.match(/^\s*\[[^\]]*\]\(([^)\s]+)\)\s*$/);
  if (markdown) rest = markdown[1];

  // The real values the strip above recovers are "/3dbelt.com/our-brands",
  // ".mareclean.com" and "@sweetvictorian.com" -- usable sites spoiled by one
  // stray character, where dropping the row would lose a working link over a
  // typo. Only a *leading* "@" goes, so "info@erpo.de" is still rejected as
  // the email address it is.
  rest = rest.replace(/^[.@\s]+/, "");

  // Whitespace anywhere else is not a url.
  if (rest === "" || /\s/.test(rest)) return { ok: false, reason: "invalid" };

  // `http://` is folded to `https://` -- by being dropped along with `https://`.
  rest = rest.replace(WEB_SCHEME, "");

  // The scheme may itself have been behind the punctuation stripped above, or
  // inside the markdown target, so look once more.
  rest = rest.replace(/^[.@]+/, "").replace(WEB_SCHEME, "");

  // Host ends at the first `/`, `?` or `#`; the remainder is kept verbatim.
  // (Paths and queries are case-sensitive, so only the host is lowercased.)
  const hostEnd = rest.search(/[/?#]/);
  const host = hostEnd === -1 ? rest : rest.slice(0, hostEnd);
  const tail = hostEnd === -1 ? "" : rest.slice(hostEnd);

  // 253 is the longest DNS name; the margin covers a port. The cap also bounds
  // the work the regex does on a hostile megabyte of input.
  if (host.length > 260 || !HOST.test(host)) return { ok: false, reason: "invalid" };

  // No trailing slash: `https://www.erpo.de/` pasted from the address bar is the
  // normal case, and `www.erpo.de` and `www.erpo.de/` are the same page. Only
  // slashes at the very end go, so `example.com/en/?page=2` keeps its path.
  const normalised = `${host.toLowerCase()}${tail.replace(/\/+$/, "")}`;

  if (normalised.length > WEBSITE_MAX_LENGTH) return { ok: false, reason: "too-long" };
  return { ok: true, value: normalised };
}

/**
 * The canonical stored form: no scheme, no trailing slash, lowercased host.
 *
 *   "https://www.erpo.de/"      -> "www.erpo.de"
 *   "WWW.ERPO.DE"               -> "www.erpo.de"
 *   "http://x.de"               -> "x.de"            (http folded to https; see top)
 *   "example.com/en/products"   -> "example.com/en/products"   (path survives)
 *   "example.com/Shop?id=7#top" -> "example.com/Shop?id=7#top" (only the host is lowercased)
 *   "not a url", "info@erpo.de", "javascript:alert(1)", "//evil.com", "" -> null
 *
 * Returns null for anything that is not a website -- null, blank, junk, a
 * non-web scheme, or something longer than WEBSITE_MAX_LENGTH once normalised.
 * Null means "store nothing", never "store the input anyway": the import calls
 * this on whatever ACT! holds, and junk in the column is junk in an href.
 *
 * Idempotent: normaliseWebsite(normaliseWebsite(x)) === normaliseWebsite(x).
 */
export function normaliseWebsite(value: string | null | undefined): string | null {
  const result = checkWebsite(value);
  return result.ok ? result.value : null;
}

/**
 * An absolute URL for an `href`, from the stored bare form, or null when there
 * is nothing safe to link to (blank, or a value that is not a website).
 *
 *   "www.erpo.de"        -> "https://www.erpo.de"
 *   "example.com/en"     -> "https://example.com/en"
 *   "https://x.de/"      -> "https://x.de"    (a row saved before z63 migrated)
 *   "not a url", null    -> null
 *
 * It normalises first, so a legacy value that still carries a scheme -- or one
 * the import wrote before it normalised -- links correctly too. The result is
 * always `https://` plus a host, never relative and never a non-web scheme.
 */
export function websiteHref(stored: string | null | undefined): string | null {
  const bare = normaliseWebsite(stored);
  return bare === null ? null : `https://${bare}`;
}

/**
 * What to show a person for a stored website: the bare form, which is the
 * stored value as-is for every row written since z63. A legacy value that still
 * has a scheme or a trailing slash is shown without them. A value that is not a
 * website at all is shown trimmed and unchanged rather than hidden, so a person
 * looking at the record can see what is wrong and fix it -- `websiteHref` is
 * null for it, so a caller that draws a link draws none.
 */
export function websiteLabel(stored: string | null | undefined): string | null {
  const bare = normaliseWebsite(stored);
  if (bare !== null) return bare;
  if (typeof stored !== "string") return null;
  const trimmed = stored.trim();
  return trimmed === "" ? null : trimmed;
}
