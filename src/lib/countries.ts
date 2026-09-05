// Pure country list + ISO 3166-1 alpha-2 helpers over the checked-in table in
// `src/lib/country-names.ts` (generated from `i18n-iso-countries` — Michael
// Wittig, Germany, MIT — deliberately chosen over alternatives per the owner's
// "no Russian-authored libraries" constraint; see that file for why the list
// is generated rather than computed at runtime, and note the package is no
// longer a dependency: generating that table was its last use, so it is
// installed on demand when the list needs regenerating). No `@/lib/db` or `next/*`
// imports — safe to import from a plain `vitest run` and from both server and
// client components (the country <select> needs this list in the browser
// bundle too).
import { COUNTRY_NAMES } from "./country-names";

export type CountryOption = { code: string; name: string };

/** Every ISO 3166-1 alpha-2 country code + English name, sorted by name —
 * the data source for `CountrySelect` and any other country picker. Copied
 * out of the readonly generated table so callers keep the mutable
 * `CountryOption[]` they've always had. */
export const COUNTRIES: CountryOption[] = COUNTRY_NAMES.map(({ code, name }) => ({ code, name }));

const COUNTRY_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c.name]));

/** True when `code` is a real ISO 3166-1 alpha-2 country code (case-sensitive
 * — callers should uppercase first, same convention as `regionCodeSchema` in
 * src/lib/validation/clients.ts). */
export function isValidCountryCode(code: string): boolean {
  return COUNTRY_BY_CODE.has(code);
}

/** The English country name for an ISO alpha-2 `code`, or `undefined` when
 * `code` isn't a recognized country. */
export function countryName(code: string): string | undefined {
  return COUNTRY_BY_CODE.get(code);
}

/** A handful of common free-text spellings that don't match their official
 * ISO name (`normalizeCountryInput`'s exact-name-match pass would otherwise
 * miss them) — keyed upper-case, values are ISO alpha-2 codes. Deliberately
 * short: this is a best-effort mapper for legacy free-text data, not a full
 * fuzzy matcher. */
const COUNTRY_ALIASES: Record<string, string> = {
  USA: "US",
  "U.S.A.": "US",
  "U.S.": "US",
  US: "US",
  "UNITED STATES": "US",
  "UNITED STATES OF AMERICA": "US",
  UK: "GB",
  "U.K.": "GB",
  "GREAT BRITAIN": "GB",
  ENGLAND: "GB",
  AUSTRALIA: "AU",
  "SOUTH KOREA": "KR",
  "NORTH KOREA": "KP",
  RUSSIA: "RU",
  "UAE": "AE",
  "UNITED ARAB EMIRATES": "AE",
  VIETNAM: "VN",
  "VIET NAM": "VN",
};

const NAME_TO_CODE = new Map(COUNTRIES.map((c) => [c.name.trim().toUpperCase(), c.code]));

/**
 * Best-effort mapper from an existing free-text `Company.country` value
 * (pre-ISO-picker data — "Australia", "USA", "United States", "UK", ...) to
 * an ISO alpha-2 code: an already-valid code passes straight through, then
 * an exact case-insensitive match against the official English country
 * name, then the small alias table above. Returns `null` when nothing
 * matches — callers (see `displayCountry`) fall back to showing the raw
 * text rather than guessing further.
 */
export function normalizeCountryInput(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const upper = trimmed.toUpperCase();
  if (isValidCountryCode(upper)) return upper;

  const byName = NAME_TO_CODE.get(upper);
  if (byName) return byName;

  const byAlias = COUNTRY_ALIASES[upper];
  if (byAlias) return byAlias;

  return null;
}

/**
 * Display helper for a possibly-legacy `Company.country` value: resolves an
 * ISO code (or a normalizable free-text value) to its English name, and
 * falls back to the raw stored value verbatim when it can't be mapped —
 * used by the clients list/detail pages and the document/quotation sheets
 * so a pre-migration free-text country never renders blank.
 */
export function displayCountry(value: string | null | undefined): string | null {
  if (!value) return null;
  const code = normalizeCountryInput(value);
  return code ? (countryName(code) ?? value) : value;
}
